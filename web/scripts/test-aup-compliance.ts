/**
 * AUP / AI-compliance static content tests.
 * Run: npx tsx scripts/test-aup-compliance.ts
 *
 * Pure file-content assertions (no server, no network):
 *   - the AUP page exists and contains all 10 section titles.
 *   - LandingFooter links to /acceptable-use-policy.
 *   - terms/page.tsx has the "AI-Generated Content and Prohibited Use" section
 *     and links to /acceptable-use-policy.
 *   - moderatePrompt.ts is server-only: it is NOT imported by any "use client"
 *     file, and CREEM_API_KEY never appears in a NEXT_PUBLIC_ context.
 */

export {};

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function main() {
  console.log("\nAUP / AI-compliance static tests\n");

  const aup = read("src/app/acceptable-use-policy/page.tsx");

  test("AUP page exists and has all 11 section titles", () => {
    const titles = [
      "1. Permitted Use",
      "2. Sexual and Adult Content",
      "3. Face Manipulation and Deceptive Media",
      "4. Violence, Harm, and Illegal Activity",
      "5. Harassment, Hate, and Exploitation",
      "6. Intellectual Property and Third-Party Rights",
      "7. Platform Abuse",
      "8. Prompt Screening and Enforcement",
      "9. Reporting Violations",
      "10. Third-Party AI Services",
      "11. Changes to This Policy",
    ];
    for (const t of titles) assert(aup.includes(t), `AUP missing section: ${t}`);
  });

  test("AUP page uses a constant Last-updated string (no runtime Date)", () => {
    assert(aup.includes('const UPDATED = "July 20, 2026"'), "UPDATED constant present");
    assert(!/new Date\(/.test(aup), "AUP must not use runtime new Date()");
  });

  test("AUP page uses support@vibepin.co", () => {
    assert(aup.includes("support@vibepin.co"), "support email present");
  });

  test("AUP cross-links to /terms and /privacy", () => {
    assert(aup.includes('href="/terms"'), "links to /terms");
    assert(aup.includes('href="/privacy"'), "links to /privacy");
  });

  test("LandingFooter links to /acceptable-use-policy", () => {
    const footer = read("src/components/landing/conversion/LandingFooter.tsx");
    assert(footer.includes("/acceptable-use-policy"), "footer href present");
    assert(footer.includes("Acceptable Use Policy"), "footer label present");
  });

  test("terms/page.tsx has the AI-Generated Content section + AUP link", () => {
    const terms = read("src/app/terms/page.tsx");
    assert(terms.includes("AI-Generated Content and Prohibited Use"), "terms section title present");
    assert(terms.includes("/acceptable-use-policy"), "terms links to AUP");
    // Existing sections must not have been removed.
    for (const s of ["1. Acceptance of Terms", "No Guarantee of Results", "Limitation of Liability", "Contact"]) {
      assert(terms.includes(s), `existing terms section preserved: ${s}`);
    }
  });

  test("prompt notice rendered near a studio prompt input", () => {
    const cdp = read("src/components/studio/CreativeDirectionPanel.tsx");
    assert(cdp.includes("studioCreative.direction.moderationNotice"), "CreativeDirectionPanel notice key");
    assert(cdp.includes("/acceptable-use-policy"), "CreativeDirectionPanel links to AUP");
    const ofs = read("src/components/studio/OpportunityFirstStudio.tsx");
    assert(ofs.includes("studioCreative.direction.moderationNotice"), "OpportunityFirstStudio notice key");
    assert(ofs.includes("/acceptable-use-policy"), "OpportunityFirstStudio links to AUP");
  });

  test("moderation notice i18n key exists in the English catalog", () => {
    const en = read("src/lib/i18n/messages/en/studioCreative.ts");
    assert(en.includes("studioCreative.direction.moderationNotice"), "en key present");
    assert(en.includes("prohibited"), "en notice text present");
  });

  test("moderatePrompt.ts is NOT imported by any client (\"use client\") file", () => {
    const files = walk(join(ROOT, "src"));
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const isClient = /^\s*["']use client["']/m.test(src.split("\n").slice(0, 3).join("\n")) || /^["']use client["']/.test(src.trimStart());
      if (isClient && /creem\/moderatePrompt/.test(src)) offenders.push(f);
    }
    assert(offenders.length === 0, `moderatePrompt imported by client file(s): ${offenders.join(", ")}`);
  });

  test("CREEM_API_KEY never appears in a NEXT_PUBLIC_ context", () => {
    const files = walk(join(ROOT, "src"));
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/NEXT_PUBLIC_[A-Z_]*CREEM_API_KEY|NEXT_PUBLIC_CREEM/.test(src)) offenders.push(f);
    }
    assert(offenders.length === 0, `NEXT_PUBLIC Creem key reference(s): ${offenders.join(", ")}`);
  });

  test("moderatePrompt.ts does not read NEXT_PUBLIC and reads CREEM_API_KEY server-side", () => {
    const mod = read("src/lib/server/creem/moderatePrompt.ts");
    assert(mod.includes("process.env.CREEM_API_KEY"), "reads CREEM_API_KEY");
    // Must never READ a NEXT_PUBLIC_ env (the comment naming it as forbidden is fine).
    assert(!/process\.env\.NEXT_PUBLIC/.test(mod), "moderatePrompt must not read a NEXT_PUBLIC env var");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
