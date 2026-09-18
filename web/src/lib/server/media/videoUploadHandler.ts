import {
  MAX_VIDEO_DURATION_MS,
  MAX_VIDEO_UPLOAD_BYTES,
  MAX_VIDEO_UPLOAD_ITEMS,
  MIN_VIDEO_DURATION_MS,
  VIDEO_FINALIZE_CLAIM_MS,
  VIDEO_SIGNED_UPLOAD_CAPABILITY_MS,
  VIDEO_UPLOAD_LEDGER_MS,
} from "@/lib/videoUploadLimits";

export const VIDEO_UPLOAD_BUCKET = "generated-private";
export { MAX_VIDEO_UPLOAD_BYTES, MAX_VIDEO_UPLOAD_ITEMS, MIN_VIDEO_DURATION_MS, MAX_VIDEO_DURATION_MS };
export const ALLOWED_VIDEO_TYPES = new Set(["video/mp4", "video/x-m4v", "video/quicktime"]);

type PreparedItem = {
  batchId: string; ordinal: number; status: string; privatePath: string;
  declaredContentType: string; declaredByteSize: number; declaredChecksumSha256: string;
  declaredWidth: number; declaredHeight: number; declaredDurationMs: number; expiresAt: string;
};

export type VideoUploadStore = {
  prepareBatch(input: { ownerUserId: string; idempotencyKey: string; expiresAt: string }): Promise<{ batchId: string }>;
  prepareItem(input: { ownerUserId: string; batchId: string; ordinal: number; idempotencyKey: string; privatePath: string; contentType: string; byteSize: number; checksumSha256: string; width: number; height: number; durationMs: number }): Promise<{ status: string }>;
  confirmCapability(input: { ownerUserId: string; batchId: string; ordinal: number; capabilityExpiresAt: string }): Promise<{ status: string; cleanupScheduled: boolean }>;
  findItem(ownerUserId: string, batchId: string, ordinal: number): Promise<PreparedItem | null>;
  claimItem(input: { ownerUserId: string; batchId: string; ordinal: number; claimToken: string; claimExpiresAt: string }): Promise<{ status: string; claimToken?: string | null; provenanceReady?: boolean }>;
  finalizeItem(input: { ownerUserId: string; batchId: string; ordinal: number; claimToken: string; bucketId: string; contentType: string; byteSize: number; checksumSha256: string | null }): Promise<{ status: string; provenanceReady: boolean }>;
  failItem(input: { ownerUserId: string; batchId: string; ordinal: number; claimToken: string; code: string }): Promise<{ status: string; cleanupAllowed: boolean; cleanupScheduled: boolean }>;
};

export type VideoObjectStorage = {
  stat(input: { bucket: string; path: string }): Promise<{ exists: boolean; contentType?: string; byteSize?: number; verifiedChecksumSha256?: string }>;
  readRange(input: { bucket: string; path: string; start: number; end: number }): Promise<Response>;
  remove(input: { bucket: string; path: string }): Promise<void>;
};

export type VideoUploadHandlerDeps = {
  getUserId(req: Request): Promise<string | null>;
  enabled: boolean; configured: boolean; bucket?: string; expiresInMs?: number; now?: () => Date;
  store: VideoUploadStore;
  createSignedUpload(input: { bucket: string; path: string; contentType: string; upsert: false }): Promise<{ token: string; signedUrl: string }>;
  pathFactory?: (ownerUserId: string, batchId: string, ordinal: number, contentType: string) => string;
  storage?: VideoObjectStorage;
  recordCleanup?: (input: { owner_user_id: string; bucket_id: string; object_path: string; reason: string }) => Promise<void>;
};

type Descriptor = { ordinal: number; idempotencyKey: string; filename: string; contentType: string; byteSize: number; checksumSha256: string; width: number; height: number; durationMs: number };
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_NAME = /^[^/\\\0-\x1f]{1,255}$/;

