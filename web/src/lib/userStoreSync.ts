/**
 * userStoreSync.ts — WP-A generic account-level write-through sync engine.
 *
 * Generalization of pinDraftSync.ts. Where pinDraftSync is a single hard-wired
 * engine for the Pin Draft store, this is a MULTI-INSTANCE factory: any number of
 * client stores each register a StoreSyncAdapter (their own storeKey, event name,
 * getAll and mergeServer) and get their own independent engine instance —
 * independent outbox, baseline, ready state and backoff — all sharing one
 * account access token.
 *
 * Per-instance protocol (identical to pinDraftSync §5 / §8.3 / §8.5):
 *  - Startup: GET /api/user-store?storeKey=… (cursor-paginated, includes
 *    tombstones) → adapter.mergeServer() LWW merge into the local store → the
 *    merged SERVER state seeds the diff baseline, so local-only / locally-newer
 *    docs naturally enter the outbox = migration-on-first-load (no flag needed).
 *  - Diff: on each adapter event, diff the store against the last-seen snapshot by
 *    (id, updatedAt); changes land in the outbox (changed → PUT, gone → DELETE).
 *  - Flush: 1.5s debounce, batched PUT/DELETE of ≤50 docs per request.
 *  - Failures (network / 401 / 5xx / 202 deferred): outbox is NEVER dropped;
 *    exponential backoff capped at 60s keeps retrying. The local store remains the
 *    offline cache, so a dead server costs nothing.
 *  - Docs whose payload exceeds 200KB are skipped with a warning; the rest sync.
 *
 * SSR-safe: registration is inert without window; initUserStoreSync() is a no-op
 * without window and is idempotent. Registration and init may happen in either
 * order — an instance mounts once BOTH have happened.
 */

// ── Public types ───────────────────────────────────────────────────────────────

export type GetAccessToken = () => Promise<string | null>;

/**
 * A store's binding to the sync engine. `T` is the document shape.
 *
 * `mergeServer` must LWW-merge the server's live docs + tombstones into the local
 * store with a SINGLE persist + a SINGLE event emit, and that emit must NOT cause
 * the just-merged data to loop back into the outbox — the engine guards this by
 * ignoring the adapter's event until the startup baseline is seeded (see
 * mergeServerDrafts in pinDraftStore for the reference behaviour).
 */
export interface StoreSyncAdapter<T> {
  /** Server-side store_key; matches /^[a-z0-9_-]{1,64}$/. */
  storeKey: string;
  /** window custom-event name the store dispatches after every persist. */
  eventName: string;
  /** Current local full state. */
  getAll(): Array<{ id: string; updatedAt: string; doc: T }>;
  /** LWW-merge server state into the local store (single persist + emit). */
  mergeServer(live: T[], deleted: Array<{ id: string; deletedAt: string }>): void;
}

export interface StoreSyncOptions {
  /** Debounce between a store write and the flush. Default 1500ms. */
  debounceMs?: number;
  /** First retry delay after a failure. Default 2000ms. */
  backoffBaseMs?: number;
  /** Retry delay cap. Default 60000ms. */
  backoffMaxMs?: number;
  /** Max docs per PUT/DELETE request. Default 50. */
  batchSize?: number;
  /** Per-doc payload byte cap (server rejects above this). Default 200KB. */
  maxPayloadBytes?: number;
  /** GET page size. Default 100. */
  pageSize?: number;
  /** Injectable fetch (tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** API base path. Default "/api/user-store". */
  endpoint?: string;
}

export interface StoreSyncHandle {
  readonly storeKey: string;
  /** Force an immediate flush (bypasses the debounce). */
  flush(): Promise<void>;
  /** Wait until the startup pull finished (ready) or the timeout elapses. */
  waitReady(timeoutMs?: number): Promise<boolean>;
  getDebug(): StoreSyncDebug;
  /** Detach the event listener + timers and drop the instance. */
  unregister(): void;
}

export interface StoreSyncDebug {
  storeKey: string;
  registered: boolean;
  mounted: boolean;
  ready: boolean;
  outboxSize: number;
  failureCount: number;
  outboxKinds: Record<string, "put" | "delete">;
}

// ── Internal types & module state ──────────────────────────────────────────────

type OutboxEntry =
  | { kind: "put"; updatedAt: string }
  | { kind: "delete"; deletedAt: string };

interface ServerDocRecord {
  docId: string;
  updatedAt: string;
  deletedAt?: string;
  payload: Record<string, unknown>;
}

type ResolvedOpts = {
  debounceMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  batchSize: number;
  maxPayloadBytes: number;
  pageSize: number;
  endpoint: string;
  fetchImpl?: typeof fetch;
};

