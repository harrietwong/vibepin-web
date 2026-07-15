// Type definitions for Creative Intelligence (Phase B) reference scoring.
//
// The deterministic scoring logic (rankReferences, scoreReference, pattern-tag
// derivation, etc.) that ranks pin_samples reference candidates by relevance-first
// then popularity ships with the CI cluster commit — this RC0 snapshot carries no
// runtime scoring logic, only the shapes that product components need for
// `import type`:
//   - AiVersionDrawer.tsx        → ReferenceRecommendation, InspirationPatternTags
//   - hiddenPromptBuilder.ts     → InspirationPatternTags
//
// ── Compliance (PRD v0.2 §4) ────────────────────────────────────────────────────
// This module NEVER emits the reference image as a generation input. Recommendations
// only rank, produce a plain-language `reason`, expose the source linkback
// (pinterest_url / source_url), and derive structured *pattern tags* (visual_format /
// composition / human_presence / text_overlay + scene/style words) that callers may
// inject into a prompt as TEXT. It never surfaces internal scores or classifier
// confidence.

// ── Public shapes ────────────────────────────────────────────────────────────────

/**
 * Derived, prompt-safe pattern tags for a selected reference. Structured TEXT only —
 * this is what may be woven into a hidden prompt. It carries NO image URL.
 */
export type InspirationPatternTags = {
  visualFormat?: string;
  compositionType?: string;
  humanPresence?: string;
  textOverlayLevel?: string;
  sceneStyleWords?: string[];
};

/** Display-safe recommended reference returned to the client. No internal scores. */
export type ReferenceRecommendation = {
  id: string;
  imageUrl: string;
  title: string;
  category: string;              // humanized label (e.g. "Home decor")
  /** One plain-language sentence; whitelisted phrases only, never a fabricated metric. */
  reason: string;
  /** Provenance is always Pinterest — the UI must label + linkback. */
  source: "pinterest";
  sourceUrl: string | null;
  pinterestUrl: string | null;
  /** Derived mode tags for prompt injection (no image data). */
  patternTags: InspirationPatternTags;
};
