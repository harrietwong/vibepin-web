/**
 * pinDraftSync.ts — WP0 write-through engine for server-authoritative Pin Drafts.
 *
 * Protocol (§5 / §8.3 / §8.5 of the Shopify Phase 1 plan):
 *  - init(getToken) subscribes to DRAFT_STORE_EVENT and diffs the store against
 *    the last-seen snapshot by (id, updatedAt); changes land in an in-memory
 *    outbox (changed → PUT, disappeared → DELETE tombstone).
 *  - Startup: GET /api/pin-drafts (cursor-paginated, includes tombstones) →
 *    pinDraftStore.mergeServerDrafts() LWW merge → the merged SERVER state seeds
 *    the diff baseline, so local-only / locally-newer drafts naturally enter the
 *    outbox = migration-on-first-load (no one-shot flag needed).
 *  - Flush: 1.5s debounce, batched PUT/DELETE of ≤50 drafts per request.
 *  - 409 stale (the server's write predicate lost its compare-and-set): RE-BASE the
 *    conflicted drafts onto the server's CURRENT row — field-level, keeping only
 *    what the merchant changed while the PUT was in flight (pinDraftStore
 *    rebaseDraftOnServer) — then retry ONCE. Deliberately NOT the whole-payload
 *    LWW the pull uses: a local edit made during a publish is newer, so LWW would
 *    hand back the entire pre-publish copy and resurrect the schedule the cron had
 *    just cleared. Still stale → give up for this cycle (warn + re-arm a flush);
 *    never loop, never drop.
 *  - Failures (network / 401 / 5xx / 202 deferred): outbox is NEVER dropped;
 *    exponential backoff capped at 60s keeps retrying. localStorage remains the
 *    offline cache layer, so a dead server costs nothing (§8.3 zero regression).
 *  - Drafts whose payload exceeds 200KB are skipped with a warning (the server
 *    would 413 the whole batch otherwise); everything else keeps syncing.
 *
 * SSR-safe: init() is a no-op without window. init() is idempotent.
 */

import {
  DRAFT_STORE_EVENT,
  getAllDrafts,
  getDraft,
  mergeServerDrafts,
  rebaseDraftOnServer,
  type PinDraft,
} from "./pinDraftStore";

// ── Types ─────────────────────────────────────────────────────────────────────

export type GetAccessToken = () => Promise<string | null>;

export interface PinDraftSyncOptions {
  /** Debounce between a store write and the flush. Default 1500ms. */
  debounceMs?: number;
  /** First retry delay after a failure. Default 2000ms. */
  backoffBaseMs?: number;
  /** Retry delay cap. Default 60000ms. */
  backoffMaxMs?: number;
  /** Max drafts per PUT/DELETE request. Default 50. */
  batchSize?: number;
  /** Per-draft payload byte cap (server rejects above this). Default 200KB. */
  maxPayloadBytes?: number;
  /** GET page size. Default 100. */
  pageSize?: number;
  /** Injectable fetch (tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** API base path. Default "/api/pin-drafts". */
  endpoint?: string;
}

/**
 * WP-E: same-shape aggregate status as userStoreSync.AggregateSyncStatus, so a
 * single UI indicator can merge both engines. The pin-draft engine is a singleton,
 * so errorStores is either [] or ["pin-drafts"].
 */
export interface PinDraftSyncStatus {
  state: "synced" | "syncing" | "error";
  pendingCount: number;
  errorStores: string[];
}

/** WP-E telemetry hooks, injected by the registry (keeps analytics out of the engine). */
export interface PinDraftSyncTelemetry {
  onErrorEntered?(failureCount: number): void;
  onRecovered?(downMs: number): void;
  onOversizeSkipped?(draftId: string): void;
}

const PIN_DRAFT_STORE_KEY = "pin-drafts";
const ERROR_THRESHOLD = 3;

type OutboxEntry =
  | { kind: "put"; updatedAt: string }
  | { kind: "delete"; deletedAt: string };

