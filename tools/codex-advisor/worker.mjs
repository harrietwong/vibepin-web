import fs from "node:fs";
import { runCodexExec } from "./invoke.mjs";

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

const spec = update({ status: "running", startedAt: new Date().toISOString() });

const outcome = await runCodexExec({
  codexBin: spec.codexBin,
  codexPrefixArgs: spec.codexPrefixArgs,
  prompt: spec.prompt,
  cwd: spec.projectRoot,
  stdoutJsonlPath: spec.stdoutJsonlPath,
  stderrLogPath: spec.stderrLogPath,
  outputPath: spec.outputPath,
  onSpawn: (pid) => update({ codexPid: pid }),
});

update({
  status: outcome.ok ? "completed" : "failed",
  exitCode: outcome.exitCode,
  signal: outcome.signal,
  completedAt: new Date().toISOString(),
  result: outcome.result,
  error: outcome.error,
});
