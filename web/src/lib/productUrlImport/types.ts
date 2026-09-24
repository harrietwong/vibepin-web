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
  | "amazon"
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
  /** Present only for Amazon links (text-only channel; never has image candidates). */
  amazon?:          AmazonImportMeta;
};

/**
 * Why an Amazon fetch did not yield product text. The card branches on these to show
 * manual entry. None of them consumes quota (the import route is not metered) and
 * none of them touches the user's fields.
 */
export type AmazonFetchFailReason =
  | "bot_check"                // HTTP 200 but a captcha / "Continue shopping" page
  | "http_error"               // non-2xx from Amazon (e.g. 404, 503)
  | "timeout"
  | "network_error"
  | "off_allowlist"            // a redirect left the Amazon whitelist; not followed
  | "too_many_redirects"
  | "no_product_fields"        // page fetched but neither a title nor bullets found
  | "short_link_unexpanded"    // amzn.to / a.co could not be expanded to a retail URL
  | "unsupported_marketplace"  // recognised Amazon site we do not fetch (e.g. amazon.nl)
  | "not_product_page";        // retail link without an ASIN (search / store page); not fetched

export type AmazonImportMeta = {
  /** ok = retail link with ASIN; no_asin = search/store page; short_unexpanded = short link not expanded. */
  linkStatus:    "ok" | "no_asin" | "short_unexpanded";
  host:          string;
  marketplace:   string | null;
  asin:          string | null;
  /** The original short link, when the pasted URL was amzn.to / a.co. */
  expandedFrom?: string;
  fetch: {
    status:      "ok" | "blocked" | "failed";
    reason?:     AmazonFetchFailReason;
    /** Upstream HTTP status for http_error. */
    httpStatus?: number;
  };
  /** Text only. Price, availability, rating and images are never extracted. */
  extracted?: { title?: string; bullets?: string[]; brand?: string };
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