function requestId(req: Request) { return (req.headers.get("x-request-id") ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128); }
function error(code: string, requestId: string, status: number) { return Response.json({ code, requestId }, { status }); }
function ownerPath(owner: string, path: string) {
  return Boolean(path) && !path.startsWith("/") && !path.includes("\\") && !path.includes("..") && !path.includes("//") && path.split("/")[0] === owner;
}
function extension(type: string) { return type === "video/mp4" ? "mp4" : type === "video/x-m4v" ? "m4v" : "mov"; }
function defaultPath(owner: string, batch: string, ordinal: number, type: string) { return `${owner}/videos/${batch}/${ordinal}-${crypto.randomUUID()}.${extension(type)}`; }

function descriptorFrom(value: unknown): Descriptor | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const number = (key: string) => typeof item[key] === "number" && Number.isSafeInteger(item[key]) ? item[key] as number : null;
  const ordinal = number("ordinal"); const byteSize = number("byteSize"); const width = number("width"); const height = number("height"); const durationMs = number("durationMs");
  if (ordinal === null || byteSize === null || width === null || height === null || durationMs === null
    || typeof item.idempotencyKey !== "string" || !SAFE_ID.test(item.idempotencyKey)
    || typeof item.filename !== "string" || !SAFE_NAME.test(item.filename)
    || typeof item.contentType !== "string" || !ALLOWED_VIDEO_TYPES.has(item.contentType)
    || typeof item.checksumSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(item.checksumSha256)
    || byteSize < 1 || byteSize > MAX_VIDEO_UPLOAD_BYTES || width < 1 || height < 1
    || durationMs < MIN_VIDEO_DURATION_MS || durationMs > MAX_VIDEO_DURATION_MS) return null;
  return { ordinal, idempotencyKey: item.idempotencyKey, filename: item.filename, contentType: item.contentType, byteSize, checksumSha256: item.checksumSha256.toLowerCase(), width, height, durationMs };
}

