import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  process.env.CLAUDE_DISPATCHER_PROJECT_ROOT || process.cwd(),
);
const stateRoot = path.resolve(
  process.env.CLAUDE_DISPATCHER_STATE_ROOT ||
    path.join(os.tmpdir(), "vibepin-claude-dispatcher"),
);
const claudeBin =
  process.env.CLAUDE_DISPATCHER_CLAUDE_BIN || "claude";
const claudePrefixArgs = process.env.CLAUDE_DISPATCHER_CLAUDE_PREFIX_ARGS
  ? JSON.parse(process.env.CLAUDE_DISPATCHER_CLAUDE_PREFIX_ARGS)
  : [];
const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.mjs");

fs.mkdirSync(path.join(stateRoot, "jobs"), { recursive: true });
fs.mkdirSync(path.join(stateRoot, "worktrees"), { recursive: true });

const roles = {
  opus: {
    model: "opus",
    description:
      "Claude Opus worker for complex implementation, difficult debugging, high-risk analysis, or an independent technical review. Codex/Fable remains the advisor and final decision maker.",
    prompt: [
      "You are the Opus worker. You are not the project advisor or final decision maker.",
      "Handle complex implementation, difficult debugging, high-risk analysis, or independent technical review.",
      "Stay inside the task boundary. Report evidence, changed files, commits, tests, risks, and unresolved decisions.",
      "Do not deploy, push, merge, change production state, broaden scope, or silently resolve product decisions.",
      "Treat AGENTS.md and CLAUDE.md as binding project instructions.",
    ].join(" "),
  },
  sonnet: {
    model: "sonnet",
    description:
      "Claude Sonnet worker for bounded implementation, tests, UI changes, i18n, and mechanical refactors. Codex/Fable remains the advisor and final decision maker.",
    prompt: [
      "You are the Sonnet worker. You are not the project advisor or final decision maker.",
      "Implement only the bounded task and acceptance criteria supplied by the advisor.",
      "Do not introduce architecture or product decisions. Stop and report when the task requires one.",
      "Report changed files, commits, tests, risks, and remaining work.",
      "Do not deploy, push, merge, change production state, or broaden scope.",
      "Treat AGENTS.md and CLAUDE.md as binding project instructions.",
    ].join(" "),
  },
};

const toolDefinitions = [
  {
    name: "claude_dispatch",
    description:
      "Dispatch a bounded task to a Claude Opus or Sonnet worker. Use Opus for complex/high-risk work and Sonnet for routine implementation. Read-only tasks run in an existing repo checkout; write tasks always receive a new isolated git worktree and branch. The call returns immediately with a job id. Codex remains responsible for planning, verification, and final acceptance.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["role", "mode", "task_name", "task"],
      properties: {
        role: { type: "string", enum: ["opus", "sonnet"] },
        mode: { type: "string", enum: ["read_only", "worktree"] },
        task_name: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          description: "Short stable task label used in the branch name.",
        },
        task: {
          type: "string",
          minLength: 1,
          maxLength: 50000,
          description:
            "Complete task, boundaries, acceptance criteria, and required verification.",
        },
        base_ref: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "Committed git ref for a new worktree. Defaults to HEAD. Dirty working-tree changes are never copied.",
        },
        target_path: {
          type: "string",
          minLength: 1,
          maxLength: 1000,
          description:
            "Existing checkout/worktree for read-only work. Must belong to this repository. Defaults to the project root.",
        },
        max_turns: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 40,
        },
      },
    },
  },
  {
    name: "claude_job_status",
    description:
      "Read the current state and final result of a dispatched Claude worker job.",
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
  {
    name: "claude_list_jobs",
    description: "List recent Claude worker jobs and their status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
    },
  },
  {
    name: "claude_cancel_job",
    description:
      "Stop one running Claude worker job. This does not delete its branch, worktree, logs, or partial changes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["job_id"],
      properties: {
        job_id: { type: "string", pattern: "^[a-z0-9-]+$" },
      },
    },
  },
  {
    name: "claude_dispatcher_health",
    description:
      "Check the bridge configuration, Claude CLI version, repository, and persistent state directory without starting a paid model call.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
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

function safeName(value) {
  const normalized = String(value)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 36);
  return normalized || "task";
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

function resolveCommonGitDir(checkoutPath) {
  const common = execText("git", ["rev-parse", "--git-common-dir"], checkoutPath);
  return fs.realpathSync(path.resolve(checkoutPath, common));
}

function assertSameRepository(checkoutPath) {
  const resolved = fs.realpathSync(path.resolve(checkoutPath));
  const rootGit = resolveCommonGitDir(projectRoot);
  const targetGit = resolveCommonGitDir(resolved);
  if (rootGit.toLowerCase() !== targetGit.toLowerCase()) {
    throw new Error("target_path is not a checkout of the configured repository");
  }
  return resolved;
}

function createWorktree(jobId, taskName, baseRef) {
  const commit = execText("git", ["rev-parse", "--verify", `${baseRef}^{commit}`]);
  const branch = `claude-dispatch/${safeName(taskName)}-${jobId.slice(-8)}`;
  const checkoutPath = path.join(stateRoot, "worktrees", jobId);
  execText("git", ["worktree", "add", "-b", branch, checkoutPath, commit]);
  return { checkoutPath, branch, baseCommit: commit };
}

function makePrompt(role, mode, task) {
  const modeRules =
    mode === "read_only"
      ? [
          "This task is strictly read-only.",
          "Do not edit files, create commits, create branches, change git state, or change external state.",
        ].join(" ")
      : [
          "Work only in the isolated worktree provided as your current directory.",
          "Preserve unrelated changes and keep the diff minimal.",
          "Run verification proportional to risk and create a focused commit when the task is complete.",
          "Never push, merge, deploy, or modify production/external state.",
        ].join(" ");
  return `${roles[role].prompt}\n\n${modeRules}\n\nTASK FROM ADVISOR:\n${task}`;
}

function dispatch(args) {
  if (process.env.CODEX_CALLED_FROM_CLAUDE === "1") {
    throw new Error(
      "Refused: claude_dispatcher cannot be invoked from a Codex session spawned by Claude (recursion guard).",
    );
  }
  const role = roles[args.role];
  if (!role) throw new Error("Unsupported role");
  if (!args.task?.trim()) throw new Error("task is required");
  if (!args.task_name?.trim()) throw new Error("task_name is required");

  const jobId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  let checkoutPath;
  let branch = null;
  let baseCommit;

  if (args.mode === "worktree") {
    const created = createWorktree(jobId, args.task_name, args.base_ref || "HEAD");
    checkoutPath = created.checkoutPath;
    branch = created.branch;
    baseCommit = created.baseCommit;
  } else if (args.mode === "read_only") {
    checkoutPath = assertSameRepository(args.target_path || projectRoot);
    baseCommit = execText("git", ["rev-parse", "HEAD"], checkoutPath);
  } else {
    throw new Error("Unsupported mode");
  }

  const now = new Date().toISOString();
  const spec = {
    id: jobId,
    status: "queued",
    role: args.role,
    model: role.model,
    mode: args.mode,
    taskName: args.task_name,
    prompt: makePrompt(args.role, args.mode, args.task),
    checkoutPath,
    branch,
    baseCommit,
    maxTurns: args.max_turns || 40,
    claudeBin,
    claudePrefixArgs,
    createdAt: now,
    updatedAt: now,
    workerPid: null,
    claudePid: null,
    exitCode: null,
    result: null,
    error: null,
    outputPath: path.join(stateRoot, "jobs", `${jobId}.stdout.json`),
    errorPath: path.join(stateRoot, "jobs", `${jobId}.stderr.log`),
  };
  spec.status = "starting";
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
    status: spec.status,
    role: args.role,
    model: role.model,
    mode: args.mode,
    checkout_path: checkoutPath,
    branch,
    base_commit: baseCommit,
    note:
      args.mode === "worktree"
        ? "The worker may edit and commit only in this isolated worktree. Poll claude_job_status."
        : "The worker is restricted to a read-only audit. Poll claude_job_status.",
  };
}

