/**
 * Explicit Creem billing mode — the production release guard.
 *
 * A test-mode Creem key must NEVER be able to open a real checkout on production.
 * `CREEM_MODE` makes the intended posture explicit and independent of which key
 * happens to be present:
 *
 *   disabled  (default when unset) — no checkout at all; paid buttons show
 *             "coming soon". Safe default so a half-configured deploy never
 *             charges anyone or 500s on a missing key.
 *   test      — sandbox billing (test-api.creem.io). Allowed in preview/local
 *             ONLY. On production this is a MISCONFIG — assertBillingModeUsable()
 *             throws (and predeploy-guard fails the deploy outright).
 *   live      — real billing (api.creem.io). Requires a full, non-test config.
 *
 * Server-only: reads process.env. NEVER import into client code.
 */

export type BillingMode = "disabled" | "test" | "live";

const VALID_MODES: readonly BillingMode[] = ["disabled", "test", "live"];

/** The six product env vars a live config must all provide. */
const REQUIRED_PRODUCT_ENVS = [
  "CREEM_PRODUCT_STARTER_MONTHLY",
  "CREEM_PRODUCT_STARTER_YEARLY",
  "CREEM_PRODUCT_PRO_MONTHLY",
  "CREEM_PRODUCT_PRO_YEARLY",
  "CREEM_PRODUCT_BUSINESS_MONTHLY",
  "CREEM_PRODUCT_BUSINESS_YEARLY",
] as const;

/**
 * True when the process is running in a PRODUCTION deploy. Vercel sets VERCEL_ENV
 * to "production" for prod deploys (the repo's canonical prod signal — see
 * pinterest/config.ts). As a belt-and-braces fallback, NODE_ENV==="production"
 * WITHOUT any VERCEL_ENV is also treated as prod so a non-Vercel prod host can't
 * slip a test key through.
 */
export function isProductionRuntime(): boolean {
  const vercelEnv = (process.env.VERCEL_ENV ?? "").trim().toLowerCase();
  if (vercelEnv) return vercelEnv === "production";
  return (process.env.NODE_ENV ?? "").trim().toLowerCase() === "production";
}

/** True when the configured Creem API key is a test-mode key (creem_test_…). */
export function isTestApiKey(apiKey: string): boolean {
  return apiKey.trim().startsWith("creem_test_");
}

/**
 * Read + validate the configured billing mode. An unset or unrecognized value
 * resolves to "disabled" (the safe default). Case-insensitive.
 */
export function getBillingMode(): BillingMode {
  const raw = (process.env.CREEM_MODE ?? "").trim().toLowerCase();
  return (VALID_MODES as readonly string[]).includes(raw)
    ? (raw as BillingMode)
    : "disabled";
}

export class BillingMisconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingMisconfiguredError";
  }
}

/**
 * Assert the current mode is USABLE for opening checkout in this runtime. Callers
 * that reach this point have already handled `disabled` (which is not an error —
 * it just means "no checkout"). Throws BillingMisconfiguredError on any dangerous
 * or incomplete configuration:
 *
 *   - prod + mode "test"      → a test key on production. HARD fail.
 *   - prod + mode "live" but the config is not a real live config (missing key,
 *     a test key, any missing product env, or missing webhook secret) → fail.
 *   - preview/local           → "test" and "live" both allowed; only the shape is
 *     checked for "live" so a broken live config still surfaces early.
 *
 * `disabled` never reaches here in the checkout path, but if called it is a no-op
 * (nothing to assert — there is no checkout to protect).
 */
export function assertBillingModeUsable(): void {
  const mode = getBillingMode();
  if (mode === "disabled") return;

  const prod = isProductionRuntime();
  const apiKey = (process.env.CREEM_API_KEY ?? "").trim();

  if (mode === "test") {
    if (prod) {
      throw new BillingMisconfiguredError(
        "CREEM_MODE=test on a production runtime — a test-mode Creem key must never open real checkout. Set CREEM_MODE=live (with a live key) or CREEM_MODE=disabled.",
      );
    }
    return; // preview/local test mode is fine
  }

  // mode === "live"
  if (!apiKey) {
    throw new BillingMisconfiguredError(
      "CREEM_MODE=live but CREEM_API_KEY is not set.",
    );
  }
  if (isTestApiKey(apiKey)) {
    throw new BillingMisconfiguredError(
      "CREEM_MODE=live but CREEM_API_KEY is a test key (creem_test_…). Use a live key.",
    );
  }
  const missingProducts = REQUIRED_PRODUCT_ENVS.filter(
    (name) => !(process.env[name] ?? "").trim(),
  );
  if (missingProducts.length > 0) {
    throw new BillingMisconfiguredError(
      `CREEM_MODE=live but missing product env(s): ${missingProducts.join(", ")}.`,
    );
  }
  if (!(process.env.CREEM_WEBHOOK_SECRET ?? "").trim()) {
    throw new BillingMisconfiguredError(
      "CREEM_MODE=live but CREEM_WEBHOOK_SECRET is not set.",
    );
  }
}
