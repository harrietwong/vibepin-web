/**
 * imageModelKey.ts — the ONE canonical contract for the client-supplied image
 * model key, shared by the route and its tests.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
 * `/api/generate` used to take `model_key` straight off the request body with no
 * whitelist at all (`String(body.model_key ?? "gemini_image")`) and forward it to
 * both dispatch branches. On the Python side `generator.py::_resolve_model_id`
 * ended with:
 *
 *     return GPT_IMAGE_MODEL or "gpt-image-2"
 *
 * i.e. ANY unrecognised string silently resolved to a specific PAID model. That is
 * two defects in one:
 *   1. COST — an arbitrary client value picks which provider the account is billed
 *      for, and the unknown-key path always landed on the GPT Image branch.
 *   2. CAPABILITY — `_model_supports_image_input` branches on the RESOLVED model
 *      id, so the key does not merely change price, it changes what the request is
 *      allowed to do with product/reference image inputs.
 *
 * The fix is a closed set validated at the HTTP trust boundary. An unknown value is
 * REFUSED (400), never coerced: silently mapping garbage onto a valid paid model is
 * exactly the behaviour being removed, and doing it in TypeScript instead of Python
 * would only move it.
 *
 * ── PRODUCT INVARIANTS (do not "improve" these) ────────────────────────────────
 * Every plan gets the SAME model choices. There is no premium model, no plan gate
 * and no per-model price: one successful image is one image allowance, flat,
 * whichever model produced it. This module is a TYPE/COST-SAFETY boundary only —
 * it must never grow entitlement logic.
 *
 * SERVER-SIDE module by convention (it lives under lib/server/ next to the other
 * trust-boundary helpers), but it holds no secrets and has no imports, so a client
 * bundle that pulled it in would leak nothing.
 */

/** The closed set of image model keys the product actually supports. */
export const CANONICAL_IMAGE_MODEL_KEYS = ["gemini_image", "gpt_image"] as const;

export type ImageModelKey = (typeof CANONICAL_IMAGE_MODEL_KEYS)[number];

/**
 * The documented default when `model_key` is absent from the request body.
 * Matches the Create Pins MVP default (studio/page.tsx `useState("gemini_image")`)
 * and generator.py's own `data.get("model_key") or "gemini_image"`.
 */
export const DEFAULT_IMAGE_MODEL_KEY: ImageModelKey = "gemini_image";

/**
 * ── LEGACY COMPATIBILITY ALIAS — DO NOT DELETE WITHOUT READING THIS ────────────
 * `nano_banana` was the original key for the Gemini image model and is still
 * present in three places that outlive any single deploy:
 *
 *   - `SetupSnapshot.modelKey` persisted in studio drafts (studioPersistence.ts,
 *     the field's own doc comment names "nano_banana") — historical local/DB
 *     drafts can still carry it, and Remix/Retry replay a snapshot's modelKey
 *     verbatim onto the wire;
 *   - `MODEL_KEY_TO_LABEL` in lib/studio/modelLabel.ts, which maps it to the
 *     "Gemini Image" label;
 *   - `_MODEL_KEY_TO_MODEL_ID` in backend/generator.py, where it is already
 *     commented "legacy alias" and points at the same Gemini model id.
 *
 * The Remix selector in PinDetailsDrawer.tsx has been changed to SEND
 * `gemini_image`, so nothing new is minted with this key. It is accepted here
 * purely so an OLD persisted draft keeps working, and it normalises immediately —
 * `gemini_image` is what leaves this module, so nothing downstream ever sees the
 * alias. Deleting this entry would 400 those historical drafts.
 *
 * This is an ALIAS, not a third model: it does not widen the closed set, and it
 * resolves to a key that is already in it.
 */
export const LEGACY_IMAGE_MODEL_KEY_ALIASES: Readonly<Record<string, ImageModelKey>> = {
  nano_banana: "gemini_image",
};

export type ImageModelKeyValidation =
  | { ok: true; modelKey: ImageModelKey }
  | { ok: false; detail: string };

/**
 * Validate and normalise a client-supplied `model_key`.
 *
 *   absent / null / undefined / empty  → DEFAULT_IMAGE_MODEL_KEY (documented default)
 *   a canonical key                    → itself
 *   a legacy alias                     → its canonical key
 *   anything else (incl. non-strings)  → { ok: false } → the caller MUST 400
 *
 * Non-string inputs are rejected rather than stringified: `String(...)` is how the
 * unvalidated value reached the provider in the first place, and `{}` becoming
 * "[object Object]" becoming GPT Image is the precise bug being closed.
 */
export function validateImageModelKey(raw: unknown): ImageModelKeyValidation {
  if (raw === undefined || raw === null) return { ok: true, modelKey: DEFAULT_IMAGE_MODEL_KEY };

  if (typeof raw !== "string") {
    return { ok: false, detail: "model_key must be a string" };
  }

  const key = raw.trim();
  // An empty/whitespace-only value is treated as "not supplied" — the same shape as
  // the route's other optional string fields, and the previous `?? "gemini_image"`
  // default already admitted `""` on this path.
  if (!key) return { ok: true, modelKey: DEFAULT_IMAGE_MODEL_KEY };

  if ((CANONICAL_IMAGE_MODEL_KEYS as readonly string[]).includes(key)) {
    return { ok: true, modelKey: key as ImageModelKey };
  }

  const alias = LEGACY_IMAGE_MODEL_KEY_ALIASES[key];
  if (alias) return { ok: true, modelKey: alias };

  // Never coerce. The rejected value is NOT echoed back — it is attacker-controlled
  // free text and the caller renders `detail` into a user-facing message.
  return {
    ok: false,
    detail: `model_key must be one of: ${CANONICAL_IMAGE_MODEL_KEYS.join(", ")}`,
  };
}
