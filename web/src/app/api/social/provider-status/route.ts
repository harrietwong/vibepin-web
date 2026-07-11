/**
 * GET /api/social/provider-status
 *
 * Server-only diagnostic that reports how the social publishing provider is
 * configured — WITHOUT exposing any secret. It returns whether the required env
 * is present (by name only), never the API key value or the base URL contents.
 *
 * Response:
 *   {
 *     provider: "mock" | "zernio" | "oneup",
 *     configured: boolean,          // is the active provider ready to use?
 *     baseUrlConfigured: boolean,
 *     missingEnv: string[]          // names of required-but-missing env vars
 *   }
 *
 * Requires auth so config presence can't be probed anonymously.
 */

import { getUserIdFromBearer } from "@/lib/server/authUser";
import { getProviderStatus } from "@/lib/social/providers";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const uid = await getUserIdFromBearer(req);
  if (!uid) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return Response.json(getProviderStatus());
}
