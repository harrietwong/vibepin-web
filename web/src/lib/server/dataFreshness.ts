// ── Data Freshness + Inventory v0 (READ-ONLY, internal admin) ────────────────
//
// Powers /admin/data. Shows data totals, freshness windows, and quality
// counters. Every query is read-only and degrades gracefully: a missing
// table/column/permission → null metric + warning, never a crash.
//
// Reuses getProductOpportunityAdminStatus() for pin_products + product_scores
// freshness (same read-only source the Overview uses). Adds pin_samples,
// visual_asset_reviews, product_ideas, and quality counters.
//
// NOTE: pin_samples has no created_at column — scraped_at is the ingestion
// clock, so samples freshness/latest uses scraped_at (created_at_source is also
// surfaced when present). product_scores has no updated_at — scored_at is used.

import {
  getProductOpportunityAdminStatus,
  type FreshnessStatus,
} from "@/lib/server/productOpportunityAdminStatus";
import { excludeRetired } from "@/lib/productTopTiers";

type PgError = { code?: string; message?: string } | null;

export type DataFreshness = {
  generatedAt: string;
  warnings: string[];
  inventory: {
    pinSamples: number | null;
    pinProducts: number | null;
    productScores: number | null;
    visualReviews: number | null;
    visualReviewsAvailable: boolean;
    productIdeas: number | null;
    productIdeasAvailable: boolean;
  };
  samples: {
    available: boolean;
    last24h: number | null;
    last48h: number | null;
    last5d: number | null;
    latestScrapedAt: string | null;
    latestCreatedAtSource: string | null;
    status: FreshnessStatus;
    missingImageUrl: number | null;
  };
  products: {
    last24h: number;
    last48h: number;
    last5d: number;
    latestCreatedAt: string | null;
    latestScrapedAt: string | null;
    status: FreshnessStatus;
    missingImageUrl: number | null;
  };
  // Product Opportunity v1 readiness coverage — derived from pin_products only
  // (NOT product_scores). These are the counters that decide whether Product
  // Opportunity has enough direct product signal to be useful.
  productCoverage: {
    missingProductUrl: number | null;
    withProductSaves: number | null;   // rows that carry a genuine product-Pin id
    withSourcePinSaves: number | null;  // rows with inherited source-Pin save evidence
    withoutCategory: number | null;     // no source_category AND no seed_keyword
  };
  scores: {
    total: number;
    latestScoredAt: string | null;
    latestUpdatedAt: string | null;
    updatedAtAvailable: boolean;
    status: FreshnessStatus;
  };
  visualReview: {
    available: boolean;
    reviewed: number | null;
    unreviewed: number | null;
    pass: number | null;
    review: number | null;
    reject: number | null;
    latestUpdatedAt: string | null;
  };
  quality: {
    missingImageSamples: number | null;
    missingImageProducts: number | null;
    brokenImage: number | null; // not instrumented
    duplicateClusters: number | null; // not instrumented
  };
};

function isMissingSchema(error: PgError): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "42703" || error.code === "PGRST205" || error.code === "PGRST204") return true;
  return /(relation|column) .* does not exist|could not find the table/i.test(error.message ?? "");
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function statusFromTimestamp(iso: string | null): FreshnessStatus {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  return Date.now() - t <= 48 * 3_600_000 ? "fresh" : "stale";
}

type CountOutcome = { n: number | null; missing: boolean };

async function countRows(qb: PromiseLike<{ count: number | null; error: PgError }>): Promise<CountOutcome> {
  try {
    const { count, error } = await qb;
    if (error) return { n: null, missing: isMissingSchema(error) };
    return { n: count ?? 0, missing: false };
  } catch {
    return { n: null, missing: false };
  }
}

