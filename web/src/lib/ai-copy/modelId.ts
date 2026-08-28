/**
 * modelId.ts — the ONE shared contract for "is this string even a plausible AI
 * model identifier" (Codex round 4, Fix 3).
 *
 * Deliberately NOT an allow-list of approved model names. Which model IDs are
 * semantically valid is the provider's call at request time, not ours to guess or
 * hardcode here — a real, currently-unsupported model id must still reach the
 * provider and come back as a provider error (chatJson/analyzeImageStructured wrap
 * that into a CopyError), never silently substituted or silently accepted. What
 * THIS module rejects is the narrower, purely-syntactic class of value that could
 * never be a real model id in the first place — blank, containing whitespace, or
 * absurdly long — the kind of value that only shows up from a misconfigured env
 * var (a pasted-in description, an empty string, a multi-line secret dropped into
 * the wrong slot), not from ever pointing at a real provider model.
 *
 * Used by:
 *   - visionServer.ts's `providerConfig()` — production: blank OR implausible
 *     `AI_COPY_TEXT_MODEL` both take the existing fail-closed `ai_copy_model_unset`
 *     path; non-production: an implausible value falls back to the hardcoded
 *     default (logged as `ai_copy_model_implausible`) instead of being handed to
 *     the provider as-is.
 *   - predeploy-guard.mjs's check 8 — an implausible `AI_COPY_TEXT_MODEL` fails the
 *     production deploy gate with a clear message, same as a blank one already did.
 *     That file is deliberately dependency-free (Node built-ins only, no TS
 *     imports), so it duplicates this regex verbatim rather than importing this
 *     module — this file stays the source of truth; keep the two in sync.
 */

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MODEL_ID_MAX_LENGTH = 120;

/**
 * True only for a non-empty string, with no whitespace anywhere, at most 120
 * characters, starting with an alphanumeric character and containing only
 * alphanumerics plus `. _ : / -` after that — permissive enough for every real
 * provider's naming convention (`gpt-4o-mini`, `gemini-2.5-flash`,
 * `openai/gpt-4o-mini:latest`) while rejecting the syntactically-impossible.
 */
export function isPlausibleModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MODEL_ID_MAX_LENGTH) return false;
  if (/\s/.test(value)) return false;
  return MODEL_ID_PATTERN.test(value);
}
