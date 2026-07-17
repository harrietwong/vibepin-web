// ── Admin AI Adoption — generation → published-draft conversion (READ-ONLY) ───
//
// Powers the operator console's "is the AI actually driving publishes" metric.
//
//   adoption rate = (completed generations whose output landed in a PUBLISHED
//                    draft) / (all completed generations)
//
// LINKAGE (generation → draft), precedence:
//   (1) EXACT   — draft payload.sourceGenerationId === generation id.
//   (2) INFERRED— a generation output URL (pin_generations.pin_urls[] or
//                 groups_json[].images[]) appears in the draft payload
//                 (imageUrl / sourceImageUrl). Only used for drafts with NO
//                 sourceGenerationId (historical drafts predate the id write).
//
// "Published" for a draft = an EXACT publish event succeeded for it (draft_id join)
//   OR payload.postedAt present (inferred).
//
// Returns DATA ONLY: global rate, numerator/denominator, an exact/inferred link
// split, and a 7-day direction SIGN (this-7d rate vs prior-7d rate) — not a chart.
//
// Efficiency: three paginated scans (generations, drafts, publish events). The
// URL index is built once. No per-user / per-generation query loops.

import {
  createAdminDb,
  isMissingSchema,
  isoHoursAgo,
  paginateRows,
  type SupabaseLikeDb,
} from "./adminQueryUtils";

// ── contract types ────────────────────────────────────────────────────────────

export interface AiAdoption {
  available: boolean;
  generatedAt: string;
  scanWindowDays: number;
  warnings: string[];
  /** completed generations that reached a published draft. */
  adopted: number;
  /** all completed generations in the window. */
  completed: number;
  /** adopted / completed, 0..1 (rounded to 4 dp). null when completed === 0. */
  rate: number | null;
  /** How the adopted generations were linked to their published draft. */
  linkSplit: { exact: number; inferred: number };
  /** Trailing-7d rate vs the prior 7d. `direction` is a SIGN, not a series. */
  trend: {
    last7dRate: number | null;
    prior7dRate: number | null;
    /** +1 improving, -1 declining, 0 flat/unknown. */
    direction: -1 | 0 | 1;
  };
}

// ── linkage primitives (pure) ─────────────────────────────────────────────────

export interface GenerationLite {
  id: string;
  createdAt: string | null;
  status: string | null;
  /** every output image URL this generation produced (pin_urls ∪ groups_json images). */
  outputUrls: string[];
}

export interface DraftLite {
  draftId: string;
  sourceGenerationId: string | null;
  /** URLs the draft references that could match a generation output. */
  imageUrls: string[];
  /** true when this draft is published (event OR postedAt). */
  published: boolean;
}

/** Flatten a pin_generations row's outputs into a URL list. */
export function extractOutputUrls(row: { pin_urls?: unknown; groups_json?: unknown }): string[] {
  const urls = new Set<string>();
  const push = (v: unknown) => { if (typeof v === "string" && v.trim()) urls.add(v); };
  if (Array.isArray(row.pin_urls)) for (const u of row.pin_urls) push(u);
  if (Array.isArray(row.groups_json)) {
    for (const g of row.groups_json) {
      const imgs = (g as { images?: unknown })?.images;
      if (Array.isArray(imgs)) for (const u of imgs) push(u);
    }
  }
  return Array.from(urls);
}

export interface AdoptionLinkResult {
  adopted: number;
  completed: number;
  exactLinks: number;
  inferredLinks: number;
}

/**
 * Compute adoption over the completed generations. A generation is "adopted" when
 * it links to at least one PUBLISHED draft. Exact link (sourceGenerationId) is
 * preferred; the URL match is only consulted for drafts lacking a sourceGenerationId.
 * Pure — unit tested directly.
 */
