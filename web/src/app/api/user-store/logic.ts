/**
 * logic.ts — pure, dependency-free helpers for the /api/user-store route.
 *
 * Extracted from the request handlers so the validation, LWW decision, cursor
 * codec and missing-table detection can be unit-tested without a running server
 * or a Supabase client (see scripts/test-user-store-route.ts). The route.ts
 * handlers are thin orchestration on top of these.
 *
 * Mirrors the /api/pin-drafts conventions, generalized with a mandatory
 * `storeKey` dimension and without pin-draft-specific promoted columns.
 */

// ── Limits & validation constants ─────────────────────────────────────────────

/** Allowed store_key shape (server + client agree on this). */
export const STORE_KEY_RE = /^[a-z0-9_-]{1,64}$/;
export const MAX_BATCH = 50;
export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 100;
export const MAX_PAYLOAD_BYTES = 200 * 1024; // 200KB per document payload
export const MAX_DOC_ID_LEN = 200;

export type IncomingDoc = { docId: string; updatedAt: string; payload: Record<string, unknown> };

// ── Primitive validators ──────────────────────────────────────────────────────

export function isValidStoreKey(value: unknown): value is string {
  return typeof value === "string" && STORE_KEY_RE.test(value);
}

/** Parse an ISO timestamp to epoch ms, or null when absent/invalid. */
export function parseMs(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** UTF-8 byte length of a serialized payload (matches the client-side guard). */
export function payloadBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload ?? null), "utf8");
}

export function payloadTooLarge(payload: unknown): boolean {
  return payloadBytes(payload) > MAX_PAYLOAD_BYTES;
}

/**
 * Server LWW: an incoming write is stale (must be skipped) only when the existing
 * row is STRICTLY newer than the incoming timestamp. Equal timestamps overwrite
 * (idempotent) — same rule as /api/pin-drafts.
 */
export function isStalePut(incomingMs: number, existingMs: number | undefined): boolean {
  return existingMs !== undefined && incomingMs < existingMs;
}

/**
 * A tombstone is eligible only when the existing row is not newer than the
 * tombstone (a newer local edit wins and revives the row on the next push).
 */
export function isTombstoneEligible(deletedMs: number, existingMs: number | undefined): boolean {
  return existingMs !== undefined && existingMs <= deletedMs;
}

/** Clamp a raw ?limit into [1, MAX_LIMIT], defaulting when unparseable. */
export function clampLimit(raw: string | null): number {
  const n = parseInt(raw ?? `${DEFAULT_LIMIT}`, 10);
  return Math.min(Math.max(Number.isNaN(n) ? DEFAULT_LIMIT : n, 1), MAX_LIMIT);
}

// ── Missing-table degradation (v40 not applied yet) ───────────────────────────

/** v40 not applied yet → degrade instead of 500 (matches pin-drafts / errors.ts). */
export function isMissingTableError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const message = err.message ?? "";
  return (
    err.code === "PGRST205"
    || err.code === "42P01"
    || message.includes("Could not find the table")
    || (message.includes("relation") && message.includes("does not exist"))
  );
}

// ── Cursor codec (keyset on updated_at desc, doc_id asc) ───────────────────────

/** Cursor = base64url({ u: updated_at, d: doc_id }) of the last row of the page. */
export function encodeCursor(u: string, d: string): string {
  return Buffer.from(JSON.stringify({ u, d }), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): { u: string; d: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { u?: unknown; d?: unknown };
    if (typeof parsed.u !== "string" || typeof parsed.d !== "string") return null;
    if (parseMs(parsed.u) === null) return null;
    return { u: parsed.u, d: parsed.d };
  } catch {
    return null;
  }
}

/** Quote a value for a PostgREST or=() filter (timestamps contain ':' and '+'). */
export function pgQuote(value: string): string {
  return `"${value.replace(/["\\]/g, "")}"`;
}

// ── Body validators ───────────────────────────────────────────────────────────

/** Error kind lets the route map to a status/code without string-sniffing. */
export type ValidationErrorKind = "bad_request" | "payload_too_large";
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: ValidationErrorKind; error: string };

/** Validate the PUT `docs` array (shape, batch cap, timestamps, payload size). */
export function validateDocs(raw: unknown): ValidationResult<IncomingDoc[]> {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, kind: "bad_request", error: "docs array is required" };
  if (raw.length > MAX_BATCH) return { ok: false, kind: "bad_request", error: `At most ${MAX_BATCH} docs per request` };

  const docs: IncomingDoc[] = [];
  for (const item of raw) {
    const d = item as Partial<IncomingDoc> | null;
    if (
      !d || typeof d.docId !== "string" || !d.docId || d.docId.length > MAX_DOC_ID_LEN
      || parseMs(d.updatedAt) === null
      || !d.payload || typeof d.payload !== "object" || Array.isArray(d.payload)
    ) {
      return { ok: false, kind: "bad_request", error: "Each doc needs docId, updatedAt (ISO) and payload (object)" };
    }
    if (payloadTooLarge(d.payload)) {
      return { ok: false, kind: "payload_too_large", error: `Doc ${d.docId} payload exceeds 200KB` };
    }
    docs.push({ docId: d.docId, updatedAt: d.updatedAt as string, payload: d.payload as Record<string, unknown> });
  }
  return { ok: true, value: docs };
}

/** Validate the DELETE `docIds` array (shape, batch cap). */
export function validateDocIds(raw: unknown): ValidationResult<string[]> {
  const ids = Array.isArray(raw)
    ? (raw as unknown[]).filter((x): x is string => typeof x === "string" && !!x && x.length <= MAX_DOC_ID_LEN)
    : [];
  if (ids.length === 0) return { ok: false, kind: "bad_request", error: "docIds array is required" };
  if (ids.length > MAX_BATCH) return { ok: false, kind: "bad_request", error: `At most ${MAX_BATCH} docIds per request` };
  return { ok: true, value: ids };
}