interface ServerDraftRecord {
  draftId: string;
  updatedAt: string;
  deletedAt?: string;
  payload: Record<string, unknown>;
}

// ── Module state (singleton engine) ───────────────────────────────────────────

const DEFAULTS = {
  debounceMs: 1_500,
  backoffBaseMs: 2_000,
  backoffMaxMs: 60_000,
  batchSize: 50,
  maxPayloadBytes: 200 * 1024,
  pageSize: 100,
  endpoint: "/api/pin-drafts",
};

let _initialized = false;
let _ready = false; // true once the startup pull + baseline seed completed
let _getToken: GetAccessToken | null = null;
let _opts = { ...DEFAULTS, fetchImpl: undefined as typeof fetch | undefined };

/** Last-seen local state (id → updatedAt). Seeded from the server after the pull. */
let _lastSeen = new Map<string, string>();
/** Pending changes not yet acknowledged by the server. Never dropped on failure. */
let _outbox = new Map<string, OutboxEntry>();

let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _retryTimer: ReturnType<typeof setTimeout> | null = null;
let _flushing = false;
let _flushQueued = false;
let _failureCount = 0;
let _unsubscribe: (() => void) | null = null;

// ── WP-E: status pub/sub + telemetry ───────────────────────────────────────────
let _telemetry: PinDraftSyncTelemetry | null = null;
const _statusSubs = new Set<() => void>();
let _lastStatus: PinDraftSyncStatus | null = null;
let _inErrorState = false;
let _errorSince = 0;

/** Register telemetry hooks (registry layer). Pass null to detach. */
export function setPinDraftSyncTelemetry(telemetry: PinDraftSyncTelemetry | null): void {
  _telemetry = telemetry;
}

function computeStatus(): PinDraftSyncStatus {
  const pendingCount = _outbox.size;
  const inError = _failureCount >= ERROR_THRESHOLD;
  const state: PinDraftSyncStatus["state"] =
    inError ? "error" : pendingCount > 0 || !_ready ? "syncing" : "synced";
  return { state, pendingCount, errorStores: inError ? [PIN_DRAFT_STORE_KEY] : [] };
}

function statusEqual(a: PinDraftSyncStatus, b: PinDraftSyncStatus): boolean {
  return (
    a.state === b.state &&
    a.pendingCount === b.pendingCount &&
    a.errorStores.length === b.errorStores.length &&
    a.errorStores.every((s, i) => s === b.errorStores[i])
  );
}

/** Recompute; notify subscribers ONLY when the value actually changed. */
function notifyStatus(): void {
  const next = computeStatus();
  if (_lastStatus && statusEqual(_lastStatus, next)) return;
  _lastStatus = next;
  for (const cb of _statusSubs) {
    try { cb(); } catch { /* a subscriber must never break the engine */ }
  }
}

/** Current status. Reference-stable for useSyncExternalStore. */
export function getPinDraftSyncStatus(): PinDraftSyncStatus {
  if (!_lastStatus) _lastStatus = computeStatus();
  return _lastStatus;
}

/** Subscribe to status changes (useSyncExternalStore). Returns unsubscribe. */
export function subscribePinDraftSyncStatus(cb: () => void): () => void {
  _statusSubs.add(cb);
  return () => { _statusSubs.delete(cb); };
}

function maybeEnterError(): void {
  if (_failureCount >= ERROR_THRESHOLD && !_inErrorState) {
    _inErrorState = true;
    _errorSince = Date.now();
    _telemetry?.onErrorEntered?.(_failureCount);
  }
}

function maybeRecover(): void {
  if (_inErrorState) {
    const downMs = Date.now() - _errorSince;
    _inErrorState = false;
    _errorSince = 0;
    _telemetry?.onRecovered?.(downMs);
  }
}

function fetcher(): typeof fetch {
  return _opts.fetchImpl ?? fetch;
}

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Mount the write-through engine. Safe to call multiple times (idempotent) and
 * safe during SSR (no-op without window).
 */