const DEFAULTS: Omit<ResolvedOpts, "fetchImpl"> = {
  debounceMs: 1_500,
  backoffBaseMs: 2_000,
  backoffMaxMs: 60_000,
  batchSize: 50,
  maxPayloadBytes: 200 * 1024,
  pageSize: 100,
  endpoint: "/api/user-store",
};

// Each registered store gets an independent engine instance; all share _getToken.
interface Instance<T = unknown> {
  adapter: StoreSyncAdapter<T>;
  opts: ResolvedOpts;
  mounted: boolean;
  ready: boolean;
  /** Last-seen local state (id → updatedAt). Seeded from the server after the pull. */
  lastSeen: Map<string, string>;
  /** Pending changes not yet acknowledged. Never dropped on failure. */
  outbox: Map<string, OutboxEntry>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
  flushQueued: boolean;
  failureCount: number;
  unsubscribe: (() => void) | null;
}

let _initialized = false;
let _getToken: GetAccessToken | null = null;
const _instances = new Map<string, Instance>();

function resolveOpts(options?: StoreSyncOptions): ResolvedOpts {
  const out: ResolvedOpts = { ...DEFAULTS, fetchImpl: options?.fetchImpl };
  for (const [k, v] of Object.entries(options ?? {})) {
    if (v !== undefined && k !== "fetchImpl") (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function fetcher(inst: Instance): typeof fetch {
  return inst.opts.fetchImpl ?? fetch;
}

// ── Registration & init ─────────────────────────────────────────────────────

/**
 * Register a store with the sync engine. Returns a handle. Registering the same
 * storeKey twice returns the existing handle (idempotent). If init already
 * happened (and window exists), the instance mounts immediately; otherwise it
 * mounts when initUserStoreSync() runs. Inert during SSR.
 */
export function registerStoreSync<T>(adapter: StoreSyncAdapter<T>, options?: StoreSyncOptions): StoreSyncHandle {
  const existing = _instances.get(adapter.storeKey);
  if (existing) return makeHandle(existing);

  const inst: Instance<T> = {
    adapter,
    opts: resolveOpts(options),
    mounted: false,
    ready: false,
    lastSeen: new Map(),
    outbox: new Map(),
    debounceTimer: null,
    retryTimer: null,
    flushing: false,
    flushQueued: false,
    failureCount: 0,
    unsubscribe: null,
  };
  _instances.set(adapter.storeKey, inst as Instance);

  if (_initialized && typeof window !== "undefined") mount(inst as Instance);
  return makeHandle(inst as Instance);
}

/**
 * Mount every registered store on the shared access token. Safe to call multiple
 * times (idempotent) and safe during SSR (no-op without window).
 */
export function initUserStoreSync(getToken: GetAccessToken): void {
  if (typeof window === "undefined") return;
  if (_initialized) return;
  _initialized = true;
  _getToken = getToken;
  for (const inst of _instances.values()) mount(inst);
}

function mount(inst: Instance): void {
  if (inst.mounted) return;
  inst.mounted = true;

  const onStoreEvent = () => {
    if (!inst.ready) return; // pre-baseline writes are captured by the post-seed full diff
    diffNow(inst);
  };
  window.addEventListener(inst.adapter.eventName, onStoreEvent);
  inst.unsubscribe = () => window.removeEventListener(inst.adapter.eventName, onStoreEvent);

  void startupPull(inst);
}

function makeHandle(inst: Instance): StoreSyncHandle {
  return {
    storeKey: inst.adapter.storeKey,
    flush: async () => {
      if (inst.debounceTimer) { clearTimeout(inst.debounceTimer); inst.debounceTimer = null; }
      await flush(inst);
    },
    waitReady: (timeoutMs = 2_000) => waitReady(inst, timeoutMs),
    getDebug: () => debugOf(inst),
    unregister: () => {
      teardown(inst);
      _instances.delete(inst.adapter.storeKey);
    },
  };
}

// ── Startup pull → merge → seed baseline → first diff ────────────────────────

async function startupPull(inst: Instance): Promise<void> {
  try {
    const { live, deleted } = await pullAllPages(inst);

    // LWW merge into the local store (single persist + emit inside the adapter).
    // The emit fires the store event, but inst.ready is still false so onStoreEvent
    // ignores it — no loopback into the outbox (see pinDraftStore.mergeServerDrafts).
    inst.adapter.mergeServer(live.map(r => r.payload as unknown), deleted);

    // Baseline = the server-authoritative docs, valued by the POST-merge LOCAL
    // updatedAt so string-format differences between the server column and the
    // client payload never cause a spurious re-upload. A doc the local store kept
    // because it is strictly newer than the server is deliberately LEFT OUT of the
    // baseline, so the first diff re-uploads it — this IS the first-load migration.
    const localAfter = new Map(inst.adapter.getAll().map(x => [x.id, x.updatedAt]));
    const baseline = new Map<string, string>();
    for (const rec of live) {
      const after = localAfter.get(rec.docId);
      if (after === undefined) continue;
      if (tsMs(after) > tsMs(rec.updatedAt)) continue; // local strictly newer → re-upload
      baseline.set(rec.docId, after);
    }
    inst.lastSeen = baseline;

    inst.ready = true;
    inst.failureCount = 0;
    diffNow(inst);
  } catch {
    // Server unreachable / table pending: retry the pull with backoff. Local
    // behaviour stays pure-localStorage until the pull succeeds.
    inst.failureCount++;
    scheduleRetry(inst, () => void startupPull(inst));
  }
}

async function pullAllPages(inst: Instance): Promise<{
  live: ServerDocRecord[];
  deleted: Array<{ id: string; deletedAt: string }>;
}> {
  const token = await requireToken();
  const live: ServerDocRecord[] = [];
  const deleted: Array<{ id: string; deletedAt: string }> = [];
  let cursor: string | null = null;
  let guard = 0;

  do {
    const qs = new URLSearchParams({ storeKey: inst.adapter.storeKey, limit: String(inst.opts.pageSize) });
    if (cursor) qs.set("cursor", cursor);
    const res = await fetcher(inst)(`${inst.opts.endpoint}?${qs.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`user-store GET failed: ${res.status}`);
    const body = (await res.json()) as { docs?: ServerDocRecord[]; nextCursor?: string };
    for (const rec of body.docs ?? []) {
      if (!rec || typeof rec.docId !== "string") continue;
      if (rec.deletedAt) deleted.push({ id: rec.docId, deletedAt: rec.deletedAt });
      else live.push(rec);
    }
    cursor = body.nextCursor ?? null;
  } while (cursor && ++guard < 100);

  return { live, deleted };
}

// ── Diff → outbox ─────────────────────────────────────────────────────────────

function diffNow(inst: Instance): void {
  const current = new Map<string, string>();
  for (const x of inst.adapter.getAll()) current.set(x.id, x.updatedAt);

  let changed = false;

  for (const [id, updatedAt] of current) {
    if (inst.lastSeen.get(id) !== updatedAt) {
      inst.outbox.set(id, { kind: "put", updatedAt });
      changed = true;
    }
  }
  for (const id of inst.lastSeen.keys()) {
    if (!current.has(id)) {
      inst.outbox.set(id, { kind: "delete", deletedAt: new Date().toISOString() });
      changed = true;
    }
  }

  inst.lastSeen = current;
  if (changed) scheduleFlush(inst);
}

function scheduleFlush(inst: Instance): void {
  if (inst.debounceTimer) clearTimeout(inst.debounceTimer);
  inst.debounceTimer = setTimeout(() => {
    inst.debounceTimer = null;
    void flush(inst);
  }, inst.opts.debounceMs);
}

function scheduleRetry(inst: Instance, run: () => void): void {
  if (inst.retryTimer) clearTimeout(inst.retryTimer);
  const delay = Math.min(
    inst.opts.backoffBaseMs * 2 ** Math.max(inst.failureCount - 1, 0),
    inst.opts.backoffMaxMs,
  );
  inst.retryTimer = setTimeout(() => {
    inst.retryTimer = null;
    run();
  }, delay);
}

// ── Flush (batched PUT / DELETE) ──────────────────────────────────────────────

async function requireToken(): Promise<string> {
  const token = _getToken ? await _getToken() : null;
  if (!token) throw new Error("user-store: no access token");
  return token;
}

async function flush(inst: Instance): Promise<void> {
  if (inst.flushing) { inst.flushQueued = true; return; }
  if (inst.outbox.size === 0) return;
  inst.flushing = true;

  try {
    const token = await requireToken();
    const local = new Map(inst.adapter.getAll().map(x => [x.id, x]));

    // Snapshot the entries being flushed; a concurrent edit replaces the entry in
    // the outbox, and we only ack entries that are still identical afterwards.
    const puts: Array<{ id: string; entry: OutboxEntry; updatedAt: string; doc: unknown }> = [];
    const deletes: Array<{ id: string; entry: OutboxEntry; deletedAt: string }> = [];

    for (const [id, entry] of inst.outbox) {
      if (entry.kind === "delete") {
        deletes.push({ id, entry, deletedAt: entry.deletedAt });
        continue;
      }
      const cur = local.get(id);
      if (!cur) { inst.outbox.delete(id); continue; } // deleted meanwhile → a delete entry exists/will exist
      if (payloadBytes(cur.doc) > inst.opts.maxPayloadBytes) {
        console.warn(`[userStoreSync:${inst.adapter.storeKey}] doc ${id} exceeds ${inst.opts.maxPayloadBytes} bytes — skipped`);
        inst.outbox.delete(id);
        continue;
      }
      puts.push({ id, entry, updatedAt: cur.updatedAt, doc: cur.doc });
    }

    for (let i = 0; i < puts.length; i += inst.opts.batchSize) {
      const chunk = puts.slice(i, i + inst.opts.batchSize);
      const res = await fetcher(inst)(inst.opts.endpoint, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          storeKey: inst.adapter.storeKey,
          docs: chunk.map(c => ({ docId: c.id, updatedAt: c.updatedAt, payload: c.doc })),
        }),
      });
      if (!res.ok && res.status !== 202) throw new Error(`user-store PUT failed: ${res.status}`);
      if (res.status === 202) throw new DeferredError(); // table not applied yet — keep outbox, retry later
      ackEntries(inst, chunk);
    }

    for (let i = 0; i < deletes.length; i += inst.opts.batchSize) {
      const chunk = deletes.slice(i, i + inst.opts.batchSize);
      const deletedAt = chunk.reduce((max, c) => (c.deletedAt > max ? c.deletedAt : max), chunk[0].deletedAt);
      const res = await fetcher(inst)(inst.opts.endpoint, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ storeKey: inst.adapter.storeKey, docIds: chunk.map(c => c.id), deletedAt }),
      });
      if (!res.ok && res.status !== 202) throw new Error(`user-store DELETE failed: ${res.status}`);
      if (res.status === 202) throw new DeferredError();
      ackEntries(inst, chunk);
    }

    inst.failureCount = 0;
  } catch {
    // Outbox entries stay put — exponential backoff (capped), forever. A 202
    // deferred (table not applied) backs off the same way.
    inst.failureCount++;
    scheduleRetry(inst, () => void flush(inst));
  } finally {
    inst.flushing = false;
    if (inst.flushQueued) {
      inst.flushQueued = false;
      scheduleFlush(inst);
    }
  }
}

class DeferredError extends Error {
  constructor() { super("user-store deferred (table not applied)"); }
}

/** Timestamp-safe compare: client ISO strings and PostgREST "+00:00" both parse. */
function tsMs(value: string | undefined): number {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/** UTF-8 byte length of the serialized doc (matches the server-side check). */
function payloadBytes(doc: unknown): number {
  return new TextEncoder().encode(JSON.stringify(doc)).length;
}

/** Remove acked entries — unless a newer store write replaced them mid-flight. */
function ackEntries(inst: Instance, chunk: Array<{ id: string; entry: OutboxEntry }>): void {
  for (const { id, entry } of chunk) {
    if (inst.outbox.get(id) === entry) inst.outbox.delete(id);
  }
}

// ── Shared teardown / debug ────────────────────────────────────────────────────

function teardown(inst: Instance): void {
  if (inst.debounceTimer) clearTimeout(inst.debounceTimer);
  if (inst.retryTimer) clearTimeout(inst.retryTimer);
  inst.unsubscribe?.();
  inst.debounceTimer = null;
  inst.retryTimer = null;
  inst.unsubscribe = null;
  inst.mounted = false;
  inst.ready = false;
  inst.flushing = false;
  inst.flushQueued = false;
}

async function waitReady(inst: Instance, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (!inst.ready && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 5));
  }
  return inst.ready;
}

function debugOf(inst: Instance): StoreSyncDebug {
  const outboxKinds: Record<string, "put" | "delete"> = {};
  for (const [id, e] of inst.outbox) outboxKinds[id] = e.kind;
  return {
    storeKey: inst.adapter.storeKey,
    registered: _instances.get(inst.adapter.storeKey) === inst,
    mounted: inst.mounted,
    ready: inst.ready,
    outboxSize: inst.outbox.size,
    failureCount: inst.failureCount,
    outboxKinds,
  };
}

// ── Test hooks (indexed by storeKey; not used by product code) ─────────────────

/** Tear down every instance and reset init state. Test-only. */
export function __resetUserStoreSyncForTests(): void {
  for (const inst of _instances.values()) teardown(inst);
  _instances.clear();
  _initialized = false;
  _getToken = null;
}

export function __getUserStoreSyncDebug(storeKey: string): StoreSyncDebug | null {
  const inst = _instances.get(storeKey);
  return inst ? debugOf(inst) : null;
}

/** Force an immediate flush for one store (bypasses the debounce). Test-only. */
export async function __flushUserStoreSyncForTests(storeKey: string): Promise<void> {
  const inst = _instances.get(storeKey);
  if (!inst) return;
  if (inst.debounceTimer) { clearTimeout(inst.debounceTimer); inst.debounceTimer = null; }
  await flush(inst);
}

/** Wait until one store's startup pull finished (ready) or the timeout elapses. Test-only. */
export async function __waitForUserStoreSyncReady(storeKey: string, timeoutMs = 2_000): Promise<boolean> {
  const inst = _instances.get(storeKey);
  if (!inst) return false;
  return waitReady(inst, timeoutMs);
}
