// Pin format taxonomy + inference for Pin Ideas.
// Pin Ideas are classified by *visual format / content angle* (not niche),
// so the Pin Ideas page can lead with format filters instead of niche overload.

import { classifyDestination } from "@/lib/assetClassification";
import type { ViralPin } from "@/lib/supabase";

export type PinFormat =
  | "Close-up"
  | "Moodboard"
  | "Lifestyle"
  | "Text Overlay"
  | "Tutorial"
  | "Blog Style"
  | "Product Showcase"
  | "Quote"
  | "Before/After";

// Order matters — this is the primary filter row order shown in the UI.
export const PIN_FORMATS: PinFormat[] = [
  "Close-up",
  "Moodboard",
  "Lifestyle",
  "Text Overlay",
  "Tutorial",
  "Blog Style",
  "Product Showcase",
  "Quote",
  "Before/After",
];

export const PIN_FORMAT_META: Record<PinFormat, { color: string; hint: string }> = {
  "Close-up":         { color: "#D97706", hint: "Detail / macro shot" },
  "Moodboard":        { color: "#9333EA", hint: "Collage / palette / inspiration grid" },
  "Lifestyle":        { color: "#16A34A", hint: "In-context / styled scene" },
  "Text Overlay":     { color: "#DB2777", hint: "List / headline over image" },
  "Tutorial":         { color: "#EA580C", hint: "How-to / step-by-step / DIY" },
  "Blog Style":       { color: "#2563EB", hint: "Article / blog hero" },
  "Product Showcase": { color: "#C026D3", hint: "Single product hero" },
  "Quote":            { color: "#0D9488", hint: "Typographic quote / affirmation" },
  "Before/After":     { color: "#4F46E5", hint: "Transformation / makeover" },
};

type FormatInput = Pick<ViralPin, "title" | "description" | "category"> & {
  outbound_link?: string | null;
  source_url?: string | null;
};

function domainOf(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Label shown on cards. "Visual" is the low-confidence fallback (not a filter chip)
// so we never assert a confident "Close-up" classification we don't actually have.
export type PinFormatLabel = PinFormat | "Visual";

/**
 * Heuristically infer the visual format / content angle of a pin from its
 * title, description, category and destination. Returns a confident format
 * when signals exist, otherwise the neutral "Visual" fallback.
 */
export function inferPinFormat(pin: FormatInput): PinFormatLabel {
  const text = `${pin.title ?? ""} ${pin.description ?? ""} ${pin.category ?? ""}`.toLowerCase();
  const dest = `${pin.outbound_link ?? ""} ${pin.source_url ?? ""}`.toLowerCase();

  if (/before\s*(?:&|and|\/|\s)\s*after|transformation|makeover|glow[ -]?up|reno(?:vation)?/.test(text))
    return "Before/After";
  if (/(?:^|\s)["“”]|quote|saying|affirmation|mantra|words to live/.test(text))
    return "Quote";
  if (/how[ -]?to|tutorial|step[- ]by[- ]step|\bdiy\b|recipe|\bguide\b/.test(text) || /youtube|youtu\.be|vimeo/.test(dest))
    return "Tutorial";
  if (/\bblog\b|article|read more|on the blog|the post\b/.test(text))
    return "Blog Style";
  if (/\b\d+\s+(?:ideas|ways|things|tips|steps|reasons|habits|must)\b|checklist|listicle/.test(text))
    return "Text Overlay";
  if (/mood\s?board|inspo\b|inspiration|palette|color scheme|colour scheme|collage|vision board/.test(text))
    return "Moodboard";
  if (/\bproduct\b|\bshop\b|\bbuy\b|review|collection|favorite|favourite|haul|wishlist/.test(text))
    return "Product Showcase";
  if (/\broom\b|\bhome\b|outfit|styled|in use|lifestyle|setup|flat\s?lay|in my|my home|my room|tablescape|styling/.test(text))
    return "Lifestyle";
  // Genuine close-up subjects (macro detail) — keep as Close-up.
  if (/\bnails?\b|manicure|\bring\b|jewel|earring|necklace|bracelet|makeup|\blips?\b|eyeshadow|swatch|macro|close[- ]?up|detail shot/.test(text))
    return "Close-up";

  return "Visual";
}

/**
 * True when a pin's destination is actually a sellable product / offer
 * (Etsy/Amazon/Shopify listing, priced download, etc.) rather than a
 * content idea. Such items belong in Product Ideas, not Pin Ideas.
 *
 * Conservative by design: content-style pins ("10 home decor ideas",
 * tutorials, blog posts) classify as articles/content and stay in Pin Ideas,
 * even when they link to a shop.
 */
export function isSellableProductPin(
  pin: FormatInput & { is_ecommerce?: boolean | null },
): boolean {
  const c = classifyDestination({
    title: pin.title,
    description: pin.description,
    domain: domainOf(pin.outbound_link ?? pin.source_url),
    sourceUrl: pin.source_url,
    destinationUrl: pin.outbound_link,
    category: pin.category,
    source: "viral_pin",
    hasCommerceSignals: pin.is_ecommerce ? true : undefined,
  });
  return c.item_type === "product" || c.item_type === "product_collection";
}
