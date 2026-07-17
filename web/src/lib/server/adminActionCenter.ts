// ── Admin Action Center — today's blocked-users list (READ-ONLY) ─────────────
//
// Powers the admin operator console's "who is stuck right now" list AND the
// Customer 360 per-user alert strip. Both call the SAME predicate implementation
// (evaluateBlockers) so the list and the detail view can never diverge.
//
// This layer returns DATA ONLY — enum codes, ids, timestamps, small typed
// evidence objects. NEVER display strings; the UI layer does i18n later.
//
// SOURCING (exact vs inferred), per the observability contract:
//   * EXACT metrics come from analytics_events publish events (pinterest_publish_
//     attempted/_succeeded/_failed), which exist only from deployment onward.
//   * INFERRED metrics come from pin_drafts.payload draft-state (postedAt /
//     publishError / scheduled time passed with no postedAt). Draft-state is
//     overwritten per attempt, so it is a fallback, never preferred over an event.
// Every blocker item carries a `dataQuality: "exact" | "inferred"` marker.
//
// Graceful degradation (adminOverview.ts conventions): a missing table/column or
// a permission error turns into a warning + an empty contribution, never a crash.
//
// Efficiency: bounded, aggregate scans (a handful of round-trips), NOT per-user
// query loops. auth listUsers is paginated (loop pages). Row scans that could
// exceed supabase-js's silent 1000-row cap use paginated .range() loops.

import type { SupabaseLikeDb, PgError } from "./adminQueryUtils";
import {
  createAdminDb,
  isMissingSchema,
  isoHoursAgo,
  listAllAuthUsers,
  paginateRows,
  type AuthUserLite,
} from "./adminQueryUtils";

// ── enums / contract types ───────────────────────────────────────────────────

export type BlockerType =
  | "publish_failure"
  | "pinterest_disconnected"
  | "generation_failures"
  | "signup_not_connected"
  | "connected_not_creating";

export type DataQuality = "exact" | "inferred";

/** A stable reason CODE for pinterest_disconnected (there is no error-text column). */
export type PinterestDisconnectReason = "needs_reconnect" | "disconnected";

/**
 * Small typed evidence bag — enough for the UI to render a reason with no free
 * text. Only the fields relevant to the item's blockerType are populated.
 */
export interface BlockerEvidence {
  /** publish_failure: failed publish attempts in the window (exact) OR ≥1 when inferred from a draft's publishError. */
  failedPublishCount?: number;
  /** publish_failure: sanitized error code from the failed event / draft (never prose). */
  publishErrorCode?: string | null;
  /** publish_failure / connected_not_creating: an offending draft id, when known. */
  draftId?: string | null;
  /** pinterest_disconnected: stable reason code. */
  disconnectReason?: PinterestDisconnectReason;
  /** generation_failures: failed generation count in the window. */
  failedGenerationCount?: number;
  /** signup_not_connected / connected_not_creating: hours since the anchoring event. */
  ageHours?: number;
}

export interface BlockerItem {
  userId: string;
  email: string | null;
  blockerType: BlockerType;
  /** When this blocker first became true (best available anchor timestamp, ISO). */
  firstSeenAt: string | null;
  dataQuality: DataQuality;
  evidence: BlockerEvidence;
}

/** The 4 boolean health signals + the derived band. Billing NEVER participates. */
export interface UserHealth {
  activeLast7d: boolean;
  publishedLast14d: boolean;
  pinterestHealthy: boolean;
  noOpenBlockers: boolean;
  band: "green" | "yellow" | "red";
  /** Which signals are false (the drivers of a non-green band). */
  drivers: Array<"activeLast7d" | "publishedLast14d" | "pinterestHealthy" | "noOpenBlockers">;
}

export interface ActionCenter {
  available: boolean;
  generatedAt: string;
  windowHours: number;
  warnings: string[];
  items: BlockerItem[];
}

export interface UserBlockers {
  userId: string;
  blockers: BlockerItem[];
  health: UserHealth;
  warnings: string[];
}

