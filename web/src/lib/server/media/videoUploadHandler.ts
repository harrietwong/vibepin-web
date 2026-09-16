import type { MediaProvenance } from "@/lib/server/mediaProvenance";

export const VIDEO_UPLOAD_BUCKET = "generated-private";
export const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_VIDEO_UPLOAD_ITEMS = 20;
export const ALLOWED_VIDEO_TYPES = new Set(["video/mp4", "video/x-m4v", "video/quicktime"]);

type PreparedItem = {
  batchId: string; ordinal: number; status: string; privatePath: string;
  declaredContentType: string; declaredByteSize: number; declaredChecksumSha256: string;
  declaredWidth: number; declaredHeight: number; declaredDurationMs: number; expiresAt: string;
};

export type VideoUploadStore = {
  prepareBatch(input: { ownerUserId: string; idempotencyKey: string; expiresAt: string }): Promise<{ batchId: string }>;
  prepareItem(input: { ownerUserId: string; batchId: string; ordinal: number; idempotencyKey: string; privatePath: string; contentType: string; byteSize: number; checksumSha256: string; width: number; height: number; durationMs: number }): Promise<{ status: string }>;
  findItem(ownerUserId: string, batchId: string, ordinal: number): Promise<PreparedItem | null>;
  finalizeItem(input: { ownerUserId: string; batchId: string; ordinal: number; contentType: string; byteSize: number; checksumSha256: string; width: number; height: number; durationMs: number }): Promise<{ status: string }>;
  failItem(input: { ownerUserId: string; batchId: string; ordinal: number; code: string }): Promise<void>;
};

