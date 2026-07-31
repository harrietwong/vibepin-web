/**
 * aiCostRates.ts — internal provider pricing constants for ai_cost_events
 * cost estimation (PRD "定价方案 credit 方案 0723", §9).
 *
 * HARD RULE: every value below MUST be a verified, current provider price
 * before it is filled in. Do NOT guess or backfill a plausible-looking
 * number — an unverified price silently corrupts the cost-analytics ledger.
 * All rates default to `null` (unknown). `estimateCost` in aiCostLog.ts
 * returns `null` whenever the relevant rate is missing; token/image counts
 * are always recorded regardless of whether a $ estimate can be computed.
 *
 * Units:
 *  - textPerMillionInputTokens / textPerMillionOutputTokens: USD per 1,000,000
 *    tokens (the provider's usual per-1M-token pricing unit).
 *  - perImage: USD per generated image (flat per-image price; providers that
 *    price by resolution/tier should key this by a resolution-qualified
 *    model id, e.g. "gemini-3.1-flash-image-preview:1024x1024", once verified).
 *
 * TODO(product): fill in verified prices per model below. Until then every
 * estimateCost() call returns null and only raw usage (tokens/images) is
 * recorded — this is the intended, safe default.
 */

export type ModelRate = {
  /** USD per 1,000,000 input tokens. null = unverified/unknown. */
  textPerMillionInputTokens: number | null;
  /** USD per 1,000,000 output tokens. null = unverified/unknown. */
  textPerMillionOutputTokens: number | null;
  /** USD per generated image. null = unverified/unknown. */
  perImage: number | null;
};

const UNVERIFIED: ModelRate = {
  textPerMillionInputTokens: null,
  textPerMillionOutputTokens: null,
  perImage: null,
};

/**
 * Rates keyed by exact model id (as sent to the provider, e.g.
 * "gemini-2.5-flash", "gpt-4o-mini", "gemini-3.1-flash-image-preview").
 * Add a new entry per model as prices are verified — never edit UNVERIFIED.
 *
 * TODO(product): verify and fill in real per-model pricing here.
 */
export const AI_MODEL_RATES: Record<string, ModelRate> = {
  // TODO(product): "gemini-2.5-flash": { textPerMillionInputTokens: null, textPerMillionOutputTokens: null, perImage: null },
  // TODO(product): "gpt-4o-mini": { textPerMillionInputTokens: null, textPerMillionOutputTokens: null, perImage: null },
  // TODO(product): "gemini-3.1-flash-image-preview": { textPerMillionInputTokens: null, textPerMillionOutputTokens: null, perImage: null },
};

/** Rate lookup for an exact model id. Returns the all-null UNVERIFIED rate for any unknown model. */
export function rateForModel(model: string | null | undefined): ModelRate {
  if (!model) return UNVERIFIED;
  return AI_MODEL_RATES[model] ?? UNVERIFIED;
}