// ── per-user fact bundle (assembled once, shared by all predicates) ───────────
//
// We assemble a compact per-user fact table from a few aggregate scans, then run
// the SAME pure predicate set over it for both the list (all users) and one user.

interface PublishFacts {
  /** latest pinterest_publish_failed (exact) at/after windowStart. */
  lastFailedAt: string | null;
  lastFailedCode: string | null;
  lastFailedDraftId: string | null;
  failedCountInWindow: number;
  /** latest pinterest_publish_succeeded (exact), any time in the scanned window. */
  lastSucceededAt: string | null;
  /** earliest succeeded (exact) — first successful publish. */
  firstSucceededAt: string | null;
}

interface DraftFacts {
  /** a live draft carrying payload.publishError (inferred publish failure). */
  publishErrorDraftId: string | null;
  publishErrorCode: string | null;
  /** a live draft whose scheduled_at passed with no postedAt (inferred stuck publish). */
  overdueDraftId: string | null;
  overdueScheduledAt: string | null;
  /** earliest postedAt across the user's drafts (inferred first publish). */
  firstPostedAt: string | null;
  /** most recent postedAt (inferred recent publish activity). */
  lastPostedAt: string | null;
  /** any live (non-deleted) draft exists at all. */
  hasAnyDraft: boolean;
  /** most recent draft updated_at (activity signal). */
  lastDraftUpdatedAt: string | null;
}

interface ConnFacts {
  createdAt: string | null;
  needsReconnect: boolean;
  disconnectedAt: string | null;
  hasRow: boolean;
}

interface GenFacts {
  lastFailedAt: string | null;
  lastSucceededAt: string | null;
  failedCountInWindow: number;
  lastCreatedAt: string | null;
  totalCount: number;
}

interface UserFacts {
  user: AuthUserLite;
  publish: PublishFacts;
  draft: DraftFacts;
  conn: ConnFacts;
  gen: GenFacts;
}

// ── time constants ────────────────────────────────────────────────────────────

const WINDOW_HOURS = 24;
const SIGNUP_NOT_CONNECTED_HOURS = 48;
const CONNECTED_NOT_CREATING_HOURS = 72;
const ACTIVE_WINDOW_HOURS = 24 * 7; // 7d
const PUBLISHED_WINDOW_HOURS = 24 * 14; // 14d
// How far back the event/draft/generation scans reach. Generously covers the 14d
// health window; blocker predicates apply their own tighter windows on top.
const SCAN_WINDOW_HOURS = 24 * 30;

// ── predicate helpers (pure — operate on the assembled facts) ─────────────────

function older(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}
function newer(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}
function hoursSince(iso: string | null): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  return Math.round((Date.now() - t) / 3_600_000);
}

/**
 * publish_failure. EXACT wins: a pinterest_publish_failed inside the window with
 * no LATER pinterest_publish_succeeded. INFERRED fallback (only when no exact
 * signal): a live draft with payload.publishError, or a scheduled time passed
 * with no postedAt.
 */
function evalPublishFailure(f: UserFacts, windowStart: string): BlockerItem | null {
  const p = f.publish;
  const exactFailed =
    p.lastFailedAt &&
    p.lastFailedAt >= windowStart &&
    (!p.lastSucceededAt || p.lastSucceededAt < p.lastFailedAt);
  if (exactFailed) {
    return {
      userId: f.user.id,
      email: f.user.email,
      blockerType: "publish_failure",
      firstSeenAt: p.lastFailedAt,
      dataQuality: "exact",
      evidence: {
        failedPublishCount: p.failedCountInWindow || 1,
        publishErrorCode: p.lastFailedCode,
        draftId: p.lastFailedDraftId,
      },
    };
  }

  const d = f.draft;
  if (d.publishErrorDraftId) {
    return {
      userId: f.user.id,
      email: f.user.email,
      blockerType: "publish_failure",
      firstSeenAt: d.lastDraftUpdatedAt,
      dataQuality: "inferred",
      evidence: { failedPublishCount: 1, publishErrorCode: d.publishErrorCode, draftId: d.publishErrorDraftId },
    };
  }
  if (d.overdueDraftId) {
    return {
      userId: f.user.id,
      email: f.user.email,
      blockerType: "publish_failure",
      firstSeenAt: d.overdueScheduledAt,
      dataQuality: "inferred",
      evidence: { failedPublishCount: 1, publishErrorCode: null, draftId: d.overdueDraftId },
    };
  }
  return null;
}

