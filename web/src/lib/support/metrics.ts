/**
 * Server-only fetch wrapper for the admin support metrics cards. All date
 * math / grouping logic lives in the pure `metricsCore.ts` (unit-tested,
 * no server imports) — this module's only job is two lean ticket queries
 * (created-in-last-7d, currently-Open) plus one events query, deduped and
 * handed to `computeMetricsFromRows`.
 */

import { createServerClient } from "@/lib/supabase";
import { computeMetricsFromRows, type EventMetricRow, type SupportMetrics, type TicketMetricRow } from "./metricsCore";

export type { SupportMetrics } from "./metricsCore";

const db = () => createServerClient();

type TicketRow = { id: string; status: string; created_at: string; updated_at: string };
type EventRow = { ticket_id: string; event_type: string; created_at: string };

export async function computeSupportMetrics(now: Date = new Date()): Promise<SupportMetrics> {
  const nowMs = now.getTime();
  const sevenDaysAgoIso = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgoIso = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [recentRes, openRes, eventsRes] = await Promise.all([
    db().from("support_tickets").select("id, status, created_at, updated_at").gte("created_at", sevenDaysAgoIso),
    db().from("support_tickets").select("id, status, created_at, updated_at").eq("status", "Open"),
    db()
      .from("support_events")
      .select("ticket_id, event_type, created_at")
      .gte("created_at", thirtyDaysAgoIso)
      .in("event_type", ["ticket_created", "ai_replied", "ai_resolved", "admin_replied"])
      .order("created_at", { ascending: true }),
  ]);

  if (recentRes.error) throw new Error(`computeSupportMetrics tickets(recent): ${recentRes.error.message}`);
  if (openRes.error) throw new Error(`computeSupportMetrics tickets(open): ${openRes.error.message}`);
  if (eventsRes.error) throw new Error(`computeSupportMetrics events: ${eventsRes.error.message}`);

  // Dedup by id — a ticket that's both created within 7d and currently Open
  // would otherwise appear in both queries and get double-counted.
  const byId = new Map<string, TicketRow>();
  for (const row of (recentRes.data ?? []) as TicketRow[]) byId.set(row.id, row);
  for (const row of (openRes.data ?? []) as TicketRow[]) byId.set(row.id, row);
  const tickets: TicketMetricRow[] = Array.from(byId.values()).map((r) => ({
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  const events: EventMetricRow[] = ((eventsRes.data ?? []) as EventRow[]).map((r) => ({
    ticketId: r.ticket_id,
    eventType: r.event_type,
    createdAt: r.created_at,
  }));

  return computeMetricsFromRows(tickets, events, now);
}
