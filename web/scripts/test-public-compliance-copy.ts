/**
 * Public-facing compliance copy tests.
 * Run: npx tsx scripts/test-public-compliance-copy.ts
 *
 * Pure file-content assertions (no server, no network). These lock down the
 * public claims a payment/compliance reviewer will read:
 *
 *   - No unproven marketing claims ("Used by creators…", "Real Pinterest teams",
 *     "Users are saving this heavily…" on the landing page). Each was a claim we
 *     cannot substantiate with data we actually hold, so each was replaced with a
 *     neutral capability statement.
 *   - No fabricated testimonials, star ratings, or user counts anywhere in src/.
 *   - The AUP states per-prompt moderation explicitly (every prompt is submitted
 *     to the moderation service) without promising the screening is exhaustive.
 *   - The Privacy Policy discloses that prompts and related user inputs go to a
 *     content-moderation service and then to a third-party AI provider.
 *   - The independent-product / no-AI-provider-affiliation statement is public.
 *   - Footer legal links are complete (Privacy, Terms, AUP, Refund).
 *   - /robots.txt allows crawling, references no sitemap (there is none), and
 *     does not block any public legal or marketing page.
 *
 * NOTE on scope: src/lib/scoring.ts contains similar "Users are saving this
 * heavily, but …" wording. That is an IN-APP interpretation of real per-keyword
 * metrics, not a landing-page marketing claim, so it is deliberately NOT covered
 * by the forbidden-string assertions below.
 */

export {};

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

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

/**
 * JSX wraps prose across source lines, so a sentence that reads as one string in
 * the browser is split by newlines + indentation in the file. Collapse runs of
 * whitespace before asserting on rendered copy.
 */
const flat = (s: string) => s.replace(/\s+/g, " ");

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

/** Every .ts/.tsx under src/, as [repo-relative path, contents]. */
function srcFiles(): Array<[string, string]> {
  return walk(join(ROOT, "src")).map(f => [
    relative(ROOT, f).replace(/\\/g, "/"),
    readFileSync(f, "utf8"),
  ]);
}

/** Landing-page marketing claims we cannot substantiate. */
const FORBIDDEN_CLAIMS = [
  "Used by creators, sellers and managers",
  "Real Pinterest teams",
  "Users are saving this heavily while commercial competition remains low.",
];

/** The neutral replacements that must be present instead. */
const REQUIRED_NEUTRAL = [
  { file: "src/components/landing/OpportunityIntelligence.tsx", text: "Built for creators, sellers and managers" },
  { file: "src/components/landing/OpportunityIntelligence.tsx", text: "Pinterest team workflows" },
  { file: "src/components/landing/IntelligenceInAction.tsx", text: "Similar Pins show strong save signals while commercial competition remains low." },
];