export type VideoObjectStorage = {
  stat(input: { bucket: string; path: string }): Promise<{ exists: boolean; contentType?: string; byteSize?: number; checksumSha256?: string }>;
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
  registerProvenance?: (input: Omit<MediaProvenance, "bucket_id"> & { bucket_id: string }) => Promise<boolean>;
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
    || byteSize < 1 || byteSize > MAX_VIDEO_UPLOAD_BYTES || width < 1 || height < 1 || durationMs < 1) return null;
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
  const files = body.files.map(descriptorFrom);
  if (files.some((file): file is null => !file)) return error("invalid_video_upload", id, 400);
  const descriptors = files as Descriptor[];
  if (new Set(descriptors.map(file => file.ordinal)).size !== descriptors.length || new Set(descriptors.map(file => file.idempotencyKey)).size !== descriptors.length || descriptors.some(file => file.ordinal < 0 || file.ordinal >= MAX_VIDEO_UPLOAD_ITEMS)) return error("invalid_video_upload", id, 400);
  const bucket = deps.bucket ?? VIDEO_UPLOAD_BUCKET;
  const now = deps.now?.() ?? new Date();
  let batch: { batchId: string };
  try { batch = await deps.store.prepareBatch({ ownerUserId: owner, idempotencyKey: body.idempotencyKey, expiresAt: new Date(now.getTime() + (deps.expiresInMs ?? 15 * 60_000)).toISOString() }); }
  catch { return error("video_upload_unavailable", id, 503); }
  const uploads: Array<{ ordinal: number; path: string; token: string; signedUrl: string; contentType: string; upsert: false }> = [];
  for (const file of descriptors) {
    // A batch replay must use the original random path. The exact item lookup is
    // owner-filtered by the store; its immutable-facts RPC below decides conflicts.
    let existing: PreparedItem | null;
    try { existing = await deps.store.findItem(owner, batch.batchId, file.ordinal); }
    catch { return error("video_upload_unavailable", id, 503); }
    const path = existing?.privatePath ?? (deps.pathFactory ?? defaultPath)(owner, batch.batchId, file.ordinal, file.contentType);
    if (!ownerPath(owner, path)) return error("video_upload_unavailable", id, 503);
    try {
      await deps.store.prepareItem({ ownerUserId: owner, batchId: batch.batchId, ordinal: file.ordinal, idempotencyKey: file.idempotencyKey, privatePath: path, contentType: file.contentType, byteSize: file.byteSize, checksumSha256: file.checksumSha256, width: file.width, height: file.height, durationMs: file.durationMs });
      const signed = await deps.createSignedUpload({ bucket, path, contentType: file.contentType, upsert: false });
      if (!signed.token || !signed.signedUrl) throw new Error("capability unavailable");
      uploads.push({ ordinal: file.ordinal, path, token: signed.token, signedUrl: signed.signedUrl, contentType: file.contentType, upsert: false });
    } catch { return error("video_upload_capability_unavailable", id, 502); }
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
function hasFtyp(bytes: Uint8Array | null) { return Boolean(bytes && bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70); }
function safeResult(item: PreparedItem, id: string) { return { ok: true, batchId: item.batchId, ordinal: item.ordinal, proxyUrl: `/api/storage-media?path=${encodeURIComponent(item.privatePath)}`, requestId: id }; }

export async function handleVideoUploadFinalize(req: Request, deps: VideoUploadHandlerDeps): Promise<Response> {
  const id = requestId(req);
  const owner = await deps.getUserId(req).catch(() => null);
  if (!owner) return error("unauthorized", id, 401);
  if (!deps.enabled) return error("video_upload_disabled", id, 404);
  if (!deps.configured || !deps.storage || !deps.registerProvenance) return error("config_error", id, 503);
  const body = await json(req);
  if (!body || typeof body.batchId !== "string" || !SAFE_ID.test(body.batchId) || typeof body.ordinal !== "number" || !Number.isInteger(body.ordinal) || body.ordinal < 0 || body.ordinal >= MAX_VIDEO_UPLOAD_ITEMS) return error("invalid_video_upload", id, 400);
  let item: PreparedItem | null;
  try { item = await deps.store.findItem(owner, body.batchId, body.ordinal); } catch { return error("video_upload_unavailable", id, 503); }
  if (!item || !ownerPath(owner, item.privatePath)) return error("video_upload_not_found", id, 404);
  if (item.status === "finalized") return Response.json(safeResult(item, id));
  const cleanup = async (code: string) => {
    try { await deps.store.failItem({ ownerUserId: owner, batchId: item!.batchId, ordinal: item!.ordinal, code }); } catch { /* failure state is best effort; cleanup remains mandatory */ }
    try { await deps.storage!.remove({ bucket: deps.bucket ?? VIDEO_UPLOAD_BUCKET, path: item!.privatePath }); }
    catch { try { await deps.recordCleanup?.({ owner_user_id: owner, bucket_id: deps.bucket ?? VIDEO_UPLOAD_BUCKET, object_path: item!.privatePath, reason: code }); } catch { /* safe failure response below */ } }
    return error(code, id, code === "missing_video_object" ? 404 : code === "video_upload_unavailable" ? 503 : 422);
  };
  if (Date.parse(item.expiresAt) <= (deps.now?.() ?? new Date()).getTime()) return cleanup("video_upload_expired");
  let stat: Awaited<ReturnType<VideoObjectStorage["stat"]>>;
  try { stat = await deps.storage.stat({ bucket: deps.bucket ?? VIDEO_UPLOAD_BUCKET, path: item.privatePath }); } catch { return cleanup("video_upload_unavailable"); }
  if (!stat.exists) return cleanup("missing_video_object");
  if (!stat.byteSize || stat.byteSize > MAX_VIDEO_UPLOAD_BYTES) return cleanup("invalid_video_size");
  if (stat.contentType !== item.declaredContentType || !ALLOWED_VIDEO_TYPES.has(stat.contentType)) return cleanup("video_content_type_mismatch");
  if (stat.byteSize !== item.declaredByteSize || (stat.checksumSha256 && stat.checksumSha256.toLowerCase() !== item.declaredChecksumSha256)) return cleanup("video_facts_mismatch");
  let header: Uint8Array | null;
  try { header = await readBounded(await deps.storage.readRange({ bucket: deps.bucket ?? VIDEO_UPLOAD_BUCKET, path: item.privatePath, start: 0, end: Math.min(63, stat.byteSize - 1) })); } catch { return cleanup("video_upload_unavailable"); }
  if (!hasFtyp(header)) return cleanup("invalid_video_container");
  try {
    const checksum = stat.checksumSha256?.toLowerCase() ?? item.declaredChecksumSha256;
    await deps.store.finalizeItem({ ownerUserId: owner, batchId: item.batchId, ordinal: item.ordinal, contentType: stat.contentType, byteSize: stat.byteSize, checksumSha256: checksum, width: item.declaredWidth, height: item.declaredHeight, durationMs: item.declaredDurationMs });
    const registered = await deps.registerProvenance({ owner_user_id: owner, bucket_id: deps.bucket ?? VIDEO_UPLOAD_BUCKET, object_path: item.privatePath, source_type: "upload", intent_id: null, lifecycle_state: "draft", media_kind: "video", content_type: stat.contentType, byte_size: stat.byteSize, checksum_sha256: checksum, width: item.declaredWidth, height: item.declaredHeight, duration_ms: item.declaredDurationMs });
    if (!registered) return cleanup("provenance_unavailable");
  } catch { return cleanup("video_upload_unavailable"); }
  return Response.json(safeResult(item, id));
}
