import "server-only";

/**
 * Loading, inferring and persisting the phrase set one connection is measured against.
 *
 * Two properties, neither obvious from the shape of the code.
 *
 * **1. A missing `account_keyword_set` means "not stored yet", never an exception.**
 * The v65 migration is a file that has not been applied anywhere; this code ships
 * first on purpose. When the relation is absent the set is built in memory from
 * `trend_keywords` (which does exist in production), the diagnosis is produced
 * normally, and `keywordSetVersion` comes back null so nobody can cite a version that
 * was never written. Deploying a diagnosis that silently fails because a table is not
 * there yet would be worse than either applying the migration or not shipping.
 *
 * **2. Inference writes a guess, and marks it as one.** When the user has not chosen
 * a category we infer it from board names and Pin titles, then persist it into
 * `social_connections.metadata` so tomorrow's run does not re-guess (and so the
 * inference cannot drift from one page load to the next). It is stored alongside
 * `insights_category_inferred: true` precisely so a guess never becomes
 * indistinguishable from the user's own choice: PATCH /api/insights/category clears
 * that flag, and a rebuild triggered by the change gets the phrases of the category
 * the user actually named.
 */

import { createServerClient } from "@/lib/supabase";
import {
  buildCategoryPhraseIndex,
  buildKeywordSet,
  EMPTY_KEYWORD_SET,
  hashPhrases,
  inferCategory,
  keywordSetIsFresh,
  KEYWORD_SET_EXPANSION_LIMIT,
  KEYWORD_SET_SEED_LIMIT,
  type AccountKeywordSet,
  type KeywordExpansionRow,
  type TrendKeywordRow,
} from "@/lib/insights/keywordSet";
import { isMissingSchema } from "./collectorStore";

const SET_TABLE = "account_keyword_set";

/** Keyword rows read to decide WHICH category an account is in. Bounded because this
 *  runs on a cache miss of a page request: the strongest 1,500 terms cover every
 *  category that has enough signal to be worth inferring, and a full-table scan to
 *  discover a category with three keywords in it would buy nothing. */
const CATEGORY_INDEX_LIMIT = 1500;

type Row = Record<string, unknown>;

export type StoredKeywordSet = {
  version: number;
  category: string | null;
  sourceSnapshotAt: string | null;
  phrases: string[];
};

function phrasesFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

/** The newest stored set for a connection, or null when there is none — including
 *  the case where the table does not exist yet. */
export async function loadStoredKeywordSet(connectionId: string): Promise<StoredKeywordSet | null> {
  const db = createServerClient();
  const { data, error } = await db
    .from(SET_TABLE)
    .select("version,category,source_snapshot_at,phrases")
    .eq("connection_id", connectionId)
    .order("version", { ascending: false })
    .limit(1);
  if (error) {
    if (isMissingSchema(error)) return null;
    throw new Error(`Unable to read account_keyword_set: ${error.message}`);
  }
  const row = (data ?? [])[0] as Row | undefined;
  if (!row) return null;
  return {
    version: Number(row.version) || 0,
    category: row.category == null ? null : String(row.category),
    sourceSnapshotAt: row.source_snapshot_at == null ? null : String(row.source_snapshot_at),
    phrases: phrasesFrom(row.phrases),
  };
}

async function persistKeywordSet(
  connectionId: string,
  version: number,
  category: string | null,
  phrases: string[],
  snapshotAt: string,
): Promise<number | null> {
  const db = createServerClient();
  const { error } = await db.from(SET_TABLE).insert({
    connection_id: connectionId,
    version,
    category,
    source_snapshot_at: snapshotAt,
    phrases,
  });
  if (error) {
    // A unique violation means another request built the same version first — the
    // set is identical by construction, so this is a race resolved in our favour,
    // not a failure. Anything else (including a missing table) leaves the set
    // unversioned rather than failing the page.
    if (!isMissingSchema(error) && error.code !== "23505") {
      console.error("[insights] persist keyword set:", error.message);
    }
    return null;
  }
  return version;
}

/** Strongest keywords of one category. */
async function loadCategoryKeywords(category: string): Promise<TrendKeywordRow[]> {
  const db = createServerClient();
  const { data, error } = await db
    .from("trend_keywords")
    .select("keyword,category,priority_score")
    .eq("status", "active")
    .eq("category", category)
    .order("priority_score", { ascending: false })
    .limit(KEYWORD_SET_SEED_LIMIT);
  if (error) {
    if (isMissingSchema(error)) return [];
    throw new Error(`Unable to read trend_keywords: ${error.message}`);
  }
  return (data ?? []).map(raw => {
    const row = raw as Row;
    return {
      keyword: String(row.keyword ?? ""),
      category: row.category == null ? null : String(row.category),
      priorityScore: row.priority_score == null ? null : Number(row.priority_score),
    };
  }).filter(row => row.keyword !== "");
}

async function loadExpansions(seeds: string[]): Promise<KeywordExpansionRow[]> {
  if (seeds.length === 0) return [];
  const db = createServerClient();
  const { data, error } = await db
    .from("keyword_expansions")
    .select("seed_keyword,expanded_keyword,rank")
    .in("seed_keyword", seeds.slice(0, KEYWORD_SET_SEED_LIMIT))
    .order("rank", { ascending: true, nullsFirst: false })
    .limit(KEYWORD_SET_EXPANSION_LIMIT);
  if (error) {
    if (isMissingSchema(error)) return [];
    throw new Error(`Unable to read keyword_expansions: ${error.message}`);
  }
  return (data ?? []).map(raw => {
    const row = raw as Row;
    return {
      seedKeyword: String(row.seed_keyword ?? ""),
      expandedKeyword: String(row.expanded_keyword ?? ""),
      rank: row.rank == null ? null : Number(row.rank),
    };
  }).filter(row => row.seedKeyword !== "" && row.expandedKeyword !== "");
}

