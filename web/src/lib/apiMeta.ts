import type { ApiListMeta } from "@/lib/freshness";

export type ApiListResponse<T> = ApiListMeta & {
  items: T[];
  data?: T[];
};

export function normalizeApiList<T>(json: Record<string, unknown>): ApiListMeta & { items: T[] } {
  const items = (json.items ?? json.data ?? []) as T[];
  return {
    items,
    lastUpdatedAt: (json.lastUpdatedAt as string | null) ?? null,
    source: (json.source as string) ?? "unknown",
    itemCount: typeof json.itemCount === "number" ? json.itemCount : items.length,
  };
}
