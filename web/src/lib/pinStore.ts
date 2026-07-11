/**
 * pinStore.ts
 *
 * Client-side pin and session status store backed by localStorage.
 * Single source of truth for pin statuses across Create Pin, History, and Weekly Plan.
 *
 * All functions are synchronous and safe to call during client component renders.
 * Emits "vp:pin_store_updated" on window after every write so listeners can re-read.
 */

import type { StoreSyncAdapter } from "./userStoreSync";

const STORE_KEY  = "vp:pin_store:v1";
export const PIN_STORE_EVENT = "vp:pin_store_updated";
/** Local hot-cache cap (sessions). `let` so tests can shrink it; product default 200. */
let MAX_SESSIONS = 200;

// ── Types ─────────────────────────────────────────────────────────────────────

export type PinStatus     = "generated" | "added_to_plan" | "ready";
export type SessionStatus = "generated" | "partially_added_to_plan" | "added_to_plan";

export interface PinRecord {
  id:               string;   // `${sessionId}_g${gi}_i${ii}`
  imageUrl:         string;
  sessionId:        string;
  keyword:          string;
  category:         string;
  groupIndex:       number;
  refUrl:           string | null;
  status:           PinStatus;
  weeklyPlanItemId?: string;
  addedToPlanAt?:   string;
  createdAt:        string;
  updatedAt?:       string;   // ISO — stamped on every write (account sync LWW key)
}

export interface PinSession {
  id:         string;   // matches HistoryEntry.id
  keyword:    string;
  category:   string;
  source:     string;
  status:     SessionStatus;
  pinIds:     string[];
  groups:     Array<{ refUrl: string | null; pinIds: string[] }>;
  totalPins:  number;
  addedCount: number;
  createdAt:  string;
  updatedAt:  string;
}

interface StoreData {
  sessions: Record<string, PinSession>;
  pins:     Record<string, PinRecord>;
}

// ── Internal I/O ─────────────────────────────────────────────────────────────

// Capacity-eviction shadows (account sync, WP-B). See pinMetadataStore for the
// rationale: localStorage is a bounded hot cache, but the sync server is the FULL
// set, so capacity-evicted sessions/pins are kept here (this session) and still
// reported by the adapters' getAll() — a trim never looks like a user delete, so no
// tombstone storm. Real deletes aren't a public op here, so nothing removes from the
// shadows except re-materialization; reload starts them empty (safe via baseline).
const _evictedSessions = new Map<string, PinSession>();
const _evictedPins     = new Map<string, PinRecord>();

function ok(): boolean { return typeof window !== "undefined"; }

function load(): StoreData {
  if (!ok()) return { sessions: {}, pins: {} };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { sessions: {}, pins: {} };
    const p = JSON.parse(raw) as Partial<StoreData>;
    return { sessions: p.sessions ?? {}, pins: p.pins ?? {} };
  } catch { return { sessions: {}, pins: {} }; }
}

function persist(data: StoreData): void {
  if (!ok()) return;
  // Trim to newest MAX_SESSIONS sessions before writing
  const sortedAll = Object.values(data.sessions).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const sorted = sortedAll.slice(0, MAX_SESSIONS);
  const keptSessionIds = new Set(sorted.map(s => s.id));
  const keepPinIds = new Set(sorted.flatMap(s => s.pinIds));

  // Capacity-evicted sessions/pins → shadows (keep them in the sync set, no tombstone).
  for (const s of sortedAll.slice(MAX_SESSIONS)) _evictedSessions.set(s.id, s);
  for (const id of keptSessionIds) _evictedSessions.delete(id);
  for (const [id, p] of Object.entries(data.pins)) {
    if (!keepPinIds.has(p.id)) _evictedPins.set(id, p);
  }
  for (const id of keepPinIds) _evictedPins.delete(id);

  const trimmed: StoreData = {
    sessions: Object.fromEntries(sorted.map(s => [s.id, s])),
    pins:     Object.fromEntries(
      Object.entries(data.pins).filter(([, p]) => keepPinIds.has(p.id)),
    ),
  };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(trimmed));
  } catch {
    // Quota exceeded — drop to newest 50
    const half = sorted.slice(0, 50);
    const halfPinIds = new Set(half.flatMap(s => s.pinIds));
    const halved: StoreData = {
      sessions: Object.fromEntries(half.map(s => [s.id, s])),
      pins:     Object.fromEntries(Object.entries(trimmed.pins).filter(([, p]) => halfPinIds.has(p.id))),
    };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(halved)); } catch { /* give up */ }
  }
}

