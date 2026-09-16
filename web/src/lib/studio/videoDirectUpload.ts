"use client";

import { createBrowserClient } from "@supabase/ssr";

export type VideoUploadDescriptor = { ordinal: number; idempotencyKey: string; filename: string; contentType: "video/mp4" | "video/x-m4v" | "video/quicktime"; byteSize: number; checksumSha256: string; width: number; height: number; durationMs: number };
export type SignedVideoUpload = { ordinal: number; path: string; token: string; signedUrl: string; contentType: string; upsert: false };
type PrepareResponse = { batchId: string; uploads: SignedVideoUpload[]; requestId: string };

let client: ReturnType<typeof createBrowserClient> | null = null;
function browser() { return client ??= createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!); }
async function authHeaders(): Promise<Record<string, string>> { const { data: { session } } = await browser().auth.getSession(); return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}; }
function requestId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`; }

export async function sha256(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function api<T>(url: string, body: unknown, id: string): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-request-id": id, ...(await authHeaders()) }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({})) as T & { code?: string };
  if (!response.ok) throw Object.assign(new Error(payload.code ?? "video_upload_failed"), { code: payload.code, requestId: id });
  return payload;
}

/** Browser-to-private-Storage transfer; no video bytes enter a Next multipart route. */
export async function prepareVideoDirectUpload(idempotencyKey: string, files: VideoUploadDescriptor[]): Promise<PrepareResponse> {
  if (process.env.NEXT_PUBLIC_VIDEO_PIN_UPLOAD !== "true") throw Object.assign(new Error("video_upload_disabled"), { code: "video_upload_disabled" });
  return api<PrepareResponse>("/api/studio/video-upload/prepare", { idempotencyKey, files }, requestId());
}
export async function uploadVideoToSignedStorage(upload: SignedVideoUpload, file: File): Promise<void> {
  const { error } = await browser().storage.from("generated-private").uploadToSignedUrl(upload.path, upload.token, file, { contentType: upload.contentType, upsert: false });
  if (error) throw Object.assign(new Error("video_upload_failed"), { code: "video_upload_failed" });
}
export async function finalizeVideoDirectUpload(batchId: string, ordinal: number) {
  return api<{ ok: true; batchId: string; ordinal: number; proxyUrl: string; requestId: string }>("/api/studio/video-upload/finalize", { batchId, ordinal }, requestId());
}
