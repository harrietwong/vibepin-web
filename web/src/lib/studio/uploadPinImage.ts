"use client";

/**
 * Client helper for POST /api/studio/upload — uploads a board Pin image and returns
 * a stable owner-protected proxy URL. Uses the Supabase browser session for the Bearer token (same
 * convention as pinterestClient). Never sets Content-Type so the browser writes the
 * multipart boundary.
 */

import {
  creativeRequestErrorFromResponse,
  creativeRequestErrorFromThrown,
  type CreativeRequestError,
} from "./recommendationRequest";
import { authedInternalRequest } from "./authedInternalRequest";

export type UploadedPinImage = {
  path: string;
  /** Deprecated compatibility alias; intentionally the protected proxy. */
  publicUrl: string;
  /** In‑app display URL; requires the authenticated owner session. */
  proxyUrl: string;
  /** Client id joining upload UI/analytics/support evidence. */
  requestId: string;
};
export type VideoPosterOperation = { batchId: string; ordinal: number };

export class UploadPinImageError extends Error {
  readonly detail: CreativeRequestError;
  constructor(detail: CreativeRequestError) {
    super(`Upload failed (${detail.code})`);
    this.name = "UploadPinImageError";
    this.detail = detail;
  }
}

export async function uploadPinImage(file: File, posterOperation?: VideoPosterOperation): Promise<UploadedPinImage> {
  const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fd = new FormData();
  fd.append("file", file);
  fd.append("requestId", requestId);
  if (posterOperation) {
    fd.append("videoBatchId", posterOperation.batchId);
    fd.append("videoOrdinal", String(posterOperation.ordinal));
  }
  try {
    const res = await authedInternalRequest("/api/studio/upload", {
      method: "POST",
      headers: { "X-Request-Id": requestId },
      body: fd,
    });
    const body = await res.json().catch(() => ({})) as UploadedPinImage & { code?: unknown; error?: unknown };
    if (!res.ok) {
      throw new UploadPinImageError(creativeRequestErrorFromResponse({ stage: "upload", requestId, response: res, body }));
    }
    return { ...body, requestId };
  } catch (error) {
    if (error instanceof UploadPinImageError) throw error;
    throw new UploadPinImageError(creativeRequestErrorFromThrown("upload", requestId, error));
  }
}

/** Queue removal of a private studio image that never became a draft cover. */
export async function requestPinImageCleanup(path: string): Promise<void> {
  const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const response = await authedInternalRequest("/api/studio/upload/cleanup", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Request-Id": requestId },
      body: JSON.stringify({ path }),
    });
    if (!response.ok) throw new Error("poster_cleanup_failed");
  } catch {
    // The caller retains its owner-scoped recovery receipt; errors must not leak a
    // storage path or provider body into the batch UI.
    throw Object.assign(new Error("poster_cleanup_failed"), { code: "poster_cleanup_failed", requestId });
  }
}