function emit(): void {
  if (ok()) window.dispatchEvent(new Event(PIN_STORE_EVENT));
}

// ── Writes ────────────────────────────────────────────────────────────────────

/**
 * Register a new generation session.
 * Call once after generation completes, using the HistoryEntry id as sessionId.
 */
export function createSession(
  sessionId: string,
  keyword:   string,
  category:  string,
  source:    string,
  groups:    Array<{ refUrl: string | null; images: string[] }>,
): PinSession {
  const data = load();
  const now  = new Date().toISOString();

  const sessionGroups: PinSession["groups"] = [];
  const allPinIds: string[] = [];

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const groupPinIds: string[] = [];
    for (let ii = 0; ii < g.images.length; ii++) {
      const pinId = `${sessionId}_g${gi}_i${ii}`;
      data.pins[pinId] = {
        id:         pinId,
        imageUrl:   g.images[ii],
        sessionId,
        keyword,
        category,
        groupIndex: gi,
        refUrl:     g.refUrl,
        status:     "generated",
        createdAt:  now,
        updatedAt:  now,
      };
      groupPinIds.push(pinId);
      allPinIds.push(pinId);
    }
    sessionGroups.push({ refUrl: g.refUrl, pinIds: groupPinIds });
  }

  const session: PinSession = {
    id:         sessionId,
    keyword,
    category,
    source,
    status:     "generated",
    pinIds:     allPinIds,
    groups:     sessionGroups,
    totalPins:  allPinIds.length,
    addedCount: 0,
    createdAt:  now,
    updatedAt:  now,
  };
  data.sessions[sessionId] = session;

  persist(data);
  emit();
  return session;
}

