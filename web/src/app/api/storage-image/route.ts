/**
 * GET /api/storage-image?path=studio/filename.png
 *
 * Proxies Supabase Storage images server-side using the service-role key.
 * Required because the "generated" bucket may not have public access enabled —
 * public URLs would 403 in the browser, but this route authenticates the fetch
 * server-side and streams the bytes back with a 24-hour cache header.
 *
 * Security: callers must be authenticated. User uploads under
 * "studio/uploads/<uid>/" are owner-only; legacy direct children of "studio/"
 * remain available to any authenticated user.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { authorizeStudioStoragePath } from "@/lib/server/storagePathAuth";

export const runtime = "nodejs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SVC_KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const BUCKET       = "generated";

export async function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get("path"); // e.g. "studio/1700000000_0_abc12345.png"

  const userId = await getUserIdFromBearerOrCookies(req).catch(() => null);
  if (!userId) {
    return new NextResponse(null, { status: 401 });
  }

  if (!path || !SUPABASE_URL || !SVC_KEY) {
    return new NextResponse(null, { status: 404 });
  }

  const authorization = authorizeStudioStoragePath(path, userId);
  if (!authorization.ok) {
    return new NextResponse(null, { status: authorization.status });
  }

  const encodedPath = authorization.path.split("/").map(encodeURIComponent).join("/");
  const authUrl   = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodedPath}`;
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${encodedPath}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  async function fetchImage(url: string, headers?: Record<string, string>) {
    const resp = await fetch(url, { headers, signal: controller.signal });
    if (!resp.ok) return null;
    const contentType = resp.headers.get("content-type") ?? "image/png";
    const body = await resp.arrayBuffer();
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type":  contentType,
        "Cache-Control": "private, max-age=86400, immutable",
        "Vary":          "Authorization, Cookie",
      },
    });
  }

  try {
    const pub = await fetchImage(publicUrl);
    if (pub) return pub;

    const authed = await fetchImage(authUrl, {
      "Authorization": `Bearer ${SVC_KEY}`,
      "apikey":        SVC_KEY,
    });
    if (authed) return authed;

    return new NextResponse(null, { status: 404 });
  } catch (err) {
    console.error("[storage-image] fetch failed:", path, err);
    return new NextResponse(null, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
