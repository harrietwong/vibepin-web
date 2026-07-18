/**
 * POST /api/analytics/events — durable sink for client analytics (PRD v0.2 A4).
 *
 * Body: `{ events: [{ event, payload?, draftId? }] }` (or a bare array). ≤20 events;
 * oversized payloads are truncated (analyticsIngest.ts). Fire-and-forget from the
 * client (navigator.sendBeacon / fetch keepalive), so auth rides the same-origin
 * Supabase session cookie — a Bearer header is honored too when present.
 *
 * Best-effort by contract:
 *  - Not signed in            → 204 (dropped, per A4).
 *  - v41 table not applied    → 204 (dropped; client has no retry/outbox).
 *  - Nothing valid to insert  → 204.
 * Only genuine DB failures are logged; the client never reads this response.
 */

import { getUserIdFromSameOriginSession } from "@/lib/server/authUser";
import { createServerClient } from "@/lib/supabase";
import { normalizeAnalyticsEvents } from "@/lib/analyticsIngest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TABLE = "analytics_events";
const noContent = () => new Response(null, { status: 204 });

/** v41 analytics_events not applied yet → drop silently (mirror of pin-drafts degrade). */
function isMissingTableError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const message = err.message ?? "";
  return (
    err.code === "PGRST205"
    || err.code === "42P01"
    || message.includes("Could not find the table")
    || (message.includes("relation") && message.includes("does not exist"))
  );
}

export async function POST(req: Request) {
  // Unauthenticated events are dropped (204), never rejected — keeps the caller silent.
  const userId = await getUserIdFromSameOriginSession(req);
  if (!userId) return noContent();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return noContent();
  }

  const rows = normalizeAnalyticsEvents(body);
  if (rows.length === 0) return noContent();

  const db = createServerClient();
  const { error } = await db.from(TABLE).insert(
    rows.map(r => ({
      workspace_id: userId,   // effective workspace == user today
      user_id:      userId,
      draft_id:     r.draft_id,
      event_name:   r.event_name,
      payload:      r.payload,
    })),
  );

  if (error && !isMissingTableError(error)) {
    console.error("[analytics/events POST] insert error:", error.message);
  }
  return noContent();
}
