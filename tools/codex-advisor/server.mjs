import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { ensureDir, resolveCodexBin } from "./invoke.mjs";

const projectRoot = path.resolve(
  process.env.CODEX_ADVISOR_PROJECT_ROOT || process.cwd(),
);
const stateRoot = path.resolve(
  process.env.CODEX_ADVISOR_STATE_ROOT ||
    path.join(os.tmpdir(), "vibepin-codex-advisor"),
);
const codexBin = process.env.CODEX_ADVISOR_CODEX_BIN || resolveCodexBin();
const codexPrefixArgs = process.env.CODEX_ADVISOR_CODEX_PREFIX_ARGS
  ? JSON.parse(process.env.CODEX_ADVISOR_CODEX_PREFIX_ARGS)
  : [];
const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.mjs");

ensureDir(path.join(stateRoot, "jobs"));

const MAX_CONTEXT_FILE_BYTES = 200_000;
const MAX_TOTAL_CONTEXT_BYTES = 1_500_000;

const toolDefinitions = [
  {
    name: "ask_codex_advisor",
    description:
      "Ask the Codex advisor for a final judgment on a plan, architecture question, or a conflict between Opus/Sonnet worker conclusions. Codex runs read-only (cannot edit files, commit, push, merge, or deploy). Only the fields you pass are sent — not the conversation history. Returns a job id immediately; poll codex_job_status for the result.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["task", "decision_type"],
      properties: {
        decision_type: {
          type: "string",
          enum: ["prd_review", "architecture", "conflict_resolution", "merge_order", "other"],
          description: "Classification for logging only; does not change behavior.",
        },
        task: {
          type: "string",
          minLength: 1,
          maxLength: 50000,
          description: "The question or decision Codex must judge.",
        },
        context_files: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 1000 },
          maxItems: 30,
          description: "Absolute paths to PRD/plan/other files to include as context.",
        },
        constraints: {
          type: "string",
          maxLength: 20000,
          description: "Known constraints Codex must respect in its judgment.",
        },
        acceptance_criteria: {
          type: "string",
          maxLength: 20000,
          description: "Acceptance criteria the plan or decision must satisfy.",
        },
      },
    },
  },
  {
    name: "review_with_codex",
    description:
      "Have Codex perform a final read-only review of a committed diff against a PRD and acceptance criteria. target_ref must be a committed git ref (commit/branch/tag) — uncommitted working-tree changes are not supported; diff that content yourself and pass it via ask_codex_advisor instead. Returns a job id immediately; poll codex_job_status for the result.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["base_ref", "target_ref"],
      properties: {
        base_ref: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Committed git ref to diff from.",
        },
        target_ref: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Committed git ref to diff to. Must resolve with git rev-parse.",
        },
        prd_paths: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 1000 },
          maxItems: 30,
          description: "Absolute paths to PRD/spec files relevant to this review.",
        },
        acceptance_criteria: {
          type: "string",
          maxLength: 20000,
          description: "Acceptance criteria the diff must satisfy.",
        },
      },
    },
  },
  {
    name: "codex_job_status",
    description: "Read the current state and final result of an ask_codex_advisor or review_with_codex job.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["job_id"],
      properties: {
        job_id: { type: "string", pattern: "^[a-z0-9-]+$" },
        max_result_chars: {
          type: "integer",
          minimum: 1000,
          maximum: 50000,
          default: 12000,
        },
      },
    },
  },
];

function execText(command, args, cwd = projectRoot) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function jobPath(jobId) {
  if (!/^[a-z0-9-]+$/.test(jobId)) throw new Error("Invalid job id");
  return path.join(stateRoot, "jobs", `${jobId}.json`);
}