/** pinterest_disconnected — needs_reconnect true OR disconnected_at non-null. */
function evalPinterestDisconnected(f: UserFacts): BlockerItem | null {
  const c = f.conn;
  if (!c.hasRow) return null;
  if (c.disconnectedAt) {
    return {
      userId: f.user.id,
      email: f.user.email,
      blockerType: "pinterest_disconnected",
      firstSeenAt: c.disconnectedAt,
      dataQuality: "exact",
      evidence: { disconnectReason: "disconnected" },
    };
  }
  if (c.needsReconnect) {
    return {
      userId: f.user.id,
      email: f.user.email,
      blockerType: "pinterest_disconnected",
      firstSeenAt: c.createdAt,
      dataQuality: "exact",
      evidence: { disconnectReason: "needs_reconnect" },
    };
  }
  return null;
}

/** generation_failures — ≥2 failed generations in the window, no success after the last failure. */
function evalGenerationFailures(f: UserFacts): BlockerItem | null {
  const g = f.gen;
  if (g.failedCountInWindow < 2) return null;
  // A success strictly after the last failure clears the block.
  if (g.lastSucceededAt && g.lastFailedAt && g.lastSucceededAt > g.lastFailedAt) return null;
  return {
    userId: f.user.id,
    email: f.user.email,
    blockerType: "generation_failures",
    firstSeenAt: g.lastFailedAt,
    dataQuality: "exact",
    evidence: { failedGenerationCount: g.failedCountInWindow },
  };
}

/** signup_not_connected — auth user created >48h ago with no pinterest connection row. */
function evalSignupNotConnected(f: UserFacts): BlockerItem | null {
  if (f.conn.hasRow) return null;
  const created = f.user.created_at;
  if (!created) return null;
  const ageH = hoursSince(created);
  if (ageH === undefined || ageH < SIGNUP_NOT_CONNECTED_HOURS) return null;
  return {
    userId: f.user.id,
    email: f.user.email,
    blockerType: "signup_not_connected",
    firstSeenAt: created,
    dataQuality: "exact",
    evidence: { ageHours: ageH },
  };
}

/** connected_not_creating — connection created >72h ago, zero generations AND zero drafts. */
function evalConnectedNotCreating(f: UserFacts): BlockerItem | null {
  const c = f.conn;
  if (!c.hasRow || c.disconnectedAt || !c.createdAt) return null;
  const ageH = hoursSince(c.createdAt);
  if (ageH === undefined || ageH < CONNECTED_NOT_CREATING_HOURS) return null;
  if (f.gen.totalCount > 0) return null;
  if (f.draft.hasAnyDraft) return null;
  return {
    userId: f.user.id,
    email: f.user.email,
    blockerType: "connected_not_creating",
    firstSeenAt: c.createdAt,
    dataQuality: "exact",
    evidence: { ageHours: ageH },
  };
}

/** Run every predicate for one user's facts. Exported ONLY for the shared paths. */
export function evaluateBlockers(f: UserFacts, windowStart: string): BlockerItem[] {
  const out: BlockerItem[] = [];
  for (const item of [
    evalPublishFailure(f, windowStart),
    evalPinterestDisconnected(f),
    evalGenerationFailures(f),
    evalSignupNotConnected(f),
    evalConnectedNotCreating(f),
  ]) {
    if (item) out.push(item);
  }
  return out;
}

