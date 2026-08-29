/**
 * recordEvent.ts — server-side, best-effort sink for analytics events.
 *
 * Extracted from POST /api/analytics/events so server routes (e.g.
 * /api/reference-candidates) can record their own events with the exact same
 * semantics the client sink already has:
 *
 *  - Not signed in         → drop silently (no row, no error).
 *  - v41 table not applied → drop silently (no retry/outbox anywhere).
 *  - Anything unexpected   → logged once, swallowed.
 *
 * Contract: this function NEVER throws and never rejects. Callers treat it as
 * fire-and-forget telemetry that must not be able to fail their response — an
 * analytics write is never a reason for a product request to break.
 */

import { getUserIdFromSameOriginSession } from "@/lib/server/authUser";
import { createServerClient } from "@/lib/supabase";
import { normalizeAnalyticsEvents } from "@/lib/analyticsIngest";

export const ANALYTICS_EVENTS_TABLE = "analytics_events";

/** One event as callers express it (row shape, not the client `track()` shape). */
export interface AnalyticsEventInput {
  event_name: string;
  draft_id?:  string | null;
  payload?:   Record<string, unknown>;
}

/** v41 analytics_events not applied yet → drop silently (mirror of pin-drafts degrade). */
export function isMissingTableError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const message = err.message ?? "";
  return (
    err.code === "PGRST205"
    || err.code === "42P01"
    || message.includes("Could not find the table")
    || (message.includes("relation") && message.includes("does not exist"))
  );
}

/**
 * Insert `rows` into analytics_events for the caller's same-origin session user.
 * Normalization (event-name/draft-id bounds, payload truncation, ≤20 per batch)
 * is delegated to normalizeAnalyticsEvents so server-side events obey exactly the
 * same limits as client-side ones.
 */
export async function recordAnalyticsEvents(
  req: Request,
  rows: AnalyticsEventInput[],
): Promise<void> {
  try {
    if (!Array.isArray(rows) || rows.length === 0) return;

    // Unauthenticated → nothing to attribute the event to; drop it.
    const userId = await getUserIdFromSameOriginSession(req);
    if (!userId) return;

    const normalized = normalizeAnalyticsEvents(
      rows.map(r => ({
        event:   r?.event_name,
        payload: r?.payload,
        draftId: r?.draft_id ?? undefined,
      })),
    );
    if (normalized.length === 0) return;

    const db = createServerClient();
    const { error } = await db.from(ANALYTICS_EVENTS_TABLE).insert(
      normalized.map(r => ({
        workspace_id: userId,   // effective workspace == user today
        user_id:      userId,
        draft_id:     r.draft_id,
        event_name:   r.event_name,
        payload:      r.payload,
      })),
    );

    if (error && !isMissingTableError(error)) {
      console.error("[recordAnalyticsEvents] insert error:", error.message);
    }
  } catch (err) {
    // Never propagate: cookies() outside a request scope, a missing service key,
    // a network blip — none of these may surface to the caller's response.
    console.error("[recordAnalyticsEvents] unexpected error:", err instanceof Error ? err.message : err);
  }
}
