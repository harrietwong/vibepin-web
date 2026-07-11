/**
 * mediaOffload.ts — WP-C image externalization + background sweep.
 *
 * The product library, asset and basket stores historically embedded uploaded
 * images as `data:` (base64) URLs — and one picker produced `blob:` URLs that die
 * on refresh. Neither is meaningful across devices and both blow past the account
 * sync engine's 200KB per-doc cap. This module:
 *
 *   1) Converts a `data:` URL to a real hosted image via POST /api/studio/upload
 *      (the SAME endpoint the studio board uses) and returns its STABLE publicUrl.
 *   2) Runs a low-concurrency, self-terminating background sweep that finds every
 *      `data:`/`blob:` image still living in those three stores, uploads it, and
 *      replaces it in place — stamping a fresh updatedAt + firing the store's
 *      persist event so the account-sync engine automatically pushes the now-stable
 *      document to the server on its next diff.
 *
 * Sweep semantics (per WP-C spec):
 *   - concurrency ≤ 2; exponential backoff on upload failure (retries forever, the
 *     local copy is untouched until an upload succeeds);
 *   - `blob:` whose bytes can't be fetched (dead handle) → skipped permanently and
 *     left local (the adapters exclude it from the sync set anyway);
 *   - malformed `data:` → skipped permanently (never retried);
 *   - idempotent + re-entrant: a second start while running returns the in-flight
 *     promise; when a pass finds no offloadable image, the sweep stops;
 *   - SSR-safe (no window → no-op); silently waits + retries when no token is
 *     available yet;
 *   - re-arms itself on any of the three stores' persist events, so a fallback
 *     `data:` written after the initial sweep finished is picked up.
 */

import {
  collectMediaOffloadCandidates as collectProductLibrary,
  PRODUCT_LIBRARY_EVENT,
} from "./productLibraryStore";
import {
  collectMediaOffloadCandidates as collectAssets,
  ASSET_STORE_EVENT,
} from "./assetStore";
import {
  collectMediaOffloadCandidates as collectBasket,
  BASKET_EVENT,
} from "./basketStore";
import { isDataUrl, isBlobUrl, isLocalMediaUrl } from "./mediaUrl";

// Re-export the URL predicates so existing importers of mediaOffload keep working.
export { isDataUrl, isBlobUrl, isLocalMediaUrl } from "./mediaUrl";

// ── Public types ───────────────────────────────────────────────────────────────

export type GetAccessToken = () => Promise<string | null>;

/**
 * One offloadable image found in a store. `url` is the current (data:/blob:) value;
 * `replace(stableUrl)` swaps it in place, bumps the owning doc's updatedAt and fires
 * the store's persist event. Stores return these from collectMediaOffloadCandidates.
 */
export interface MediaOffloadCandidate {
  url: string;
  replace: (stableUrl: string) => void;
}

export interface MediaOffloadOptions {
  /** Injectable fetch (tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Upload endpoint. Default "/api/studio/upload". */
  uploadEndpoint?: string;
  /** First backoff delay after a failure. Default 2000ms. */
  backoffBaseMs?: number;
  /** Backoff cap. Default 60000ms. */
  backoffMaxMs?: number;
  /** Max concurrent uploads. Default 2. */
  concurrency?: number;
}

// ── URL helpers ────────────────────────────────────────────────────────────────

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!match) throw new Error("mediaOffload: not a data URL");
  const mime = match[1] || "application/octet-stream";
  const isBase64 = !!match[2];
  const data = match[3];
  if (isBase64) {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(data)], { type: mime });
}

export function dataUrlToFile(dataUrl: string, filename?: string): File {
  const blob = dataUrlToBlob(dataUrl);
  const ext = EXT_BY_MIME[blob.type] ?? "png";
  return new File([blob], filename ?? `offload_${Date.now()}.${ext}`, { type: blob.type || "image/png" });
}

// ── Single-image upload ────────────────────────────────────────────────────────

function resolveOpts(opts?: MediaOffloadOptions): Required<Omit<MediaOffloadOptions, "fetchImpl">> & { fetchImpl: typeof fetch } {
  return {
    fetchImpl: opts?.fetchImpl ?? fetch,
    uploadEndpoint: opts?.uploadEndpoint ?? "/api/studio/upload",
    backoffBaseMs: opts?.backoffBaseMs ?? 2_000,
    backoffMaxMs: opts?.backoffMaxMs ?? 60_000,
    concurrency: opts?.concurrency ?? 2,
  };
}

async function uploadBlob(blob: Blob, token: string, endpoint: string, fetchImpl: typeof fetch): Promise<string> {
  const ext = EXT_BY_MIME[blob.type] ?? "png";
  const file = new File([blob], `offload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`, {
    type: blob.type || "image/png",
  });
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!res.ok) throw new Error(`mediaOffload: upload failed ${res.status}`);
  const body = (await res.json()) as { publicUrl?: string };
  if (!body?.publicUrl) throw new Error("mediaOffload: upload response missing publicUrl");
  return body.publicUrl;
}

