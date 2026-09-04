/**
 * GET /api/storage-image?path=studio/filename.png
 *
 * Proxies Supabase Storage images server-side using the service-role key.
 * Required because the "generated" bucket may not have public access enabled —
 * public URLs would 403 in the browser, but this route authenticates the fetch
 * server-side and streams the bytes back with a 24-hour cache header.
 *
 * Security: callers must be authenticated. User uploads under
 * "studio/uploads/<uid>/" are owner-only. Legacy direct children of "studio/"
 * require an exact result URL in this user's service-role-only generation job;
 * an arbitrary client-writable draft/history URL is never ownership evidence.
 */

import { NextRequest } from "next/server";
import { handleStorageImageGet } from "@/lib/server/storageImageHandler";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  return handleStorageImageGet(req);
}
