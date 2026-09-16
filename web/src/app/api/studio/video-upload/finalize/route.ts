import { getUserIdFromBearer } from "@/lib/server/authUser";
import { createMediaProvenanceStore } from "@/lib/server/mediaProvenance";
import { createSupabaseVideoStorage } from "@/lib/server/media/supabaseVideoStorage";
import { handleVideoUploadFinalize, VIDEO_UPLOAD_BUCKET } from "@/lib/server/media/videoUploadHandler";
import { createVideoUploadStore } from "@/lib/server/media/videoUploadStore";
import { createServerClient } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let db: ReturnType<typeof createServerClient> | null = null;
  const client = () => (db ??= createServerClient());
  const bucket = process.env.VIBEPIN_DRAFT_BUCKET ?? VIDEO_UPLOAD_BUCKET;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return handleVideoUploadFinalize(req, {
    getUserId: getUserIdFromBearer, enabled: process.env.VIDEO_PIN_UPLOAD_ENABLED === "true", configured: Boolean(url && key), bucket,
    store: createVideoUploadStore(client()),
    createSignedUpload: async () => { throw new Error("unused"); },
    storage: createSupabaseVideoStorage({ supabaseUrl: url, serviceRoleKey: key }),
    registerProvenance: input => createMediaProvenanceStore(client()).register(input),
    recordCleanup: input => createMediaProvenanceStore(client()).recordCleanup(input),
  });
}
