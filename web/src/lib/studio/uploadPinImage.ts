"use client";

/**
 * Client helper for POST /api/studio/upload — uploads a board Pin image and returns
 * stable hosted URLs. Uses the Supabase browser session for the Bearer token (same
 * convention as pinterestClient). Never sets Content-Type so the browser writes the
 * multipart boundary.
 */

import { createBrowserClient } from "@supabase/ssr";

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
  /** Public URL for publishing (Pinterest fetches this unauthenticated). */
  publicUrl: string;
  /** In‑app display URL that works even if the bucket is private. */
  proxyUrl: string;
};

export async function uploadPinImage(file: File): Promise<UploadedPinImage> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/studio/upload", {
    method: "POST",
    headers: await bearer(),
    body: fd,
  });
  if (!res.ok) {
    let message = "Upload failed. Please try again.";
    try {
      const body = await res.json() as { error?: string };
      if (body?.error) message = body.error;
    } catch { /* non‑JSON */ }
    throw new Error(message);
  }
  return res.json() as Promise<UploadedPinImage>;
}
