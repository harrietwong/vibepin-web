/**
 * amazonCardImport.ts — one "get product details" run for an Amazon card.
 *
 * Calls the import route (T2's text-only Amazon channel), then merges the answer into
 * the card's CURRENT stored source (re-read after the await, so manual edits typed
 * while the request was in flight are never lost). It only ever persists
 * `amazonSource`; title / description / Website URL are not touched, and nothing here
 * reserves AI quota (the import route is not metered).
 */

import type { AmazonImportMeta } from "@/lib/productUrlImport/types";
import {
  applyAmazonImportError,
  applyAmazonImportResult,
  type AmazonCardSource,
} from "./amazonCardSource";

export type AmazonImportFn = (urls: string[]) => Promise<{
  results: Array<{ sourceUrl: string; normalizedUrl?: string; status?: string; amazon?: AmazonImportMeta }>;
}>;

export async function runAmazonCardImport(deps: {
  /** Fresh read of the card's stored source. */
  getSource: () => AmazonCardSource | undefined;
  persist: (next: AmazonCardSource) => void;
  importFn: AmazonImportFn;
}): Promise<AmazonCardSource | undefined> {
  const start = deps.getSource();
  if (!start) return undefined;
  let next: AmazonCardSource | undefined;
  try {
    const response = await deps.importFn([start.pastedUrl]);
    const result = response.results?.find(r => (r.sourceUrl ?? "").trim() === start.pastedUrl) ?? response.results?.[0];
    const fresh = deps.getSource();
    if (!fresh) return undefined;
    next = result ? applyAmazonImportResult(fresh, result) : applyAmazonImportError(fresh);
  } catch {
    const fresh = deps.getSource();
    if (!fresh) return undefined;
    // Only mark the failure on the link we asked about.
    next = fresh.pastedUrl === start.pastedUrl ? applyAmazonImportError(fresh) : fresh;
  }
  if (next !== deps.getSource()) deps.persist(next);
  return next;
}
