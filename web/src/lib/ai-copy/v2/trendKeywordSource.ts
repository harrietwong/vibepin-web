/** Raw trend_keywords loader. It never fabricates IDs or quality labels. */
import { buildQueryTerms, type KeywordContextInput, type KeywordRow } from "../keywordContext";

export type TrendKeywordLoader = (input: KeywordContextInput) => Promise<KeywordRow[]>;

const FIELDS = [
  "id", "keyword", "category", "search_volume_level", "volume_signal",
  "volume_score", "priority_score", "region", "data_quality", "language",
  "locale", "source", "source_layer", "country",
].join(",");

const productionLoader: TrendKeywordLoader = async input => {
  const terms = buildQueryTerms(input);
  if (!terms.length) return [];
  const { createServerClient } = await import("@/lib/supabase");
  const db = createServerClient();
  const region = input.region ?? "US";
  const resultSets = await Promise.all(terms.slice(0, 8).map(async term => {
    const { data, error } = await db.from("trend_keywords").select(FIELDS)
      .eq("status", "active").or(`region.eq.${region},region.is.null`)
      .ilike("keyword", `%${term}%`).order("priority_score", { ascending: false }).limit(15);
    if (error) throw new Error("trend_keyword_read_failed");
    return (data ?? []) as unknown as KeywordRow[];
  }));
  const byId = new Map<string, KeywordRow>();
  for (const rows of resultSets) for (const row of rows) {
    if (row.id && !byId.has(row.id)) byId.set(row.id, row);
  }
  return [...byId.values()];
};

let override: TrendKeywordLoader | null = null;
export function __setTrendKeywordLoaderForTests(loader: TrendKeywordLoader | null): void { override = loader; }
export function getTrendKeywordLoader(): TrendKeywordLoader { return override ?? productionLoader; }
