/**
 * Amazon channel orchestration for importUrl (design §1.6, §2).
 *
 * pasted link → parseAmazonLink → (short: expand, retail only) → whitelist gate →
 * fetchAmazonPage → bot check → text extraction.
 *
 * Contract for the card (design §2.3):
 *  - Every outcome is a ProductUrlImportResult with provider "amazon" and an
 *    `amazon` meta block; failures carry an enumerated `amazon.fetch.reason`.
 *  - Failures carry NO title/description at all (not empty strings), so a client
 *    merge can never blank the user's fields. `sourceUrl` is always the pasted link.
 *  - Never image candidates (Amazon images are not importable), never price /
 *    availability / rating.
 *  - Nothing here reserves or settles quota; the import route is not metered.
 */

import { parseAmazonLink, type AmazonRetailParse } from "@/lib/affiliate/amazonLink";
import { amazonAdapter } from "./adapters/amazon";
import { fetchAmazonPage } from "./amazonFetcher";
import { expandAmazonShortLink, type ShortLinkFetch } from "./amazonShortLink";
import type { AmazonFetchFailReason, AmazonImportMeta, ProductUrlImportResult } from "./types";
import { validateAmazonUrl } from "./urlSecurity";

export type AmazonImportOptions = {
  /** Injected network for tests; defaults to global fetch. Used for expansion and page fetch. */
  amazonFetch?: ShortLinkFetch;
};

const FALLBACK_ACTIONS = ["manual_entry"];

const FAILURE_MESSAGES: Record<AmazonFetchFailReason, string> = {
  bot_check:               "Amazon did not return the product page. Enter the product name and selling points manually.",
  http_error:              "Amazon did not return this product page. Check the link, or enter the product details manually.",
  timeout:                 "Amazon took too long to respond. Enter the product details manually or try again later.",
  network_error:           "Could not reach Amazon. Enter the product details manually or try again later.",
  off_allowlist:           "This link redirects outside Amazon, so it was not followed. Enter the product details manually.",
  too_many_redirects:      "This link redirected too many times. Enter the product details manually.",
  no_product_fields:       "No product details were found on this page. Enter the product name and selling points manually.",
  short_link_unexpanded:   "This short link could not be expanded. Paste the full Amazon product link, or enter the product details manually.",
  unsupported_marketplace: "Product details can't be fetched from this Amazon site. Enter the product details manually.",
  not_product_page:        "This is not an Amazon product page link. Paste a product link, or enter the product details manually.",
};

function sourceDomain(host: string): string {
  return host.replace(/^www\./, "");
}

function failure(
  pasted: string,
  meta: Omit<AmazonImportMeta, "fetch">,
  reason: AmazonFetchFailReason,
  normalizedUrl: string,
  httpStatus?: number,
): ProductUrlImportResult {
  const status = reason === "bot_check" ? "blocked" : "failed";
  return {
    originalUrl:     pasted,
    normalizedUrl,
    sourceUrl:       pasted,
    sourceDomain:    sourceDomain(meta.host),
    provider:        "amazon",
    assetType:       "product",
    status,
    candidates:      [],
    message:         FAILURE_MESSAGES[reason],
    fallbackActions: FALLBACK_ACTIONS,
    debugCode:       `amazon_${reason}`,
    error:           FAILURE_MESSAGES[reason],
    amazon: {
      ...meta,
      fetch: { status: status === "blocked" ? "blocked" : "failed", reason, ...(httpStatus ? { httpStatus } : {}) },
    },
  };
}

function retailMeta(p: AmazonRetailParse, expandedFrom?: string): Omit<AmazonImportMeta, "fetch"> {
  return {
    linkStatus:  p.asin ? "ok" : "no_asin",
    host:        p.host,
    marketplace: p.marketplace,
    asin:        p.asin,
    ...(expandedFrom ? { expandedFrom } : {}),
  };
}

/** Returns null when `rawUrl` is not an Amazon retail/short link (caller uses the generic path). */
export async function importAmazonUrl(
  rawUrl: string,
  opts: AmazonImportOptions = {},
): Promise<ProductUrlImportResult | null> {
  const pasted = rawUrl.trim();
  const parsed = parseAmazonLink(pasted);
  if (!parsed.ok) return null;
  const fetchImpl = opts.amazonFetch;

  let retail: AmazonRetailParse;
  let expandedFrom: string | undefined;

  if (parsed.kind === "short") {
    const shortMeta = { linkStatus: "short_unexpanded" as const, host: parsed.host, marketplace: null, asin: null, expandedFrom: pasted };
    const expansion = await expandAmazonShortLink(parsed.shortUrl, fetchImpl);
    if (!expansion.ok) return failure(pasted, shortMeta, "short_link_unexpanded", pasted);
    const reparsed = parseAmazonLink(expansion.retailUrl);
    if (!reparsed.ok || reparsed.kind !== "retail") return failure(pasted, shortMeta, "short_link_unexpanded", pasted);
    retail = reparsed;
    expandedFrom = pasted;
  } else {
    retail = parsed;
  }

  const meta = retailMeta(retail, expandedFrom);
  // Search / store pages carry no product to describe — do not fetch them.
  if (!retail.asin) return failure(pasted, meta, "not_product_page", retail.normalizedUrl);
  // Fetch the tag-free canonical page: a server-side request must never hit the
  // user's affiliate link (it would register as a bot click on their tag).
  const target = validateAmazonUrl(`https://www.${retail.host}/dp/${retail.asin}`);
  if (!target.ok || target.kind !== "retail") {
    return failure(pasted, meta, "unsupported_marketplace", retail.normalizedUrl);
  }

  const page = await fetchAmazonPage(target.url.href, fetchImpl);
  if (!page.ok) return failure(pasted, meta, page.reason, retail.normalizedUrl, page.httpStatus);

  const extracted = amazonAdapter(page.html);
  if (extracted.status === "blocked" || extracted.status === "failed") {
    return failure(pasted, meta, extracted.reason, retail.normalizedUrl);
  }

  const fields: NonNullable<AmazonImportMeta["extracted"]> = {};
  if (extracted.title) fields.title = extracted.title;
  if (extracted.bullets.length) fields.bullets = extracted.bullets;
  if (extracted.brand) fields.brand = extracted.brand;

  return {
    originalUrl:   pasted,
    normalizedUrl: retail.normalizedUrl,
    sourceUrl:     pasted,
    sourceDomain:  sourceDomain(retail.host),
    provider:      "amazon",
    assetType:     "product",
    status:        extracted.status,
    ...(extracted.title ? { title: extracted.title } : {}),
    ...(extracted.bullets.length ? { description: extracted.bullets.join("\n") } : {}),
    candidates:    [],
    message:       "Product text imported from Amazon. Amazon images are not imported.",
    amazon: { ...meta, fetch: { status: "ok" }, extracted: fields },
  };
}
