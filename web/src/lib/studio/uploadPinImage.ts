"use client";

/**
 * Client helper for POST /api/studio/upload — uploads a board Pin image and returns
 * a stable owner-protected proxy URL. Uses the Supabase browser session for the Bearer token (same
 * convention as pinterestClient). Never sets Content-Type so the browser writes the
 * multipart boundary.
 */

import { createBrowserClient } from "@supabase/ssr";
import {
  creativeRequestErrorFromResponse,
  creativeRequestErrorFromThrown,
  type CreativeRequestError,
} from "./recommendationRequest";

let _client: ReturnType<typeof createBrowserClient> | null = null;
function browser() {
  if (_client) return _client;
  _client = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  return _client;
}

async function bearer(): Promise<Record<string, string>> {
  const { data: { session } } = await browser().auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

export type UploadedPinImage = {
  path: string;
  /** Deprecated compatibility alias; intentionally the protected proxy. */
  publicUrl: string;
  /** In‑app display URL; requires the authenticated owner session. */
  proxyUrl: string;
  /** Client id joining upload UI/analytics/support evidence. */
  requestId: string;
};

export class UploadPinImageError extends Error {
  readonly detail: CreativeRequestError;
  constructor(detail: CreativeRequestError) {
    super(`Upload failed (${detail.code})`);
    this.name = "UploadPinImageError";
    this.detail = detail;
  }
}

export async function uploadPinImage(file: File): Promise<UploadedPinImage> {
  const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fd = new FormData();
  fd.append("file", file);
  fd.append("requestId", requestId);
  try {
    const res = await fetch("/api/studio/upload", {
      method: "POST",
      headers: { ...(await bearer()), "X-Request-Id": requestId },
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
