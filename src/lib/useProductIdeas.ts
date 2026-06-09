import useSWR from "swr";
import {
  fetchProductIdeasWithMeta,
  fetchProductIdeasCategoryMap,
  PRODUCT_IDEAS_SWR_KEY,
  type ProductIdeasFetchResult,
} from "@/lib/productIdeas";

export function useProductIdeas() {
  return useSWR<ProductIdeasFetchResult>(PRODUCT_IDEAS_SWR_KEY, fetchProductIdeasWithMeta, {
    revalidateOnFocus: false,
    revalidateOnReconnect: true,
    errorRetryCount: 2,
    dedupingInterval: 30_000,
    shouldRetryOnError: true,
  });
}

export function useProductIdeasCategoryMap() {
  return useSWR<Record<string, string>>("kw_cat_map_v2", fetchProductIdeasCategoryMap, {
    revalidateOnFocus: false,
  });
}