export function computeAdoption(generations: GenerationLite[], drafts: DraftLite[]): AdoptionLinkResult {
  // Index published drafts for both linkage strategies.
  const publishedByGenId = new Set<string>(); // sourceGenerationId of published drafts
  const publishedUrlToNothing = new Map<string, true>(); // published draft image URL → exists
  for (const d of drafts) {
    if (!d.published) continue;
    if (d.sourceGenerationId) {
      publishedByGenId.add(d.sourceGenerationId);
    } else {
      for (const u of d.imageUrls) publishedUrlToNothing.set(u, true);
    }
  }

  let adopted = 0, exactLinks = 0, inferredLinks = 0, completed = 0;
  for (const g of generations) {
    if (g.status !== "completed") continue;
    completed += 1;
    // (1) exact: a published draft points at this generation id.
    if (publishedByGenId.has(g.id)) {
      adopted += 1;
      exactLinks += 1;
      continue;
    }
    // (2) inferred: any of this generation's outputs is referenced by a published
    //     draft that had no sourceGenerationId.
    const hit = g.outputUrls.some(u => publishedUrlToNothing.has(u));
    if (hit) {
      adopted += 1;
      inferredLinks += 1;
    }
  }
  return { adopted, completed, exactLinks, inferredLinks };
}

function rateOf(adopted: number, completed: number): number | null {
  if (completed <= 0) return null;
  return Math.round((adopted / completed) * 10_000) / 10_000;
}

// ── scans ─────────────────────────────────────────────────────────────────────

const SCAN_WINDOW_DAYS = 14; // covers both 7d trend halves

async function loadGenerations(
  db: SupabaseLikeDb,
  since: string,
  warnings: string[],
): Promise<{ rows: GenerationLite[]; statusAvailable: boolean; available: boolean }> {
  let statusAvailable = true;
  let res = await paginateRows<{ id: string; created_at: string | null; status: string | null; pin_urls: unknown; groups_json: unknown }>(
    db,
    "pin_generations",
    {
      columns: "id,created_at,status,pin_urls,groups_json",
      filters: qb => qb.gte("created_at", since),
      orderColumn: "created_at",
      ascending: false,
    },
  );
  if (res.error && isMissingSchema(res.error)) {
    // status column absent — without it we cannot identify "completed" generations.
    statusAvailable = false;
  }
  if (res.missing) {
    warnings.push("pin_generations unavailable — AI adoption cannot be computed.");
    return { rows: [], statusAvailable: false, available: false };
  }
  if (res.error && !statusAvailable) {
    warnings.push("pin_generations.status column not present — AI adoption cannot be computed.");
    return { rows: [], statusAvailable: false, available: false };
  }
  if (res.error) {
    warnings.push(`pin_generations scan failed: ${res.error.message ?? "unknown"}.`);
    return { rows: [], statusAvailable: false, available: false };
  }
  const rows: GenerationLite[] = res.rows.map(r => ({
    id: r.id,
    createdAt: r.created_at,
    status: r.status,
    outputUrls: extractOutputUrls(r),
  }));
  return { rows, statusAvailable, available: true };
}

/** Load drafts + resolve their published state (event OR postedAt). */
async function loadDrafts(
  db: SupabaseLikeDb,
  since: string,
  publishedDraftIds: Set<string>,
  warnings: string[],
): Promise<DraftLite[]> {
  const { rows, error, missing } = await paginateRows<{ draft_id: string | null; vibepin_user_id: string | null; payload: Record<string, unknown> | null; deleted_at: string | null }>(
    db,
    "pin_drafts",
    {
      columns: "draft_id,vibepin_user_id,payload,deleted_at",
      filters: qb => qb.is("deleted_at", null).gte("updated_at", since),
      orderColumn: "updated_at",
      ascending: false,
    },
  );
  if (missing) { warnings.push("pin_drafts unavailable — AI adoption cannot be computed."); return []; }
  if (error) { warnings.push(`pin_drafts scan failed: ${error.message ?? "unknown"}.`); return []; }

  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  return rows.map(r => {
    const p = r.payload ?? {};
    const imageUrls = new Set<string>();
    for (const key of ["imageUrl", "sourceImageUrl", "sourceProductImageUrl"]) {
      const u = str(p[key]);
      if (u) imageUrls.add(u);
    }
    const draftId = r.draft_id ?? "";
    const publishedByEvent = draftId ? publishedDraftIds.has(draftId) : false;
    const publishedByPostedAt = !!str(p.postedAt);
    return {
      draftId,
      sourceGenerationId: str(p.sourceGenerationId),
      imageUrls: Array.from(imageUrls),
      published: publishedByEvent || publishedByPostedAt,
    };
  });
}