export function initPinDraftSync(getToken: GetAccessToken, options?: PinDraftSyncOptions): void {
  if (typeof window === "undefined") return;
  if (_initialized) return;
  _initialized = true;
  _getToken = getToken;
  _opts = { ...DEFAULTS, fetchImpl: options?.fetchImpl, ...stripUndefined(options ?? {}) };

  const onStoreEvent = () => {
    if (!_ready) return; // pre-pull writes are captured by the post-seed full diff
    diffNow();
  };
  window.addEventListener(DRAFT_STORE_EVENT, onStoreEvent);
  _unsubscribe = () => window.removeEventListener(DRAFT_STORE_EVENT, onStoreEvent);

  void startupPull();
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && k !== "fetchImpl") (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// ── Startup pull → merge → seed baseline → first diff ────────────────────────

async function startupPull(): Promise<void> {
  try {
    const { live, deleted } = await pullAllPages();

    // LWW merge into the local store (single persist + emit inside).
    mergeServerDrafts(
      live.map(r => r.payload as unknown as PinDraft).filter(d => typeof d?.id === "string" && !!d.id),
      deleted,
    );

    // Baseline = server live state. Local-only or locally-newer drafts then show
    // up as diffs and enter the outbox — this IS the first-load migration.
    _lastSeen = new Map(
      live.map(r => [r.draftId, ((r.payload as { updatedAt?: string }).updatedAt) || r.updatedAt]),
    );
    _ready = true;
    _failureCount = 0;
    maybeRecover();
    diffNow(); // diffNow calls notifyStatus (covers the ready transition)
  } catch {
    // Server unreachable / table pending: retry the pull with backoff. Local
    // behaviour stays pure-localStorage until the pull succeeds (§8.3).
    _failureCount++;
    maybeEnterError();
    notifyStatus();
    scheduleRetry(() => void startupPull());
  }
}

async function pullAllPages(): Promise<{
  live: ServerDraftRecord[];
  deleted: Array<{ id: string; deletedAt: string }>;
}> {
  const token = await requireToken();
  const live: ServerDraftRecord[] = [];
  const deleted: Array<{ id: string; deletedAt: string }> = [];
  let cursor: string | null = null;
  let guard = 0;

  do {
    const qs = new URLSearchParams({ limit: String(_opts.pageSize) });
    if (cursor) qs.set("cursor", cursor);
    const res = await fetcher()(`${_opts.endpoint}?${qs.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`pin-drafts GET failed: ${res.status}`);
    const body = (await res.json()) as { drafts?: ServerDraftRecord[]; nextCursor?: string };
    for (const rec of body.drafts ?? []) {
      if (!rec || typeof rec.draftId !== "string") continue;
      if (rec.deletedAt) deleted.push({ id: rec.draftId, deletedAt: rec.deletedAt });
      else live.push(rec);
    }
    cursor = body.nextCursor ?? null;
  } while (cursor && ++guard < 100);

  return { live, deleted };
}

// ── Diff → outbox ─────────────────────────────────────────────────────────────

function diffNow(): void {
  const current = new Map<string, string>();
  for (const d of getAllDrafts()) current.set(d.id, d.updatedAt);

  let changed = false;

  for (const [id, updatedAt] of current) {
    if (_lastSeen.get(id) !== updatedAt) {
      _outbox.set(id, { kind: "put", updatedAt });
      changed = true;
    }
  }
  for (const id of _lastSeen.keys()) {
    if (!current.has(id)) {
      _outbox.set(id, { kind: "delete", deletedAt: new Date().toISOString() });
      changed = true;
    }
  }

  _lastSeen = current;
  if (changed) scheduleFlush();
  notifyStatus(); // outbox may have grown/shrunk → status may have changed
}

function scheduleFlush(): void {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    void flush();
  }, _opts.debounceMs);
}

function scheduleRetry(run: () => void): void {
  if (_retryTimer) clearTimeout(_retryTimer);
  const delay = Math.min(_opts.backoffBaseMs * 2 ** Math.max(_failureCount - 1, 0), _opts.backoffMaxMs);
  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    run();
  }, delay);
}

// ── Flush (batched PUT / DELETE) ──────────────────────────────────────────────

async function requireToken(): Promise<string> {
  const token = _getToken ? await _getToken() : null;
  if (!token) throw new Error("pin-drafts: no access token");
  return token;
}

async function flush(): Promise<void> {
  if (_flushing) { _flushQueued = true; return; }
  if (_outbox.size === 0) return;
  _flushing = true;

  try {
    const token = await requireToken();

    // Snapshot the entries being flushed; a concurrent edit replaces the entry
    // in the outbox, and we only ack entries that are still identical afterwards.
    const puts: Array<{ id: string; entry: OutboxEntry; draft: PinDraft }> = [];
    const deletes: Array<{ id: string; entry: OutboxEntry; deletedAt: string }> = [];

    for (const [id, entry] of _outbox) {
      if (entry.kind === "delete") {
        deletes.push({ id, entry, deletedAt: entry.deletedAt });
        continue;
      }
      const draft = getDraft(id);
      if (!draft) { _outbox.delete(id); continue; } // deleted meanwhile → a delete entry exists/will exist
      if (payloadBytes(draft) > _opts.maxPayloadBytes) {
        console.warn(`[pinDraftSync] draft ${id} exceeds ${_opts.maxPayloadBytes} bytes — skipped`);
        _outbox.delete(id);
        _telemetry?.onOversizeSkipped?.(id);
        continue;
      }
      puts.push({ id, entry, draft });
    }

    for (let i = 0; i < puts.length; i += _opts.batchSize) {
      const chunk = puts.slice(i, i + _opts.batchSize);
      const res = await putChunk(token, chunk);
      if (res.status === 202) throw new DeferredError(); // table not applied yet — keep outbox, retry later

      if (res.status === 409) {
        // The server refused these drafts because the stored row changed between
        // its read and its write — the row we are holding is genuinely older than
        // what is stored. Reconcile instead of insisting: re-base onto the server's
        // copy, keeping only the fields edited since THIS chunk was sent (see
        // reconcileStale), and send the merged result once.
        const conflicted = await reconcileStale(res, chunk);
        // Everything the server DID apply in that request is durable; only the
        // conflicted ids still owe a write.
        ackEntries(chunk.filter(c => !conflicted.has(c.id)));
        if (conflicted.size === 0) continue;

        const retry = rebuildChunk(conflicted);
        if (retry.length === 0) { scheduleFlush(); continue; }
        const res2 = await putChunk(token, retry);
        if (res2.status === 202) throw new DeferredError();
        if (res2.status === 409) {
          // Lost the race twice in one cycle. Stop here on purpose: a third attempt
          // is the same bet, and looping would hammer the endpoint for as long as
          // the other writer keeps winning. The entries stay in the outbox and the
          // next flush picks them up with a freshly merged payload — so this is a
          // delay, never a dropped edit. Warn, because silence here would look
          // exactly like a successful sync.
          // Fold the SECOND conflict's current row in as well, so the next cycle
          // starts from what is actually stored instead of repeating this dance.
          await reconcileStale(res2, retry);
          console.warn(
            `[pinDraftSync] draft(s) still stale after one merge+retry — deferred to the next sync: ${[...conflicted].join(", ")}`,
          );
          // Re-arm a flush. The engine has no periodic timer, so without this the
          // entry would sit in the outbox until some unrelated store write happens
          // — pendingCount stuck at 1 forever is the silent drop this must not be.
          // Bounded work per cycle (one PUT + at most one retry), debounce-spaced,
          // and each cycle re-merges first, so the payload converges rather than
          // re-sending the same losing copy.
          scheduleFlush();
          continue;
        }
        if (!res2.ok) throw new Error(`pin-drafts PUT failed: ${res2.status}`);
        ackEntries(retry);
        continue;
      }

      if (!res.ok) throw new Error(`pin-drafts PUT failed: ${res.status}`);
      ackEntries(chunk);
    }

    for (let i = 0; i < deletes.length; i += _opts.batchSize) {
      const chunk = deletes.slice(i, i + _opts.batchSize);
      const deletedAt = chunk.reduce((max, c) => (c.deletedAt > max ? c.deletedAt : max), chunk[0].deletedAt);
      const res = await fetcher()(_opts.endpoint, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ draftIds: chunk.map(c => c.id), deletedAt }),
      });
      if (!res.ok && res.status !== 202) throw new Error(`pin-drafts DELETE failed: ${res.status}`);
      if (res.status === 202) throw new DeferredError();
      ackEntries(chunk);
    }

    _failureCount = 0;
    maybeRecover();
    notifyStatus(); // outbox drained + failure cleared → likely back to "synced"
  } catch {
    // Outbox entries stay put — exponential backoff (capped at backoffMaxMs), forever.
    // A 202 deferred (table not applied) backs off the same way.
    _failureCount++;
    maybeEnterError();
    notifyStatus();
    scheduleRetry(() => void flush());
  } finally {
    _flushing = false;
    if (_flushQueued) {
      _flushQueued = false;
      scheduleFlush();
    }
  }
}

class DeferredError extends Error {
  constructor() { super("pin-drafts deferred (table not applied)"); }
}

type PutChunk = Array<{ id: string; entry: OutboxEntry; draft: PinDraft }>;

/** One PUT of a chunk. Split out so the 409 retry sends the identical shape. */
async function putChunk(token: string, chunk: PutChunk): Promise<Response> {
  return fetcher()(_opts.endpoint, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      drafts: chunk.map(c => ({ draftId: c.id, updatedAt: c.draft.updatedAt, payload: c.draft })),
    }),
  });
}

/** The 409 body: `stale[]` always, plus a `current` mirror of stale[0] for single-draft clients. */
interface StaleConflictBody {
  code?: string;
  stale?: Array<{ draftId?: string; current?: { payload?: unknown; updated_at?: string } | null }>;
  current?: { payload?: unknown; updated_at?: string } | null;
}

/**
 * Re-base the conflicted drafts of this chunk onto the server's CURRENT rows, and
 * report which ids were refused.
 *
 * `chunk` is not just the list of ids: each entry carries the exact `draft` object
 * that `putChunk` serialized, so it IS the payload the server answered 409 about.
 * That snapshot is what makes a field-level merge possible at all — local-vs-sent
 * is precisely the edit the merchant made while the request was in flight, and
 * everything else can safely come from the server. The merge itself lives in
 * pinDraftStore.rebaseDraftOnServer, which documents the field rules.
 *
 * This must NOT go through `mergeServerDrafts`. That is whole-payload LWW, and
 * under the race this path exists for the local copy is the newer one while being
 * wrong: an edit typed during a publish carries the pre-publish schedule with it,
 * so LWW rejects the server row wholesale and the retry re-sends a schedule the
 * cron had already cleared — the Content goes out twice. LWW stays where its
 * question is the right one: the startup pull, where there is no in-flight write
 * to diff against. Here the question is "which fields did the merchant change",
 * and only the sent snapshot can answer it.
 *
 * A conflict with no `current` (the row vanished between the failed write and the
 * server's re-read) is still returned as conflicted: nothing to re-base onto, so
 * the retry simply re-sends what we have, and the next cycle sees whatever landed.
 */
async function reconcileStale(res: Response, chunk: PutChunk): Promise<Set<string>> {
  const conflicted = new Set<string>();
  let body: StaleConflictBody | null = null;
  try { body = (await res.json()) as StaleConflictBody; } catch { body = null; }

  const entries = body?.stale?.length
    ? body.stale
    : body?.current !== undefined && chunk.length === 1
      // Single-draft request answered with only the `current` mirror.
      ? [{ draftId: chunk[0].id, current: body.current }]
      : [];

  // The payload each conflicted draft was SENT with, by id — the other half of the
  // diff. Absent (a draft not in this chunk) → no basis for a delta, so no re-base.
  const sentById = new Map(chunk.map(c => [c.id, c.draft]));

  for (const e of entries) {
    const id = typeof e?.draftId === "string" ? e.draftId : null;
    if (!id) continue;
    conflicted.add(id);
    const payload = e?.current?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const server = payload as unknown as PinDraft;
    if (typeof server.id !== "string" || !server.id) continue;
    const sent = sentById.get(id);
    if (!sent) continue;
    rebaseDraftOnServer(server, sent);
  }

  // A 409 the client cannot parse must not be treated as success: assume the whole
  // chunk was refused rather than acking writes that may never have happened.
  if (entries.length === 0) for (const c of chunk) conflicted.add(c.id);
  return conflicted;
}

/** Re-read the conflicted drafts from the store AFTER the re-base, for the single retry. */
function rebuildChunk(ids: Set<string>): PutChunk {
  const out: PutChunk = [];
  for (const id of ids) {
    const draft = getDraft(id);
    if (!draft) continue; // removed meanwhile → a delete entry covers it
    if (payloadBytes(draft) > _opts.maxPayloadBytes) continue;
    const entry = _outbox.get(id);
    // Send the CURRENT store state — i.e. the re-based draft — under the entry that
    // is actually in the outbox, so ackEntries' identity check still protects a
    // concurrent edit.
    out.push({ id, entry: entry ?? { kind: "put", updatedAt: draft.updatedAt }, draft });
  }
  return out;
}

/** UTF-8 byte length of the serialized draft (matches the server-side check). */
function payloadBytes(draft: PinDraft): number {
  return new TextEncoder().encode(JSON.stringify(draft)).length;
}

/** Remove acked entries — unless a newer store write replaced them mid-flight. */
function ackEntries(chunk: Array<{ id: string; entry: OutboxEntry }>): void {
  for (const { id, entry } of chunk) {
    if (_outbox.get(id) === entry) _outbox.delete(id);
  }
}

// ── Test hooks (not used by product code) ─────────────────────────────────────

export function __resetPinDraftSyncForTests(): void {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  if (_retryTimer) clearTimeout(_retryTimer);
  _unsubscribe?.();
  _initialized = false;
  _ready = false;
  _getToken = null;
  _opts = { ...DEFAULTS, fetchImpl: undefined };
  _lastSeen = new Map();
  _outbox = new Map();
  _debounceTimer = null;
  _retryTimer = null;
  _flushing = false;
  _flushQueued = false;
  _failureCount = 0;
  _unsubscribe = null;
  _telemetry = null;
  _statusSubs.clear();
  _lastStatus = null;
  _inErrorState = false;
  _errorSince = 0;
}

export function __getPinDraftSyncDebug(): {
  initialized: boolean;
  ready: boolean;
  outboxSize: number;
  failureCount: number;
  outboxKinds: Record<string, "put" | "delete">;
} {
  const outboxKinds: Record<string, "put" | "delete"> = {};
  for (const [id, e] of _outbox) outboxKinds[id] = e.kind;
  return {
    initialized: _initialized,
    ready: _ready,
    outboxSize: _outbox.size,
    failureCount: _failureCount,
    outboxKinds,
  };
}

/** Force an immediate flush (bypasses the debounce). Test-only. */
export async function __flushPinDraftSyncForTests(): Promise<void> {
  if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
  await flush();
}

/** Wait until the startup pull finished (ready) or the timeout elapses. Test-only. */
export async function __waitForPinDraftSyncReady(timeoutMs = 2_000): Promise<boolean> {
  const start = Date.now();
  while (!_ready && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 5));
  }
  return _ready;
}
