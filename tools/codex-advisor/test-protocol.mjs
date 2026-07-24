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
    CODEX_ADVISOR_PROJECT_ROOT: projectRoot,
    CODEX_ADVISOR_STATE_ROOT: path.join(process.env.TEMP || here, "vibepin-codex-advisor-test"),
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
  assert.equal(initialized.serverInfo.name, "vibepin-codex-advisor");
  const listed = await request(2, "tools/list");
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ["ask_codex_advisor", "review_with_codex", "codex_job_status"],
  );

  // review_with_codex must reject non-committed refs without ever spawning codex.
  const rejected = await request(3, "tools/call", {
    name: "review_with_codex",
    arguments: {
      base_ref: "HEAD",
      target_ref: "not-a-real-ref-xyz",
    },
  }).catch((error) => error);
  assert.match(rejected.message, /committed git refs/);

  console.log("Codex advisor protocol tests passed (no codex process spawned).");
} finally {
  child.kill();
}
