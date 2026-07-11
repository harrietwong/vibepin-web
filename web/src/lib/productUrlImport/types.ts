export type CandidateReason =
  | "direct_image_url"
  | "jsonld_product_image"
  | "og_image"
  | "twitter_image"
  | "shopify_product_json"
  | "shopify_html_fallback"
  | "woocommerce_gallery"
  | "etsy_metadata_fallback"
  | "pinterest_og"
  | "html_img_fallback";

export type Provider =
  | "direct_image"
  | "shopify"
  | "woocommerce"
  | "etsy"
  | "pinterest"
  | "generic"
  | "unknown";

export type AssetType = "product" | "reference";

/** Extended status — "failed" kept for backward compat */
export type ImportStatus = "success" | "partial" | "blocked" | "unsupported" | "error" | "failed";

export type ProductImageCandidate = {
  id:       string;
  imageUrl: string;
  width?:   number;
  height?:  number;
  score:    number;
  reason:   CandidateReason;
};

export type ProductUrlImportResult = {
  sourceUrl:        string;
  sourceDomain:     string;
  status:           ImportStatus;
  title?:           string;
  description?:     string;
  candidates?:      ProductImageCandidate[];
  error?:           string;
  // Provider-level enrichment (all optional for backward compat)
  originalUrl?:     string;
  normalizedUrl?:   string;
  provider?:        Provider;
  assetType?:       AssetType;
  message?:         string;
  fallbackActions?: string[];
  debugCode?:       string;
};

export type ProductUrlImportResponse = {
  results: ProductUrlImportResult[];
};

export type RawCandidate = {
  imageUrl: string;
  width?:   number;
  height?:  number;
  score:    number;
  reason:   CandidateReason;
};

/** Returned by each provider adapter before the orchestrator wraps it. */
export type AdapterResult = {
  status:           ImportStatus;
  title?:           string;
  description?:     string;
  candidates:       RawCandidate[];
  message?:         string;
  fallbackActions?: string[];
  debugCode?:       string;
};

/** Injectable page fetcher; default implementation is in urlImportService.ts */
export type PageFetcher = (url: string) => Promise<{ html: string; finalUrl: string }>;