/** Derive the 4 health signals + band from a user's facts and open blockers. */
export function computeHealth(f: UserFacts, blockers: BlockerItem[]): UserHealth {
  const activeSince = isoHoursAgo(ACTIVE_WINDOW_HOURS);
  const publishedSince = isoHoursAgo(PUBLISHED_WINDOW_HOURS);

  const lastActivity = newer(
    newer(f.user.last_sign_in_at ?? null, f.gen.lastCreatedAt),
    f.draft.lastDraftUpdatedAt,
  );
  const activeLast7d = !!lastActivity && lastActivity >= activeSince;

  const lastPublish = newer(f.publish.lastSucceededAt, f.draft.lastPostedAt);
  const publishedLast14d = !!lastPublish && lastPublish >= publishedSince;

  const pinterestHealthy = f.conn.hasRow && !f.conn.disconnectedAt && !f.conn.needsReconnect;
  const noOpenBlockers = blockers.length === 0;

  const signals = { activeLast7d, publishedLast14d, pinterestHealthy, noOpenBlockers };
  const drivers = (Object.keys(signals) as Array<keyof typeof signals>).filter(k => !signals[k]);
  const falseCount = drivers.length;
  const band: UserHealth["band"] = falseCount === 0 ? "green" : falseCount === 1 ? "yellow" : "red";
  return { ...signals, band, drivers };
}

// ── DB scans → per-user facts ─────────────────────────────────────────────────

const PUBLISH_EVENT_ATTEMPTED = "pinterest_publish_attempted";
const PUBLISH_EVENT_SUCCEEDED = "pinterest_publish_succeeded";
const PUBLISH_EVENT_FAILED = "pinterest_publish_failed";

interface AnalyticsRow {
  user_id: string | null;
  draft_id: string | null;
  event_name: string | null;
  payload: Record<string, unknown> | null;
  created_at: string | null;
}

async function loadPublishFacts(
  db: SupabaseLikeDb,
  since: string,
  windowStart: string,
  warnings: string[],
): Promise<Map<string, PublishFacts>> {
  const byUser = new Map<string, PublishFacts>();
  const empty = (): PublishFacts => ({
    lastFailedAt: null,
    lastFailedCode: null,
    lastFailedDraftId: null,
    failedCountInWindow: 0,
    lastSucceededAt: null,
    firstSucceededAt: null,
  });

  const { rows, error, missing } = await paginateRows<AnalyticsRow>(db, "analytics_events", {
    columns: "user_id,draft_id,event_name,payload,created_at",
    filters: qb =>
      qb
        .in("event_name", [PUBLISH_EVENT_SUCCEEDED, PUBLISH_EVENT_FAILED])
        .gte("created_at", since),
    orderColumn: "created_at",
    ascending: false,
  });
  if (missing) {
    warnings.push("Publish events unavailable — analytics_events not present; publish signals fall back to inferred draft state.");
    return byUser;
  }
  if (error) {
    warnings.push(`analytics_events scan failed: ${error.message ?? "unknown"} — publish signals fall back to inferred draft state.`);
    return byUser;
  }

  for (const r of rows) {
    const uid = r.user_id;
    if (!uid) continue;
    const at = r.created_at;
    const f = byUser.get(uid) ?? empty();
    if (r.event_name === PUBLISH_EVENT_SUCCEEDED) {
      f.lastSucceededAt = newer(f.lastSucceededAt, at);
      f.firstSucceededAt = older(f.firstSucceededAt, at);
    } else if (r.event_name === PUBLISH_EVENT_FAILED) {
      if (at && at >= windowStart) {
        f.failedCountInWindow += 1;
        // rows arrive newest-first; the first FAILED we see in-window is the latest.
        if (!f.lastFailedAt) {
          f.lastFailedAt = at;
          const p = r.payload ?? {};
          f.lastFailedCode = typeof p.errorCode === "string" ? p.errorCode : null;
          f.lastFailedDraftId = r.draft_id ?? null;
        }
      }
    }
    byUser.set(uid, f);
  }
  return byUser;
}

