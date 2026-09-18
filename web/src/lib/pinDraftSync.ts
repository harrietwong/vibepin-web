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
 *  - Drafts whose payload exceeds 200KB become per-draft action-required issues;
 *    valid siblings continue syncing and the rejected revision is not hot-retried.
 *
 * SSR-safe: init() is a no-op without window. init() is idempotent.
 */

import {
  DRAFT_STORE_EVENT,
  getAllDrafts,
  getDraft,
  mergeServerDrafts,
  rebaseDraftOnServer,
  setPinDraftOwnerScope,
  clearPinDraftOwnerScope,
  type PinDraft,
} from "./pinDraftStore";

// ── Types ─────────────────────────────────────────────────────────────────────

export type GetAccessToken = () => Promise<string | null>;

export interface PinDraftSyncOptions {
  /** Verified Supabase user id. Required by product code; omitted only by legacy tests. */
  ownerUserId?: string;
  /** Workspace namespace. Defaults to "default" until multi-workspace ships. */
  workspaceId?: string;
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
  state: "synced" | "syncing" | "error" | "action_required";
  pendingCount: number;
  errorStores: string[];
  actionRequiredCount?: number;
}

export interface PinDraftSyncIssue {
  draftId: string;
  updatedAt: string;
  code: "destination_not_schedulable" | "destination_unavailable" | "quota_exceeded" | "payload_too_large";
  userMessageKey: string;
  retryable: false;
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

interface DurableSyncState {
  version: 1;
  outbox: Record<string, OutboxEntry>;
  issues: Record<string, PinDraftSyncIssue>;
}

type DraftSyncOutcome = {
  draftId?: string;
  status?: "applied" | "stale" | "rejected" | "deferred";
  code?: string;
  userMessageKey?: string;
  retryable?: boolean;
};

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
/** Only server reads and successful writes establish durable media evidence. */
let _acknowledgedMedia = new Map<string, string>();

function mediaSyncIdentity(draft: Pick<PinDraft, "media" | "imageUrl">): string {
  return JSON.stringify({ media: draft.media, imageUrl: draft.imageUrl });
}

export function isPinDraftMediaSynced(draftId: string): boolean {
  const draft = getDraft(draftId);
  return !!draft && _initialized && _ready && !_outbox.has(draftId) && !_issues.has(draftId)
    && _acknowledgedMedia.get(draftId) === mediaSyncIdentity(draft);
}

/** Wait for the existing write-through engine; rejected/deferred/local-only edits never count. */
export async function waitForPinDraftMediaSync(draftId: string, timeoutMs = 15_000): Promise<void> {
  const epoch = _runEpoch;
  const draft = getDraft(draftId);
  if (!_initialized || !draft) throw new Error("The cover is not synced yet. Please retry after syncing.");
  const identity = mediaSyncIdentity(draft);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const current = getDraft(draftId);
    if (epoch !== _runEpoch || !current || mediaSyncIdentity(current) !== identity) {
      throw new Error("The cover changed while syncing. Please retry.");
    }
    if (isPinDraftMediaSynced(draftId)) return;
    if (_issues.has(draftId) || Date.now() >= deadline) throw new Error("The cover is not synced yet. Please retry after syncing.");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
/** Pending changes not yet acknowledged by the server. Never dropped on failure. */
let _outbox = new Map<string, OutboxEntry>();
let _issues = new Map<string, PinDraftSyncIssue>();
let _ownerKey = "legacy";
let _runEpoch = 0;

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
    !_initialized ? "synced" : inError ? "error" : _issues.size > 0 ? "action_required" : pendingCount > 0 || !_ready ? "syncing" : "synced";
  return {
    state,
    pendingCount,
    errorStores: inError || _issues.size > 0 ? [PIN_DRAFT_STORE_KEY] : [],
    actionRequiredCount: _issues.size,
  };
}

function statusEqual(a: PinDraftSyncStatus, b: PinDraftSyncStatus): boolean {
  return (
    a.state === b.state &&
    a.pendingCount === b.pendingCount &&
    a.actionRequiredCount === b.actionRequiredCount &&
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

/** Deterministic, card-addressable sync problem for the current owner only. */
export function getPinDraftSyncIssue(draftId: string): PinDraftSyncIssue | null {
  return _issues.get(draftId) ?? null;
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

function durableStateKey(): string {
  return `vp:pin_draft_sync:v2:${_ownerKey}`;
}

function loadDurableState(): void {
  _outbox = new Map();
  _issues = new Map();
  try {
    const raw = localStorage.getItem(durableStateKey());
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<DurableSyncState>;
    if (parsed.version !== 1) return;
    for (const [id, entry] of Object.entries(parsed.outbox ?? {})) {
      if (entry?.kind === "put" && typeof entry.updatedAt === "string") _outbox.set(id, entry);
      if (entry?.kind === "delete" && typeof entry.deletedAt === "string") _outbox.set(id, entry);
    }
    for (const [id, issue] of Object.entries(parsed.issues ?? {})) {
      if (issue?.draftId === id && typeof issue.updatedAt === "string" && issue.retryable === false) {
        _issues.set(id, issue);
      }
    }
  } catch {
    // Corrupt sync metadata must never expose another owner or block the draft store.
    _outbox = new Map();
    _issues = new Map();
  }
}

function persistDurableState(): void {
  try {
    const state: DurableSyncState = {
      version: 1,
      outbox: Object.fromEntries(_outbox),
      issues: Object.fromEntries(_issues),
    };
    localStorage.setItem(durableStateKey(), JSON.stringify(state));
  } catch {
    // The local draft store already surfaces quota failures. Sync metadata remains
    // in memory and is reconstructed from updatedAt on a later healthy session.
  }
}

function ownerStorageKey(ownerUserId?: string, workspaceId?: string): string {
  const owner = ownerUserId?.trim();
  if (!owner) return "legacy";
  return `${encodeURIComponent(owner)}:${encodeURIComponent(workspaceId?.trim() || "default")}`;
}

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Mount the write-through engine. Safe to call multiple times (idempotent) and
 * safe during SSR (no-op without window).
 */
export function initPinDraftSync(getToken: GetAccessToken, options?: PinDraftSyncOptions): void {
  if (typeof window === "undefined") return;
  const nextOwnerKey = ownerStorageKey(options?.ownerUserId, options?.workspaceId);
  if (_initialized && nextOwnerKey === _ownerKey) {
    _getToken = getToken;
    return;
  }
  if (_initialized) stopPinDraftSync({ clearOwnerScope: false });
  if (options?.ownerUserId?.trim()) {
    setPinDraftOwnerScope(options.ownerUserId, options.workspaceId ?? "default");
  }
  _initialized = true;
  const epoch = ++_runEpoch;
  _ownerKey = nextOwnerKey;
  _getToken = getToken;
  _opts = { ...DEFAULTS, fetchImpl: options?.fetchImpl, ...stripUndefined(options ?? {}) };
  loadDurableState();

  const onStoreEvent = () => {
    if (!_ready) return; // pre-pull writes are captured by the post-seed full diff
    diffNow();
  };
  window.addEventListener(DRAFT_STORE_EVENT, onStoreEvent);
  _unsubscribe = () => window.removeEventListener(DRAFT_STORE_EVENT, onStoreEvent);

  void startupPull(epoch);
}

/**
 * Stop the singleton before logout/account switch. Timers/listeners and all
 * in-memory snapshots are detached, while this owner's durable outbox remains.
 */
export function stopPinDraftSync(options: { clearOwnerScope?: boolean } = {}): void {
  _runEpoch++;
  if (_debounceTimer) clearTimeout(_debounceTimer);
  if (_retryTimer) clearTimeout(_retryTimer);
  persistDurableState();
  _unsubscribe?.();
  _initialized = false;
  _ready = false;
  _getToken = null;
  _lastSeen = new Map();
  _acknowledgedMedia = new Map();
  _outbox = new Map();
  _issues = new Map();
  _debounceTimer = null;
  _retryTimer = null;
  _flushing = false;
  _flushQueued = false;
  _failureCount = 0;
  _unsubscribe = null;
  _ownerKey = "legacy";
  if (options.clearOwnerScope !== false) clearPinDraftOwnerScope();
  notifyStatus();
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && k !== "fetchImpl" && k !== "ownerUserId" && k !== "workspaceId") {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

// ── Startup pull → merge → seed baseline → first diff ────────────────────────

class StaleSyncRunError extends Error {}

function ensureActive(epoch: number): void {
  if (!_initialized || epoch !== _runEpoch) throw new StaleSyncRunError("stale pin-draft sync run");
}

async function startupPull(epoch = _runEpoch): Promise<void> {
  try {
    const { live, deleted } = await pullAllPages(epoch);
    ensureActive(epoch);

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
    _acknowledgedMedia = new Map(live.map(row => [row.draftId, mediaSyncIdentity(row.payload as unknown as PinDraft)]));
    _ready = true;
    _failureCount = 0;
    maybeRecover();
    diffNow(); // diffNow calls notifyStatus (covers the ready transition)
  } catch (error) {
    if (error instanceof StaleSyncRunError) return;
    // Server unreachable / table pending: retry the pull with backoff. Local
    // behaviour stays pure-localStorage until the pull succeeds (§8.3).
    _failureCount++;
    maybeEnterError();
    notifyStatus();
    scheduleRetry(() => void startupPull(epoch));
  }
}

async function pullAllPages(epoch: number): Promise<{
  live: ServerDraftRecord[];
  deleted: Array<{ id: string; deletedAt: string }>;
}> {
  const token = await requireToken();
  const live: ServerDraftRecord[] = [];
  const deleted: Array<{ id: string; deletedAt: string }> = [];
  let cursor: string | null = null;
  let guard = 0;

  do {
    ensureActive(epoch);
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
      const issue = _issues.get(id);
      // A deterministic rejection is acknowledged for this exact revision. Do not
      // hot-retry it after reload. A real merchant edit changes updatedAt, clears the
      // issue, and becomes a fresh outbox entry.
      if (issue?.updatedAt === updatedAt) continue;
      if (issue) _issues.delete(id);
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
  if (changed) persistDurableState();
  if (changed) scheduleFlush();
  notifyStatus(); // outbox may have grown/shrunk → status may have changed
}

function scheduleFlush(): void {
  // A store event raised by reconcile/merge while a request is still in flight
  // belongs to the NEXT cycle. Starting its debounce now shortens (or entirely
  // consumes) the cycle boundary before the current PUT has finished. Record one
  // queued pass instead; `finally` starts the debounce after `_flushing` clears.
  if (_flushing) {
    _flushQueued = true;
    return;
  }
  // A failed/deferred cycle owns the next attempt through its backoff timer.
  // A concurrent store event may add work to the same durable outbox, but must not
  // create a second, earlier scheduler that bypasses that backoff.
  if (_retryTimer) return;
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    void flush();
  }, _opts.debounceMs);
}

function scheduleRetry(run: () => void): void {
  // Retry is the sole scheduler after a failed/deferred cycle. Cancel any debounce
  // that was armed by a reconcile-driven store event before the failure surfaced.
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
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
  const epoch = _runEpoch;

  try {
    const token = await requireToken();
    ensureActive(epoch);

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
        console.warn(`[pinDraftSync] a draft exceeds ${_opts.maxPayloadBytes} bytes — action required`);
        _issues.set(id, {
          draftId: id,
          updatedAt: draft.updatedAt,
          code: "payload_too_large",
          userMessageKey: "studioBoard.card.syncIssue.payloadTooLarge",
          retryable: false,
        });
        _outbox.delete(id);
        _telemetry?.onOversizeSkipped?.(id);
        persistDurableState();
        continue;
      }
      puts.push({ id, entry, draft });
    }

    for (let i = 0; i < puts.length; i += _opts.batchSize) {
      const chunk = puts.slice(i, i + _opts.batchSize);
      const res = await putChunk(token, chunk);
      ensureActive(epoch);
      if (res.status === 202) throw new DeferredError(); // table not applied yet — keep outbox, retry later
      if (await applyDeterministicHttpError(res, chunk, epoch)) continue;

      if (res.status === 409) {
        // A modern 409 may also contain accepted/rejected siblings. Apply those
        // outcomes first, but keep retryable CAS-stale entries for re-base below.
        const outcomeResult = await applyPutOutcomes(res, chunk, epoch, { deferPending: false });
        // The server refused these drafts because the stored row changed between
        // its read and its write — the row we are holding is genuinely older than
        // what is stored. Reconcile instead of insisting: re-base onto the server's
        // copy, keeping only the fields edited since THIS chunk was sent (see
        // reconcileStale), and send the merged result once.
        // Ids the server has TOMBSTONED: reconcileStale applied the deletion, and
        // they must be acked rather than retried — re-sending would revive the row.
        const dropped = new Set<string>();
        const conflicted = await reconcileStale(res, chunk, dropped, epoch);
        ensureActive(epoch);
        // Legacy 409s have no per-draft outcomes, so their stale list remains the
        // only proof that non-conflicted siblings landed. In v2, ack only explicit
        // terminal outcomes (already handled above); an omitted non-conflict stays
        // durable and is retried with backoff instead of being guessed successful.
        if (outcomeResult === null) {
          ackEntries(chunk.filter(c => !conflicted.has(c.id) || dropped.has(c.id)));
        } else {
          ackEntries(chunk.filter(c => dropped.has(c.id)));
        }
        const pendingNonConflicted = outcomeResult !== null && chunk.some(
          sent => !conflicted.has(sent.id) && _outbox.get(sent.id) === sent.entry,
        );
        for (const id of dropped) conflicted.delete(id);
        if (conflicted.size === 0) {
          if (pendingNonConflicted) throw new DeferredError();
          continue;
        }

        const retry = rebuildChunk(conflicted);
        if (retry.length === 0) {
          if (pendingNonConflicted) throw new DeferredError();
          scheduleFlush();
          continue;
        }
        const res2 = await putChunk(token, retry);
        ensureActive(epoch);
        if (res2.status === 202) throw new DeferredError();
        if (await applyDeterministicHttpError(res2, retry, epoch)) continue;
        if (res2.status === 409) {
          const retryOutcomeResult = await applyPutOutcomes(res2, retry, epoch, { deferPending: false });
          // Lost the race twice in one cycle. Stop here on purpose: a third attempt
          // is the same bet, and looping would hammer the endpoint for as long as
          // the other writer keeps winning. The entries stay in the outbox and the
          // next flush picks them up with a freshly merged payload — so this is a
          // delay, never a dropped edit. Warn, because silence here would look
          // exactly like a successful sync.
          // Fold the SECOND conflict's current row in as well, so the next cycle
          // starts from what is actually stored instead of repeating this dance.
          const dropped2 = new Set<string>();
          const conflicted2 = await reconcileStale(res2, retry, dropped2, epoch);
          ensureActive(epoch);
          // A row tombstoned by the second conflict owes nothing either.
          ackEntries(retry.filter(c => dropped2.has(c.id)));
          const pendingRetryNonConflicted = retryOutcomeResult !== null && retry.some(
            sent => !conflicted2.has(sent.id) && !dropped2.has(sent.id) && _outbox.get(sent.id) === sent.entry,
          );
          console.warn(
            `[pinDraftSync] draft(s) still stale after one merge+retry — deferred to the next sync: ${[...conflicted].join(", ")}`,
          );
          // Re-arm a flush. The engine has no periodic timer, so without this the
          // entry would sit in the outbox until some unrelated store write happens
          // — pendingCount stuck at 1 forever is the silent drop this must not be.
          // Bounded work per cycle (one PUT + at most one retry), debounce-spaced,
          // and each cycle re-merges first, so the payload converges rather than
          // re-sending the same losing copy.
          if (pendingNonConflicted || pendingRetryNonConflicted) throw new DeferredError();
          scheduleFlush();
          continue;
        }
        if (!res2.ok) throw new Error(`pin-drafts PUT failed: ${res2.status}`);
        if (!(await applyPutOutcomes(res2, retry, epoch))) ackEntries(retry);
        if (pendingNonConflicted) throw new DeferredError();
        continue;
      }

      if (!res.ok) throw new Error(`pin-drafts PUT failed: ${res.status}`);
      if (!(await applyPutOutcomes(res, chunk, epoch))) ackEntries(chunk);
    }

    for (let i = 0; i < deletes.length; i += _opts.batchSize) {
      const chunk = deletes.slice(i, i + _opts.batchSize);
      const deletedAt = chunk.reduce((max, c) => (c.deletedAt > max ? c.deletedAt : max), chunk[0].deletedAt);
      const res = await fetcher()(_opts.endpoint, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ draftIds: chunk.map(c => c.id), deletedAt }),
      });
      ensureActive(epoch);
      if (!res.ok && res.status !== 202) throw new Error(`pin-drafts DELETE failed: ${res.status}`);
      if (res.status === 202) throw new DeferredError();
      ackEntries(chunk);
    }

