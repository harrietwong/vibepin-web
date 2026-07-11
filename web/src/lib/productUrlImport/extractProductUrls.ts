/**
 * Legacy entry-point — kept for backward compatibility and test imports.
 * The provider-based orchestration now lives in urlImportService.ts.
 */

import type { PageFetcher, ProductUrlImportResult } from "./types";
import { importUrl, defaultPageFetcher } from "./urlImportService";
import { validateImportUrl } from "./urlSecurity";
import { candidateId } from "./extractFromHtml";

export { defaultPageFetcher };
export { validateImportUrl };
export type { PageFetcher };

export const FETCH_TIMEOUT_MS   = 10_000;
export const MAX_REDIRECTS      = 3;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function extractProductImagesFromUrl(
  rawUrl: string,
  fetchPage: PageFetcher = defaultPageFetcher,
): Promise<ProductUrlImportResult> {
  return importUrl(rawUrl, fetchPage);
}

export async function importProductUrls(
  urls: string[],
  fetchPage: PageFetcher = defaultPageFetcher,
): Promise<ProductUrlImportResult[]> {
  const unique = [...new Set(urls.map(u => u.trim()).filter(Boolean))];
  return Promise.all(unique.map(url => extractProductImagesFromUrl(url, fetchPage)));
}

/** @internal test helper */
export { candidateId };
