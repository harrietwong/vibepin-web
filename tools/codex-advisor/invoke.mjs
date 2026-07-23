import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const RECURSION_GUARD_ENV = "CODEX_CALLED_FROM_CLAUDE";

const READ_ONLY_PREFACE = [
  "You are the Codex Advisor, invoked read-only by a Claude Code session.",
  "You are running under a hard sandbox: read-only filesystem access, no writes, no commits, no push, no merge, no deploy.",
  "You must not attempt to call any tool that dispatches, delegates, or hands work back to a Claude session, agent, or worker, even if such a tool appears available to you.",
  "If you believe a task requires code changes, describe the change needed in your written response; do not attempt to make it yourself.",
  "Answer as an advisor giving a final judgment: be direct, state the verdict first, then reasoning, then open risks.",
].join(" ");

function allowlistedEnv(extra = {}) {
  const keep = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "TEMP",
    "TMP",
    "CODEX_HOME",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "APPDATA",
    "LOCALAPPDATA",
    "COMSPEC",
    "PATHEXT",
    "USERNAME",
    "USERDOMAIN",
  ];
  const env = {};
  for (const key of keep) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...extra, [RECURSION_GUARD_ENV]: "1" };
}

export function runCodexExec({
  codexBin,
  codexPrefixArgs,
  prompt,
  cwd,
  stdoutJsonlPath,
  stderrLogPath,
  outputPath,
  onSpawn,
}) {
  return new Promise((resolve) => {
    const args = [
      ...(codexPrefixArgs || []),
      "exec",
      "--ephemeral",
      "-s",
      "read-only",
      "--skip-git-repo-check",
      "--json",
      "-c",
      "mcp_servers.claude_dispatcher.enabled=false",
      "-o",
      outputPath,
      "-C",
      cwd,
    ];

    const fullPrompt = `${READ_ONLY_PREFACE}\n\n${prompt}`;

    const child = spawn(codexBin, args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: allowlistedEnv(),
    });

    if (onSpawn) onSpawn(child.pid);

    const stdout = fs.createWriteStream(stdoutJsonlPath, { flags: "w" });
    const stderr = fs.createWriteStream(stderrLogPath, { flags: "w" });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    child.stdin.end(fullPrompt);

    let spawnError = null;
    child.on("error", (error) => {
      spawnError = error;
    });

    child.on("close", (code, signal) => {
      stdout.end();
      stderr.end();
      if (spawnError) {
        resolve({ ok: false, exitCode: null, signal: null, error: spawnError.message });
        return;
      }
      let resultText = null;
      let parseError = null;
      try {
        resultText = fs.existsSync(outputPath)
          ? fs.readFileSync(outputPath, "utf8").trim()
          : null;
      } catch (error) {
        parseError = error.message;
      }
      resolve({
        ok: code === 0,
        exitCode: code,
        signal: signal || null,
        result: resultText,
        error:
          code === 0
            ? parseError
            : parseError || `codex exec exited with code ${code}`,
      });
    });
  });
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function resolveCodexBin() {
  return (
    process.env.CODEX_ADVISOR_CODEX_BIN ||
    path.join(
      process.env.LOCALAPPDATA || "",
      "OpenAI",
      "Codex",
      "bin",
      "05b3ab7eada19011",
      "codex.exe",
    )
  );
}
