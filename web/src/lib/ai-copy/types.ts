import type { PinterestBoard } from "@/lib/pinterestClient";
import type { SetupSnapshot } from "@/lib/studioPersistence";
import type { LanguageCode } from "@/lib/i18n/config";
import type { PinMetadataDraft } from "@/lib/pinMetadata";
import type { FactSummaryItem, KeywordProvenance, ValidationReport } from "./v2/types";

export type AICopyV2Evidence = {
  facts: FactSummaryItem[];
  primaryKeyword?: { id: string; phrase: string; provenance: KeywordProvenance; label: string };
  selectedKeywords: Array<{ id: string; phrase: string; provenance: KeywordProvenance; label: string }>;
  degradedMode: "none" | "no_keyword_demand_data" | "video_cover_unavailable";
  mediaEvidenceMode?: "image" | "video_cover";
  validationReport: ValidationReport;
};

export type CopyStrategy = "default" | "regenerate";

/**
 * Copy length preference surfaced by PinAICopyPanel (PRD 6.3):
 *   short    → title ≤50,  description ≤180
 *   standard → title ≤80,  description ≤300 (default)
 *   seo-rich → title ≤100, description ≤500 (natural keywords, never stuffed)
 * ("detailed" is the legacy wire value for seo-rich; the API normalizes it.)
 */
export type PinCopyLength = "short" | "standard" | "seo-rich";

/** Cached upload-time image analysis, when a caller wants to pass it explicitly. */
export type CachedImageAnalysis = {
  imageSummary: string;
  visibleObjects: string[];
  colors: string[];
  style: string;
  ocrText: string;
  category: string;
};

export type ImageContext = {
  primarySubject?: string;
  primarySubjects?: string[];
  scene?: string;
  attributes: string[];
  colors?: string[];
  style: string[];
  detectedText?: string[];
  visibleText?: string[];
  source: "cached" | "heuristic" | "unavailable";
};

export type PageContext = {
  pageTitle?: string;
  pageDescription?: string;
  domain?: string;
  source: "cached" | "url" | "none";
};

export type ProductContext = {
  title?: string;
  category?: string;
  productUrl?: string;
  attributes?: string[];
  source?: string;
  // ── Shopify-only grounding fields (WP6, §3.7.1) ────────────────────────────
  // Populated only when the primary linked product's source is "shopify" and the
  // draft snapshot actually carries the field; never fabricated when absent.
  vendor?: string;
  /** Up to 10 tags. */
  tags?: string[];
  /** Display-formatted, e.g. "USD 19.99" — currency already folded in. */
  price?: string;
  availability?: string;
  // ── User-declared structured facts (Amazon manual entry, design §3.2) ─────
  // Mapped server-side exactly like the Shopify commercial fields
  // (product_material / product_quantity, product_catalog + asserted).
  material?: string;
  /** Size / quantity, e.g. "40 oz". */
  quantity?: string;
};

export type BoardContext = {
  boardId?: string;
  boardName?: string;
  boardDescription?: string;
};

export type KeywordContext = {
  terms: string[];
  source: "cached" | "heuristic" | "none";
};

export type CopyContextBundle = {
  image?: ImageContext;
  product?: ProductContext;
  page?: PageContext;
  board?: BoardContext;
  keywords: KeywordContext;
  /** High-search Pinterest keywords recommended for this Pin (NOT trend data). */
  recommendedKeywords?: string[];
  imageSummary?: string;
  boardName?: string | null;
  trendContext?: Array<{ term: string; signal?: string; source?: string }>;
  contextSourcesUsed: string[];
  contextSummary: string;
  contextDetails: string[];
  timingsMs: Record<string, number>;
  requestId?: string;
  provider?: string;
  model?: string;
  fallbackUsed?: boolean;
  promptContext?: unknown;
  /** Present only when NEXT_PUBLIC_AI_COPY_V2=true. */
  aiCopyV2?: AICopyV2Evidence;
};

/**
 * Lean, store-independent input so the same helper powers Create Pins, the Plan
 * single-pin modal, and Batch Edit. When imageAnalysis/mode/previousCopy are omitted,
 * the helper resolves them from pinDraftStore (by draftId, then imageUrl) — preserving
 * the Create Pins fast-path behavior — and otherwise uses the vision fallback.
 */
export type GeneratePinterestPinCopyInput = {
  draftId: string;
  imageUrl: string;
  title?: string;
  description?: string;
  boardId?: string;
  boardName?: string;
  category?: string;
  keyword?: string;
  destinationUrl?: string;
  setupSnapshot?: SetupSnapshot;
  promptSnapshot?: string;
  opportunity?: string;
  /** Explicit cached analysis; if omitted the helper reads pinDraftStore. */
  imageAnalysis?: CachedImageAnalysis | null;
  recommendedKeywords?: string[];
  /** Force initial/regenerate; if omitted the helper derives it from prior copy meta. */
  mode?: "initial" | "regenerate";
  previousCopy?: { title?: string; description?: string };
  boards?: PinterestBoard[];
  language: LanguageCode;
  country?: string;
  length?: PinCopyLength;
  onStage?: (stage: "analyzing" | "generating" | "checking") => void;
};

export type GeneratePinterestPinCopyResult = {
  metadataDraft: PinMetadataDraft;
  fields: {
    title: string;
    description: string;
    altText: string;
    destinationUrl: string;
  };
  tags: string[];
  strategy: CopyStrategy;
  context: CopyContextBundle;
};
