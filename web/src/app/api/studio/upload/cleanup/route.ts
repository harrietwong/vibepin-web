import { getUserIdFromBearer } from "@/lib/server/authUser";
import { createMediaProvenanceStore } from "@/lib/server/mediaProvenance";
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
    recordCleanup: input => createMediaProvenanceStore(db()).recordCleanup(input),
  });
}
