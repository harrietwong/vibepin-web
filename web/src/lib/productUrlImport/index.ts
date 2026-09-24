// Types
export type {
  AdapterResult,
  AssetType,
  CandidateReason,
  ImportStatus,
  PageFetcher,
  ProductImageCandidate,
  ProductUrlImportResponse,
  ProductUrlImportResult,
  Provider,
  RawCandidate,
} from "./types";

// Security
export {
  isBlockedMarketplace,
  isDirectImageUrl,
  sourceDomainFromUrl,
  validateAmazonUrl,
  validateImportUrl,
} from "./urlSecurity";
export type { AmazonUrlValidation } from "./urlSecurity";
export { expandAmazonShortLink, AMAZON_SHORT_LINK_MAX_HOPS } from "./amazonShortLink";
export type { AmazonShortLinkExpansion, ShortLinkFetch } from "./amazonShortLink";

// HTML extraction utilities (used by tests + external callers)
export {
  candidateId,
  extractCandidatesFromHtml,
  finalizeCandidates,
  toProductCandidates,
} from "./extractFromHtml";

// Legacy extraction API (backward compat)
export {
  extractProductImagesFromUrl,
  importProductUrls,
  FETCH_TIMEOUT_MS,
  MAX_REDIRECTS,
} from "./extractProductUrls";

// New service
export { importUrl, defaultPageFetcher } from "./urlImportService";
