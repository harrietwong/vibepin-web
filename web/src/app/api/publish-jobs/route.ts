/**
 * POST /api/publish-jobs  — Schedule a generated asset for publishing
 * GET  /api/publish-jobs  — List publish jobs for the authenticated user
 *
 * POST body:
 *   {
 *     asset_id:      string   // UUID of generated_assets row (required)
 *     scheduled_at?: string   // ISO timestamp; defaults to now()
 *     mock_board_id?: string  // board identifier; defaults to 'mock-board-01'
 *     platform?:     string   // defaults to 'pinterest'
 *   }
 *
 * GET query params:
 *   ?status=scheduled|pending|sending|published|failed  (omit = all)
 *   ?limit=25  (default 50, max 100)
 *
 * The service role key is used server-side so RLS is bypassed.
 * user_id is resolved from the Bearer token in Authorization header.
 */

import { createClient }    from "@supabase/supabase-js";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Browser-facing writes use the service role so the server can write on behalf
// of the authenticated user without needing cookie-based SSR clients.
// Lazy: a clean `next build` collects page data without Supabase env vars.
let _adminDb: ReturnType<typeof createServerClient> | null = null;
const adminDb = () => (_adminDb ??= createServerClient());

// ── Types ─────────────────────────────────────────────────────────────────────

export type PublishJobStatus =
  | "scheduled"
  | "pending"
  | "sending"
  | "published"
  | "failed";

export type PublishJob = {
  id:                  string;
  user_id:             string;
  generated_asset_id:  string | null;
  platform:            string;
  mock_board_id:       string | null;
  scheduled_at:        string;
  status:              PublishJobStatus;
  pinterest_pin_url:   string | null;
  error_message:       string | null;
  retry_count:         number;
  published_at:        string | null;
  created_at:          string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve the user_id from the Authorization: Bearer <supabase-access-token>
 * header. Returns null if the token is missing or invalid.
 */
async function getUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!token) return null;

  // Verify the JWT against Supabase Auth (anon key is sufficient for getUser)
  const anonClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  const { data: { user }, error } = await anonClient.auth.getUser(token);
  if (error || !user) return null;
  return user.id;
}

// ── POST — schedule a job ─────────────────────────────────────────────────────

export async function POST(req: Request) {
  const userId = await getUserId(req);
  if (!userId) {
    return Response.json(
      { error: "Unauthorized — include Authorization: Bearer <token>" },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Accept asset_id or generated_asset_id; both are optional for mock flows
  // where generated_assets rows don't exist yet.
  const assetId =
    typeof body.asset_id            === "string" ? body.asset_id.trim() :
    typeof body.generated_asset_id  === "string" ? body.generated_asset_id.trim() :
    null;

  const scheduledAt = body.scheduled_at
    ? new Date(String(body.scheduled_at)).toISOString()
    : new Date().toISOString();

  const mockBoardId =
    typeof body.mock_board_id === "string" ? body.mock_board_id.trim() : "mock-board-01";

  const platform =
    typeof body.platform === "string" ? body.platform.trim() : "pinterest";

  const { data, error } = await adminDb()
    .from("publish_jobs")
    .insert({
      user_id:            userId,
      generated_asset_id: assetId,
      platform,
      mock_board_id:      mockBoardId,
      scheduled_at:       scheduledAt,
      status:             "scheduled" satisfies PublishJobStatus,
    })
    .select("id, user_id, generated_asset_id, platform, mock_board_id, scheduled_at, status, created_at")
    .single();

  if (error) {
    console.error("[publish-jobs POST]", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true, job: data as PublishJob }, { status: 201 });
}

// ── PATCH — manually mark a job as published ─────────────────────────────────

export async function PATCH(req: Request) {
  const userId = await getUserId(req);
  if (!userId) {
    return Response.json(
      { error: "Unauthorized — include Authorization: Bearer <token>" },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : null;
  if (!id) {
    return Response.json({ error: "id is required" }, { status: 400 });
  }

  const { error } = await adminDb()
    .from("publish_jobs")
    .update({
      status:       "published" satisfies PublishJobStatus,
      published_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", userId);

  if (error) {
    console.error("[publish-jobs PATCH]", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ ok: true });
}

// ── GET — list jobs for the current user ──────────────────────────────────────

export async function GET(req: Request) {
  const userId = await getUserId(req);
  if (!userId) {
    return Response.json(
      { error: "Unauthorized — include Authorization: Bearer <token>" },
      { status: 401 },
    );
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") as PublishJobStatus | null;
  const limit  = Math.min(
    parseInt(searchParams.get("limit") ?? "50", 10),
    100,
  );

  let query = adminDb()
    .from("publish_jobs")
    .select(
      "id, user_id, generated_asset_id, platform, mock_board_id, scheduled_at, status, " +
      "pinterest_pin_url, error_message, retry_count, published_at, created_at",
    )
    .eq("user_id", userId)
    .order("scheduled_at", { ascending: true })
    .limit(limit);

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;

  if (error) {
    console.error("[publish-jobs GET]", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ jobs: (data ?? []) as unknown as PublishJob[] });
}
