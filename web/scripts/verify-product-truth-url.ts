import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { chromium } from "playwright";

type TruthRule = {
  id: string;
  pattern: RegExp;
};

const RETIRED_OR_FABRICATED_CLAIMS: TruthRule[] = [
  { id: "numeric_opportunity_score", pattern: /opportunity score\s*(?::|=)?\s*\d{1,3}\b/i },
  { id: "competition_verdict", pattern: /\b(?:low|medium|high)\s+competition\b/i },
  { id: "commercial_competition", pattern: /commercial competition/i },
  { id: "fabricated_demand_delta", pattern: /[+\-−]\d+(?:\.\d+)?%\s+demand\b/i },
  { id: "fabricated_demand_window", pattern: /demand\s+vs\s+(?:the\s+)?last\s+30\s+days/i },
  { id: "fabricated_week_delta", pattern: /[+\-−]\d+(?:\.\d+)?%\s+this\s+week/i },
  { id: "fabricated_live_badge", pattern: /●\s*live\b/i },
  { id: "fabricated_high_save_inventory", pattern: /high-save pins/i },
  { id: "fabricated_product_inventory", pattern: /product signals discovered/i },
  { id: "product_demand_verdict", pattern: /product demand\s*(?::|=)?\s*(?:high|medium|low)\b/i },
  { id: "estimated_opportunity_verdict", pattern: /estimated opportunity\s*(?::|=)?\s*(?:high|medium|low)\b/i },
  { id: "fabricated_weekly_growth", pattern: /weekly growth\s*(?::|=)?\s*[+\-−]?\d+(?:\.\d+)?%/i },
];

const REQUIRED_TRUTH_BOUNDARIES: TruthRule[] = [
  {
    id: "auditable_product_evidence_copy",
    pattern: /real product pages? with auditable Pinterest evidence/i,
  },
];

export function findProductTruthViolations(renderedText: string): string[] {
  const text = renderedText.replace(/\s+/g, " ").trim();
  const violations = RETIRED_OR_FABRICATED_CLAIMS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ id }) => id);

  for (const { id, pattern } of REQUIRED_TRUTH_BOUNDARIES) {
    if (!pattern.test(text)) violations.push(`missing_${id}`);
  }

  return violations;
}

export function assertAllowedVerificationUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  const isReleaseHost = hostname === "vibepin.co" || hostname === "www.vibepin.co" || hostname.endsWith(".vercel.app");

  if ((!isLocal && url.protocol !== "https:") || (isLocal && !["http:", "https:"].includes(url.protocol))) {
    throw new Error("Verification URL must use HTTPS, except for localhost testing.");
  }
  if (!isLocal && !isReleaseHost) {
    throw new Error("Verification URL must be vibepin.co or a Vercel preview host.");
  }
  return url;
}

async function verifyUrl(rawUrl: string): Promise<void> {
  const url = assertAllowedVerificationUrl(rawUrl);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const response = await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (!response?.ok()) {
      throw new Error(`Page returned HTTP ${response?.status() ?? "unknown"}.`);
    }

    const body = page.locator("body");
    await body.waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(1_000);
    const renderedText = await body.innerText({ timeout: 10_000 });
    const violations = findProductTruthViolations(renderedText);
    if (violations.length > 0) {
      throw new Error(`Product truth verification failed: ${violations.join(", ")}`);
    }

    console.log(`Product truth live render: PASS (${url.origin})`);
  } finally {
    await browser.close();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: npm run verify:product-truth -- https://<preview-or-production-host>/");
    process.exitCode = 2;
  } else {
    verifyUrl(target).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