async function json(req: Request): Promise<Record<string, unknown> | null> {
  try { const value = await req.json(); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
}

export async function handleVideoUploadPrepare(req: Request, deps: VideoUploadHandlerDeps): Promise<Response> {
  const id = requestId(req);
  const owner = await deps.getUserId(req).catch(() => null);
  if (!owner) return error("unauthorized", id, 401);
  if (!deps.enabled) return error("video_upload_disabled", id, 404);
  if (!deps.configured) return error("config_error", id, 503);
  const body = await json(req);
  if (!body || typeof body.idempotencyKey !== "string" || !SAFE_ID.test(body.idempotencyKey) || !Array.isArray(body.files)) return error("invalid_video_upload", id, 400);
  if (body.files.length === 0) return error("invalid_video_upload", id, 400);
  if (body.files.length > MAX_VIDEO_UPLOAD_ITEMS) return error("batch_limit_exceeded", id, 413);
  if (body.files.some(file => {
    if (!file || typeof file !== "object") return false;
    const byteSize = (file as Record<string, unknown>).byteSize;
    return typeof byteSize === "number" && byteSize > MAX_VIDEO_UPLOAD_BYTES;
  })) return error("video_too_large", id, 413);
  const files = body.files.map(descriptorFrom);
  if (files.some((file): file is null => !file)) return error("invalid_video_upload", id, 400);
  const descriptors = files as Descriptor[];
  if (new Set(descriptors.map(file => file.ordinal)).size !== descriptors.length || new Set(descriptors.map(file => file.idempotencyKey)).size !== descriptors.length || descriptors.some(file => file.ordinal < 0 || file.ordinal >= MAX_VIDEO_UPLOAD_ITEMS)) return error("invalid_video_upload", id, 400);
  const bucket = deps.bucket ?? VIDEO_UPLOAD_BUCKET;
  const now = deps.now?.() ?? new Date();
  let batch: { batchId: string };
  try { batch = await deps.store.prepareBatch({ ownerUserId: owner, idempotencyKey: body.idempotencyKey, expiresAt: new Date(now.getTime() + (deps.expiresInMs ?? VIDEO_UPLOAD_LEDGER_MS)).toISOString() }); }
  catch (cause) {
    const code = storeErrorCode(cause);
    if (code === "video_upload_batch_expired") return error("video_upload_expired", id, 422);
    if (code === "video_upload_batch_not_preparable") return error("video_upload_not_uploadable", id, 409);
    return error("video_upload_unavailable", id, 503);
  }
  const uploads: Array<{ ordinal: number; path: string; token: string; signedUrl: string; contentType: string; upsert: false }> = [];
  for (const file of descriptors) {
    // A batch replay must use the original random path. The exact item lookup is
    // owner-filtered by the store; its immutable-facts RPC below decides conflicts.
    let existing: PreparedItem | null;
    try { existing = await deps.store.findItem(owner, batch.batchId, file.ordinal); }
    catch { return error("video_upload_unavailable", id, 503); }
    if (existing && (Date.parse(existing.expiresAt) <= now.getTime() || existing.status !== "prepared")) {
      return error("video_upload_not_uploadable", id, 409);
    }
    const path = existing?.privatePath ?? (deps.pathFactory ?? defaultPath)(owner, batch.batchId, file.ordinal, file.contentType);
    if (!ownerPath(owner, path)) return error("video_upload_unavailable", id, 503);
    try {
      await deps.store.prepareItem({ ownerUserId: owner, batchId: batch.batchId, ordinal: file.ordinal, idempotencyKey: file.idempotencyKey, privatePath: path, contentType: file.contentType, byteSize: file.byteSize, checksumSha256: file.checksumSha256, width: file.width, height: file.height, durationMs: file.durationMs });
      const signed = await deps.createSignedUpload({ bucket, path, contentType: file.contentType, upsert: false });
      if (!signed.token || !signed.signedUrl) throw new Error("capability unavailable");
      const issuedAt = deps.now?.() ?? new Date();
      const confirmation = await deps.store.confirmCapability({ ownerUserId: owner, batchId: batch.batchId, ordinal: file.ordinal,
        capabilityExpiresAt: new Date(issuedAt.getTime() + VIDEO_SIGNED_UPLOAD_CAPABILITY_MS).toISOString() });
      if (confirmation.status !== "prepared" || !confirmation.cleanupScheduled) throw new Error("capability confirmation unavailable");
      uploads.push({ ordinal: file.ordinal, path, token: signed.token, signedUrl: signed.signedUrl, contentType: file.contentType, upsert: false });
    } catch (cause) {
      const code = storeErrorCode(cause);
      if (code === "video_upload_item_idempotency_conflict") return error("video_upload_conflict", id, 409);
      if (code === "video_upload_batch_expired") return error("video_upload_expired", id, 422);
      if (code === "video_upload_batch_not_preparable" || code === "video_upload_item_not_preparable") return error("video_upload_not_uploadable", id, 409);
      return error("video_upload_capability_unavailable", id, 502);
    }
  }
  return Response.json({ ok: true, batchId: batch.batchId, uploads, requestId: id });
}

async function readBounded(response: Response, maximum = 64 * 1024): Promise<Uint8Array | null> {
  const reader = response.body?.getReader(); if (!reader) return null;
  const chunks: Uint8Array[] = []; let length = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; if (!value) continue; length += value.byteLength; if (length > maximum) { await reader.cancel(); return null; } chunks.push(value); } }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result;
}
const ALLOWED_FTYP_BRANDS = new Set(["isom", "iso2", "avc1", "mp41", "mp42", "M4V ", "qt  "]);
function brand(bytes: Uint8Array, offset: number) { return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]); }
function hasFtyp(bytes: Uint8Array | null) {
  if (!bytes || bytes.length < 16 || brand(bytes, 4) !== "ftyp") return false;
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (size < 16 || size > bytes.length || (size - 16) % 4 !== 0) return false;
  // Bytes 12..15 are the mandatory minor_version uint32. A permitted major or
  // compatible brand is required; offset-four magic alone is not a container.
  if (ALLOWED_FTYP_BRANDS.has(brand(bytes, 8))) return true;
  for (let offset = 16; offset + 4 <= size; offset += 4) if (ALLOWED_FTYP_BRANDS.has(brand(bytes, offset))) return true;
  return false;
}
async function readInitialRange(response: Response, end: number, total: number, contentType: string) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  const responseType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const expected = end + 1;
  const length = response.headers.get("content-length");
  if (response.status !== 206 || responseType !== contentType || !match
    || Number(match[1]) !== 0 || Number(match[2]) !== end || Number(match[3]) !== total
    || (length !== null && Number(length) !== expected)) {
    await response.body?.cancel();
    return null;
  }
  const bytes = await readBounded(response, expected);
  return bytes?.byteLength === expected ? bytes : null;
}
function safeResult(item: PreparedItem, id: string) { return { ok: true, batchId: item.batchId, ordinal: item.ordinal, proxyUrl: `/api/storage-media?path=${encodeURIComponent(item.privatePath)}`, requestId: id }; }
function storeErrorCode(value: unknown) {
  const message = value instanceof Error ? value.message : "";
  return new Set([
    "video_upload_item_claimed", "video_upload_claim_lost", "video_upload_provenance_incomplete",
    "video_upload_batch_expired", "video_upload_item_not_finalizable", "video_upload_batch_not_finalizable",
    "video_upload_item_idempotency_conflict", "video_upload_batch_not_found", "video_upload_item_not_found",
    "video_upload_batch_not_preparable", "video_upload_batch_limit_exceeded", "video_upload_too_large",
    "video_upload_item_not_preparable",
  ]).has(message) ? message : null;
}

