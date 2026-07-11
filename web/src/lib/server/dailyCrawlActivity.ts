// ── Daily crawl activity (READ-ONLY, internal admin) ─────────────────────────
//
// Powers the /admin/data "Daily crawl activity" section: what did the pipeline
// actually produce each day — trend keywords touched, pins scraped, products
// added, save snapshots written — plus the newest crawled pin/product images.
//
// Every query is read-only and degrades gracefully (missing table/column →
// null metric, never a crash). Day buckets are UTC to match the crawler's
// pin_save_snapshots.captured_on convention.

type CountQuery = PromiseLike<{ count: number | null; error: unknown }>;

export type DailyActivityRow = {
  date: string;                       // UTC YYYY-MM-DD
  pinsScraped: number | null;         // pin_samples.scraped_at within the day
  productsAdded: number | null;       // pin_products.created_at within the day
  trendKeywordsUpdated: number | null; // trend_keywords.last_updated_at within the day
  saveSnapshots: number | null;       // pin_save_snapshots.captured_on = day (v37)
};

export type LatestPin = {
  id: string;
  image_url: string;
  title: string | null;
  seed_keyword: string | null;
  source_keyword: string | null;
  category: string | null;
  save_count: number | null;
  scraped_at: string | null;
};

export type LatestProduct = {
  id: string;
  image_url: string;
  product_name: string | null;
  seed_keyword: string | null;
  save_count: number | null;
  source_pin_save_count: number | null;
  created_at: string | null;
};

export type DailyCrawlActivity = {
  generatedAt: string;
  days: DailyActivityRow[];           // newest first
  snapshotsAvailable: boolean;        // false until migrate_v37 is applied
  latestPins: LatestPin[];
  latestProducts: LatestProduct[];
  warnings: string[];
};

function utcDayStart(offsetDays: number): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return d;
}

async function countRows(q: CountQuery): Promise<number | null> {
  try {
    const { count, error } = await q;
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}

export async function getDailyCrawlActivity(days = 7): Promise<DailyCrawlActivity> {
  const { createServerClient } = await import("@/lib/supabase");
  const db = createServerClient();
  const warnings: string[] = [];

  // Probe pin_save_snapshots once (table exists only after migrate_v37).
  let snapshotsAvailable = true;
  try {
    const { error } = await db.from("pin_save_snapshots").select("id", { count: "exact", head: true });
    if (error) snapshotsAvailable = false;
  } catch {
    snapshotsAvailable = false;
  }
  if (!snapshotsAvailable) warnings.push("pin_save_snapshots not found — apply migrate_v37 to track daily save snapshots.");

  // Per-day counts, all in parallel (head-only, cheap).
  const dayRows = await Promise.all(
    Array.from({ length: days }, (_, i) => {
      const start = utcDayStart(i);
      const end = utcDayStart(i - 1);
      const date = start.toISOString().slice(0, 10);
      const startIso = start.toISOString();
      const endIso = end.toISOString();
      return Promise.all([
        countRows(db.from("pin_samples").select("id", { count: "exact", head: true })
          .gte("scraped_at", startIso).lt("scraped_at", endIso)),
        countRows(db.from("pin_products").select("id", { count: "exact", head: true })
          .gte("created_at", startIso).lt("created_at", endIso)),
        countRows(db.from("trend_keywords").select("id", { count: "exact", head: true })
          .gte("last_updated_at", startIso).lt("last_updated_at", endIso)),
        snapshotsAvailable
          ? countRows(db.from("pin_save_snapshots").select("id", { count: "exact", head: true })
              .eq("captured_on", date))
          : Promise.resolve(null),
      ]).then(([pinsScraped, productsAdded, trendKeywordsUpdated, saveSnapshots]): DailyActivityRow => ({
        date, pinsScraped, productsAdded, trendKeywordsUpdated, saveSnapshots,
      }));
    }),
  );

  // Newest crawl output — image evidence for "what did we actually fetch".
  let latestPins: LatestPin[] = [];
  try {
    const { data } = await db
      .from("pin_samples")
      .select("id,image_url,title,seed_keyword,source_keyword,category,save_count,scraped_at")
      .not("image_url", "is", null)
      .order("scraped_at", { ascending: false })
      .limit(12);
    latestPins = (data ?? []) as LatestPin[];
  } catch {
    warnings.push("Could not load latest pin_samples images.");
  }

  let latestProducts: LatestProduct[] = [];
  try {
    const { data } = await db
      .from("pin_products")
      .select("id,image_url,product_name,seed_keyword,save_count,source_pin_save_count,created_at")
      .not("image_url", "is", null)
      .order("created_at", { ascending: false })
      .limit(12);
    latestProducts = (data ?? []) as LatestProduct[];
  } catch {
    warnings.push("Could not load latest pin_products images.");
  }

  return {
    generatedAt: new Date().toISOString(),
    days: dayRows,
    snapshotsAvailable,
    latestPins,
    latestProducts,
    warnings,
  };
}
