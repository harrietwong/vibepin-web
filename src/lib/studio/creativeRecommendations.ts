// Creative Recommendation view-model (Create Pins UX).
//
// Wraps the internal creative directions into lightweight, user-facing chips.
// Normal UI shows ONLY `label`. Everything else (confidence, signals, internal
// direction id, hidden brief) is internal and only surfaced in developer mode.

import type { CreativeDirectionRecommendation } from "./creativeDirections";

export type CreativeRecommendation = {
  id: string;
  label: string;
  /** internal direction this chip maps to — drives the hidden prompt, never shown */
  internalDirectionId: string;
  shortInternalSummary?: string;
  confidence?: "high" | "medium" | "low";
  sourceSignals?: string[];
  hiddenBrief?: string;
};

// Friendly short chip labels for the titles the direction engine produces.
// Anything not mapped is shortened generically (suffixes like "portrait"/"Pin" removed).
const CHIP_LABEL_MAP: Record<string, string> = {
  // Fashion
  "Street-style outfit portrait": "Street-style outfit",
  "On-model outfit portrait": "Outfit portrait",
  "Creator-style mirror outfit Pin": "Mirror outfit",
  "Product-visible outfit editorial": "Outfit editorial",
  "Lifestyle lookbook": "Lifestyle lookbook",
  "Outfit flat lay": "Flat lay",
  "Lookbook editorial": "Lookbook editorial",
  "Mirror outfit shot": "Mirror outfit",
  // Home decor
  "Warm room styling": "Styled room",
  "Styled room scene": "Styled room scene",
  "Styled decor vignette": "Product-focused room",
  "Room moodboard": "Room moodboard",
  "Before & after": "Before & after",
  // Beauty
  "Beauty flat lay": "Beauty flat lay",
  "On-model beauty application": "On-model beauty",
  "Product + face composition": "Product + face",
  "Routine shelfie": "Beauty routine",
  "Glossy editorial": "Glossy editorial",
  "Beauty routine Pin": "Beauty routine",
  // Digital products
  "Device mockup": "Product preview",
  "Product mockup showcase": "Product preview",
  "Printable flat lay": "Page breakdown",
  "Template showcase": "Feature breakdown",
  "Benefit-led information Pin": "Benefit Pin",
  // DIY & crafts
  "Finished project hero": "Finished project",
  "Materials & supplies flat lay": "Materials flat lay",
  "Step-by-step tutorial": "Step-by-step",
  // Travel
  "Destination scene": "Destination scene",
  "Travel detail moment": "Travel detail",
  "Travel guide board": "Travel guide",
  // Food & drink
  "Styled tabletop": "Tabletop scene",
  "Recipe board": "Recipe board",
  "Food editorial": "Food editorial",
  // Generic
  "Editorial product story": "Editorial scene",
  "Visual inspiration board": "Inspiration board",
  "Lifestyle showcase": "Lifestyle scene",
};

function shorten(title: string): string {
  const out = title
    .replace(/creator-style\s*/i, "")
    .replace(/\b(portrait|pin|shot|image|composition|showcase|story)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return out || title;
}

/** User-facing chip label for a direction — concise, never internal jargon. */
export function toChipLabel(direction: CreativeDirectionRecommendation): string {
  return CHIP_LABEL_MAP[direction.title] ?? shorten(direction.title);
}

/** Map internal directions → lightweight recommendations (max 3). */
export function toCreativeRecommendations(
  directions: CreativeDirectionRecommendation[],
): CreativeRecommendation[] {
  return directions.slice(0, 3).map(d => ({
    id: d.id,
    label: toChipLabel(d),
    internalDirectionId: d.kind ?? d.id,
    shortInternalSummary: d.shortDescription ?? d.summary,
    confidence: d.confidence,
    sourceSignals: d.influencedBy,
    hiddenBrief: d.whyThisDirection,
  }));
}