export async function handleVideoUploadFinalize(req: Request, deps: VideoUploadHandlerDeps): Promise<Response> {
  const id = requestId(req);
  const owner = await deps.getUserId(req).catch(() => null);
  if (!owner) return error("unauthorized", id, 401);
  if (!deps.enabled) return error("video_upload_disabled", id, 404);
  if (!deps.configured || !deps.storage) return error("config_error", id, 503);
  const body = await json(req);
  if (!body || typeof body.batchId !== "string" || !SAFE_ID.test(body.batchId) || typeof body.ordinal !== "number" || !Number.isInteger(body.ordinal) || body.ordinal < 0 || body.ordinal >= MAX_VIDEO_UPLOAD_ITEMS) return error("invalid_video_upload", id, 400);
  let item: PreparedItem | null;
  try { item = await deps.store.findItem(owner, body.batchId, body.ordinal); } catch { return error("video_upload_unavailable", id, 503); }
  if (!item || !ownerPath(owner, item.privatePath)) return error("video_upload_not_found", id, 404);
  const now = deps.now?.() ?? new Date();
  const claimToken = crypto.randomUUID();
  let claim: Awaited<ReturnType<VideoUploadStore["claimItem"]>>;
  try {
    claim = await deps.store.claimItem({ ownerUserId: owner, batchId: item.batchId, ordinal: item.ordinal, claimToken, claimExpiresAt: new Date(now.getTime() + VIDEO_FINALIZE_CLAIM_MS).toISOString() });
  } catch (cause) {
    const code = storeErrorCode(cause);
    if (code === "video_upload_item_claimed" || code === "video_upload_claim_lost") return error("video_upload_in_progress", id, 409);
    if (code === "video_upload_provenance_incomplete") return error("provenance_unavailable", id, 503);
    if (code === "video_upload_batch_expired") return error("video_upload_expired", id, 422);
    if (code === "video_upload_item_not_finalizable" || code === "video_upload_batch_not_finalizable") return error("video_upload_not_finalizable", id, 409);
    return error("video_upload_unavailable", id, 503);
  }
  if (claim.status === "finalized") {
    return claim.provenanceReady ? Response.json(safeResult(item, id)) : error("provenance_unavailable", id, 503);
  }
  if (claim.status !== "finalizing" || claim.claimToken !== claimToken) return error("video_upload_in_progress", id, 409);
  const cleanup = async (code: string) => {
    let failure: Awaited<ReturnType<VideoUploadStore["failItem"]>>;
    try { failure = await deps.store.failItem({ ownerUserId: owner, batchId: item!.batchId, ordinal: item!.ordinal, claimToken, code }); }
    catch (cause) {
      const lost = storeErrorCode(cause) === "video_upload_claim_lost";
      return error(lost ? "video_upload_in_progress" : "video_upload_unavailable", id, lost ? 409 : 503);
    }
    if (!failure.cleanupAllowed || failure.status !== "failed") return error("video_upload_in_progress", id, 409);
    if (!failure.cleanupScheduled) return error("cleanup_not_scheduled", id, 503);
    // The fail RPC already persisted a delayed recheck beyond the capability's
    // lifetime. Immediate deletion is best-effort; a still-valid token can write
    // again, so successful deletion must not settle that durable responsibility.
    try { await deps.storage!.remove({ bucket: deps.bucket ?? VIDEO_UPLOAD_BUCKET, path: item!.privatePath }); }
    catch { /* delayed cleanup is already durable */ }
    return error(code, id, code === "missing_video_object" ? 404 : code === "video_upload_unavailable" ? 503 : 422);
  };
  if (Date.parse(item.expiresAt) <= now.getTime()) return cleanup("video_upload_expired");
  let stat: Awaited<ReturnType<VideoObjectStorage["stat"]>>;
  try { stat = await deps.storage.stat({ bucket: deps.bucket ?? VIDEO_UPLOAD_BUCKET, path: item.privatePath }); } catch { return cleanup("video_upload_unavailable"); }
  if (!stat.exists) return cleanup("missing_video_object");
  if (!stat.byteSize || stat.byteSize > MAX_VIDEO_UPLOAD_BYTES) return cleanup("invalid_video_size");
  if (stat.contentType !== item.declaredContentType || !ALLOWED_VIDEO_TYPES.has(stat.contentType)) return cleanup("video_content_type_mismatch");
  if (stat.byteSize !== item.declaredByteSize || (stat.verifiedChecksumSha256 && stat.verifiedChecksumSha256.toLowerCase() !== item.declaredChecksumSha256)) return cleanup("video_facts_mismatch");
  let header: Uint8Array | null;
  const headerEnd = Math.min(63, stat.byteSize - 1);
  try { header = await readInitialRange(await deps.storage.readRange({ bucket: deps.bucket ?? VIDEO_UPLOAD_BUCKET, path: item.privatePath, start: 0, end: headerEnd }), headerEnd, stat.byteSize, stat.contentType); } catch { return cleanup("video_upload_unavailable"); }
  if (!header) return cleanup("video_upload_unavailable");
  if (!hasFtyp(header)) return cleanup("invalid_video_container");
  try {
    const finalized = await deps.store.finalizeItem({ ownerUserId: owner, batchId: item.batchId, ordinal: item.ordinal, claimToken,
      bucketId: deps.bucket ?? VIDEO_UPLOAD_BUCKET, contentType: stat.contentType, byteSize: stat.byteSize,
      checksumSha256: stat.verifiedChecksumSha256?.toLowerCase() ?? null });
    if (finalized.status !== "finalized" || !finalized.provenanceReady) return cleanup("provenance_unavailable");
  } catch { return cleanup("video_upload_unavailable"); }
  return Response.json(safeResult(item, id));
}