/** The per-category phrase lists inference chooses between. */
async function loadCategoryIndex(): Promise<TrendKeywordRow[]> {
  const db = createServerClient();
  const { data, error } = await db
    .from("trend_keywords")
    .select("keyword,category,priority_score")
    .eq("status", "active")
    .not("category", "is", null)
    .order("priority_score", { ascending: false })
    .limit(CATEGORY_INDEX_LIMIT);
  if (error) {
    if (isMissingSchema(error)) return [];
    throw new Error(`Unable to read trend_keywords: ${error.message}`);
  }
  return (data ?? []).map(raw => {
    const row = raw as Row;
    return {
      keyword: String(row.keyword ?? ""),
      category: row.category == null ? null : String(row.category),
      priorityScore: row.priority_score == null ? null : Number(row.priority_score),
    };
  }).filter(row => row.keyword !== "" && row.category !== null);
}

/** Every category a set can legitimately be built for. The PATCH route validates
 *  against exactly this list, so a user cannot name a category we have no phrases
 *  for and then wonder why nothing is measured. */
export async function listKeywordCategories(): Promise<string[]> {
  const rows = await loadCategoryIndex();
  return [...new Set(rows.map(row => row.category).filter((value): value is string => !!value))].sort();
}

export function readStoredCategory(metadata: Record<string, unknown> | null | undefined): {
  category: string | null;
  inferred: boolean;
} {
  const raw = metadata?.insights_category;
  const category = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  return { category, inferred: metadata?.insights_category_inferred === true };
}

/** Merge one key into `social_connections.metadata` without disturbing the rest of
 *  it (default board, provider blocks). Best effort: a failed write costs a re-guess
 *  tomorrow, and must never fail the page. */
export async function writeConnectionCategory(
  uid: string,
  connectionId: string,
  category: string | null,
  inferred: boolean,
): Promise<boolean> {
  const db = createServerClient();
  const { data, error } = await db
    .from("social_connections")
    .select("metadata")
    .eq("id", connectionId)
    .eq("user_id", uid)
    .limit(1);
  if (error || !data || data.length === 0) {
    if (error && !isMissingSchema(error)) console.error("[insights] read connection metadata:", error.message);
    return false;
  }
  const metadata = ((data[0] as Row).metadata ?? {}) as Record<string, unknown>;
  const { error: writeError } = await db
    .from("social_connections")
    .update({
      metadata: { ...metadata, insights_category: category, insights_category_inferred: inferred },
      updated_at: new Date().toISOString(),
    })
    .eq("id", connectionId)
    .eq("user_id", uid);
  if (writeError) {
    console.error("[insights] write insights category:", writeError.message);
    return false;
  }
  return true;
}

export type KeywordSetRequest = {
  uid: string;
  connectionId: string;
  metadata: Record<string, unknown> | null;
  /** Board names and Pin titles — used ONLY to pick a category, never to make a
   *  phrase. See the module header of `lib/insights/keywordSet.ts`. */
  inferenceTexts: string[];
  now?: Date;
};

/**
 * The set this connection's Pin text is checked against.
 *
 * Order of authority for the category: the user's choice, then a category already
 * recorded (including a previous inference), then inference from the account's own
 * text, then nothing. "Nothing" is a real answer — A1 reports `insufficient` rather
 * than measuring against a category we picked at random.
 */
export async function loadAccountKeywordSet(request: KeywordSetRequest): Promise<AccountKeywordSet> {
  const now = request.now ?? new Date();
  const stored = await loadStoredKeywordSet(request.connectionId).catch(() => null);
  const chosen = readStoredCategory(request.metadata);

  let category = chosen.category ?? stored?.category ?? null;
  if (!category) {
    const index = buildCategoryPhraseIndex(await loadCategoryIndex().catch(() => []));
    const inferred = inferCategory(request.inferenceTexts, index);
    category = inferred.category;
    if (category) {
      // Persisted so the guess is stable and visible, not re-derived per request.
      await writeConnectionCategory(request.uid, request.connectionId, category, true).catch(() => false);
    }
  }

  if (stored && keywordSetIsFresh(stored, category, now) && stored.phrases.length > 0) {
    return {
      category: stored.category,
      phrases: stored.phrases,
      hash: hashPhrases(stored.phrases),
      version: stored.version,
      sourceSnapshotAt: stored.sourceSnapshotAt,
    };
  }

  if (!category) return EMPTY_KEYWORD_SET;

  const keywords = await loadCategoryKeywords(category).catch(() => []);
  if (keywords.length === 0) return { ...EMPTY_KEYWORD_SET, category };
  const expansions = await loadExpansions(keywords.map(row => row.keyword)).catch(() => []);
  const built = buildKeywordSet(keywords, expansions, { category });
  const snapshotAt = now.toISOString();
  const version = built.phrases.length > 0
    ? await persistKeywordSet(
      request.connectionId,
      (stored?.version ?? 0) + 1,
      category,
      built.phrases,
      snapshotAt,
    ).catch(() => null)
    : null;

  return {
    category,
    phrases: built.phrases,
    hash: built.hash,
    version,
    sourceSnapshotAt: snapshotAt,
  };
}
