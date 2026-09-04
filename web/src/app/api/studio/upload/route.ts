/**
 * POST /api/studio/upload  (multipart form-data, field: "file")
 *
 * Uploads a user image for a Create Pins **board** Pin to Supabase Storage and
 * returns STABLE owner-protected proxy URLs. Unlike the old picker (which produced non‑publishable
 * `data:` URLs), this yields a real hosted object so the Pin can be published.
 *
 * Returns:
 *   { ok, path, publicUrl, proxyUrl }
 *   - publicUrl : deprecated compatibility alias containing the protected proxy;
 *     it is never a public/provider-facing URL.
 *   - proxyUrl  : `/api/storage-image?path=<path>` — always works in‑app for display
 *     even if the bucket is private.
 *
 * Security: authenticated user (Bearer); image content‑types only; size‑capped;
 * stored under `studio/uploads/<uid>/…` so the existing storage-image proxy (which
 * only serves `studio/…`) can display it.
 */

import { getUserIdFromBearer } from "@/lib/server/authUser";
import { createServerClient } from "@/lib/supabase";
import { createMediaProvenanceStore } from "@/lib/server/mediaProvenance";
import { DEFAULT_DRAFT_BUCKET, handleStudioUpload } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const BUCKET = process.env.VIBEPIN_DRAFT_BUCKET ?? DEFAULT_DRAFT_BUCKET;

export async function POST(req: Request) {
  let sb: ReturnType<typeof createServerClient> | null = null;
  const client = () => (sb ??= createServerClient());
  return handleStudioUpload(req, {
    getUserId: getUserIdFromBearer,
    configured: Boolean(SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    bucket: BUCKET,
    uploadObject: async ({ bucket, path, bytes, contentType }) => {
      const { error } = await client().storage.from(bucket).upload(path, Buffer.from(bytes), {
        contentType,
        upsert: false,
        cacheControl: "31536000",
      });
      if (error) console.error("[studio/upload] storage upload failed:", error.message);
      return { error: error?.message ?? null };
    },
    registerProvenance: input => createMediaProvenanceStore(client()).register(input),
    recordCleanup: input => createMediaProvenanceStore(client()).recordCleanup(input),
    removeObject: async (bucket, path) => {
      const { error } = await client().storage.from(bucket).remove([path]);
      if (error) throw error;
    },
  });
}