interface DraftRow {
  vibepin_user_id: string | null;
  draft_id: string | null;
  payload: Record<string, unknown> | null;
  updated_at: string | null;
  scheduled_at: string | null;
  deleted_at: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

async function loadDraftFacts(
  db: SupabaseLikeDb,
  since: string,
  warnings: string[],
): Promise<Map<string, DraftFacts>> {
  const byUser = new Map<string, DraftFacts>();
  const empty = (): DraftFacts => ({
    publishErrorDraftId: null,
    publishErrorCode: null,
    overdueDraftId: null,
    overdueScheduledAt: null,
    firstPostedAt: null,
    lastPostedAt: null,
    hasAnyDraft: false,
    lastDraftUpdatedAt: null,
  });
  const nowIso = new Date().toISOString();

  // scheduled_at may not exist (v50 unapplied). Try with it, fall back without.
  let usedScheduled = true;
  let res = await paginateRows<DraftRow>(db, "pin_drafts", {
    columns: "vibepin_user_id,draft_id,payload,updated_at,scheduled_at,deleted_at",
    filters: qb => qb.is("deleted_at", null).gte("updated_at", since),
    orderColumn: "updated_at",
    ascending: false,
  });
  if (res.error && isMissingSchema(res.error)) {
    usedScheduled = false;
    res = await paginateRows<DraftRow>(db, "pin_drafts", {
      columns: "vibepin_user_id,draft_id,payload,updated_at,deleted_at",
      filters: qb => qb.is("deleted_at", null).gte("updated_at", since),
      orderColumn: "updated_at",
      ascending: false,
    });
  }
  if (res.missing) {
    warnings.push("pin_drafts unavailable — inferred publish/draft signals disabled.");
    return byUser;
  }
  if (res.error) {
    warnings.push(`pin_drafts scan failed: ${res.error.message ?? "unknown"}.`);
    return byUser;
  }

  for (const r of res.rows) {
    const uid = r.vibepin_user_id;
    if (!uid) continue;
    const f = byUser.get(uid) ?? empty();
    f.hasAnyDraft = true;
    f.lastDraftUpdatedAt = newer(f.lastDraftUpdatedAt, r.updated_at);
    const p = r.payload ?? {};
    const postedAt = str(p.postedAt);
    if (postedAt) {
      f.firstPostedAt = older(f.firstPostedAt, postedAt);
      f.lastPostedAt = newer(f.lastPostedAt, postedAt);
    }
    const publishError = str(p.publishError);
    if (publishError && !f.publishErrorDraftId) {
      f.publishErrorDraftId = r.draft_id ?? null;
      f.publishErrorCode = str(p.publishErrorCode);
    }
    // Overdue: a scheduled instant in the past with no postedAt on the same draft.
    if (usedScheduled && !postedAt && r.scheduled_at && r.scheduled_at < nowIso && !f.overdueDraftId) {
      f.overdueDraftId = r.draft_id ?? null;
      f.overdueScheduledAt = r.scheduled_at;
    }
    byUser.set(uid, f);
  }
  return byUser;
}

interface ConnRow {
  vibepin_user_id: string | null;
  needs_reconnect: boolean | null;
  disconnected_at: string | null;
  created_at: string | null;
}

async function loadConnFacts(db: SupabaseLikeDb, warnings: string[]): Promise<Map<string, ConnFacts>> {
  const byUser = new Map<string, ConnFacts>();
  const { rows, error, missing } = await paginateRows<ConnRow>(db, "pinterest_connections", {
    columns: "vibepin_user_id,needs_reconnect,disconnected_at,created_at",
    orderColumn: "created_at",
    ascending: true,
  });
  if (missing) {
    warnings.push("pinterest_connections unavailable — connection blockers disabled.");
    return byUser;
  }
  if (error) {
    warnings.push(`pinterest_connections scan failed: ${error.message ?? "unknown"}.`);
    return byUser;
  }
  for (const r of rows) {
    const uid = r.vibepin_user_id;
    if (!uid) continue;
    // Keep the earliest connection row per user (rows arrive oldest-first).
    if (byUser.has(uid)) continue;
    byUser.set(uid, {
      createdAt: r.created_at,
      needsReconnect: !!r.needs_reconnect,
      disconnectedAt: r.disconnected_at,
      hasRow: true,
    });
  }
  return byUser;
}

interface GenRow {
  user_id: string | null;
  created_at: string | null;
  status: string | null;
}

async function loadGenFacts(
  db: SupabaseLikeDb,
  since: string,
  windowStart: string,
  warnings: string[],
): Promise<{ byUser: Map<string, GenFacts>; statusAvailable: boolean }> {
  const byUser = new Map<string, GenFacts>();
  const empty = (): GenFacts => ({
    lastFailedAt: null,
    lastSucceededAt: null,
    failedCountInWindow: 0,
    lastCreatedAt: null,
    totalCount: 0,
  });

  // Try with status; fall back to a status-less scan (older DBs) so totalCount /
  // connected_not_creating still work even when the success/failure split can't.
  let statusAvailable = true;
  let res = await paginateRows<GenRow>(db, "pin_generations", {
    columns: "user_id,created_at,status",
    filters: qb => qb.gte("created_at", since),
    orderColumn: "created_at",
    ascending: false,
  });
  if (res.error && isMissingSchema(res.error)) {
    statusAvailable = false;
    res = await paginateRows<GenRow>(db, "pin_generations", {
      columns: "user_id,created_at",
      filters: qb => qb.gte("created_at", since),
      orderColumn: "created_at",
      ascending: false,
    });
  }
  if (res.missing) {
    warnings.push("pin_generations unavailable — generation blockers disabled.");
    return { byUser, statusAvailable: false };
  }
  if (res.error) {
    warnings.push(`pin_generations scan failed: ${res.error.message ?? "unknown"}.`);
    return { byUser, statusAvailable: false };
  }

  for (const r of res.rows) {
    const uid = r.user_id;
    if (!uid) continue;
    const f = byUser.get(uid) ?? empty();
    f.totalCount += 1;
    f.lastCreatedAt = newer(f.lastCreatedAt, r.created_at);
    if (statusAvailable && r.created_at && r.created_at >= windowStart) {
      if (r.status === "failed") {
        f.failedCountInWindow += 1;
        f.lastFailedAt = newer(f.lastFailedAt, r.created_at);
      } else if (r.status === "completed") {
        f.lastSucceededAt = newer(f.lastSucceededAt, r.created_at);
      }
    }
    byUser.set(uid, f);
  }
  if (!statusAvailable) {
    warnings.push("pin_generations.status column not present — generation_failures blocker cannot fire.");
  }
  return { byUser, statusAvailable };
}

// ── assembly ──────────────────────────────────────────────────────────────────

const EMPTY_PUBLISH: PublishFacts = {
  lastFailedAt: null, lastFailedCode: null, lastFailedDraftId: null,
  failedCountInWindow: 0, lastSucceededAt: null, firstSucceededAt: null,
};
const EMPTY_DRAFT: DraftFacts = {
  publishErrorDraftId: null, publishErrorCode: null, overdueDraftId: null,
  overdueScheduledAt: null, firstPostedAt: null, lastPostedAt: null,
  hasAnyDraft: false, lastDraftUpdatedAt: null,
};
const EMPTY_CONN: ConnFacts = { createdAt: null, needsReconnect: false, disconnectedAt: null, hasRow: false };
const EMPTY_GEN: GenFacts = { lastFailedAt: null, lastSucceededAt: null, failedCountInWindow: 0, lastCreatedAt: null, totalCount: 0 };

function assembleFacts(
  user: AuthUserLite,
  publish: Map<string, PublishFacts>,
  draft: Map<string, DraftFacts>,
  conn: Map<string, ConnFacts>,
  gen: Map<string, GenFacts>,
): UserFacts {
  return {
    user,
    publish: publish.get(user.id) ?? EMPTY_PUBLISH,
    draft: draft.get(user.id) ?? EMPTY_DRAFT,
    conn: conn.get(user.id) ?? EMPTY_CONN,
    gen: gen.get(user.id) ?? EMPTY_GEN,
  };
}

/** paid = plan metadata present and not "free" (Creem tables absent — degrade silently). */
function isPaid(user: AuthUserLite): boolean {
  const fromApp = user.app_metadata?.["plan"];
  const fromUser = user.user_metadata?.["plan"];
  const plan = typeof fromApp === "string" ? fromApp : typeof fromUser === "string" ? fromUser : null;
  return !!plan && plan.trim().toLowerCase() !== "free";
}

// ── public entry points ────────────────────────────────────────────────────────

export async function getActionCenter(injectedDb?: SupabaseLikeDb): Promise<ActionCenter> {
  const db = injectedDb ?? (await createAdminDb());
  const warnings: string[] = [];
  const since = isoHoursAgo(SCAN_WINDOW_HOURS);
  const windowStart = isoHoursAgo(WINDOW_HOURS);

  const users = await listAllAuthUsers(db, warnings);
  if (users === null) {
    return { available: false, generatedAt: new Date().toISOString(), windowHours: WINDOW_HOURS, warnings, items: [] };
  }

  const [publish, draft, conn, gen] = await Promise.all([
    loadPublishFacts(db, since, windowStart, warnings),
    loadDraftFacts(db, since, warnings),
    loadConnFacts(db, warnings),
    loadGenFacts(db, since, windowStart, warnings).then(r => r.byUser),
  ]);

  const items: BlockerItem[] = [];
  const paidByUser = new Map<string, boolean>();
  for (const user of users) {
    const facts = assembleFacts(user, publish, draft, conn, gen);
    paidByUser.set(user.id, isPaid(user));
    items.push(...evaluateBlockers(facts, windowStart));
  }

  // Sort: paid users first, then by blocker age (oldest firstSeenAt first — the
  // longest-stuck user bubbles to the top).
  items.sort((a, b) => {
    const pa = paidByUser.get(a.userId) ? 0 : 1;
    const pb = paidByUser.get(b.userId) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    // Older firstSeenAt = more urgent → ascending ISO (oldest first).
    return (a.firstSeenAt ?? "").localeCompare(b.firstSeenAt ?? "");
  });

  return { available: true, generatedAt: new Date().toISOString(), windowHours: WINDOW_HOURS, warnings, items };
}

/**
 * Same predicate set for one user — used by the Customer 360 alert strip. Shares
 * evaluateBlockers / computeHealth so the list and the detail view never diverge.
 * A handful of user-scoped queries (small, indexed by user).
 */
export async function getUserBlockers(userId: string, injectedDb?: SupabaseLikeDb): Promise<UserBlockers> {
  const db = injectedDb ?? (await createAdminDb());
  const warnings: string[] = [];
  const since = isoHoursAgo(SCAN_WINDOW_HOURS);
  const windowStart = isoHoursAgo(WINDOW_HOURS);

  let user: AuthUserLite | null = null;
  try {
    const { data, error } = await db.auth.admin.getUserById(userId);
    if (error || !data?.user) warnings.push("User not found or auth admin API unavailable.");
    else user = data.user as unknown as AuthUserLite;
  } catch {
    warnings.push("Auth admin API threw while loading the user.");
  }
  if (!user) {
    const emptyFacts: UserFacts = {
      user: { id: userId, email: null, created_at: null, last_sign_in_at: null },
      publish: EMPTY_PUBLISH, draft: EMPTY_DRAFT, conn: EMPTY_CONN, gen: EMPTY_GEN,
    };
    return { userId, blockers: [], health: computeHealth(emptyFacts, []), warnings };
  }

  const [publish, draft, conn, genRes] = await Promise.all([
    loadPublishFacts(db, since, windowStart, warnings),
    loadDraftFacts(db, since, warnings),
    loadConnFacts(db, warnings),
    loadGenFacts(db, since, windowStart, warnings),
  ]);

  const facts = assembleFacts(user, publish, draft, conn, genRes.byUser);
  const blockers = evaluateBlockers(facts, windowStart);
  const health = computeHealth(facts, blockers);
  return { userId, blockers, health, warnings };
}

/** Convenience: just the health band for one user (shares getUserBlockers). */
export async function getUserHealth(userId: string): Promise<UserHealth> {
  return (await getUserBlockers(userId)).health;
}
