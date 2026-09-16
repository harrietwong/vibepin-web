import { getUserIdFromBearer } from "@/lib/server/authUser";
import { handleVideoUploadPrepare, VIDEO_UPLOAD_BUCKET } from "@/lib/server/media/videoUploadHandler";
import { createVideoUploadStore } from "@/lib/server/media/videoUploadStore";
import { createServerClient } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let db: ReturnType<typeof createServerClient> | null = null;
  const client = () => (db ??= createServerClient());
  const bucket = process.env.VIBEPIN_DRAFT_BUCKET ?? VIDEO_UPLOAD_BUCKET;
  return handleVideoUploadPrepare(req, {
    getUserId: getUserIdFromBearer,
    enabled: process.env.VIDEO_PIN_UPLOAD_ENABLED === "true",
    configured: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY), bucket,
    store: createVideoUploadStore(client()),
    createSignedUpload: async ({ path, contentType, upsert }) => {
      const { data, error } = await client().storage.from(bucket).createSignedUploadUrl(path, { upsert });
      if (error || !data?.token || !data.signedUrl) throw new Error("signed_upload_unavailable");
      return { token: data.token, signedUrl: data.signedUrl };
    },
  });
}
