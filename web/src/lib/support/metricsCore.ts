/**
 * Pure, network-free core for the admin support metrics cards + aging
 * badges. No server imports (no Supabase client) — this module is safe to
 * import from a "use client" component. `metrics.ts` (server-only) wraps
 * `computeMetricsFromRows` with the actual Supabase fetch.
 */

export type SupportMetrics = {
  newLast7d: number;
  staleOpenOver48h: number;
  aiReplyRate30d: number | null;
  aiResolvedRate30d: number | null;
  avgFirstHumanReplyHours30d: number | null;
};

export type TicketMetricRow = { status: string; createdAt: string; updatedAt: string };
export type EventMetricRow = { ticketId: string; eventType: string; createdAt: string };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Computes the admin support metrics from already-fetched rows. All date
 * math lives here so it can be unit-tested without a database.
 *
 * `tickets` only needs to be a superset covering both the "created in the
 * last 7 days" and "currently Open" populations — the two counts below
 * filter it independently. `events` should already be scoped to
 * created_at >= now-30d server-side, but this function re-filters
 * defensively so callers can't accidentally over-count on a stale window.
 */
export function computeMetricsFromRows(
  tickets: TicketMetricRow[],
  events: EventMetricRow[],
  now: Date,
): SupportMetrics {
  const nowMs = now.getTime();
  const sevenDaysAgo = nowMs - 7 * DAY_MS;
  const fortyEightHoursAgo = nowMs - 48 * HOUR_MS;
  const thirtyDaysAgo = nowMs - 30 * DAY_MS;

  const newLast7d = tickets.filter((t) => new Date(t.createdAt).getTime() >= sevenDaysAgo).length;
  const staleOpenOver48h = tickets.filter(
    (t) => t.status === "Open" && new Date(t.updatedAt).getTime() < fortyEightHoursAgo,
  ).length;

  const windowedEvents = events.filter((e) => new Date(e.createdAt).getTime() >= thirtyDaysAgo);

  const createdTicketIds = new Set<string>();
  const aiRepliedTicketIds = new Set<string>();
  const aiResolvedTicketIds = new Set<string>();
  const ticketCreatedAt = new Map<string, number>();
  const firstAdminReplyAt = new Map<string, number>();

  for (const e of windowedEvents) {
    const t = new Date(e.createdAt).getTime();
    switch (e.eventType) {
      case "ticket_created":
        createdTicketIds.add(e.ticketId);
        if (!ticketCreatedAt.has(e.ticketId) || t < (ticketCreatedAt.get(e.ticketId) as number)) {
          ticketCreatedAt.set(e.ticketId, t);
        }
        break;
      case "ai_replied":
        aiRepliedTicketIds.add(e.ticketId);
        break;
      case "ai_resolved":
        aiResolvedTicketIds.add(e.ticketId);
        break;
      case "admin_replied": {
        const existing = firstAdminReplyAt.get(e.ticketId);
        if (existing === undefined || t < existing) firstAdminReplyAt.set(e.ticketId, t);
        break;
      }
      default:
        break;
    }
  }

  const aiReplyRate30d = createdTicketIds.size > 0 ? aiRepliedTicketIds.size / createdTicketIds.size : null;
  const aiResolvedRate30d = aiRepliedTicketIds.size > 0 ? aiResolvedTicketIds.size / aiRepliedTicketIds.size : null;

  const firstReplyHours: number[] = [];
  for (const [ticketId, createdAt] of ticketCreatedAt.entries()) {
    const adminReplyAt = firstAdminReplyAt.get(ticketId);
    if (adminReplyAt !== undefined) firstReplyHours.push((adminReplyAt - createdAt) / HOUR_MS);
  }
  const avgFirstHumanReplyHours30d =
    firstReplyHours.length > 0
      ? Math.round((firstReplyHours.reduce((a, b) => a + b, 0) / firstReplyHours.length) * 10) / 10
      : null;

  return { newLast7d, staleOpenOver48h, aiReplyRate30d, aiResolvedRate30d, avgFirstHumanReplyHours30d };
}

/**
 * Aging pill for an Open ticket's Status cell, based on how long it's been
 * since the last update (updated_at moves on any admin action, so this
 * reflects "user waiting with no activity"). Callers gate this on
 * status === "Open" themselves — this is pure time math.
 */
export function agingBadge(updatedAt: string, now: Date = new Date()): "24h+" | "48h+" | null {
  const hours = (now.getTime() - new Date(updatedAt).getTime()) / HOUR_MS;
  if (hours >= 48) return "48h+";
  if (hours >= 24) return "24h+";
  return null;
}
