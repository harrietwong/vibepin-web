import { createClient } from "@supabase/supabase-js";
import { getInstagramAccessToken } from "@/lib/server/instagram/connectionStore";
import { fetchRecentInstagramMedia, InstagramApiError } from "@/lib/server/instagram/service";

export const dynamic = "force-dynamic";

async function authenticatedUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  const { data: { user }, error } = await client.auth.getUser(token);
  return error || !user ? null : user.id;
}

export async function GET(req: Request): Promise<Response> {
  const userId = await authenticatedUserId(req);
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const connectionId = url.searchParams.get("connectionId")?.trim() ?? "";
  const since = url.searchParams.get("since")?.trim() ?? "";
  if (!connectionId || !since || !Number.isFinite(Date.parse(since))) {
    return Response.json({ error: "connectionId and a valid since timestamp are required" }, { status: 400 });
  }

  const connection = await getInstagramAccessToken(userId, connectionId);
  if (!connection?.accessToken || !connection.userId) {
    return Response.json({ error: "Instagram connection unavailable" }, { status: 404 });
  }

  try {
    const media = await fetchRecentInstagramMedia({
      accessToken: connection.accessToken,
      igUserId: connection.userId,
      since,
      limit: 25,
    });
    return Response.json({ accountId: connection.userId, username: connection.username, media });
  } catch (error) {
    const status = error instanceof InstagramApiError && error.status >= 400 && error.status < 500
      ? error.status
      : 502;
    return Response.json({
      error: error instanceof InstagramApiError ? error.code : "instagram_media_fetch_failed",
    }, { status });
  }
}
