import type { AssetType, PageFetcher, Provider, ProductUrlImportResult } from "./types";
import { isDirectImageUrl, sourceDomainFromUrl, validateImportUrl } from "./urlSecurity";
import { finalizeCandidates, toProductCandidates } from "./extractFromHtml";
import { mergeFacts, withFactsImages } from "./productFacts";
import { directImageAdapter } from "./adapters/directImage";
import { ETSY_BLOCKED_RESULT, etsyAdapter } from "./adapters/etsy";
import { PINTEREST_BLOCKED_RESULT, pinterestAdapter } from "./adapters/pinterest";
import { shopifyAdapter } from "./adapters/shopify";
import { woocommerceAdapter } from "./adapters/woocommerce";
import { genericProductAdapter } from "./adapters/genericProduct";
import { DEFAULT_HEADERS } from "./fetchHeaders";
import { classifyAmazonHost } from "@/lib/affiliate/amazonHosts";
import { importAmazonUrl, type AmazonImportOptions } from "./amazonImport";
import { hintsFromMarketplaceUrl, marketplaceImageCandidates } from "./marketplaceHosts";

export const FETCH_TIMEOUT_MS  = 10_000;
export const MAX_REDIRECTS     = 3;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;


export async function defaultPageFetcher(rawUrl: string): Promise<{ html: string; finalUrl: string }> {
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const validated = validateImportUrl(current);
    if (!validated.ok) throw new Error(validated.error);

    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

    try {
      const resp = await fetch(validated.url.toString(), {
        method:   "GET",
        redirect: "manual",
        signal:   ctrl.signal,
        headers:  DEFAULT_HEADERS,
      });

      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get("location");
        if (!location) throw new Error("Redirect without location header");
        current = new URL(location, validated.url).toString();
        continue;
      }

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const contentType = resp.headers.get("content-type") ?? "";
      if (contentType.includes("image/")) {
        return { html: "", finalUrl: validated.url.toString() };
      }

      const buf = await resp.arrayBuffer();
      if (buf.byteLength > MAX_RESPONSE_BYTES) throw new Error("Response too large");
      return {
        html:     new TextDecoder("utf-8", { fatal: false }).decode(buf),
        finalUrl: validated.url.toString(),
      };
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") throw new Error("Request timed out");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error("Too many redirects");
}

// ── Provider detection ──────────────────────────────────────────────────────

function detectUrlProvider(url: URL): Provider {
  if (isDirectImageUrl(url)) return "direct_image";
  // Defensive: Amazon links are routed to importAmazonUrl before this runs.
  if (classifyAmazonHost(url.hostname)) return "amazon";

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname;

  // Pinterest — covers all country TLDs (.com, .co.uk, .fr, .de, …) + pin.it short links
  if (host === "pin.it" || host === "pinterest.com" || host.startsWith("pinterest.")) {
    return "pinterest";
  }

  // Etsy — including country subdomains
  if (host === "etsy.com" || host.endsWith(".etsy.com")) return "etsy";

  // Shopify — myshopify.com stores or any store with /products/{handle}
  if (host.endsWith("myshopify.com") || /\/products\/[a-zA-Z0-9_-]+/i.test(path)) {
    return "shopify";
  }

  return "generic";
}

function isWooCommerceHtml(html: string): boolean {
  return /woocommerce-product-gallery|wc-product-image|class="[^"]*product_cat[^"]*"/i.test(html);
}

// ── Main orchestrator ───────────────────────────────────────────────────────

