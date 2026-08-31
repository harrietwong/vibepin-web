import crypto from "crypto";

/**
 * Canonical JSON for generation-intent fingerprints. Object key order must not turn
 * the same logical request into a different idempotency contract, while array order
 * remains significant (product/reference image order affects the generated result).
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter(key => object[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

/**
 * Server-side immutable request fingerprint. Only the digest is persisted; prompts,
 * URLs, product metadata and references never enter an idempotency lookup column or
 * log line. The slot count is included explicitly so a key cannot be reused to mask
 * a more expensive request.
 */
export function deriveGenerationIntentFingerprint(
  slotCount: number,
  params: Record<string, unknown>,
): string {
  const slots = Math.max(1, Math.floor(slotCount) || 1);
  return crypto
    .createHash("sha256")
    .update(canonicalJson({ slots, params }))
    .digest("hex");
}

export class GenerationIntentConflictError extends Error {
  constructor() {
    super("generation_intent_conflict");
    this.name = "GenerationIntentConflictError";
  }
}

export function isGenerationIntentConflict(error: unknown): boolean {
  return error instanceof GenerationIntentConflictError;
}
