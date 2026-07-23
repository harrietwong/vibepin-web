import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..");
const stateRoot = path.join(process.env.TEMP || here, "vibepin-codex-advisor-mock-test");

const child = spawn(process.execPath, [path.join(here, "server.mjs")], {
  cwd: projectRoot,
  env: {
    ...process.env,
    CODEX_ADVISOR_PROJECT_ROOT: projectRoot,
    CODEX_ADVISOR_STATE_ROOT: stateRoot,
    CODEX_ADVISOR_CODEX_BIN: process.execPath,
    CODEX_ADVISOR_CODEX_PREFIX_ARGS: JSON.stringify([path.join(here, "mock-codex.mjs")]),
  },
  stdio: ["pipe", "pipe", "inherit"],
});

const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const handler = pending.get(message.id);
  if (handler) {
    pending.delete(message.id);
    handler(message);
  }
});

let nextId = 1;
function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${method}`)), 10000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function textResult(call) {
  return JSON.parse(call.content[0].text);
}

async function pollUntilDone(jobId) {
  let job;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    job = textResult(
      await request("tools/call", {
        name: "codex_job_status",
        arguments: { job_id: jobId },
      }),
    );
    if (["completed", "failed"].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return job;
}

try {
  await request("initialize", { protocolVersion: "2024-11-05" });

  const dispatched = textResult(
    await request("tools/call", {
      name: "ask_codex_advisor",
      arguments: {
        decision_type: "architecture",
        task: "Should we use approach A or B?",
        constraints: "Must not touch production.",
        acceptance_criteria: "Pick one and justify it.",
      },
    }),
  );
  assert.match(dispatched.job_id, /^[a-z0-9-]+$/);

  const job = await pollUntilDone(dispatched.job_id);
  assert.equal(job.status, "completed");
  assert.match(job.result, /mock codex advisor received/);
  assert.match(job.result, /recursion_guard_env=true/);
  assert.match(job.result, /dispatcher_disabled_flag=true/);
  assert.match(job.result, /sandbox=read-only/);

  console.log("Codex advisor async job + recursion-guard tests passed (mock codex, no paid call).");
} finally {
  child.kill();
}