/** Mark pins as added to plan, identified by image URL. */
export function markPinsByImageUrls(imageUrls: string[], weeklyPlanItemId?: string): void {
  const data   = load();
  const urlMap = new Map<string, string>(); // imageUrl → pinId
  for (const [id, pin] of Object.entries(data.pins)) urlMap.set(pin.imageUrl, id);

  const now             = new Date().toISOString();
  const touchedSessions = new Set<string>();

  for (const url of imageUrls) {
    const pinId = urlMap.get(url);
    if (!pinId) continue;
    const pin = data.pins[pinId];
    if (!pin) continue;
    pin.status        = "added_to_plan";
    pin.addedToPlanAt = now;
    pin.updatedAt     = now;
    if (weeklyPlanItemId) pin.weeklyPlanItemId = weeklyPlanItemId;
    touchedSessions.add(pin.sessionId);
  }

  for (const sid of touchedSessions) {
    const session = data.sessions[sid];
    if (!session) continue;
    const pins       = session.pinIds.map(id => data.pins[id]).filter(Boolean) as PinRecord[];
    const addedCount = pins.filter(p => p.status !== "generated").length;
    session.addedCount = addedCount;
    session.status     =
      addedCount === 0                 ? "generated"
      : addedCount < session.totalPins ? "partially_added_to_plan"
      : "added_to_plan";
    session.updatedAt = now;
  }

  persist(data);
  emit();
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export function getSession(sessionId: string): PinSession | null {
  return load().sessions[sessionId] ?? null;
}

export function getSessionPins(sessionId: string): PinRecord[] {
  const data    = load();
  const session = data.sessions[sessionId];
  if (!session) return [];
  return session.pinIds.map(id => data.pins[id]).filter(Boolean) as PinRecord[];
}

export function getPinByImageUrl(imageUrl: string): PinRecord | null {
  const data = load();
  for (const pin of Object.values(data.pins)) {
    if (pin.imageUrl === imageUrl) return pin;
  }
  return null;
}

/**
 * Summary used by Weekly Plan to show pin counts per plan item.
 * Sums `addedCount` across all sessions that match keyword + category.
 */
export function getPlanPinSummary(keyword: string, category: string): {
  addedCount:    number;
  latestSession: PinSession | null;
} {
  const data     = load();
  const sessions = Object.values(data.sessions)
    .filter(s =>
      s.keyword.toLowerCase() === keyword.toLowerCase() &&
      (!category || s.category.toLowerCase() === category.toLowerCase()),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (sessions.length === 0) return { addedCount: 0, latestSession: null };
  const addedCount = sessions.reduce((n, s) => n + s.addedCount, 0);
  return { addedCount, latestSession: sessions[0] };
}

/** Derive session status label for UI display. */
export function sessionStatusLabel(status: SessionStatus): string {
  if (status === "added_to_plan")           return "Added to Plan";
  if (status === "partially_added_to_plan") return "Partially added";
  return "Generated";
}

export function sessionStatusColor(status: SessionStatus): string {
  if (status === "added_to_plan")           return "#059669";
  if (status === "partially_added_to_plan") return "#D97706";
  return "#94A3B8";
}

// ── Account-level sync (WP-B) ────────────────────────────────────────────────
// Two adapters over the ONE localStorage doc: `pin_sessions` (doc_id = session id)
// and `pin_records` (doc_id = pin id). They share PIN_STORE_EVENT. Both report the
// hot cache PLUS their capacity-eviction shadow so MAX_SESSIONS trims never look
// like deletes. Each mergeServer LWW-merges then persists+emits once.

function pinStoreTsMs(v: string | null | undefined): number {
  const ms = v ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/** Stable LWW key for a pin: updatedAt if present, else its createdAt. */
function pinUpdatedAt(p: PinRecord): string {
  return p.updatedAt || p.createdAt;
}

export const pinSessionsSyncAdapter: StoreSyncAdapter<PinSession> = {
  storeKey: "pin_sessions",
  eventName: PIN_STORE_EVENT,
  getAll() {
    const present = load().sessions;
    const out: Array<{ id: string; updatedAt: string; doc: PinSession }> = [];
    const seen = new Set<string>();
    for (const s of Object.values(present)) {
      out.push({ id: s.id, updatedAt: s.updatedAt, doc: s });
      seen.add(s.id);
    }
    for (const s of _evictedSessions.values()) {
      if (!seen.has(s.id)) out.push({ id: s.id, updatedAt: s.updatedAt, doc: s });
    }
    return out;
  },
  mergeServer(live, deleted) {
    if (!ok()) return;
    const data = load();
    let changed = false;
    for (const inc of live) {
      if (!inc || typeof inc.id !== "string" || !inc.id) continue;
      const local = data.sessions[inc.id] ?? _evictedSessions.get(inc.id) ?? null;
      if (local && pinStoreTsMs(inc.updatedAt) <= pinStoreTsMs(local.updatedAt)) continue;
      data.sessions[inc.id] = inc;
      _evictedSessions.delete(inc.id);
      changed = true;
    }
    for (const t of deleted) {
      if (!t || typeof t.id !== "string") continue;
      const local = data.sessions[t.id] ?? _evictedSessions.get(t.id) ?? null;
      if (!local) continue;
      if (pinStoreTsMs(local.updatedAt) >= pinStoreTsMs(t.deletedAt)) continue;
      delete data.sessions[t.id];
      _evictedSessions.delete(t.id);
      changed = true;
    }
    if (changed) { persist(data); emit(); }
  },
};

export const pinRecordsSyncAdapter: StoreSyncAdapter<PinRecord> = {
  storeKey: "pin_records",
  eventName: PIN_STORE_EVENT,
  getAll() {
    const present = load().pins;
    const out: Array<{ id: string; updatedAt: string; doc: PinRecord }> = [];
    const seen = new Set<string>();
    for (const p of Object.values(present)) {
      out.push({ id: p.id, updatedAt: pinUpdatedAt(p), doc: p });
      seen.add(p.id);
    }
    for (const p of _evictedPins.values()) {
      if (!seen.has(p.id)) out.push({ id: p.id, updatedAt: pinUpdatedAt(p), doc: p });
    }
    return out;
  },
  mergeServer(live, deleted) {
    if (!ok()) return;
    const data = load();
    let changed = false;
    for (const inc of live) {
      if (!inc || typeof inc.id !== "string" || !inc.id) continue;
      const local = data.pins[inc.id] ?? _evictedPins.get(inc.id) ?? null;
      if (local && pinStoreTsMs(pinUpdatedAt(inc)) <= pinStoreTsMs(pinUpdatedAt(local))) continue;
      data.pins[inc.id] = inc;
      _evictedPins.delete(inc.id);
      changed = true;
    }
    for (const t of deleted) {
      if (!t || typeof t.id !== "string") continue;
      const local = data.pins[t.id] ?? _evictedPins.get(t.id) ?? null;
      if (!local) continue;
      if (pinStoreTsMs(pinUpdatedAt(local)) >= pinStoreTsMs(t.deletedAt)) continue;
      delete data.pins[t.id];
      _evictedPins.delete(t.id);
      changed = true;
    }
    if (changed) { persist(data); emit(); }
  },
};

// ── Test-only hooks (not used by product code) ───────────────────────────────
export function __setMaxSessionsForTests(n: number): void { MAX_SESSIONS = n; }
export function __resetPinStoreForTests(): void {
  _evictedSessions.clear();
  _evictedPins.clear();
  MAX_SESSIONS = 200;
}