    _failureCount = 0;
    maybeRecover();
    persistDurableState();
    notifyStatus(); // outbox drained + failure cleared → likely back to "synced"
  } catch (error) {
    if (error instanceof StaleSyncRunError) return;
    // Outbox entries stay put — exponential backoff (capped at backoffMaxMs), forever.
    // A 202 deferred (table not applied) backs off the same way.
    _failureCount++;
    // Store events raised while the request was in flight may have set this flag.
    // On any failed/deferred cycle, the retry timer is the sole scheduler; letting
    // finally consume _flushQueued would bypass backoff and create a hot loop.
    _flushQueued = false;
    maybeEnterError();
    notifyStatus();
    scheduleRetry(() => void flush());
  } finally {
    if (epoch === _runEpoch) {
      _flushing = false;
      if (_flushQueued) {
        _flushQueued = false;
        scheduleFlush();
      }
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

function deterministicIssue(outcome: DraftSyncOutcome, sent: PutChunk[number]): PinDraftSyncIssue | null {
  if (outcome.status !== "rejected" || outcome.retryable !== false) return null;
  if (![
    "destination_not_schedulable",
    "destination_unavailable",
    "quota_exceeded",
    "payload_too_large",
  ].includes(outcome.code ?? "")) return null;
  return {
    draftId: sent.id,
    updatedAt: sent.draft.updatedAt,
    code: outcome.code as PinDraftSyncIssue["code"],
    userMessageKey: outcome.userMessageKey || `studioBoard.card.syncIssue.${outcome.code}`,
    retryable: false,
  };
}

/**
 * Apply a v2 per-draft response. Returns null for the legacy aggregate response,
 * allowing old servers to keep the previous ack-whole-chunk behavior. A Set is
 * returned for v2 even when empty, so callers never confuse an incomplete v2
 * response with a legacy success.
 */
async function applyPutOutcomes(
  res: Response,
  chunk: PutChunk,
  epoch = _runEpoch,
  options: { deferPending?: boolean } = {},
): Promise<Set<string> | null> {
  let body: { outcomes?: DraftSyncOutcome[] } | null = null;
  try { body = (await res.clone().json()) as { outcomes?: DraftSyncOutcome[] }; } catch { body = null; }
  ensureActive(epoch);
  if (!Array.isArray(body?.outcomes)) return null;

  const sentById = new Map(chunk.map(c => [c.id, c]));
  const terminal = new Set<string>();
  for (const outcome of body.outcomes) {
    const sent = typeof outcome.draftId === "string" ? sentById.get(outcome.draftId) : undefined;
    if (!sent) continue;
    if (outcome.status === "applied" || (outcome.status === "stale" && outcome.retryable === false)) {
      if (outcome.status === "applied") _acknowledgedMedia.set(sent.id, mediaSyncIdentity(sent.draft));
      else _acknowledgedMedia.delete(sent.id);
      ackEntries([sent]);
      _issues.delete(sent.id);
      terminal.add(sent.id);
      continue;
    }
    const issue = deterministicIssue(outcome, sent);
    if (issue) {
      _issues.set(sent.id, issue);
      ackEntries([sent]);
      terminal.add(sent.id);
    }
    // deferred/retryable outcomes intentionally remain in the durable outbox.
  }
  persistDurableState();
  notifyStatus();
  const pendingFromChunk = chunk.some(sent => _outbox.get(sent.id) === sent.entry);
  if (pendingFromChunk && options.deferPending !== false) throw new DeferredError();
  return terminal;
}

/**
 * Rollout compatibility for the old batch-wide 422/429 contract. A listed bad
 * draft becomes action-required; siblings remain in the outbox and are retried in
 * a clean request, so one legacy rejection still cannot block them forever.
 */
async function applyDeterministicHttpError(res: Response, chunk: PutChunk, epoch = _runEpoch): Promise<boolean> {
  if (![413, 422, 429].includes(res.status)) return false;
  let body: { code?: string; drafts?: Array<{ draftId?: string }> } | null = null;
  try { body = (await res.clone().json()) as { code?: string; drafts?: Array<{ draftId?: string }> }; } catch { body = null; }
  ensureActive(epoch);
  const code = body?.code;
  if (!code || ![
    "destination_not_schedulable",
    "destination_unavailable",
    "quota_exceeded",
    "payload_too_large",
  ].includes(code)) return false;

  const listed = new Set(
    (body?.drafts ?? []).map(item => item?.draftId).filter((id): id is string => typeof id === "string" && !!id),
  );
  const affected = chunk.filter(sent => {
    if (listed.size > 0) return listed.has(sent.id);
    if (code === "quota_exceeded") return !!(sent.draft.plannedAt || sent.draft.scheduledDate);
    return chunk.length === 1;
  });
  if (affected.length === 0) return false;

  const keyByCode: Record<string, string> = {
    destination_not_schedulable: "studioBoard.card.syncIssue.destinationNotSchedulable",
    destination_unavailable: "studioBoard.card.syncIssue.destinationUnavailable",
    quota_exceeded: "studioBoard.card.syncIssue.quotaExceeded",
    payload_too_large: "studioBoard.card.syncIssue.payloadTooLarge",
  };
  for (const sent of affected) {
    _issues.set(sent.id, {
      draftId: sent.id,
      updatedAt: sent.draft.updatedAt,
      code: code as PinDraftSyncIssue["code"],
      userMessageKey: keyByCode[code],
      retryable: false,
    });
    ensureActive(epoch);
  }
  ackEntries(affected);
  notifyStatus();
  const pendingFromChunk = chunk.some(sent => _outbox.get(sent.id) === sent.entry);
  if (pendingFromChunk) throw new DeferredError();
  return true;
}

/**
 * The row the 409 hands back, as the route writes it (`readCurrentRow`).
 *
 * The COLUMNS matter as much as the payload. `updated_at` is what the route's LWW
 * compares the retry against and can be newer than `payload.updatedAt` (a write that
 * touches only columns — a tombstone, the draft-cap sweep — never rewrites the
 * payload). `deleted_at` is the ONLY signal that the row was tombstoned meanwhile:
 * the DELETE path writes columns exclusively, so a payload-only view of the row still
 * looks alive.
 */
interface StaleCurrentRow {
  payload?: unknown;
  updated_at?: string | null;
  scheduled_at?: string | null;
  deleted_at?: string | null;
}

/** The 409 body: `stale[]` always, plus a `current` mirror of stale[0] for single-draft clients. */
interface StaleConflictBody {
  code?: string;
  stale?: Array<{ draftId?: string; current?: StaleCurrentRow | null }>;
  current?: StaleCurrentRow | null;
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
 *
 * A row that is TOMBSTONED is resolved with the same LWW rule as the startup pull.
 * A newer tombstone removes the local draft and must not be retried, because a retry
 * would revive what the merchant deleted. A newer local edit survives and MUST stay
 * conflicted so it is retried: that is how the documented "newer local edit revives"
 * rule reaches the server instead of becoming a browser-only edit.
 *
 * `ids` collects the drafts whose outbox entry must be dropped rather than retried:
 * with the draft gone locally, `rebuildChunk` would skip it and its entry would sit
 * in the outbox forever, holding `pendingCount` at 1 with nothing left to send.
 */
async function reconcileStale(
  res: Response,
  chunk: PutChunk,
  dropped?: Set<string>,
  epoch = _runEpoch,
): Promise<Set<string>> {
  const conflicted = new Set<string>();
  let body: StaleConflictBody | null = null;
  try { body = (await res.json()) as StaleConflictBody; } catch { body = null; }
  ensureActive(epoch);

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
    const current = e?.current ?? null;

    // Tombstoned on the server → apply the same LWW rule as the startup pull.
    const deletedAt = typeof current?.deleted_at === "string" ? current.deleted_at.trim() : "";
    if (deletedAt) {
      const { removed } = mergeServerDrafts([], [{ id, deletedAt }]);
      // Only acknowledge the PUT when the tombstone actually won. If a newer local
      // edit survived, leave the id conflicted and the outbox entry intact so the
      // normal one-shot retry revives the server row. Dropping it here would report
      // "synced" while the edit exists only in localStorage, with no later write
      // guaranteed to enqueue it again.
      if (removed > 0 || !getDraft(id)) dropped?.add(id);
      continue;
    }

    const payload = current?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const server = payload as unknown as PinDraft;
    if (typeof server.id !== "string" || !server.id) continue;
    const sent = sentById.get(id);
    if (!sent) continue;
    // The row's own columns ride along: `updated_at` can be newer than the payload's,
    // and stamping the retry below it is what turns a real edit into `skippedStale`.
    rebaseDraftOnServer(server, sent, {
      updatedAt:   typeof current?.updated_at === "string" ? current.updated_at : null,
      scheduledAt: typeof current?.scheduled_at === "string" ? current.scheduled_at : null,
    });
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
  persistDurableState();
}

// ── Test hooks (not used by product code) ─────────────────────────────────────

export function __resetPinDraftSyncForTests(): void {
  _acknowledgedMedia = new Map();
  _runEpoch++;
  if (_debounceTimer) clearTimeout(_debounceTimer);
  if (_retryTimer) clearTimeout(_retryTimer);
  _unsubscribe?.();
  _initialized = false;
  _ready = false;
  _getToken = null;
  _opts = { ...DEFAULTS, fetchImpl: undefined };
  _lastSeen = new Map();
  _outbox = new Map();
  _issues = new Map();
  _ownerKey = "legacy";
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
  actionRequired: Record<string, string>;
} {
  const outboxKinds: Record<string, "put" | "delete"> = {};
  for (const [id, e] of _outbox) outboxKinds[id] = e.kind;
  return {
    initialized: _initialized,
    ready: _ready,
    outboxSize: _outbox.size,
    failureCount: _failureCount,
    outboxKinds,
    actionRequired: Object.fromEntries([..._issues].map(([id, issue]) => [id, issue.code])),
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
