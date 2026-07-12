/**
 * shopifyIntegration feature flag — gates the Shopify UI surface (Settings tab,
 * picker tab/source, StudioBoard entry, drawer chip). Launch/callback/webhooks
 * routes are NOT gated by this flag (Partner dashboard already locks those URLs
 * — §8.4 of the Phase 1 implementation plan).
 *
 * Resolution priority (structure copied from studioBoardFlag.ts):
 *   1. NEXT_PUBLIC_SHOPIFY_INTEGRATION === "true"  → on
 *   2. NEXT_PUBLIC_SHOPIFY_INTEGRATION === "false" → off
 *   3. localStorage `vp:shopify_integration` "1"/"0" (dev/local override, client-only)
 *   4. default                                       → off
 *
 * Steps 1–2 are a build-time-inlined public env var, so they resolve
 * SYNCHRONOUSLY on both the server render and the first client render — no
 * post-mount delay, no hydration mismatch. Steps 3–4 depend on localStorage and
 * are therefore client-only; they matter only when the env var is unset.
 */

export const SHOPIFY_INTEGRATION_KEY = "vp:shopify_integration";

/**
 * Env-only decision, safe during SSR and the first client render (build-time
 * inlined). Returns null when the env var is unset — i.e. the decision still
 * needs the client-only localStorage override (see resolveShopifyIntegrationFromClient).
 */
export function resolveShopifyIntegrationFromEnv(): boolean | null {
  if (process.env.NEXT_PUBLIC_SHOPIFY_INTEGRATION === "true") return true;
  if (process.env.NEXT_PUBLIC_SHOPIFY_INTEGRATION === "false") return false;
  return null;
}

/**
 * Client-only override, consulted ONLY when the env var is unset. Reads the
 * localStorage toggle, otherwise falls back to the default (off). Safe to call
 * on the server (returns the default).
 */
export function resolveShopifyIntegrationFromClient(): boolean {
  if (typeof window !== "undefined") {
    try {
      const local = window.localStorage.getItem(SHOPIFY_INTEGRATION_KEY);
      if (local === "1") return true;
      if (local === "0") return false;
    } catch {
      /* storage unavailable */
    }
  }
  return false;
}

/** Composed boolean form (identical semantics to the two resolvers above). */
export function isShopifyIntegrationEnabled(): boolean {
  const env = resolveShopifyIntegrationFromEnv();
  if (env !== null) return env;
  return resolveShopifyIntegrationFromClient();
}

/** Dev/local opt-in toggle (no effect when the env flag forces it on/off). */
export function setShopifyIntegrationOverride(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SHOPIFY_INTEGRATION_KEY, enabled ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}
