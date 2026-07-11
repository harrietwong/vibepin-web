import type { PinterestBoard } from "@/lib/pinterestClient";
import type { SetupSnapshot } from "@/lib/studioPersistence";
import type { LanguageCode } from "@/lib/i18n/config";
import type { PinMetadataDraft } from "@/lib/pinMetadata";

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
