#!/usr/bin/env node
/**
 * Credential scan gate.
 *
 * Blocks a release when a real secret is committed to the working tree. Born from a
 * live incident: a production root password sat in 26 tracked files for months.
 *
 * Scans git-TRACKED files only — untracked scratch files and gitignored .env files
 * are not what ships. Findings are fatal; there is no warn-only mode, because a
 * warning nobody blocks on is how the password got there in the first place.
 *
 * Run: node scripts/scan-secrets.mjs
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RULES = [
  { id: "private-key",   re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,  what: "private key" },
  { id: "aws-key",       re: /\bAKIA[0-9A-Z]{16}\b/,                                          what: "AWS access key id" },
  { id: "github-token",  re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,                                what: "GitHub token" },
  { id: "slack-token",   re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,                              what: "Slack token" },
  { id: "openai-key",    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,                           what: "OpenAI-style API key" },
  { id: "google-key",    re: /\bAIza[0-9A-Za-z_-]{35}\b/,                                     what: "Google API key" },
  { id: "stripe-key",    re: /\b[sr]k_live_[0-9A-Za-z]{16,}\b/,                               what: "Stripe live key" },
  { id: "jwt",           re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, what: "JWT / signed token" },
  { id: "conn-string",   re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/:@]{6,}@[^\s/]+/,        what: "credentials embedded in a URL" },
  // The shape that actually bit us: a literal password/secret assigned inline. Only
  // fires on a hardcoded literal — env lookups and interpolation are the fix, not the bug.
  { id: "inline-secret", re: /\b(?:password|passwd|secret|api_?key|access_?token|auth_?token)\b\s*[:=]\s*["'][^"'\s${}<>]{8,}["']/i, what: "hardcoded credential literal" },
];

// Values that look like secrets but carry no access. Keep this list SHORT and specific:
// every entry is a hole in the gate.
const ALLOW_VALUE = [
  /^(?:x{3,}|\.{3,}|\*{3,})$/i,
  /\b(?:your[_-]?|my[_-]?|example|placeholder|dummy|sample|changeme|redacted|replace[_-]?me|insert[_-]?|fake|test[_-]?only|not[_-]?a[_-]?real)/i,
  /\b(?:process\.env|os\.environ|import\.meta\.env|getenv|System\.getenv)\b/,
];

// Files whose whole purpose is to document key NAMES, or to talk about this gate.
// Test suites are excluded wholesale: they are full of deliberately fake tokens
// ("shpat_rotated_token") that grant nothing, and a gate that cries wolf every run is
// a gate people learn to bypass. A REAL key pasted into a test would be missed — the
// tradeoff is deliberate, and the rules below still cover live-key shapes everywhere else.
const ALLOW_PATH = [
  /(?:^|[\\/])\.env\.example$/,
  /(?:^|[\\/])[a-z.]*\.env\.example$/,
  /(?:^|[\\/])scan-secrets\.mjs$/,
  /(?:^|[\\/])package-lock\.json$/,
  /(?:^|[\\/])(?:pnpm-lock\.yaml|yarn\.lock)$/,
  /(?:^|[\\/])(?:tests?|__tests__|e2e)[\\/]/,
  /(?:^|[\\/])(?:test|spec)-[^\\/]*\.(?:ts|tsx|js|mjs|py)$/,
  /(?:^|[\\/])test_[^\\/]*\.py$/,
];

const BINARY = /\.(?:png|jpe?g|gif|webp|ico|pdf|docx?|xlsx?|zip|gz|woff2?|ttf|eot|mp4|mov|node|wasm)$/i;

function tracked() {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\0").filter(Boolean);
}

const findings = [];
for (const file of tracked()) {
  if (BINARY.test(file) || ALLOW_PATH.some(r => r.test(file))) continue;

  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  if (text.includes("\0")) continue; // binary we failed to spot by extension

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 500) continue;                 // minified/bundled
    if (/\bscan-secrets-ignore\b/.test(line)) continue;
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      if (ALLOW_VALUE.some(r => r.test(m[0]))) continue;
      findings.push({ file, line: i + 1, rule: rule.id, what: rule.what, snippet: line.trim().slice(0, 100) });
      break;
    }
  }
}

if (findings.length === 0) {
  console.log("Credential scan: clean — no secrets in tracked files.");
  process.exit(0);
}

console.error(`Credential scan FAILED — ${findings.length} finding(s):\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  [${f.rule}] ${f.what}`);
  console.error(`      ${f.snippet}\n`);
}
console.error("Move the value into an env var (fail loudly when it is missing) and rotate it — it is");
console.error("already in git history, so deleting the line does not make the credential safe again.");
console.error("If a match is genuinely not a secret, append a `scan-secrets-ignore` comment on that line.");
process.exit(1);
