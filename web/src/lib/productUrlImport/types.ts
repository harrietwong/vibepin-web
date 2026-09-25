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
  /**
   * Structured product facts (price / brand / availability / description) for
   * independent-store pages (FR-01/FR-02). Never present for the Amazon channel
   * (see `amazon.extracted`, which is text-only and has no price semantics).
   * Absent on failure — never a shell of empty-string fields.
   */
  facts?:            ProductFacts;
};

/**
 * Structured facts extracted from a single already-fetched page response — never a
 * new outbound request. Every field is filled only when the page states it
 * explicitly; nothing here is inferred (no price guesses, no brand-from-image).
 */
export type ProductFactsSource = "shopify_json" | "jsonld" | "woocommerce" | "og_meta" | "manual";

export type ProductFactsPrice = {
  amount:     string;
  currency:   string;
  compareAt?: string;
};

export type ProductFactsAvailability = "in_stock" | "out_of_stock" | "preorder" | "unknown";

export type ProductFacts = {
  title?:        string;
  /** Cleaned plain text, HTML stripped, whitespace collapsed, capped at 1000 chars. */
  description?:  string;
  /** JSON-LD `brand.name` / Shopify `vendor`. */
  brand?:        string;
  price?:        ProductFactsPrice;
  availability?: ProductFactsAvailability;
  /** Same images as `candidates`, capped at 8. Filled by the orchestrator after finalizeCandidates. */
  images?:       string[];
  /** Normalized page URL. */
  sourceUrl:     string;
  /** ISO timestamp of when the facts were extracted. */
  fetchedAt:     string;
  source:        ProductFactsSource;
  /** "partial" whenever price or brand is missing. */
  completeness:  "full" | "partial";
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
  /** Facts without `images` filled yet — the orchestrator fills `images` from the finalized candidate list. */
  facts?:           ProductFacts;
};

/** Injectable page fetcher; default implementation is in urlImportService.ts */
export type PageFetcher = (url: string) => Promise<{ html: string; finalUrl: string }>;
