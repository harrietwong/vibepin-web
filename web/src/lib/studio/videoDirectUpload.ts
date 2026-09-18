"use client";

import { sha256Blob } from "./incrementalSha256";
import { VIDEO_UPLOAD_MAX_IN_FLIGHT_MS } from "@/lib/videoUploadLimits";
import { authedInternalRequest, type InternalApiPath } from "./authedInternalRequest";

export { VIDEO_UPLOAD_MAX_IN_FLIGHT_MS } from "@/lib/videoUploadLimits";

export type VideoUploadDescriptor = { ordinal: number; idempotencyKey: string; filename: string; contentType: "video/mp4" | "video/x-m4v" | "video/quicktime"; byteSize: number; checksumSha256: string; width: number; height: number; durationMs: number };
export type SignedVideoUpload = { ordinal: number; path: string; token: string; signedUrl: string; contentType: string; upsert: false };
type PrepareResponse = { batchId: string; uploads: SignedVideoUpload[]; requestId: string };

function requestId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`; }

export async function sha256(file: Blob, signal?: AbortSignal): Promise<string> {
  return sha256Blob(file, signal);
}
async function api<T>(url: InternalApiPath, body: unknown, id: string, fetchImpl: typeof fetch = fetch): Promise<T> {
  const response = await authedInternalRequest(url, {
    method: "POST", headers: { "content-type": "application/json", "x-request-id": id }, body: JSON.stringify(body),
  }, fetchImpl);
  const payload = await response.json().catch(() => ({})) as T & { code?: string };
  if (!response.ok) throw Object.assign(new Error(payload.code ?? "video_upload_failed"), { code: payload.code, requestId: id });
  return payload;
}

/** Browser-to-private-Storage transfer; no video bytes enter a Next multipart route. */
export async function prepareVideoDirectUpload(idempotencyKey: string, files: VideoUploadDescriptor[]): Promise<PrepareResponse> {
  if (process.env.NEXT_PUBLIC_VIDEO_PIN_UPLOAD !== "true") throw Object.assign(new Error("video_upload_disabled"), { code: "video_upload_disabled" });
  return api<PrepareResponse>("/api/studio/video-upload/prepare", { idempotencyKey, files }, requestId());
}
export type DirectUploadOptions = {
  batchId: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
};

function verifiedSignedUploadUrl(upload: SignedVideoUpload) {
  try {
    const url = new URL(upload.signedUrl);
    const marker = "/object/upload/sign/";
    const markerAt = url.pathname.indexOf(marker);
    const signedPath = markerAt < 0 ? "" : decodeURIComponent(url.pathname.slice(markerAt + marker.length));
    if (url.protocol !== "https:" || signedPath !== `generated-private/${upload.path}`
      || url.searchParams.get("token") !== upload.token || upload.upsert !== false) throw new Error("mismatch");
    return url.toString();
  } catch {
    throw Object.assign(new Error("video_upload_invalid_capability"), { code: "video_upload_invalid_capability" });
  }
}

export async function uploadVideoToSignedStorage(upload: SignedVideoUpload, file: File, options: DirectUploadOptions): Promise<void> {
  const signedUrl = verifiedSignedUploadUrl(upload);
  const fetchImpl = options.fetchImpl ?? fetch;
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  const controller = new AbortController();
  let timedOut = false;
  const callerAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) callerAbort();
  else options.signal?.addEventListener("abort", callerAbort, { once: true });
  const timer = setTimeoutImpl(() => { timedOut = true; controller.abort(); }, VIDEO_UPLOAD_MAX_IN_FLIGHT_MS);
  try {
    const body = new FormData();
    body.append("cacheControl", "3600");
    body.append("", file);
    const response = await fetchImpl(signedUrl, {
      method: "PUT", headers: { "x-upsert": "false" }, body, signal: controller.signal,
    });
    if (!response.ok) throw Object.assign(new Error("video_upload_failed"), { code: "video_upload_failed" });
  } catch (cause) {
    if (!controller.signal.aborted) throw cause;
    const code = timedOut ? "video_upload_timeout" : "video_upload_aborted";
    // Never use the success/finalize endpoint as an abort notification. The PUT may
    // have committed just before cancellation; finalizing here would make the object
    // permanent while the batch state discards the response and creates no draft.
    // The prepare transaction already owns the durable late-object cleanup/recheck.
    throw Object.assign(new Error(code), { code });
  } finally {
    clearTimeoutImpl(timer);
    options.signal?.removeEventListener("abort", callerAbort);
  }
}
export async function finalizeVideoDirectUpload(batchId: string, ordinal: number) {
  return api<{ ok: true; batchId: string; ordinal: number; proxyUrl: string; requestId: string }>("/api/studio/video-upload/finalize", { batchId, ordinal }, requestId());
}
export async function retainVideoPosterOperation(batchId: string, ordinal: number, path: string): Promise<void> {
  await api<{ ok: true }>("/api/studio/upload/poster-operation", { action: "retain", batchId, ordinal, path }, requestId());
}
