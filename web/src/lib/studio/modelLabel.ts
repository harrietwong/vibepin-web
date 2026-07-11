/**
 * modelLabel.ts — one canonical mapping from the image-model key to its display
 * label, plus a resolver that always prefers real generation metadata.
 *
 * The Create Pins selector, the generation request, the generation job snapshot,
 * and the rendered Pin card must all agree on the model. Historically a stale
 * hardcoded "GPT Image 2" string leaked into the card whenever a session was
 * rebuilt from history — this resolver ignores that legacy value and derives the
 * label from the snapshot's modelKey instead.
 */

export const MODEL_KEY_TO_LABEL: Record<string, string> = {
  gpt_image:    "GPT Image",
  gemini_image: "Gemini Image",
  nano_banana:  "Gemini Image", // legacy key → same provider, shown as Gemini Image
};

/** MVP default provider label (used only when no real metadata is available). */
export const DEFAULT_MODEL_LABEL = "Gemini Image";

/** Legacy/invalid label that must never be shown — it was a hardcoded placeholder. */
const STALE_MODEL_LABEL = "GPT Image 2";

/**
 * Resolve the display label from the real generation metadata:
 *   1. a valid stored display `model` (ignoring the stale "GPT Image 2"),
 *   2. else the `modelKey` mapped to a label,
 *   3. else the MVP default.
 */
export function resolveModelLabel(model?: string | null, modelKey?: string | null): string {
  const m = (model ?? "").trim();
  if (m && m !== STALE_MODEL_LABEL) return m;
  const key = (modelKey ?? "").trim();
  if (key && MODEL_KEY_TO_LABEL[key]) return MODEL_KEY_TO_LABEL[key];
  return DEFAULT_MODEL_LABEL;
}
