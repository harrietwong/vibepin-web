import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..");
const child = spawn(process.execPath, [path.join(here, "server.mjs")], {
  cwd: projectRoot,
  env: {
    ...process.env,
    CLAUDE_DISPATCHER_PROJECT_ROOT: projectRoot,
    CLAUDE_DISPATCHER_STATE_ROOT: path.join(process.env.TEMP || here, "vibepin-claude-dispatcher-test"),
    CLAUDE_DISPATCHER_CLAUDE_BIN: process.env.CLAUDE_DISPATCHER_CLAUDE_BIN || "claude",
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

function request(id, method, params = {}) {
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

try {
  const initialized = await request(1, "initialize", { protocolVersion: "2024-11-05" });
  assert.equal(initialized.serverInfo.name, "vibepin-claude-dispatcher");
  const listed = await request(2, "tools/list");
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    [
      "claude_dispatch",
      "claude_job_status",
      "claude_list_jobs",
      "claude_cancel_job",
      "claude_dispatcher_health",
    ],
  );
  const healthCall = await request(3, "tools/call", {
    name: "claude_dispatcher_health",
    arguments: {},
  });
  const health = JSON.parse(healthCall.content[0].text);
  assert.equal(health.ok, true);
  assert.match(health.claude_version, /Claude Code/);
  assert.equal(health.paid_model_call_started, false);
  console.log("Claude dispatcher protocol tests passed (no paid model call)." );
} finally {
  child.kill();
}

