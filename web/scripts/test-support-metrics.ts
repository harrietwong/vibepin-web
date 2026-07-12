#!/usr/bin/env tsx
/**
 * test-support-metrics.ts
 *
 * Verifies computeMetricsFromRows and agingBadge (the pure, network-free
 * core of the admin support metrics cards / aging badges) handle empty
 * inputs, rate/average math, stale-open counting, and the 30d event window
 * correctly.
 *
 * Run: npx tsx scripts/test-support-metrics.ts
 * Exit 0 = all pass, 1 = failures.
 */

import { agingBadge, computeMetricsFromRows, type EventMetricRow, type TicketMetricRow } from "../src/lib/support/metricsCore";

// ── Mini test runner (matches scripts/test-support-ai-responder.ts) ────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗  ${name}`);
    console.error(`       ${String(e)}`);
    failed++;
  }
}

function eq<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) throw new Error(msg ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function approxEq(actual: number | null, expected: number | null, epsilon = 1e-6, msg?: string): void {
  if (actual === null || expected === null) {
    eq(actual, expected, msg);
    return;
  }
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(msg ?? `Expected ~${expected}, got ${actual}`);
  }
}

const NOW = new Date("2026-07-11T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * HOUR).toISOString();
}
function daysAgo(d: number): string {
  return new Date(NOW.getTime() - d * DAY).toISOString();
}
function hoursAfter(iso: string, h: number): string {
  return new Date(new Date(iso).getTime() + h * HOUR).toISOString();
}

console.log("\n── computeMetricsFromRows ──");

test("1. empty inputs -> zero counts, null rates/average", () => {
  const result = computeMetricsFromRows([], [], NOW);
  eq(result.newLast7d, 0);
  eq(result.staleOpenOver48h, 0);
  eq(result.aiReplyRate30d, null);
  eq(result.aiResolvedRate30d, null);
  eq(result.avgFirstHumanReplyHours30d, null);
});

test("2. newLast7d counts tickets created within 7d regardless of status", () => {
  const tickets: TicketMetricRow[] = [
    { status: "Open", createdAt: hoursAgo(60), updatedAt: hoursAgo(60) }, // within 7d
    { status: "Open", createdAt: daysAgo(10), updatedAt: hoursAgo(30) }, // outside 7d
    { status: "Resolved", createdAt: daysAgo(3), updatedAt: hoursAgo(100) }, // within 7d
  ];
  const result = computeMetricsFromRows(tickets, [], NOW);
  eq(result.newLast7d, 2);
});

test("3. staleOpenOver48h counts only Open tickets with updatedAt >= 48h stale, ignores other statuses", () => {
  const tickets: TicketMetricRow[] = [
    { status: "Open", createdAt: hoursAgo(60), updatedAt: hoursAgo(60) }, // Open, stale (>=48h)
    { status: "Open", createdAt: daysAgo(10), updatedAt: hoursAgo(30) }, // Open, not stale (<48h)
    { status: "Resolved", createdAt: daysAgo(3), updatedAt: hoursAgo(100) }, // not Open, excluded even though stale by time
  ];
  const result = computeMetricsFromRows(tickets, [], NOW);
  eq(result.staleOpenOver48h, 1);
});

test("4. exactly 48h is not yet stale (spec is strict updated_at < now-48h); just past it is", () => {
  const exactly48h: TicketMetricRow[] = [{ status: "Open", createdAt: hoursAgo(48), updatedAt: hoursAgo(48) }];
  eq(computeMetricsFromRows(exactly48h, [], NOW).staleOpenOver48h, 0);

  const justPast48h: TicketMetricRow[] = [{ status: "Open", createdAt: hoursAgo(48.01), updatedAt: hoursAgo(48.01) }];
  eq(computeMetricsFromRows(justPast48h, [], NOW).staleOpenOver48h, 1);
});

// Three-ticket AI/human-reply scenario:
// ticket1: AI-replied + ai_resolved (no human reply)
// ticket2: AI-replied, then admin replied 4h after creation
// ticket3: no AI reply, admin replied 2h after creation
const t1Created = hoursAgo(20);
const t2Created = hoursAgo(20);
const t3Created = hoursAgo(20);