/** draft_ids that have at least one succeeded publish event (exact "published"). */
async function loadPublishedDraftIds(
  db: SupabaseLikeDb,
  since: string,
  warnings: string[],
): Promise<Set<string>> {
  const ids = new Set<string>();
  const { rows, error, missing } = await paginateRows<{ draft_id: string | null; event_name: string | null }>(
    db,
    "analytics_events",
    {
      columns: "draft_id,event_name,created_at",
      filters: qb => qb.eq("event_name", "pinterest_publish_succeeded").gte("created_at", since),
      orderColumn: "created_at",
      ascending: false,
    },
  );
  if (missing) {
    warnings.push("analytics_events unavailable — 'published' falls back to draft postedAt only.");
    return ids;
  }
  if (error) {
    warnings.push(`analytics_events scan failed: ${error.message ?? "unknown"} — 'published' falls back to postedAt.`);
    return ids;
  }
  for (const r of rows) if (r.draft_id) ids.add(r.draft_id);
  return ids;
}

// ── public entry point ─────────────────────────────────────────────────────────

export async function getAiAdoption(injectedDb?: SupabaseLikeDb): Promise<AiAdoption> {
  const db = injectedDb ?? (await createAdminDb());
  const warnings: string[] = [];
  const since = isoHoursAgo(SCAN_WINDOW_DAYS * 24);
  const now = Date.now();
  const sevenDaysAgo = new Date(now - 7 * 24 * 3_600_000).toISOString();

  // Publish events first (needed to resolve draft published-state), then drafts +
  // generations. Generations + publish events are independent → run in parallel.
  const [genRes, publishedIds] = await Promise.all([
    loadGenerations(db, since, warnings),
    loadPublishedDraftIds(db, since, warnings),
  ]);

  if (!genRes.available) {
    return {
      available: false, generatedAt: new Date().toISOString(), scanWindowDays: SCAN_WINDOW_DAYS,
      warnings, adopted: 0, completed: 0, rate: null, linkSplit: { exact: 0, inferred: 0 },
      trend: { last7dRate: null, prior7dRate: null, direction: 0 },
    };
  }

  const drafts = await loadDrafts(db, since, publishedIds, warnings);

  // Global (14d window) adoption.
  const global = computeAdoption(genRes.rows, drafts);

  // 7-day direction: split generations into this-7d / prior-7d halves, recompute
  // the rate over each half against the SAME draft set (a draft published now can
  // adopt a generation from either half).
  const last7 = genRes.rows.filter(g => g.createdAt && g.createdAt >= sevenDaysAgo);
  const prior7 = genRes.rows.filter(g => g.createdAt && g.createdAt < sevenDaysAgo);
  const last7Res = computeAdoption(last7, drafts);
  const prior7Res = computeAdoption(prior7, drafts);
  const last7dRate = rateOf(last7Res.adopted, last7Res.completed);
  const prior7dRate = rateOf(prior7Res.adopted, prior7Res.completed);

  let direction: -1 | 0 | 1 = 0;
  if (last7dRate !== null && prior7dRate !== null) {
    if (last7dRate > prior7dRate) direction = 1;
    else if (last7dRate < prior7dRate) direction = -1;
  }

  return {
    available: true,
    generatedAt: new Date().toISOString(),
    scanWindowDays: SCAN_WINDOW_DAYS,
    warnings,
    adopted: global.adopted,
    completed: global.completed,
    rate: rateOf(global.adopted, global.completed),
    linkSplit: { exact: global.exactLinks, inferred: global.inferredLinks },
    trend: { last7dRate, prior7dRate, direction },
  };
}