export async function importUrl(
  rawUrl: string,
  fetchPage: PageFetcher = defaultPageFetcher,
  opts: AmazonImportOptions = {},
): Promise<ProductUrlImportResult> {
  // ── Amazon channel first ─────────────────────────────────────────────────
  // The generic channel blocks every Amazon host, so Amazon links must branch off
  // BEFORE validateImportUrl. Text only, whitelist-validated on every hop.
  const amazonResult = await importAmazonUrl(rawUrl, opts);
  if (amazonResult) return amazonResult;

  const validated = validateImportUrl(rawUrl);
  if (!validated.ok) {
    // FR-04: Temu / Shein / AliExpress / TikTok Shop get a manual-entry fallback
    // instead of a plain failure. Zero network calls — this branches straight off
    // the pure hostname classification, before any fetch would have happened.
    if (validated.marketplace) {
      const trimmed = rawUrl.trim();
      let sourceDomain = "";
      let hintsUrl: URL | null = null;
      try {
        hintsUrl = new URL(trimmed);
        sourceDomain = sourceDomainFromUrl(hintsUrl);
      } catch { /* unreachable: validateImportUrl already parsed it */ }
      // 0925 follow-up: the pasted URL itself may carry a readable product-name slug
      // and (Temu only) a direct CDN image URL — read back from the URL the user
      // already had open, never fetched. Still zero network calls.
      const hints = hintsUrl ? hintsFromMarketplaceUrl(hintsUrl, validated.marketplace) : {};
      const candidates = hintsUrl ? toProductCandidates(finalizeCandidates(marketplaceImageCandidates(hints), trimmed)) : [];
      return {
        sourceUrl:       trimmed,
        sourceDomain,
        originalUrl:     trimmed,
        provider:        "marketplace_manual",
        assetType:       "product",
        status:          "unsupported",
        marketplace:     validated.marketplace,
        candidates,
        fallbackActions: ["manual_entry", "upload_image"],
        debugCode:       `marketplace_manual_${validated.marketplace}`,
        message:         "This marketplace does not allow automatic product reads. Upload a product photo and fill in the name and selling points — the link stays as the destination.",
        ...(hints.suggestedTitle ? { suggestedTitle: hints.suggestedTitle } : {}),
      };
    }
    return {
      sourceUrl:    rawUrl.trim(),
      sourceDomain: "",
      status:       "failed",
      error:        validated.error,
    };
  }

  const url          = validated.url;
  const sourceUrl    = url.toString();
  const sourceDomain = sourceDomainFromUrl(url);
  const provider     = detectUrlProvider(url);
  const assetType: AssetType = provider === "pinterest" ? "reference" : "product";
  const originalUrl  = rawUrl.trim();

  // Invariant: an Amazon host never reaches the generic, image-extracting fetch.
  if (provider === "amazon") {
    return { sourceUrl, sourceDomain, provider, assetType, status: "failed", error: "This marketplace is not supported for URL import" };
  }

  // ── Direct image: no page fetch needed ──────────────────────────────────
  if (provider === "direct_image") {
    const r = directImageAdapter(sourceUrl);
    return {
      originalUrl,
      normalizedUrl: sourceUrl,
      sourceUrl,
      sourceDomain,
      provider:      "direct_image",
      assetType:     "product",
      status:        "success",
      title:         `Imported product from ${sourceDomain}`,
      candidates:    toProductCandidates(finalizeCandidates(r.candidates, sourceUrl)),
    };
  }

  // ── Fetch the page ───────────────────────────────────────────────────────
  let html: string;
  let finalUrl: string;

  try {
    const fetched = await fetchPage(sourceUrl);
    html     = fetched.html;
    finalUrl = fetched.finalUrl;
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);

    if (provider === "etsy") {
      return {
        originalUrl, normalizedUrl: sourceUrl, sourceUrl, sourceDomain,
        provider: "etsy", assetType: "product",
        status:          ETSY_BLOCKED_RESULT.status,
        message:         ETSY_BLOCKED_RESULT.message,
        fallbackActions: ETSY_BLOCKED_RESULT.fallbackActions,
        debugCode:       ETSY_BLOCKED_RESULT.debugCode,
        error:           errMsg,
      };
    }

    if (provider === "pinterest") {
      return {
        originalUrl, normalizedUrl: sourceUrl, sourceUrl, sourceDomain,
        provider: "pinterest", assetType: "reference",
        status:          PINTEREST_BLOCKED_RESULT.status,
        message:         PINTEREST_BLOCKED_RESULT.message,
        fallbackActions: PINTEREST_BLOCKED_RESULT.fallbackActions,
        debugCode:       PINTEREST_BLOCKED_RESULT.debugCode,
        error:           errMsg,
      };
    }

    return {
      originalUrl, normalizedUrl: sourceUrl, sourceUrl, sourceDomain,
      provider, assetType,
      status: "failed",
      error:  errMsg,
    };
  }

  // ── Refine provider from HTML ────────────────────────────────────────────
  let effectiveProvider: Provider = provider;
  if (effectiveProvider === "generic" && isWooCommerceHtml(html)) {
    effectiveProvider = "woocommerce";
  }

  // ── Run provider adapter ─────────────────────────────────────────────────
  let adapterResult = await (async () => {
    switch (effectiveProvider) {
      case "shopify":     return shopifyAdapter(url, fetchPage, html, finalUrl);
      case "woocommerce": return woocommerceAdapter(html, finalUrl);
      case "etsy":        return etsyAdapter(html, finalUrl);
      case "pinterest":   return pinterestAdapter(html, finalUrl);
      default:            return genericProductAdapter(html, finalUrl);
    }
  })();

  // ── Fallback to generic if adapter returned nothing ──────────────────────
  if (!adapterResult.candidates.length && effectiveProvider !== "generic") {
    const fallback = genericProductAdapter(html, finalUrl);
    adapterResult = {
      ...fallback,
      title:       adapterResult.title ?? fallback.title,
      description: adapterResult.description ?? fallback.description,
      // Keep facts from the original adapter (e.g. Shopify JSON price/brand) even
      // when it had no image candidates; merge in whatever the generic fallback found.
      facts:       mergeFacts([adapterResult.facts, fallback.facts]),
    };
  }

  if (!adapterResult.candidates.length) {
    return {
      originalUrl, normalizedUrl: sourceUrl, sourceUrl, sourceDomain,
      provider: effectiveProvider, assetType,
      status:  "failed",
      message: adapterResult.message,
      error:   "Could not extract product images",
      // No candidates means no page content was usable — do not attach facts either.
    };
  }

  const finalCandidates = toProductCandidates(finalizeCandidates(adapterResult.candidates, finalUrl));

  return {
    originalUrl,
    normalizedUrl: sourceUrl,
    sourceUrl,
    sourceDomain,
    provider:        effectiveProvider,
    assetType,
    status:          "success",
    title:           adapterResult.title ?? `Imported from ${sourceDomain}`,
    description:     adapterResult.description,
    candidates:      finalCandidates,
    message:         adapterResult.message,
    fallbackActions: adapterResult.fallbackActions,
    facts:           withFactsImages(adapterResult.facts, finalCandidates.map(c => c.imageUrl)),
  };
}
