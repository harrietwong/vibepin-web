/**
 * Timezone-aware scheduled-instant tests (RC0 WP2).
 * Run: npx tsx scripts/test-schedule-timezone.ts   (from web/)
 *
 * Covers promote.ts::buildScheduledAt resolving a client-local wall-clock + IANA zone
 * (payload.scheduleTimezone) into a real UTC instant, plus the legacy fallbacks:
 *   - PST/PDT and EST/EDT standard vs. DST offsets (fixed dates, no runtime-clock reliance)
 *   - Spring-forward gap (a wall-clock that does not exist) → equivalent instant after gap
 *   - Fall-back overlap (a wall-clock that occurs twice)   → earlier (first) occurrence
 *   - Invalid zone → legacy "interpret as UTC" behavior
 *   - No zone (legacy draft) → legacy "interpret as UTC" behavior
 * plus the client-side stamp: pinDraftStore schedule writes tag the draft with a zone.
 */

import assert from "node:assert";
import { buildScheduledAt } from "../src/app/api/pin-drafts/promote";

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

// ── Standard vs. DST offsets, fixed dates ────────────────────────────────────────
test("LA winter 09:00 PST → 17:00Z", () => {
  assert.equal(
    buildScheduledAt({ plannedAt: "2026-01-15T09:00", scheduleTimezone: "America/Los_Angeles" }),
    "2026-01-15T17:00:00.000Z",
  );
});

test("LA summer 09:00 PDT → 16:00Z", () => {
  assert.equal(
    buildScheduledAt({ plannedAt: "2026-07-15T09:00", scheduleTimezone: "America/Los_Angeles" }),
    "2026-07-15T16:00:00.000Z",
  );
});

test("NY winter 09:00 EST → 14:00Z", () => {
  assert.equal(
    buildScheduledAt({ plannedAt: "2026-01-15T09:00", scheduleTimezone: "America/New_York" }),
    "2026-01-15T14:00:00.000Z",
  );
});

test("NY summer 09:00 EDT → 13:00Z", () => {
  assert.equal(
    buildScheduledAt({ plannedAt: "2026-07-15T09:00", scheduleTimezone: "America/New_York" }),
    "2026-07-15T13:00:00.000Z",
  );
});

// ── DST boundaries ───────────────────────────────────────────────────────────────
test("spring-forward gap (NY 2026-03-08 02:30 does not exist) → equivalent post-gap instant", () => {
  // Clocks jump 02:00 EST → 03:00 EDT; 02:30 has no real instant. The probe lands on the
  // post-gap (EDT, UTC-4) offset, so 02:30 resolves to 06:30Z — deterministic forward shift.
  assert.equal(
    buildScheduledAt({ plannedAt: "2026-03-08T02:30", scheduleTimezone: "America/New_York" }),
    "2026-03-08T06:30:00.000Z",
  );
});

test("fall-back overlap (NY 2026-11-01 01:30 occurs twice) → earlier EDT occurrence (05:30Z)", () => {
  // Clocks fall 02:00 EDT → 01:00 EST; 01:30 occurs twice. We deterministically pick the
  // FIRST (EDT, UTC-4) occurrence → 05:30Z, never the later 06:30Z EST one.
  assert.equal(
    buildScheduledAt({ plannedAt: "2026-11-01T01:30", scheduleTimezone: "America/New_York" }),
    "2026-11-01T05:30:00.000Z",
  );
});

// ── Fallbacks (back-compat) ──────────────────────────────────────────────────────
test("invalid zone → legacy interpret-as-UTC", () => {
  assert.equal(
    buildScheduledAt({ plannedAt: "2026-01-15T09:00", scheduleTimezone: "Not/AZone" }),
    "2026-01-15T09:00:00.000Z",
  );
});

test("no zone (legacy draft) → legacy interpret-as-UTC", () => {
  assert.equal(
    buildScheduledAt({ plannedAt: "2026-01-15T09:00" }),
    "2026-01-15T09:00:00.000Z",
  );
});

test("empty-string zone → legacy interpret-as-UTC", () => {
  assert.equal(
    buildScheduledAt({ plannedAt: "2026-07-15T09:00", scheduleTimezone: "   " }),
    "2026-07-15T09:00:00.000Z",
  );
});

test("date+time fallback source honors the zone too", () => {
  assert.equal(
    buildScheduledAt({ scheduledDate: "2026-01-15", scheduledTime: "09:00", scheduleTimezone: "America/Los_Angeles" }),
    "2026-01-15T17:00:00.000Z",
  );
});

test("posted pin is never due, zone notwithstanding", () => {
  assert.equal(
    buildScheduledAt({ plannedAt: "2026-01-15T09:00", scheduleTimezone: "America/Los_Angeles", remotePinId: "abc" }),
    null,
  );
});

test("date-only wall-clock (00:00) resolves in-zone", () => {
  assert.equal(
    buildScheduledAt({ scheduledDate: "2026-07-15", scheduleTimezone: "America/New_York" }),
    "2026-07-15T04:00:00.000Z", // 00:00 EDT = 04:00Z
  );
});

// ── Client stamp: schedule writes tag the draft with the resolved zone ───────────
test("pinDraftStore stamps scheduleTimezone on schedule writes", async () => {
  // Deterministic zone regardless of the runner's machine clock.
  const FIXED = "America/Los_Angeles";
  const realDTF = Intl.DateTimeFormat;
  // Wrap so resolvedOptions().timeZone is pinned but formatting still works.
  (Intl as unknown as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat =
    function (this: unknown, ...args: unknown[]) {
      const inst = new (realDTF as unknown as new (...a: unknown[]) => Intl.DateTimeFormat)(...args);
      const realResolve = inst.resolvedOptions.bind(inst);
      inst.resolvedOptions = () => ({ ...realResolve(), timeZone: FIXED });
      return inst;
    } as unknown as typeof Intl.DateTimeFormat;

  // Minimal localStorage shim so the store module loads under node.
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null, length: 0,
  };
  (globalThis as unknown as { window?: unknown }).window = (globalThis as unknown as { window?: unknown }).window ?? {
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
  };

  try {
    const store = await import("../src/lib/pinDraftStore");
    assert.equal(store.resolveScheduleTimezone(), FIXED, "helper reads the pinned zone");

    const created = store.createDraft({ imageUrl: "img://x", keyword: "kw", category: "home" });
    const scheduled = store.smartScheduleDraft(created.id, { plannedDate: "2026-01-15", plannedTime: "09:00" });
    assert.ok(scheduled, "smartScheduleDraft returned a draft");
    assert.equal(scheduled!.plannedAt, "2026-01-15T09:00");
    assert.equal(scheduled!.scheduleTimezone, FIXED, "schedule write stamped the resolved zone");

    // End-to-end: the stamped draft resolves to the correct UTC instant server-side.
    assert.equal(
      buildScheduledAt(scheduled as unknown as Record<string, unknown>),
      "2026-01-15T17:00:00.000Z",
    );
  } finally {
    (Intl as unknown as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = realDTF;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
