import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { createMediaProvenanceStore } from "@/lib/server/mediaProvenance";
import { createSupabaseVideoStorage } from "@/lib/server/media/supabaseVideoStorage";
import { handleStorageMediaGet } from "@/lib/server/media/storageMediaHandler";
import { VIDEO_UPLOAD_BUCKET } from "@/lib/server/media/videoUploadHandler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const bucket = process.env.VIBEPIN_DRAFT_BUCKET ?? VIDEO_UPLOAD_BUCKET;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const storage = createSupabaseVideoStorage({ supabaseUrl: url, serviceRoleKey: key });
  return handleStorageMediaGet(req, {
    getUserId: getUserIdFromBearerOrCookies, configured: Boolean(url && key), bucket,
    findProvenance: (owner, activeBucket, path) => createMediaProvenanceStore().findExact(owner, activeBucket, path),
    readRange: storage.readRange,
  });
}
