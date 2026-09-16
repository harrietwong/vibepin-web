import type { MediaProvenance } from "@/lib/server/mediaProvenance";
import { ALLOWED_VIDEO_TYPES, MAX_VIDEO_UPLOAD_BYTES, VIDEO_UPLOAD_BUCKET } from "./videoUploadHandler";

export type StorageMediaDeps = {
  getUserId(req: Request): Promise<string | null>; configured: boolean; bucket?: string;
  findProvenance(ownerUserId: string, bucket: string, path: string): Promise<MediaProvenance | null>;
  readRange(input: { bucket: string; path: string; start: number; end: number }): Promise<Response>;
};
const ALLOWED_VIDEO_LIFECYCLES = new Set(["draft", "publish_pending", "published", "retained"]);

function pathStatus(owner: string, path: string | null): 0 | 400 | 403 {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("..") || path.includes("//")) return 400;
  return path.split("/")[0] === owner ? 0 : 403;
}
const PRIVATE_VARY = "Cookie, Authorization, Range";
function empty(status: number, headers: HeadersInit = {}) { return new Response(null, { status, headers: { Vary: PRIVATE_VARY, ...headers } }); }
function range(value: string | null, size: number): { start: number; end: number; partial: boolean } | null {
  if (!value) return { start: 0, end: size - 1, partial: false };
  if (value.includes(",") || !value.startsWith("bytes=")) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value); if (!match || (!match[1] && !match[2])) return null;
  let start: number; let end: number;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix < 1) return null; start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null; end = Math.min(end, size - 1); }
  return { start, end, partial: true };
}

/** Reject a misbehaving upstream rather than streaming bytes past the authorized range. */
function boundedRangeBody(body: ReadableStream<Uint8Array>, expected: number): ReadableStream<Uint8Array> {
  let received = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > expected) {
        controller.error(new Error("range body exceeded"));
        return;
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (received !== expected) controller.error(new Error("range body incomplete"));
    },
  }));
}

function normalizedType(value: string | null) { return value?.split(";", 1)[0]?.trim().toLowerCase() ?? ""; }
function contentRange(value: string | null) {
  const match = value && /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
  if (!match) return null;
  const parsed = match.slice(1).map(Number);
  return parsed.every(Number.isSafeInteger) ? { start: parsed[0], end: parsed[1], total: parsed[2] } : null;
}
function readyVideoFacts(provenance: MediaProvenance) {
  const checksumReady = provenance.checksum_source === "unavailable" ? provenance.checksum_sha256 == null
    : provenance.checksum_source === "storage_digest_verified" && typeof provenance.checksum_sha256 === "string" && /^[a-f0-9]{64}$/.test(provenance.checksum_sha256);
  return provenance.content_type_source === "storage_head_verified" && provenance.byte_size_source === "storage_head_verified"
    && checksumReady && provenance.dimensions_source === "browser_declared" && provenance.duration_source === "browser_declared"
    && Number.isSafeInteger(provenance.width) && provenance.width! > 0 && Number.isSafeInteger(provenance.height) && provenance.height! > 0
    && Number.isSafeInteger(provenance.duration_ms) && provenance.duration_ms! >= 4_000 && provenance.duration_ms! <= 300_000;
}

export async function handleStorageMediaGet(req: Request, deps: StorageMediaDeps): Promise<Response> {
  const owner = await deps.getUserId(req).catch(() => null); if (!owner) return empty(401);
  if (!deps.configured) return empty(404);
  const url = new URL(req.url); if (url.searchParams.getAll("path").length !== 1 || [...url.searchParams.keys()].some(key => key !== "path")) return empty(400);
  const path = url.searchParams.get("path"); const unsafe = pathStatus(owner, path); if (unsafe) return empty(unsafe);
  const bucket = deps.bucket ?? VIDEO_UPLOAD_BUCKET;
  const provenance = await deps.findProvenance(owner, bucket, path!).catch(() => null);
  if (!provenance || provenance.owner_user_id !== owner || provenance.bucket_id !== bucket || provenance.object_path !== path || provenance.media_kind !== "video" || !ALLOWED_VIDEO_LIFECYCLES.has(provenance.lifecycle_state) || !ALLOWED_VIDEO_TYPES.has(provenance.content_type ?? "") || !Number.isSafeInteger(provenance.byte_size) || provenance.byte_size! < 1 || provenance.byte_size! > MAX_VIDEO_UPLOAD_BYTES || !readyVideoFacts(provenance)) return empty(403);
  const requested = range(req.headers.get("range"), provenance.byte_size!); if (!requested) return empty(416, { "Content-Range": `bytes */${provenance.byte_size}` });
  try {
    const upstream = await deps.readRange({ bucket, path: path!, start: requested.start, end: requested.end });
    const expected = requested.end - requested.start + 1;
    const contentLength = upstream.headers.get("content-length");
    const length = contentLength === null ? null : Number(contentLength);
    const upstreamType = normalizedType(upstream.headers.get("content-type"));
    const rawContentRange = upstream.headers.get("content-range");
    const upstreamRange = contentRange(rawContentRange);
    const exactPartial = upstream.status === 206 && upstreamRange?.start === requested.start
      && upstreamRange.end === requested.end && upstreamRange.total === provenance.byte_size;
    const exactFull200 = !requested.partial && upstream.status === 200 && rawContentRange === null && length === expected;
    if (!upstream.body || upstreamType !== provenance.content_type || (!exactPartial && !exactFull200)
      || (length !== null && (!Number.isSafeInteger(length) || length !== expected))) { await upstream.body?.cancel(); return empty(502); }
    return new Response(boundedRangeBody(upstream.body, expected), { status: requested.partial ? 206 : 200, headers: {
      "Content-Type": provenance.content_type!, "Content-Length": String(expected),
      ...(requested.partial ? { "Content-Range": `bytes ${requested.start}-${requested.end}/${provenance.byte_size}` } : {}),
      "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=300", Vary: PRIVATE_VARY, "X-Content-Type-Options": "nosniff",
    } });
  } catch { return empty(502); }
}
