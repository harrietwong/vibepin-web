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
 * Two tiers of rule (see below):
 *   HIGH-CONFIDENCE (real credential shapes: GitHub/AWS/OpenAI/Slack keys, PEM blocks,
 *     JWTs, …) scan EVERY text file — tests, e2e, .env.example, lockfiles included.
 *     There are no directory or filename exemptions; a live token pasted into a test
 *     used to scan clean, and no longer does.
 *   GENERIC/heuristic (inline password= / secret= literals, creds-in-URL) also scan
 *     everywhere but tolerate obvious placeholders.
 * The ONLY way to silence a specific line, in either tier, is an explicit inline
 * `scan-secrets: allow` marker (legacy `scan-secrets-ignore` still works). Verify the
 * value is genuinely not a secret before adding one — every marker is a hole.
 *
 * Run: node scripts/scan-secrets.mjs
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Two tiers.
//
// HIGH-CONFIDENCE rules match live-credential SHAPES that carry access no matter where
// they sit — a real GitHub token in a test fixture is just as dangerous as one in
// prod code. These scan EVERY text file: tests, e2e, .env.example, lockfiles, all of
// it. There are NO directory or filename exemptions for this tier; the only way to
// silence a specific line is an explicit inline `scan-secrets: allow` marker on it,
// and every such marker is a deliberate, reviewable decision.
const HIGH_CONFIDENCE = [
  { id: "private-key",   re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,  what: "private key" },
  { id: "aws-key",       re: /\bAKIA[0-9A-Z]{16}\b/,                                          what: "AWS access key id" },
  { id: "github-token",  re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,                                what: "GitHub token" },
  { id: "github-pat",    re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,                              what: "GitHub fine-grained PAT" },
  { id: "slack-token",   re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,                              what: "Slack token" },
  { id: "openai-key",    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,                           what: "OpenAI-style API key" },
  { id: "google-key",    re: /\bAIza[0-9A-Za-z_-]{35}\b/,                                     what: "Google API key" },
  { id: "stripe-key",    re: /\b[sr]k_live_[0-9A-Za-z]{16,}\b/,                               what: "Stripe live key" },
  { id: "jwt",           re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, what: "JWT / signed token" },
];

// GENERIC / heuristic rules catch the fuzzy shapes — a password/secret assigned to an
// inline literal, or credentials embedded in a URL. These fire on obvious fake test
// fixtures too, so they are exemptible — but ONLY via the same explicit inline
// `scan-secrets: allow` marker, never via a directory or filename skip. A whole-suite
// exemption is exactly the blind spot this rewrite removes.
const GENERIC = [
  { id: "conn-string",   re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/:@]{6,}@[^\s/]+/,        what: "credentials embedded in a URL" },
  // The shape that actually bit us: a literal password/secret assigned inline. Only
  // fires on a hardcoded literal — env lookups and interpolation are the fix, not the bug.
  { id: "inline-secret", re: /\b(?:password|passwd|secret|api_?key|access_?token|auth_?token)\b\s*[:=]\s*["'][^"'\s${}<>]{8,}["']/i, what: "hardcoded credential literal" },
];

// Values that look like secrets but carry no access. Applies to GENERIC rules only:
// a high-confidence shape is a real credential regardless of surrounding wording, so it
// is never value-allowlisted — only an explicit inline marker can silence it.
// Keep this list SHORT and specific: every entry is a hole in the generic tier.
const ALLOW_VALUE = [
  /^(?:x{3,}|\.{3,}|\*{3,})$/i,
  /\b(?:your[_-]?|my[_-]?|example|placeholder|dummy|sample|changeme|redacted|replace[_-]?me|insert[_-]?|fake|test[_-]?only|not[_-]?a[_-]?real)/i,
  /\b(?:process\.env|os\.environ|import\.meta\.env|getenv|System\.getenv)\b/,
];

// The ONLY per-line escape hatch, for BOTH tiers. Legacy `scan-secrets-ignore` still
// honoured so old markers do not silently break.
const INLINE_ALLOW = /\bscan-secrets:\s*allow\b|\bscan-secrets-ignore\b/;

// This scanner is scanning itself — the rule regexes above would otherwise flag it.
// This is the single file-level skip that remains, and it exempts NOTHING else.
const SELF = /(?:^|[\\/])scan-secrets\.mjs$/;

const BINARY = /\.(?:png|jpe?g|gif|webp|ico|pdf|docx?|xlsx?|zip|gz|woff2?|ttf|eot|mp4|mov|node|wasm)$/i;

function tracked() {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\0").filter(Boolean);
}

const findings = [];
for (const file of tracked()) {
  if (BINARY.test(file) || SELF.test(file)) continue;

  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  if (text.includes("\0")) continue; // binary we failed to spot by extension

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 500) continue;                 // minified/bundled
    const allowed = INLINE_ALLOW.test(line);         // the ONLY per-line escape hatch

    // High-confidence rules scan every file and are never value-allowlisted — only an
    // explicit inline marker silences them.
    let hit = false;
    for (const rule of HIGH_CONFIDENCE) {
      if (!rule.re.test(line)) continue;
      if (!allowed) findings.push({ file, line: i + 1, rule: rule.id, what: rule.what, snippet: line.trim().slice(0, 100) });
      hit = true;
      break;
    }
    if (hit) continue;

    // Generic/heuristic rules: exemptible by the inline marker OR a known placeholder value.
    if (allowed) continue;
    for (const rule of GENERIC) {
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
console.error("If a match is genuinely not a secret, append a `scan-secrets: allow` comment on that line.");
process.exit(1);
