// ── Admin Activation Funnel — 30-day signup cohort milestone conversion ───────
//
// Powers the operator console's activation view. Cohort = users who signed up in
// the last 30 days. For each we compute five milestone timestamps and roll them
// up into per-stage conversion counts + how many are currently STUCK at each
// stage. The two publish-based stages carry an exact/inferred count split.
//
// Returns DATA ONLY (counts, ids, timestamps). No display strings.
//
// Milestones (each is a timestamp or null):
//   1. signup            — auth.users.created_at
//   2. pinterestConnected— earliest pinterest_connections.created_at
//   3. firstGeneration   — earliest pin_generations.created_at
//   4. firstPublish      — EXACT: earliest pinterest_publish_succeeded;
//                          else INFERRED: earliest draft payload.postedAt
//   5. repeatPublish     — a 2nd successful publish within 7d AFTER the first,
//                          same exact/inferred sourcing as firstPublish
//
// The funnel is ordered: a user "reaches" stage N only if they also reached every
// prior stage (monotonic). "Stuck at stage N" = reached N but not N+1.
//
// Efficiency: aggregate scans (one paginated pass per source table), NOT per-user
// queries. auth listUsers loops pages. Row scans use paginated .range() loops so a
// >1000-row source never silently truncates.

import {
  createAdminDb,
  isoHoursAgo,
  listAllAuthUsers,
  paginateRows,
  type SupabaseLikeDb,
  type AuthUserLite,
} from "./adminQueryUtils";

// ── contract types ────────────────────────────────────────────────────────────

export type FunnelStage =
  | "signup"
  | "pinterestConnected"
  | "firstGeneration"
  | "firstPublish"
  | "repeatPublish";

export const FUNNEL_STAGES: readonly FunnelStage[] = [
  "signup",
  "pinterestConnected",
  "firstGeneration",
  "firstPublish",
  "repeatPublish",
] as const;

export interface StageCount {
  stage: FunnelStage;
  /** Reached this stage AND every prior one (monotonic funnel). */
  reached: number;
  /** Reached this stage but NOT the next (currently stuck here). repeatPublish (last) is never "stuck". */
  stuck: number;
}

/** exact/inferred split for the two publish-based stages. */
export interface PublishSourceSplit {
  stage: "firstPublish" | "repeatPublish";
  exact: number;
  inferred: number;
}

export interface ActivationFunnel {
  available: boolean;
  generatedAt: string;
  cohortWindowDays: number;
  cohortSize: number;
  warnings: string[];
  stages: StageCount[];
  publishSplit: PublishSourceSplit[];
}

// ── per-user milestone bundle ─────────────────────────────────────────────────

interface Milestones {
  signup: string | null;
  pinterestConnected: string | null;
  firstGeneration: string | null;
  firstPublish: string | null;
  firstPublishSource: "exact" | "inferred" | null;
  repeatPublish: string | null;
  repeatPublishSource: "exact" | "inferred" | null;
}

const COHORT_WINDOW_DAYS = 30;
const REPEAT_PUBLISH_WINDOW_MS = 7 * 24 * 3_600_000;