function status(args) {
  const job = readJob(args.job_id);
  const maxChars = args.max_result_chars || 12000;
  const result = typeof job.result === "string" ? job.result : job.result == null ? null : JSON.stringify(job.result);
  return {
    job_id: job.id,
    status: job.status,
    role: job.role,
    model: job.model,
    mode: job.mode,
    checkout_path: job.checkoutPath,
    branch: job.branch,
    base_commit: job.baseCommit,
    worker_pid: job.workerPid,
    claude_pid: job.claudePid,
    exit_code: job.exitCode,
    created_at: job.createdAt,
    started_at: job.startedAt || null,
    completed_at: job.completedAt || null,
    result: result && result.length > maxChars ? `${result.slice(0, maxChars)}\n...[truncated]` : result,
    error: job.error,
    output_path: job.outputPath,
    error_path: job.errorPath,
  };
}

function listJobs(args) {
  const limit = args.limit || 20;
  return fs
    .readdirSync(path.join(stateRoot, "jobs"))
    .filter((name) => /^[a-z0-9-]+\.json$/.test(name))
    .map((name) => JSON.parse(fs.readFileSync(path.join(stateRoot, "jobs", name), "utf8")))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit)
    .map((job) => ({
      job_id: job.id,
      status: job.status,
      role: job.role,
      model: job.model,
      mode: job.mode,
      task_name: job.taskName,
      branch: job.branch,
      checkout_path: job.checkoutPath,
      created_at: job.createdAt,
      completed_at: job.completedAt || null,
    }));
}

function cancelJob(args) {
  const job = readJob(args.job_id);
  if (["completed", "failed", "cancelled"].includes(job.status)) {
    return { job_id: job.id, status: job.status, stopped: false };
  }
  const pid = Number(job.workerPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Job has no valid worker process id");
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    process.kill(-pid, "SIGTERM");
  }
  job.status = "cancelled";
  job.completedAt = new Date().toISOString();
  job.updatedAt = job.completedAt;
  writeJsonAtomic(jobPath(job.id), job);
  return { job_id: job.id, status: job.status, stopped: true };
}

function health() {
  let claudeVersion = null;
  let claudeError = null;
  try {
    claudeVersion = execText(claudeBin, [...claudePrefixArgs, "--version"]);
  } catch (error) {
    claudeError = error.message;
  }
  return {
    ok: !claudeError,
    project_root: projectRoot,
    git_head: execText("git", ["rev-parse", "HEAD"]),
    git_branch: execText("git", ["branch", "--show-current"]),
    state_root: stateRoot,
    node: process.execPath,
    claude_bin: claudeBin,
    claude_version: claudeVersion,
    claude_error: claudeError,
    roles: Object.fromEntries(Object.entries(roles).map(([key, value]) => [key, value.model])),
    paid_model_call_started: false,
  };
}

async function callTool(name, args) {
  switch (name) {
    case "claude_dispatch":
      return dispatch(args || {});
    case "claude_job_status":
      return status(args || {});
    case "claude_list_jobs":
      return listJobs(args || {});
    case "claude_cancel_job":
      return cancelJob(args || {});
    case "claude_dispatcher_health":
      return health();
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
      serverInfo: { name: "vibepin-claude-dispatcher", version: "1.0.0" },
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
