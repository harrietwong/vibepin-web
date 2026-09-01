import useSWR from "swr";
import type { ProductIdea, ProductIdeasFetchResult } from "@/lib/productIdeas";
import { fetchProductOpportunities } from "@/lib/productOpportunitiesClient";
import type { ProductOpportunityItem } from "@/lib/server/productOpportunities";
import { isNonPinterestMerchantImageUrl } from "@/lib/productImageEvidence";

export const CANONICAL_PRODUCT_PICKER_SWR_KEY = "/api/product-opportunities?surface=product-picker";

function pickerProduct(item: ProductOpportunityItem): ProductIdea {
  return {
    id: item.id,
    product_name: item.productName,
    price: null,
    currency: null,
    source_url: item.productUrl,
    domain: item.domain,
    merchant: item.merchant,
    image_url: item.productImageUrl,
    merchant_image_verified: isNonPinterestMerchantImageUrl(item.productImageUrl),
    save_count: item.pinterestEvidenceType === "product_pin" ? item.latestPinterestSaves : null,
    reaction_count: 0,
    source_pin_save_count: item.pinterestEvidenceType === "source_pin" ? item.latestPinterestSaves : null,
    source_pin_ids: item.pinterestEvidenceType === "source_pin" ? [item.pinterestUrl] : [],
    target_product_pin_url: item.pinterestEvidenceType === "product_pin" ? item.pinterestUrl : null,
    seed_keyword: item.category,
    category: item.category,
    parent_pin_id: "",
    scraped_at: item.latestPinterestSnapshotAt,
    opportunity_score: null,
    trend_score: null,
    save_velocity_score: null,
    item_type: "product",
    source_context: "saved_from_product_ideas",
  };
}

async function fetchCanonicalProductIdeas(): Promise<ProductIdeasFetchResult> {
  const result = await fetchProductOpportunities({ limit: 100, sort: "newest" });
  const products = result.items.map(pickerProduct).filter((item) => item.merchant_image_verified);
  const timestamps = products.map((item) => item.scraped_at).filter((value): value is string => Boolean(value)).sort();
  return {
    products,
    lastUpdatedAt: timestamps.at(-1) ?? null,
    source: "product_opportunity_catalog_v1",
    itemCount: result.accessibleCount,
    meta: {
      totalPinProducts: result.accessibleCount,
      platformVisible: [...new Set(products.map((item) => item.domain).filter((value): value is string => Boolean(value)))].sort(),
    },
  };
}

export function useProductIdeas() {
  return useSWR<ProductIdeasFetchResult>(CANONICAL_PRODUCT_PICKER_SWR_KEY, fetchCanonicalProductIdeas, {
    revalidateOnFocus: false,
    revalidateOnReconnect: true,
    errorRetryCount: 0,
    dedupingInterval: 30_000,
    shouldRetryOnError: false,
  });
}

export function useProductIdeasCategoryMap() {
  // v3.7 catalog items already carry their canonical category. Keep this hook for
  // caller compatibility without opening a second browser-side database path.
  return useSWR<Record<string, string>>("product-opportunity-category-map-v1", async () => ({}), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
}
