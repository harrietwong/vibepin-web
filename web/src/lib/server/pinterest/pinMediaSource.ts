/**
 * Builds the `media_source` half of a Pinterest v5 POST /pins body.
 *
 * Deliberately import-free so the request shape can be unit-tested without a
 * Supabase client, an env var, or a network stub — service.ts (which owns the HTTP
 * call) pulls connectionStore and config, and neither belongs in a shape test.
 *
 * Two shapes, chosen by how many images the Pin carries (Pinterest v5):
 *   1 image   { source_type: "image_url", url }
 *   2–5       { source_type: "multiple_image_urls", items: [{ url, title?, description?, link? }] }
 *
 * The per-item title/description/link repeat the Pin's own values: Pinterest gives
 * each carousel slide its own copy, and leaving them off would publish a carousel
 * whose slides carry no text or destination at all. Undefined keys are omitted
 * rather than sent as null — Pinterest validates the item object strictly.
 *
 * COUNT IS NOT VALIDATED HERE. `checkPinterestMedia` (lib/publish/mediaRules) owns
 * that and runs before this, so an over-long set is refused with a customer-safe
 * message instead of being silently truncated. This builder therefore never drops
 * an image: whatever it is handed, it sends.
 */

export type PinMediaSource =
  | { source_type: "image_url"; url: string }
  | {
      source_type: "multiple_image_urls";
      items: Array<{ url: string; title?: string; description?: string; link?: string }>;
    };

export type PinMediaSourceInput = {
  /** The Pin's media in display order; index 0 is the cover. */
  imageUrls: readonly string[];
  title?: string;
  description?: string;
  link?: string;
};

/** Trimmed value, or undefined when empty — so the key is omitted, never sent blank. */
function defined(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
}

/**
 * Build the media_source for a Pin. Throws on an empty list: a Pin with no image
 * is not publishable, and inventing one would be worse than failing loudly (the
 * callers all validate the URLs before reaching here).
 */
export function buildPinMediaSource(input: PinMediaSourceInput): PinMediaSource {
  const urls = (input.imageUrls ?? []).filter(u => typeof u === "string" && u.trim().length > 0).map(u => u.trim());
  if (urls.length === 0) {
    throw new Error("buildPinMediaSource requires at least one image URL");
  }
  if (urls.length === 1) {
    return { source_type: "image_url", url: urls[0] };
  }

  const title = defined(input.title);
  const description = defined(input.description);
  const link = defined(input.link);
  return {
    source_type: "multiple_image_urls",
    items: urls.map(url => ({
      url,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(link ? { link } : {}),
    })),
  };
}
