import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..");
const stateRoot = path.join(process.env.TEMP || here, "vibepin-claude-dispatcher-dispatch-test");
const child = spawn(process.execPath, [path.join(here, "server.mjs")], {
  cwd: projectRoot,
  env: {
    ...process.env,
    CLAUDE_DISPATCHER_PROJECT_ROOT: projectRoot,
    CLAUDE_DISPATCHER_STATE_ROOT: stateRoot,
    CLAUDE_DISPATCHER_CLAUDE_BIN: process.execPath,
    CLAUDE_DISPATCHER_CLAUDE_PREFIX_ARGS: JSON.stringify([path.join(here, "mock-claude.mjs")]),
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

try {
  await request("initialize", { protocolVersion: "2024-11-05" });
  const dispatched = textResult(
    await request("tools/call", {
      name: "claude_dispatch",
      arguments: {
        role: "opus",
        mode: "read_only",
        task_name: "bridge-smoke",
        task: "Inspect nothing and return the mock result.",
        max_turns: 1,
      },
    }),
  );
  assert.match(dispatched.job_id, /^[a-z0-9-]+$/);
  let job;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    job = textResult(
      await request("tools/call", {
        name: "claude_job_status",
        arguments: { job_id: dispatched.job_id },
      }),
    );
    if (["completed", "failed"].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(job.status, "completed");
  assert.match(job.result, /mock worker received/);
  assert.equal(job.mode, "read_only");
  console.log("Claude dispatcher async job tests passed (mock model, no paid call)." );
} finally {
  child.kill();
}

