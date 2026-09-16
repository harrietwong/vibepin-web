import { getUserIdFromBearer } from "@/lib/server/authUser";
import { createMediaProvenanceStore } from "@/lib/server/mediaProvenance";
import { createVideoPosterOperationStore } from "@/lib/server/media/videoPosterOperationStore";
import { createServerClient } from "@/lib/supabase";
import { DEFAULT_DRAFT_BUCKET, handleStudioUploadCleanup } from "../handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let client: ReturnType<typeof createServerClient> | null = null;
  const db = () => (client ??= createServerClient());
  return handleStudioUploadCleanup(req, {
    getUserId: getUserIdFromBearer,
    configured: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    bucket: process.env.VIBEPIN_DRAFT_BUCKET ?? DEFAULT_DRAFT_BUCKET,
    findProvenance: async input => createMediaProvenanceStore(db()).findExact(input.owner_user_id, input.bucket_id, input.object_path),
    canCleanupPoster: async input => createVideoPosterOperationStore(db()).canCleanup({ ownerUserId: input.owner_user_id, bucketId: input.bucket_id, objectPath: input.object_path }),
    recordCleanup: input => createMediaProvenanceStore(db()).recordCleanup(input),
  });
}
