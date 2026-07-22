import type { Browser, Page } from "@playwright/test";

/**
 * Runtime probe for the server's billing posture (CREEM_MODE).
 *
 * `/pricing` is server-rendered with `billingEnabled = getBillingMode() !== "disabled"`
 * (see src/app/pricing/page.tsx). Tests cannot read the server's process.env, so
 * we detect the posture from what the page actually paints:
 *
 *   billing DISABLED → every paid tier renders a `disabled` button labelled
 *                      "Coming soon" (pricing-client.tsx PlanCards, and the same
 *                      treatment on the bottom "Start Pro" CTA).
 *   billing ENABLED  → paid tiers render an enabled button with the plan's real
 *                      CTA label ("Start Pro" for the Pro tier).
 *
 * The probe keys on the presence of an enabled paid CTA rather than on the
 * "Coming soon" text alone, so it stays correct if the copy is reworded but the
 * disabled state stays.
 *
 * The result is cached per process: the server's CREEM_MODE cannot change mid-run,
 * and probing once keeps the extra page load off every single test.
 */

export type BillingPosture = "enabled" | "disabled";

let cached: BillingPosture | null = null;

/** Locator for the Pro tier CTA in its ENABLED (billing on) form. */
export function proCtaLocator(page: Page) {
  return page.getByRole("button", { name: /^(Start Pro|Loading…)$/ }).first();
}

/** Locator for the paid-tier CTA in its DISABLED ("coming soon") form. */
export function comingSoonCtaLocator(page: Page) {
  return page.getByRole("button", { name: /^coming soon$/i }).first();
}

async function probe(page: Page): Promise<BillingPosture> {
  await page.goto("/pricing", { waitUntil: "networkidle" });

  // Whichever of the two mutually exclusive states paints first wins. Both are
  // server-rendered, so this resolves on the first paint — no hydration wait.
  const enabledCta = proCtaLocator(page);
  const disabledCta = comingSoonCtaLocator(page);

  const winner = await Promise.race([
    enabledCta.waitFor({ state: "visible", timeout: 20_000 }).then(() => "enabled" as const),
    disabledCta.waitFor({ state: "visible", timeout: 20_000 }).then(() => "disabled" as const),
  ]).catch(() => null);

  if (winner) return winner;

  throw new Error(
    "billing-posture probe failed: /pricing rendered neither an enabled paid CTA " +
      '("Start Pro") nor the disabled "Coming soon" button within 20s. Is the dev ' +
      "server up on the configured baseURL?",
  );
}

/**
 * Resolve the billing posture once per process, using a throwaway context so the
 * probe never pollutes the calling test's page/state.
 */
export async function getBillingPosture(browser: Browser): Promise<BillingPosture> {
  if (cached) return cached;
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    cached = await probe(page);
    return cached;
  } finally {
    await context.close();
  }
}

/** True when the server has checkout turned on (CREEM_MODE=test|live). */
export async function isBillingEnabled(browser: Browser): Promise<boolean> {
  return (await getBillingPosture(browser)) === "enabled";
}

export const BILLING_DISABLED_SKIP_REASON =
  'billing disabled (CREEM_MODE unset/disabled) — paid CTAs render as "Coming soon", ' +
  "there is no checkout flow to assert. Set CREEM_MODE=test in web/.env.local to run this.";