function main() {
  console.log("\nPublic compliance copy tests\n");

  const files = srcFiles();

  // ── 1. Unproven marketing claims ────────────────────────────────────────────

  test("the three unproven marketing claims are absent from src/", () => {
    for (const claim of FORBIDDEN_CLAIMS) {
      const hits = files.filter(([, src]) => src.includes(claim)).map(([p]) => p);
      assert(hits.length === 0, `forbidden claim ${JSON.stringify(claim)} still present in: ${hits.join(", ")}`);
    }
  });

  test("the neutral replacement strings are present", () => {
    for (const { file, text } of REQUIRED_NEUTRAL) {
      assert(flat(read(file)).includes(text), `${file} missing neutral string: ${JSON.stringify(text)}`);
    }
  });

  test("TESTIMONIALS_ENABLED is still false", () => {
    const data = read("src/lib/landing/conversionData.ts");
    assert(
      /export const TESTIMONIALS_ENABLED\s*=\s*false\s*;/.test(data),
      "TESTIMONIALS_ENABLED must remain false — no testimonial section may ship",
    );
  });

  test("no fabricated user counts, growth stats, or star ratings in src/", () => {
    // e.g. "10,000+ users", "trusted by 500 brands", "2x growth", "4.9/5", "rated 5 stars".
    // Deliberately narrow: each pattern needs marketing-claim context, because
    // "4/5" is also a Pin aspect ratio, "2/5" an upload counter, and "403
    // merchants" an HTTP status in a comment. Broad numeric matching here only
    // produced false positives.
    const patterns: Array<[string, RegExp]> = [
      ["user/customer count", /\b(?:over|more than|already|[0-9][0-9,.]*\s*(?:k|m|\+))\s*[0-9,.]*\s*(?:happy\s+)?(?:users|customers|brands|merchants|marketers|businesses|creators|sellers)\b/i],
      ["trusted-by claim", /\btrusted by\b/i],
      ["join-N claim", /\bjoin\s+[0-9][0-9,.]*\s*(?:k|m|\+)/i],
      ["multiplier growth claim", /\b[0-9]+(?:\.[0-9]+)?x\s+(?:growth|more|faster|traffic|revenue|saves)\b/i],
      ["star rating", /\b[0-9](?:\.[0-9])?\s*(?:out of\s*5|\/\s*5\s*stars?|stars?\s*(?:rating|review)|-star\b)/i],
      ["review-count claim", /\b[0-9][0-9,.]*\+?\s*(?:reviews|ratings|testimonials)\b/i],
    ];
    const offenders: string[] = [];
    for (const [path, src] of files) {
      // Admin-only surfaces are internal, never public marketing.
      if (path.startsWith("src/app/admin/") || path.startsWith("src/lib/server/")) continue;
      for (const [label, re] of patterns) {
        const m = src.match(re);
        if (m) offenders.push(`${path}: ${label} → ${JSON.stringify(m[0])}`);
      }
    }
    assert(offenders.length === 0, `possible fabricated metric claim(s):\n      ${offenders.join("\n      ")}`);
  });

  // ── 2. AUP moderation wording ───────────────────────────────────────────────

  const aup = read("src/app/acceptable-use-policy/page.tsx");
  const aupFlat = flat(aup);

  test("AUP states per-prompt moderation explicitly", () => {
    assert(
      aupFlat.includes(
        "Every user-submitted image-generation prompt is submitted to a content-moderation service before it is sent to an AI image-generation provider.",
      ),
      "AUP must state that every prompt is submitted to a content-moderation service",
    );
    assert(
      !aupFlat.includes("User-submitted prompts may be screened before they are sent to an AI image-generation provider."),
      "the old weak 'may be screened' wording must be gone",
    );
  });

  test("AUP does not claim moderation is guaranteed or exhaustive", () => {
    assert(
      aupFlat.includes("No screening system identifies every possible violation"),
      "AUP must disclaim exhaustive screening",
    );
    for (const overclaim of [/guarantee[sd]?\s+that\s+(?:all|every)/i, /catches all/i, /officially confirmed/i]) {
      assert(!overclaim.test(aup), `AUP must not over-claim moderation: ${overclaim}`);
    }
  });

  // ── 3. Privacy prompt-data disclosure ───────────────────────────────────────

  const privacy = read("src/app/privacy/page.tsx");
  const privacyFlat = flat(privacy);

  test("Privacy discloses prompt inputs sent to moderation + third-party AI", () => {
    assert(privacyFlat.includes("content-moderation"), "privacy mentions content moderation");
    assert(
      privacyFlat.includes(
        "Image-generation prompts and related user-controlled inputs may be transmitted to third-party content-moderation and artificial-intelligence service providers solely to screen requests and provide the requested generation features.",
      ),
      "privacy has the third-party transmission sentence",
    );
    assert(
      privacyFlat.includes("third-party AI image-generation service"),
      "privacy names the third-party AI image-generation step",
    );
    for (const input of ["keywords", "prompts", "creative direction", "category", "tags"]) {
      assert(privacyFlat.includes(input), `privacy enumerates processed input: ${input}`);
    }
  });

  test("Privacy makes no third-party retention promise and no never-retains claim", () => {
    assert(
      privacyFlat.includes(
        "We do not make any representation about how long a third-party moderation or AI provider retains request data.",
      ),
      "privacy must decline to promise a third-party retention period",
    );
    assert(!/never retain/i.test(privacyFlat), "privacy must not claim providers never retain data");
  });

  test("Privacy states API keys are never logged or exposed", () => {
    assert(
      privacyFlat.includes("never written to logs") && privacyFlat.includes("never exposed in client-side code"),
      "privacy must state credentials are never logged and never exposed client-side",
    );
  });

  // ── 4. Independent-product disclosure ───────────────────────────────────────

  test("independent-product / no-AI-affiliation statement is public", () => {
    const carriers = [aupFlat, privacyFlat].filter(src =>
      src.includes(
        "VibePin is an independent product that integrates third-party artificial-intelligence services. It is not affiliated with or endorsed by the providers of those AI models.",
      ),
    );
    assert(carriers.length >= 1, "the independent-product statement must appear on a public page");
    assert(carriers.length === 2, "expected the statement on BOTH the AUP and the Privacy page");
  });

  test("the Pinterest non-affiliation statement is intact", () => {
    const footer = flat(read("src/components/landing/conversion/LandingFooter.tsx"));
    assert(
      footer.includes("VibePin is not affiliated with or endorsed by Pinterest."),
      "footer Pinterest non-affiliation line must remain",
    );
    assert(
      privacyFlat.includes("VibePin is not endorsed by, sponsored by, or affiliated with Pinterest."),
      "privacy Pinterest non-affiliation line must remain",
    );
  });

  // ── 5. Footer legal links ───────────────────────────────────────────────────

  test("footer legal links are complete (Privacy, Terms, AUP, Refund)", () => {
    const footer = read("src/components/landing/conversion/LandingFooter.tsx");
    for (const [label, href] of [
      ["Privacy Policy", "/privacy"],
      ["Terms of Service", "/terms"],
      ["Acceptable Use Policy", "/acceptable-use-policy"],
      ["Refund Policy", "/refund-policy"],
    ]) {
      assert(footer.includes(label), `footer missing label: ${label}`);
      assert(footer.includes(`"${href}"`), `footer missing href: ${href}`);
    }
  });

  // ── 6. robots.txt ───────────────────────────────────────────────────────────

  test("app/robots.ts exists and uses the MetadataRoute.Robots convention", () => {
    assert(existsSync(join(ROOT, "src/app/robots.ts")), "src/app/robots.ts must exist");
    const robots = read("src/app/robots.ts");
    assert(/MetadataRoute\.Robots/.test(robots), "robots.ts must be typed as MetadataRoute.Robots");
    assert(/export default function robots\(/.test(robots), "robots.ts must default-export robots()");
  });

  test("robots allows / for all user agents", () => {
    const robots = read("src/app/robots.ts");
    assert(/userAgent:\s*"\*"/.test(robots), 'robots must target userAgent "*"');
    assert(/allow:\s*"\/"/.test(robots), 'robots must allow "/"');
  });

  test("robots references NO sitemap (this repo has none)", () => {
    const robots = read("src/app/robots.ts");
    assert(!/\bsitemap\s*:/i.test(robots), "robots must not emit a sitemap directive");
    const hasSitemapRoute =
      existsSync(join(ROOT, "src/app/sitemap.ts")) ||
      existsSync(join(ROOT, "src/app/sitemap.xml")) ||
      existsSync(join(ROOT, "public/sitemap.xml"));
    assert(!hasSitemapRoute, "a sitemap now exists — revisit the robots sitemap directive");
  });

  test("robots does not block any public marketing or legal page", () => {
    const robots = read("src/app/robots.ts");
    const disallow = robots.match(/disallow:\s*(\[[^\]]*\]|"[^"]*")/);
    assert(disallow, "robots must declare a disallow list");
    const blocked = (disallow![1].match(/"([^"]*)"/g) ?? []).map(s => s.replace(/"/g, ""));
    for (const path of ["/", "/pricing", "/terms", "/privacy", "/acceptable-use-policy", "/refund-policy"]) {
      for (const b of blocked) {
        assert(b !== "/", "robots must never disallow /");
        assert(!(b !== "/" && path.startsWith(b)), `robots blocks public page ${path} via ${b}`);
      }
    }
    assert(!/noindex/i.test(robots), "robots.ts must not emit noindex");
  });

  test("no public legal or marketing page carries a noindex robots directive", () => {
    for (const page of [
      "src/app/page.tsx",
      "src/app/pricing/page.tsx",
      "src/app/terms/page.tsx",
      "src/app/privacy/page.tsx",
      "src/app/acceptable-use-policy/page.tsx",
    ]) {
      if (!existsSync(join(ROOT, page))) continue;
      assert(!/noindex/i.test(read(page)), `${page} must not be noindex`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
