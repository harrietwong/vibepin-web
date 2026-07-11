/**
 * POST /api/studio/upload  (multipart form-data, field: "file")
 *
 * Uploads a user image for a Create Pins **board** Pin to Supabase Storage and
 * returns STABLE URLs. Unlike the old picker (which produced non‑publishable
 * `data:` URLs), this yields a real hosted object so the Pin can be published.
 *
 * Returns:
 *   { ok, path, publicUrl, proxyUrl }
 *   - publicUrl : `${SUPABASE_URL}/storage/v1/object/public/generated/<path>` — used
 *     for Pinterest publish (Pinterest fetches it unauthenticated). Requires the
 *     `generated` bucket to allow public reads.
 *   - proxyUrl  : `/api/storage-image?path=<path>` — always works in‑app for display
 *     even if the bucket is private.
 *
 * Security: authenticated user (Bearer); image content‑types only; size‑capped;
 * stored under `studio/uploads/<uid>/…` so the existing storage-image proxy (which
 * only serves `studio/…`) can display it.
 */

import { getUserIdFromBearer } from "@/lib/server/authUser";
import { createServerClient } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const BUCKET = "generated";
const MAX_BYTES = 12 * 1024 * 1024; // 12 MB

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function genName(ext: string): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${ext}`;
}

export async function POST(req: Request) {
  const uid = await getUserIdFromBearer(req);
  if (!uid) {
    return Response.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }
  if (!SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return Response.json({ error: "Storage is not configured", code: "config_error" }, { status: 500 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Expected multipart/form-data", code: "bad_request" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "Missing file", code: "bad_request" }, { status: 400 });
  }
  const ext = EXT_BY_TYPE[file.type];
  if (!ext) {
    return Response.json({ error: "Unsupported image type", code: "invalid_type" }, { status: 415 });
  }
  if (file.size <= 0 || file.size > MAX_BYTES) {
    return Response.json({ error: "Image too large (max 12MB)", code: "too_large" }, { status: 413 });
  }

  const path = `studio/uploads/${uid}/${genName(ext)}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const sb = createServerClient();
    const { error } = await sb.storage.from(BUCKET).upload(path, buffer, {
      contentType: file.type,
      upsert: false,
      cacheControl: "31536000",
    });
    if (error) {
      console.error("[studio/upload] storage upload failed:", error.message);
      return Response.json({ error: "Upload failed. Please try again.", code: "upload_failed" }, { status: 502 });
    }
  } catch (err) {
    console.error("[studio/upload] unexpected error:", (err as Error)?.message);
    return Response.json({ error: "Upload failed. Please try again.", code: "internal_error" }, { status: 500 });
  }

  return Response.json(
    {
      ok: true,
      path,
      publicUrl: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`,
      proxyUrl: `/api/storage-image?path=${encodeURIComponent(path)}`,
    },
    { status: 201 },
  );
}