function older(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

// ── scans (each returns a per-user map) ───────────────────────────────────────

async function loadEarliestConnection(
  db: SupabaseLikeDb,
  warnings: string[],
): Promise<Map<string, string>> {
  const byUser = new Map<string, string>();
  const { rows, error, missing } = await paginateRows<{ vibepin_user_id: string | null; created_at: string | null }>(
    db,
    "pinterest_connections",
    { columns: "vibepin_user_id,created_at", orderColumn: "created_at", ascending: true },
  );
  if (missing) { warnings.push("pinterest_connections unavailable — connect stage cannot be measured."); return byUser; }
  if (error) { warnings.push(`pinterest_connections scan failed: ${error.message ?? "unknown"}.`); return byUser; }
  for (const r of rows) {
    const uid = r.vibepin_user_id;
    if (!uid || !r.created_at) continue;
    byUser.set(uid, older(byUser.get(uid) ?? null, r.created_at)!);
  }
  return byUser;
}

async function loadEarliestGeneration(
  db: SupabaseLikeDb,
  since: string,
  warnings: string[],
): Promise<Map<string, string>> {
  const byUser = new Map<string, string>();
  const { rows, error, missing } = await paginateRows<{ user_id: string | null; created_at: string | null }>(
    db,
    "pin_generations",
    { columns: "user_id,created_at", filters: qb => qb.gte("created_at", since), orderColumn: "created_at", ascending: true },
  );
  if (missing) { warnings.push("pin_generations unavailable — generation stage cannot be measured."); return byUser; }
  if (error) { warnings.push(`pin_generations scan failed: ${error.message ?? "unknown"}.`); return byUser; }
  for (const r of rows) {
    const uid = r.user_id;
    if (!uid || !r.created_at) continue;
    byUser.set(uid, older(byUser.get(uid) ?? null, r.created_at)!);
  }
  return byUser;
}

/** EXACT publishes: first + second (for repeat) succeeded-event timestamps per user. */
async function loadExactPublishes(
  db: SupabaseLikeDb,
  since: string,
  warnings: string[],
): Promise<Map<string, string[]>> {
  const byUser = new Map<string, string[]>();
  const { rows, error, missing } = await paginateRows<{ user_id: string | null; event_name: string | null; created_at: string | null }>(
    db,
    "analytics_events",
    {
      columns: "user_id,event_name,created_at",
      filters: qb => qb.eq("event_name", "pinterest_publish_succeeded").gte("created_at", since),
      orderColumn: "created_at",
      ascending: true,
    },
  );
  if (missing) { warnings.push("analytics_events unavailable — exact publish stages fall back to inferred postedAt."); return byUser; }
  if (error) { warnings.push(`analytics_events scan failed: ${error.message ?? "unknown"}.`); return byUser; }
  for (const r of rows) {
    const uid = r.user_id;
    if (!uid || !r.created_at) continue;
    const list = byUser.get(uid) ?? [];
    list.push(r.created_at); // ascending order preserved
    byUser.set(uid, list);
  }
  return byUser;
}

/** INFERRED publishes: sorted postedAt timestamps per user (from live drafts). */
async function loadInferredPublishes(
  db: SupabaseLikeDb,
  since: string,
  warnings: string[],
): Promise<Map<string, string[]>> {
  const byUser = new Map<string, string[]>();
  const { rows, error, missing } = await paginateRows<{ vibepin_user_id: string | null; payload: Record<string, unknown> | null; deleted_at: string | null }>(
    db,
    "pin_drafts",
    {
      columns: "vibepin_user_id,payload,deleted_at",
      filters: qb => qb.is("deleted_at", null).gte("updated_at", since),
      orderColumn: "updated_at",
      ascending: true,
    },
  );
  if (missing) { warnings.push("pin_drafts unavailable — inferred publish stages disabled."); return byUser; }
  if (error) { warnings.push(`pin_drafts scan failed: ${error.message ?? "unknown"}.`); return byUser; }
  for (const r of rows) {
    const uid = r.vibepin_user_id;
    if (!uid) continue;
    const postedAt = r.payload?.postedAt;
    if (typeof postedAt !== "string" || !postedAt.trim()) continue;
    const list = byUser.get(uid) ?? [];
    list.push(postedAt);
    byUser.set(uid, list);
  }
  // sort each user's inferred publishes ascending (drafts don't guarantee order)
  for (const list of byUser.values()) list.sort();
  return byUser;
}

// ── milestone assembly (pure) ─────────────────────────────────────────────────

/**
 * Resolve the two publish milestones for one user with EXACT-beats-INFERRED
 * precedence. If any exact succeeded event exists, exact wins for BOTH firstPublish
 * and repeatPublish (repeat = a 2nd exact within 7d of the first). Otherwise fall
 * back to inferred postedAt with the same rule. Pure — unit tested directly.
 */
export function resolvePublishMilestones(
  exact: string[] | undefined,
  inferred: string[] | undefined,
): Pick<Milestones, "firstPublish" | "firstPublishSource" | "repeatPublish" | "repeatPublishSource"> {
  const pick = (list: string[]): { first: string; repeat: string | null } => {
    const first = list[0];
    let repeat: string | null = null;
    const firstMs = Date.parse(first);
    for (let i = 1; i < list.length; i++) {
      if (Date.parse(list[i]) - firstMs <= REPEAT_PUBLISH_WINDOW_MS) { repeat = list[i]; break; }
    }
    return { first, repeat };
  };

  if (exact && exact.length > 0) {
    const { first, repeat } = pick(exact);
    return {
      firstPublish: first,
      firstPublishSource: "exact",
      repeatPublish: repeat,
      repeatPublishSource: repeat ? "exact" : null,
    };
  }
  if (inferred && inferred.length > 0) {
    const { first, repeat } = pick(inferred);
    return {
      firstPublish: first,
      firstPublishSource: "inferred",
      repeatPublish: repeat,
      repeatPublishSource: repeat ? "inferred" : null,
    };
  }
  return { firstPublish: null, firstPublishSource: null, repeatPublish: null, repeatPublishSource: null };
}

export function buildMilestones(
  user: AuthUserLite,
  connectedAt: string | null,
  firstGenAt: string | null,
  exactPublishes: string[] | undefined,
  inferredPublishes: string[] | undefined,
): Milestones {
  const publish = resolvePublishMilestones(exactPublishes, inferredPublishes);
  return {
    signup: user.created_at,
    pinterestConnected: connectedAt,
    firstGeneration: firstGenAt,
    ...publish,
  };
}

/**
 * Roll a cohort of milestone bundles into monotonic stage counts + a stuck count
 * per stage + the exact/inferred split for the two publish stages. Pure.
 */
export function rollUp(cohort: Milestones[]): { stages: StageCount[]; publishSplit: PublishSourceSplit[] } {
  const reachedFlags = (m: Milestones): Record<FunnelStage, boolean> => {
    // Monotonic: each stage requires all prior milestones present.
    const s = !!m.signup;
    const c = s && !!m.pinterestConnected;
    const g = c && !!m.firstGeneration;
    const p = g && !!m.firstPublish;
    const r = p && !!m.repeatPublish;
    return { signup: s, pinterestConnected: c, firstGeneration: g, firstPublish: p, repeatPublish: r };
  };

  const reachedCounts: Record<FunnelStage, number> = {
    signup: 0, pinterestConnected: 0, firstGeneration: 0, firstPublish: 0, repeatPublish: 0,
  };
  let firstExact = 0, firstInferred = 0, repeatExact = 0, repeatInferred = 0;

  for (const m of cohort) {
    const flags = reachedFlags(m);
    for (const stage of FUNNEL_STAGES) if (flags[stage]) reachedCounts[stage] += 1;
    if (flags.firstPublish) {
      if (m.firstPublishSource === "exact") firstExact += 1;
      else if (m.firstPublishSource === "inferred") firstInferred += 1;
    }
    if (flags.repeatPublish) {
      if (m.repeatPublishSource === "exact") repeatExact += 1;
      else if (m.repeatPublishSource === "inferred") repeatInferred += 1;
    }
  }

  const stages: StageCount[] = FUNNEL_STAGES.map((stage, i) => {
    const next = FUNNEL_STAGES[i + 1];
    const reached = reachedCounts[stage];
    const stuck = next ? reached - reachedCounts[next] : 0;
    return { stage, reached, stuck };
  });

  const publishSplit: PublishSourceSplit[] = [
    { stage: "firstPublish", exact: firstExact, inferred: firstInferred },
    { stage: "repeatPublish", exact: repeatExact, inferred: repeatInferred },
  ];
  return { stages, publishSplit };
}

// ── public entry point ─────────────────────────────────────────────────────────

export async function getActivationFunnel(injectedDb?: SupabaseLikeDb): Promise<ActivationFunnel> {
  const db = injectedDb ?? (await createAdminDb());
  const warnings: string[] = [];
  const since = isoHoursAgo(COHORT_WINDOW_DAYS * 24);

  const users = await listAllAuthUsers(db, warnings);
  if (users === null) {
    return {
      available: false, generatedAt: new Date().toISOString(), cohortWindowDays: COHORT_WINDOW_DAYS,
      cohortSize: 0, warnings, stages: [], publishSplit: [],
    };
  }

  const cohortUsers = users.filter(u => u.created_at && u.created_at >= since);

  const [connByUser, genByUser, exactByUser, inferredByUser] = await Promise.all([
    loadEarliestConnection(db, warnings),
    loadEarliestGeneration(db, since, warnings),
    loadExactPublishes(db, since, warnings),
    loadInferredPublishes(db, since, warnings),
  ]);

  const cohort: Milestones[] = cohortUsers.map(u =>
    buildMilestones(u, connByUser.get(u.id) ?? null, genByUser.get(u.id) ?? null, exactByUser.get(u.id), inferredByUser.get(u.id)),
  );

  const { stages, publishSplit } = rollUp(cohort);

  return {
    available: true,
    generatedAt: new Date().toISOString(),
    cohortWindowDays: COHORT_WINDOW_DAYS,
    cohortSize: cohort.length,
    warnings,
    stages,
    publishSplit,
  };
}