async function latest(
  qb: PromiseLike<{ data: Array<Record<string, unknown>> | null; error: PgError }>,
  field: string,
): Promise<{ value: string | null; missing: boolean }> {
  try {
    const { data, error } = await qb;
    if (error) return { value: null, missing: isMissingSchema(error) };
    const v = data?.[0]?.[field];
    return { value: typeof v === "string" ? v : null, missing: false };
  } catch {
    return { value: null, missing: false };
  }
}

export async function getDataFreshness(): Promise<DataFreshness> {
  const { createServerClient } = await import("@/lib/supabase");
  const db = createServerClient();
  const warnings: string[] = [];
  const b = { last24h: isoHoursAgo(24), last48h: isoHoursAgo(48), last5d: isoHoursAgo(24 * 5) };

  // pin_products + product_scores freshness (reused, read-only).
  const product = await getProductOpportunityAdminStatus().catch(() => null);
  if (!product) warnings.push("pin_products / product_scores freshness query failed.");
  const pf = product?.productDataFreshness;
  const sf = product?.scoreFreshness;

  const [
    samplesTotal, samples24, samples48, samples5d,
    productsTotal, scoresTotal, reviewsTotal, ideasTotal,
    samplesMissingImg, productsMissingImg,
    reviewPass, reviewReview, reviewReject,
    prodImgs, sampleImgs,
    productsMissingUrl, productsWithProductSaves, productsWithSourceSaves, productsWithoutCategory,
  ] = await Promise.all([
    countRows(db.from("pin_samples").select("id", { count: "exact", head: true })),
    countRows(db.from("pin_samples").select("id", { count: "exact", head: true }).gte("scraped_at", b.last24h)),
    countRows(db.from("pin_samples").select("id", { count: "exact", head: true }).gte("scraped_at", b.last48h)),
    countRows(db.from("pin_samples").select("id", { count: "exact", head: true }).gte("scraped_at", b.last5d)),
    // Every pin_products counter excludes soft-retired rows (lifecycle_status='retired',
    // migrate_v46): these numbers describe the corpus the product surfaces can actually
    // draw from, so a row that can never surface must not inflate them.
    countRows(excludeRetired(db.from("pin_products").select("id", { count: "exact", head: true }))),
    countRows(db.from("product_scores").select("id", { count: "exact", head: true })),
    countRows(db.from("visual_asset_reviews").select("id", { count: "exact", head: true })),
    countRows(db.from("product_ideas").select("id", { count: "exact", head: true })),
    countRows(db.from("pin_samples").select("id", { count: "exact", head: true }).is("image_url", null)),
    countRows(excludeRetired(db.from("pin_products").select("id", { count: "exact", head: true }).is("image_url", null))),
    countRows(db.from("visual_asset_reviews").select("id", { count: "exact", head: true }).eq("decision_label", "PASS")),
    countRows(db.from("visual_asset_reviews").select("id", { count: "exact", head: true }).eq("decision_label", "REVIEW")),
    countRows(db.from("visual_asset_reviews").select("id", { count: "exact", head: true }).eq("decision_label", "REJECT")),
    countRows(excludeRetired(db.from("pin_products").select("id", { count: "exact", head: true }).not("image_url", "is", null))),
    countRows(db.from("pin_samples").select("id", { count: "exact", head: true }).not("image_url", "is", null)),
    // Product Opportunity v1 coverage counters (pin_products only).
    countRows(excludeRetired(db.from("pin_products").select("id", { count: "exact", head: true }).is("source_url", null))),
    countRows(excludeRetired(db.from("pin_products").select("id", { count: "exact", head: true }).not("product_pin_id", "is", null))),
    countRows(excludeRetired(db.from("pin_products").select("id", { count: "exact", head: true }).gt("source_pin_save_count", 0))),
    countRows(excludeRetired(db.from("pin_products").select("id", { count: "exact", head: true }).is("source_category", null).is("seed_keyword", null))),
  ]);

  const [samplesLatestScraped, samplesLatestSource, reviewsLatest, scoresUpdated] = await Promise.all([
    latest(db.from("pin_samples").select("scraped_at").not("scraped_at", "is", null).order("scraped_at", { ascending: false }).limit(1), "scraped_at"),
    latest(db.from("pin_samples").select("created_at_source").not("created_at_source", "is", null).order("created_at_source", { ascending: false }).limit(1), "created_at_source"),
    latest(db.from("visual_asset_reviews").select("updated_at").order("updated_at", { ascending: false }).limit(1), "updated_at"),
    // product_scores.updated_at "if available" — probe; falls back to scored_at.
    latest(db.from("product_scores").select("updated_at").order("updated_at", { ascending: false }).limit(1), "updated_at"),
  ]);

  const samplesAvailable = !samplesTotal.missing;
  const reviewsAvailable = !reviewsTotal.missing;
  if (ideasTotal.missing) warnings.push("product_ideas table not found — Product Ideas derive from pin_products (no dedicated table).");
  if (!reviewsAvailable) warnings.push("visual_asset_reviews table not found — migration v31 pending.");
  if (!samplesAvailable) warnings.push("pin_samples not available.");

  const candidatePool = (prodImgs.n ?? 0) + (sampleImgs.n ?? 0);
  const reviewed = reviewsAvailable ? reviewsTotal.n ?? 0 : 0;

  return {
    generatedAt: new Date().toISOString(),
    warnings,
    inventory: {
      pinSamples: samplesTotal.n,
      pinProducts: productsTotal.n,
      productScores: scoresTotal.n,
      visualReviews: reviewsAvailable ? reviewsTotal.n : null,
      visualReviewsAvailable: reviewsAvailable,
      productIdeas: ideasTotal.missing ? null : ideasTotal.n,
      productIdeasAvailable: !ideasTotal.missing,
    },
    samples: {
      available: samplesAvailable,
      last24h: samples24.n,
      last48h: samples48.n,
      last5d: samples5d.n,
      latestScrapedAt: samplesLatestScraped.value,
      latestCreatedAtSource: samplesLatestSource.value,
      status: statusFromTimestamp(samplesLatestScraped.value),
      missingImageUrl: samplesMissingImg.n,
    },
    products: {
      last24h: pf?.rowsCreatedLast24h ?? 0,
      last48h: pf?.rowsCreatedLast48h ?? 0,
      last5d: pf?.rowsCreatedLast5d ?? 0,
      latestCreatedAt: pf?.latestCreatedAt ?? null,
      latestScrapedAt: pf?.latestScrapedAt ?? null,
      status: pf?.status ?? "unknown",
      missingImageUrl: productsMissingImg.n,
    },
    productCoverage: {
      missingProductUrl: productsMissingUrl.n,
      withProductSaves: productsWithProductSaves.n,
      withSourcePinSaves: productsWithSourceSaves.n,
      withoutCategory: productsWithoutCategory.n,
    },
    scores: {
      total: sf?.totalRows ?? scoresTotal.n ?? 0,
      latestScoredAt: sf?.latestScoredAt ?? null,
      latestUpdatedAt: scoresUpdated.missing ? null : scoresUpdated.value,
      updatedAtAvailable: !scoresUpdated.missing,
      status: sf?.status ?? statusFromTimestamp(sf?.latestScoredAt ?? null),
    },
    visualReview: {
      available: reviewsAvailable,
      reviewed: reviewsAvailable ? reviewed : null,
      unreviewed: reviewsAvailable ? Math.max(0, candidatePool - reviewed) : candidatePool || null,
      pass: reviewsAvailable ? reviewPass.n : null,
      review: reviewsAvailable ? reviewReview.n : null,
      reject: reviewsAvailable ? reviewReject.n : null,
      latestUpdatedAt: reviewsLatest.value,
    },
    quality: {
      missingImageSamples: samplesMissingImg.n,
      missingImageProducts: productsMissingImg.n,
      brokenImage: null, // not instrumented (no image-health probe in v0)
      duplicateClusters: null, // not instrumented (no dedup-cluster counter in v0)
    },
  };
}
