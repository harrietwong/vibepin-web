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
function empty(status: number) { return new Response(null, { status }); }
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
function boundedRangeBody(body: ReadableStream<Uint8Array>, maximum: number): ReadableStream<Uint8Array> {
  let received = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > maximum) {
        controller.error(new Error("range body exceeded"));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
}

export async function handleStorageMediaGet(req: Request, deps: StorageMediaDeps): Promise<Response> {
  const owner = await deps.getUserId(req).catch(() => null); if (!owner) return empty(401);
  if (!deps.configured) return empty(404);
  const url = new URL(req.url); if (url.searchParams.getAll("path").length !== 1 || [...url.searchParams.keys()].some(key => key !== "path")) return empty(400);
  const path = url.searchParams.get("path"); const unsafe = pathStatus(owner, path); if (unsafe) return empty(unsafe);
  const bucket = deps.bucket ?? VIDEO_UPLOAD_BUCKET;
  const provenance = await deps.findProvenance(owner, bucket, path!).catch(() => null);
  if (!provenance || provenance.owner_user_id !== owner || provenance.bucket_id !== bucket || provenance.object_path !== path || provenance.media_kind !== "video" || !ALLOWED_VIDEO_LIFECYCLES.has(provenance.lifecycle_state) || !ALLOWED_VIDEO_TYPES.has(provenance.content_type ?? "") || !Number.isSafeInteger(provenance.byte_size) || provenance.byte_size! < 1 || provenance.byte_size! > MAX_VIDEO_UPLOAD_BYTES) return empty(403);
  const requested = range(req.headers.get("range"), provenance.byte_size!); if (!requested) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${provenance.byte_size}` } });
  try {
    const upstream = await deps.readRange({ bucket, path: path!, start: requested.start, end: requested.end });
    const expected = requested.end - requested.start + 1;
    const contentLength = upstream.headers.get("content-length");
    const length = contentLength === null ? null : Number(contentLength);
    if (!upstream.ok || !upstream.body || (length !== null && (!Number.isSafeInteger(length) || length !== expected))) { await upstream.body?.cancel(); return empty(502); }
    return new Response(boundedRangeBody(upstream.body, expected), { status: requested.partial ? 206 : 200, headers: {
      "Content-Type": provenance.content_type!, "Content-Length": String(expected),
      ...(requested.partial ? { "Content-Range": `bytes ${requested.start}-${requested.end}/${provenance.byte_size}` } : {}),
      "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=300", Vary: "Authorization, Range", "X-Content-Type-Options": "nosniff",
    } });
  } catch { return empty(502); }
}
