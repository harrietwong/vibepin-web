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
 *
 * Auth + insert + degrade rules live in lib/server/recordEvent.ts so server-side
 * callers (reference-candidates) record events through the identical path.
 */

import { normalizeAnalyticsEvents } from "@/lib/analyticsIngest";
import { recordAnalyticsEvents } from "@/lib/server/recordEvent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noContent = () => new Response(null, { status: 204 });

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return noContent();
  }

  const rows = normalizeAnalyticsEvents(body);
  if (rows.length === 0) return noContent();

  // Never throws; unauthenticated batches are dropped inside (204, never rejected).
  await recordAnalyticsEvents(
    req,
    rows.map(r => ({
      event_name: r.event_name,
      draft_id:   r.draft_id,
      payload:    r.payload ?? undefined,
    })),
  );
  return noContent();
}
