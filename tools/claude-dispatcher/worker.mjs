import { spawn } from "node:child_process";
import fs from "node:fs";

const specPath = process.argv[2];
if (!specPath) throw new Error("Missing job spec path");

function readSpec() {
  return JSON.parse(fs.readFileSync(specPath, "utf8"));
}

function writeSpec(value) {
  const temp = `${specPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, specPath);
}

function update(patch) {
  const current = readSpec();
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeSpec(next);
  return next;
}

const spec = update({
  status: "running",
  workerPid: process.pid,
  startedAt: new Date().toISOString(),
});

const readOnlyTools = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git show:*)",
  "Bash(git log:*)",
  "Bash(git rev-parse:*)",
  "Bash(git branch:*)",
  "Bash(git ls-files:*)",
];
const writeTools = ["Read", "Write", "Edit", "Grep", "Glob", "Bash"];
const allowedTools = spec.mode === "read_only" ? readOnlyTools : writeTools;
const permissionMode = spec.mode === "read_only" ? "plan" : "acceptEdits";

const agents = {
  [`${spec.role}-worker`]: {
    description: `Bounded ${spec.role} worker controlled by the Codex/Fable advisor.`,
    prompt: spec.prompt.split("\n\nTASK FROM ADVISOR:\n")[0],
    model: spec.model,
    tools: allowedTools,
    permissionMode,
    maxTurns: spec.maxTurns,
  },
};

const args = [
  ...(spec.claudePrefixArgs || []),
  "-p",
  "--output-format",
  "json",
  "--model",
  spec.model,
  "--agent",
  `${spec.role}-worker`,
  "--agents",
  JSON.stringify(agents),
  "--permission-mode",
  permissionMode,
  "--max-turns",
  String(spec.maxTurns),
  "--allowedTools",
  ...allowedTools,
];

if (spec.mode === "read_only") {
  args.push("--disallowedTools", "Write", "Edit", "NotebookEdit");
}

const stdout = fs.createWriteStream(spec.outputPath, { flags: "w" });
const stderr = fs.createWriteStream(spec.errorPath, { flags: "w" });
const child = spawn(spec.claudeBin, args, {
  cwd: spec.checkoutPath,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
update({ claudePid: child.pid });

child.stdout.pipe(stdout);
child.stderr.pipe(stderr);
child.stdin.end(spec.prompt);

let spawnFailed = false;

child.on("error", (error) => {
  spawnFailed = true;
  stdout.end();
  stderr.end();
  update({
    status: "failed",
    exitCode: null,
    completedAt: new Date().toISOString(),
    error: error.message,
  });
});

child.on("close", (code, signal) => {
  if (spawnFailed) return;
  stdout.end();
  stderr.end();
  let parsed = null;
  let parseError = null;
  try {
    const raw = fs.readFileSync(spec.outputPath, "utf8").trim();
    parsed = raw ? JSON.parse(raw) : null;
  } catch (error) {
    parseError = error.message;
  }
  const stderrText = fs.existsSync(spec.errorPath)
    ? fs.readFileSync(spec.errorPath, "utf8").trim()
    : "";
  update({
    status: code === 0 ? "completed" : "failed",
    exitCode: code,
    signal: signal || null,
    completedAt: new Date().toISOString(),
    result: parsed?.result ?? parsed,
    sessionId: parsed?.session_id || null,
    error:
      code === 0
        ? parseError
        : stderrText || parseError || `Claude exited with code ${code}`,
  });
});