/**
 * Upload one `data:` URL and return its stable publicUrl. Throws when there is no
 * token or the upload fails (so callers can decide to keep the data URL). Fetch is
 * injectable for tests.
 */
export async function offloadDataUrl(
  dataUrl: string,
  getToken: GetAccessToken,
  opts?: MediaOffloadOptions,
): Promise<string> {
  const token = await getToken();
  if (!token) throw new Error("mediaOffload: no access token");
  const { uploadEndpoint, fetchImpl } = resolveOpts(opts);
  return uploadBlob(dataUrlToBlob(dataUrl), token, uploadEndpoint, fetchImpl);
}

// ── Background sweep ───────────────────────────────────────────────────────────

let _current: Promise<void> | null = null;
let _getToken: GetAccessToken | null = null;
let _opts: MediaOffloadOptions | undefined;
let _rearmAttached = false;
/** Permanently-skipped URLs (dead blob handles / malformed data URLs). */
const _skip = new Set<string>();

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function gather(): MediaOffloadCandidate[] {
  const all = [...collectProductLibrary(), ...collectAssets(), ...collectBasket()];
  return all.filter((c) => isLocalMediaUrl(c.url) && !_skip.has(c.url));
}

/** Turn a candidate URL into uploadable bytes, or null if it should be skipped. */
async function resolveToUploadable(url: string, fetchImpl: typeof fetch): Promise<Blob | null> {
  if (isDataUrl(url)) {
    try {
      return dataUrlToBlob(url);
    } catch {
      return null; // malformed → skip permanently
    }
  }
  if (isBlobUrl(url)) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) return null;
      const blob = await res.blob();
      return blob && blob.size > 0 ? blob : null;
    } catch {
      return null; // dead handle → skip permanently
    }
  }
  return null;
}

async function runPool(
  items: MediaOffloadCandidate[],
  limit: number,
  worker: (c: MediaOffloadCandidate) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const item = items[idx++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function sweep(): Promise<void> {
  const { fetchImpl, uploadEndpoint, backoffBaseMs, backoffMaxMs, concurrency } = resolveOpts(_opts);
  let failCount = 0;
  for (;;) {
    const items = gather();
    if (items.length === 0) return; // nothing left → stop

    const token = _getToken ? await _getToken() : null;
    if (!token) {
      // Silently wait + retry until a token is available.
      await delay(Math.min(backoffBaseMs * 2 ** failCount, backoffMaxMs));
      failCount++;
      continue;
    }

    let anySuccess = false;
    let anyRetryable = false;
    await runPool(items, concurrency, async (item) => {
      const blob = await resolveToUploadable(item.url, fetchImpl);
      if (!blob) {
        _skip.add(item.url); // dead blob / malformed data URL — permanent skip
        return;
      }
      try {
        const stableUrl = await uploadBlob(blob, token, uploadEndpoint, fetchImpl);
        item.replace(stableUrl);
        anySuccess = true;
      } catch {
        anyRetryable = true; // network/server — retry with backoff
      }
    });

    if (anySuccess) {
      failCount = 0;
    } else if (anyRetryable) {
      await delay(Math.min(backoffBaseMs * 2 ** failCount, backoffMaxMs));
      failCount++;
    }
    // else: only permanent skips happened this pass → the next gather() drops them
    // and returns [] (unless a store event added new work), so the loop terminates.
  }
}

function attachRearm(): void {
  if (_rearmAttached || typeof window === "undefined") return;
  _rearmAttached = true;
  const rearm = () => {
    // A fallback data URL (or a fresh blob) was persisted — restart if idle.
    // start* is a no-op while a sweep is in flight.
    kickoff();
  };
  window.addEventListener(PRODUCT_LIBRARY_EVENT, rearm);
  window.addEventListener(ASSET_STORE_EVENT, rearm);
  window.addEventListener(BASKET_EVENT, rearm);
}

function kickoff(): Promise<void> {
  if (_current) return _current;
  if (typeof window === "undefined") return Promise.resolve();
  if (gather().length === 0) return Promise.resolve();
  _current = sweep().finally(() => {
    _current = null;
  });
  return _current;
}

/**
 * Start the background media-offload sweep. Idempotent + re-entrant (a call while a
 * sweep runs returns the in-flight promise). SSR-safe. Captures the token getter +
 * options for later self-re-arm on store events. Returns the sweep promise (tests
 * await it; product callers ignore it).
 */
export function startMediaOffloadSweep(getToken: GetAccessToken, opts?: MediaOffloadOptions): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  _getToken = getToken;
  if (opts) _opts = opts;
  attachRearm();
  return kickoff();
}

// ── Test-only hooks ────────────────────────────────────────────────────────────

export function __resetMediaOffloadForTests(): void {
  _current = null;
  _getToken = null;
  _opts = undefined;
  _rearmAttached = false;
  _skip.clear();
}

export function __getMediaOffloadDebug(): { running: boolean; skipped: number; pending: number } {
  return { running: _current !== null, skipped: _skip.size, pending: gather().length };
}