function buildRateScenarioEvents(): EventMetricRow[] {
  return [
    { ticketId: "t1", eventType: "ticket_created", createdAt: t1Created },
    { ticketId: "t1", eventType: "ai_replied", createdAt: hoursAfter(t1Created, 0.1) },
    { ticketId: "t1", eventType: "ai_resolved", createdAt: hoursAfter(t1Created, 0.2) },

    { ticketId: "t2", eventType: "ticket_created", createdAt: t2Created },
    { ticketId: "t2", eventType: "ai_replied", createdAt: hoursAfter(t2Created, 0.1) },
    { ticketId: "t2", eventType: "admin_replied", createdAt: hoursAfter(t2Created, 4) },

    { ticketId: "t3", eventType: "ticket_created", createdAt: t3Created },
    { ticketId: "t3", eventType: "admin_replied", createdAt: hoursAfter(t3Created, 2) },
  ];
}

test("5. aiReplyRate30d = distinct ai_replied tickets / distinct ticket_created tickets (2/3)", () => {
  const result = computeMetricsFromRows([], buildRateScenarioEvents(), NOW);
  approxEq(result.aiReplyRate30d, 2 / 3);
});

test("6. aiResolvedRate30d = distinct ai_resolved tickets / distinct ai_replied tickets (1/2)", () => {
  const result = computeMetricsFromRows([], buildRateScenarioEvents(), NOW);
  approxEq(result.aiResolvedRate30d, 1 / 2);
});

test("7. avgFirstHumanReplyHours30d averages (adminReplied - created) across tickets that have both, 1 decimal", () => {
  // t2: 4h, t3: 2h -> avg 3.0h. t1 has no admin_replied and is excluded.
  const result = computeMetricsFromRows([], buildRateScenarioEvents(), NOW);
  eq(result.avgFirstHumanReplyHours30d, 3.0);
});

test("8. an event older than 30d is excluded from the window (denominator unaffected)", () => {
  const events = [
    ...buildRateScenarioEvents(),
    // A 4th ticket's ticket_created is 31 days old -> outside the 30d window.
    { ticketId: "t4-old", eventType: "ticket_created", createdAt: daysAgo(31) } as EventMetricRow,
    { ticketId: "t4-old", eventType: "ai_replied", createdAt: daysAgo(31) } as EventMetricRow,
  ];
  const result = computeMetricsFromRows([], events, NOW);
  // Still 2/3, not 2/4 — the old ticket_created/ai_replied pair must not count.
  approxEq(result.aiReplyRate30d, 2 / 3);
});

test("9. multiple admin_replied events for the same ticket -> earliest one wins", () => {
  const events: EventMetricRow[] = [
    { ticketId: "t5", eventType: "ticket_created", createdAt: t1Created },
    { ticketId: "t5", eventType: "admin_replied", createdAt: hoursAfter(t1Created, 6) },
    { ticketId: "t5", eventType: "admin_replied", createdAt: hoursAfter(t1Created, 3) }, // earlier, out of order
  ];
  const result = computeMetricsFromRows([], events, NOW);
  eq(result.avgFirstHumanReplyHours30d, 3.0);
});

console.log("\n── agingBadge ──");

test("10. 23h since update -> null (under the 24h threshold)", () => {
  eq(agingBadge(hoursAgo(23), NOW), null);
});

test("11. 25h since update -> \"24h+\"", () => {
  eq(agingBadge(hoursAgo(25), NOW), "24h+");
});

test("12. 49h since update -> \"48h+\"", () => {
  eq(agingBadge(hoursAgo(49), NOW), "48h+");
});

test("13. exactly 24h -> \"24h+\" (>= boundary)", () => {
  eq(agingBadge(hoursAgo(24), NOW), "24h+");
});

test("14. exactly 48h -> \"48h+\" (>= boundary)", () => {
  eq(agingBadge(hoursAgo(48), NOW), "48h+");
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