function readJob(jobId) {
  const file = jobPath(jobId);
  if (!fs.existsSync(file)) throw new Error(`Unknown job: ${jobId}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

function newJobId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function readContextFiles(paths) {
  if (!paths || !paths.length) return "";
  let total = 0;
  const blocks = [];
  for (const p of paths) {
    const resolved = path.resolve(p);
    if (!fs.existsSync(resolved)) {
      blocks.push(`--- ${p} ---\n[missing file]`);
      continue;
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      blocks.push(`--- ${p} ---\n[not a regular file]`);
      continue;
    }
    let content = fs.readFileSync(resolved, "utf8");
    if (content.length > MAX_CONTEXT_FILE_BYTES) {
      content = `${content.slice(0, MAX_CONTEXT_FILE_BYTES)}\n...[truncated: file exceeds per-file limit]`;
    }
    total += content.length;
    if (total > MAX_TOTAL_CONTEXT_BYTES) {
      blocks.push(`--- ${p} ---\n[skipped: total context budget exceeded]`);
      continue;
    }
    blocks.push(`--- ${p} ---\n${content}`);
  }
  return blocks.join("\n\n");
}

function buildAdvisorPrompt(args) {
  const parts = [
    `DECISION TYPE: ${args.decision_type}`,
    `TASK:\n${args.task}`,
  ];
  if (args.constraints) parts.push(`CONSTRAINTS:\n${args.constraints}`);
  if (args.acceptance_criteria) parts.push(`ACCEPTANCE CRITERIA:\n${args.acceptance_criteria}`);
  const context = readContextFiles(args.context_files);
  if (context) parts.push(`CONTEXT FILES:\n${context}`);
  return parts.join("\n\n");
}

function buildReviewPrompt(args, diff) {
  const parts = [
    `You are performing a final read-only review of a committed diff.`,
    `BASE REF: ${args.base_ref}`,
    `TARGET REF: ${args.target_ref}`,
    `DIFF:\n${diff}`,
  ];
  if (args.acceptance_criteria) parts.push(`ACCEPTANCE CRITERIA:\n${args.acceptance_criteria}`);
  const context = readContextFiles(args.prd_paths);
  if (context) parts.push(`PRD / SPEC FILES:\n${context}`);
  parts.push(
    "Give a verdict: APPROVE, APPROVE WITH NOTES, or REJECT, then list concrete issues tied to file/line where possible.",
  );
  return parts.join("\n\n");
}

function startJob({ prompt, kind, meta }) {
  const jobId = newJobId();
  const now = new Date().toISOString();
  const spec = {
    id: jobId,
    kind,
    status: "starting",
    meta,
    codexBin,
    codexPrefixArgs,
    projectRoot,
    prompt,
    createdAt: now,
    updatedAt: now,
    workerPid: null,
    codexPid: null,
    exitCode: null,
    result: null,
    error: null,
    stdoutJsonlPath: path.join(stateRoot, "jobs", `${jobId}.stdout.jsonl`),
    stderrLogPath: path.join(stateRoot, "jobs", `${jobId}.stderr.log`),
    outputPath: path.join(stateRoot, "jobs", `${jobId}.output.txt`),
  };
  writeJsonAtomic(jobPath(jobId), spec);

  const child = spawn(process.execPath, [workerPath, jobPath(jobId)], {
    cwd: projectRoot,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  const latest = readJob(jobId);
  latest.workerPid = child.pid;
  latest.updatedAt = new Date().toISOString();
  writeJsonAtomic(jobPath(jobId), latest);

  return {
    job_id: jobId,
    status: latest.status,
    note: "Codex is running read-only. Poll codex_job_status for the result.",
  };
}

function askCodexAdvisor(args) {
  if (!args.task?.trim()) throw new Error("task is required");
  if (!args.decision_type) throw new Error("decision_type is required");
  const prompt = buildAdvisorPrompt(args);
  return startJob({
    prompt,
    kind: "ask_codex_advisor",
    meta: { decision_type: args.decision_type },
  });
}

function reviewWithCodex(args) {
  if (!args.base_ref?.trim()) throw new Error("base_ref is required");
  if (!args.target_ref?.trim()) throw new Error("target_ref is required");

  let baseCommit;
  let targetCommit;
  try {
    baseCommit = execText("git", ["rev-parse", "--verify", `${args.base_ref}^{commit}`]);
    targetCommit = execText("git", ["rev-parse", "--verify", `${args.target_ref}^{commit}`]);
  } catch {
    throw new Error(
      "base_ref and target_ref must be committed git refs (commit/branch/tag). Uncommitted working-tree changes are not supported here.",
    );
  }

  const diff = execText("git", ["diff", `${baseCommit}..${targetCommit}`]);
  if (!diff.trim()) throw new Error("Diff between base_ref and target_ref is empty");

  const prompt = buildReviewPrompt(args, diff);
  return startJob({
    prompt,
    kind: "review_with_codex",
    meta: { base_ref: args.base_ref, target_ref: args.target_ref, base_commit: baseCommit, target_commit: targetCommit },
  });
}

function jobStatus(args) {
  const job = readJob(args.job_id);
  const maxChars = args.max_result_chars || 12000;
  const result = job.result;
  return {
    job_id: job.id,
    kind: job.kind,
    status: job.status,
    meta: job.meta,
    created_at: job.createdAt,
    started_at: job.startedAt || null,
    completed_at: job.completedAt || null,
    exit_code: job.exitCode,
    result: result && result.length > maxChars ? `${result.slice(0, maxChars)}\n...[truncated]` : result,
    error: job.error,
    stdout_jsonl_path: job.stdoutJsonlPath,
    stderr_log_path: job.stderrLogPath,
  };
}

async function callTool(name, args) {
  switch (name) {
    case "ask_codex_advisor":
      return askCodexAdvisor(args || {});
    case "review_with_codex":
      return reviewWithCodex(args || {});
    case "codex_job_status":
      return jobStatus(args || {});
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  if (message.method === "initialize") {
    return {
      protocolVersion: message.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "vibepin-codex-advisor", version: "1.0.0" },
    };
  }
  if (message.method === "ping") return {};
  if (message.method === "tools/list") return { tools: toolDefinitions };
  if (message.method === "tools/call") {
    const value = await callTool(message.params?.name, message.params?.arguments || {});
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  }
  if (message.method?.startsWith("notifications/")) return undefined;
  throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (message.id == null) {
    try {
      await handle(message);
    } catch {
      // Notifications never receive responses.
    }
    return;
  }
  try {
    const result = await handle(message);
    send({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: error.code || -32000, message: error.message },
    });
  }
});
