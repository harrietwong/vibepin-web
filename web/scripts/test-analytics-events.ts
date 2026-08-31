/**
 * Unit tests for analytics event ingest (A4): the pure normalizer and the
 * client-side fire-and-forget buffer/report path.
 * Run: npx tsx scripts/test-analytics-events.ts   (from web/)
 */

import assert from "node:assert";
import Module from "node:module";

// ── window / navigator shim (must exist before importing analytics.ts) ─────────
const listeners = new Map<string, Set<() => void>>();
const beacons: Array<{ url: string; body: string }> = [];
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (t: string, cb: () => void) => {
    if (!listeners.has(t)) listeners.set(t, new Set());
    listeners.get(t)!.add(cb);
  },
  removeEventListener: (t: string, cb: () => void) => { listeners.get(t)?.delete(cb); },
  dispatchEvent: () => true,
};
// `navigator` is a read-only getter on globalThis in modern Node — define it.
const navShim = {
  sendBeacon: ((url: string, data: Blob | string) => {
    // In this shim we synchronously capture the serialized body.
    if (typeof data === "string") beacons.push({ url, body: data });
    else beacons.push({ url, body: (data as unknown as { _text?: string })._text ?? "[blob]" });
    return true;
  }) as unknown,
};
Object.defineProperty(globalThis, "navigator", { value: navShim, configurable: true, writable: true });
// Minimal Blob that preserves text so the shim can read it back.
(globalThis as unknown as { Blob: unknown }).Blob = class {
  _text: string;
  type: string;
  constructor(parts: string[], opts?: { type?: string }) { this._text = parts.join(""); this.type = opts?.type ?? ""; }
};

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}
async function asyncTest(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

async function main() {
  const ingest = await import("../src/lib/analyticsIngest");
  const analytics = await import("../src/lib/analytics");

  // ── normalizeAnalyticsEvents ────────────────────────────────────────────────

  test("normalize: accepts { events: [...] } and a bare array alike", () => {
    const a = ingest.normalizeAnalyticsEvents({ events: [{ event: "draft_published" }] });
    const b = ingest.normalizeAnalyticsEvents([{ event: "draft_published" }]);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0].event_name, "draft_published");
  });

  test("normalize: drops items without a usable event name", () => {
    const rows = ingest.normalizeAnalyticsEvents([
      { event: "regenerate_clicked" },
      { event: "" },
      { event: "   " },
      { payload: { a: 1 } },
      { event: "x".repeat(ingest.MAX_EVENT_NAME_LEN + 1) },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_name, "regenerate_clicked");
  });

  test("normalize: caps the batch at MAX_EVENTS_PER_BATCH", () => {
    const many = Array.from({ length: ingest.MAX_EVENTS_PER_BATCH + 10 }, () => ({ event: "keyword_removed" }));
    assert.equal(ingest.normalizeAnalyticsEvents(many).length, ingest.MAX_EVENTS_PER_BATCH);
  });

  test("normalize: extracts draftId, accepts props as a payload alias", () => {
    const rows = ingest.normalizeAnalyticsEvents([
      { event: "direction_selected", draftId: "pd_1", props: { direction: "warm" } },
    ]);
    assert.equal(rows[0].draft_id, "pd_1");
    assert.deepEqual(rows[0].payload, { direction: "warm" });
  });

  test("normalize: oversized payload is replaced with a truncation marker", () => {
    const big = { blob: "x".repeat(ingest.MAX_PAYLOAD_BYTES + 100) };
    const rows = ingest.normalizeAnalyticsEvents([{ event: "ai_copy_success", payload: big }]);
    assert.equal(rows[0].payload!._truncated, true);
    assert.ok((rows[0].payload!._bytes as number) > ingest.MAX_PAYLOAD_BYTES);
  });

  test("normalize: empty/invalid payload → null", () => {
    const rows = ingest.normalizeAnalyticsEvents([
      { event: "generation_kept", payload: {} },
      { event: "generation_deleted", payload: [1, 2] },
    ]);
    assert.equal(rows[0].payload, null);
    assert.equal(rows[1].payload, null);
  });

  // ── client track() buffering / reporting ────────────────────────────────────

  test("track: buffers then reports a batch via sendBeacon on flush", () => {
    analytics.__resetAnalyticsForTests();
    beacons.length = 0;
    analytics.track("reference_selected", { draftId: "pd_9", refId: "r1" });
    assert.equal(analytics.__getAnalyticsBufferForTests().length, 1, "buffered, not sent yet");
    assert.equal(beacons.length, 0);
    analytics.__flushAnalyticsForTests();
    assert.equal(beacons.length, 1, "flush sent one beacon");
    const sent = JSON.parse(beacons[0].body) as { events: Array<{ event: string; draftId?: string; payload?: Record<string, unknown> }> };
    assert.equal(sent.events[0].event, "reference_selected");
    assert.equal(sent.events[0].draftId, "pd_9");
    assert.equal(sent.events[0].payload!.refId, "r1");
    assert.equal(analytics.__getAnalyticsBufferForTests().length, 0, "buffer drained");
  });

  test("track: auto-flushes once the buffer reaches the threshold", () => {
    analytics.__resetAnalyticsForTests();
    beacons.length = 0;
    for (let i = 0; i < 15; i++) analytics.track("keyword_removed", { draftId: `pd_${i}` });
    assert.equal(beacons.length, 1, "threshold flush fired without waiting for the timer");
    const sent = JSON.parse(beacons[0].body) as { events: unknown[] };
    assert.ok(sent.events.length <= 20, "never exceeds the server batch cap");
  });

  test("track: never throws even if reporting internals are gone", () => {
    analytics.__resetAnalyticsForTests();
    const savedBeacon = (globalThis as unknown as { navigator: { sendBeacon?: unknown } }).navigator.sendBeacon;
    (globalThis as unknown as { navigator: { sendBeacon?: unknown } }).navigator.sendBeacon = undefined;
    (globalThis as unknown as { fetch?: unknown }).fetch = () => { throw new Error("no fetch"); };
    assert.doesNotThrow(() => {
      analytics.track("draft_published", { draftId: "pd_x" });
      analytics.__flushAnalyticsForTests();
    });
    (globalThis as unknown as { navigator: { sendBeacon?: unknown } }).navigator.sendBeacon = savedBeacon;
  });

  await asyncTest("forged SSR cookie is verified and rejected before analytics body parsing", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
    let verifiedCalls = 0;
    let jsonCalls = 0;
    let insertCalls = 0;
    const originalLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
    (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function (
      this: unknown, request: string, parent: unknown, isMain: boolean,
    ) {
      if (request === "@supabase/supabase-js") {
        return { createClient: () => ({ auth: { getUser: async () => {
          verifiedCalls++;
          return { data: { user: null }, error: new Error("invalid token") };
        } } }) };
      }
      if (request === "@supabase/ssr") {
        return { createServerClient: () => ({ auth: { getSession: async () => ({ data: { session: {
          access_token: "forged-access-token",
          user: { id: "forged-user-id" },
        } } }) } }) };
      }
      if (request === "next/headers") {
        return { cookies: async () => ({ getAll: () => [], set: () => undefined }) };
      }
      if (request.endsWith("/lib/supabase") || request === "@/lib/supabase") {
        return { createServerClient: () => ({ from: () => ({ insert: async () => {
          insertCalls++;
          return { error: null };
        } }) }) };
      }
      return originalLoad.call(this, request, parent, isMain);
    } as never;

    try {
      const authPath = require.resolve("../src/lib/server/authUser");
      delete require.cache[authPath];
      const auth = await import("../src/lib/server/authUser");
      const forged = await auth.getUserIdFromSameOriginSession(new Request("https://vibepin.co/api/private"));
      assert.equal(forged, null, "locally decoded forged user id must not be accepted");
      assert.equal(verifiedCalls, 1, "cookie access token must be verified with Auth");

      const routePath = require.resolve("../src/app/api/analytics/events/route");
      const recordPath = require.resolve("../src/lib/server/recordEvent");
      delete require.cache[routePath];
      delete require.cache[recordPath];
      const route = await import("../src/app/api/analytics/events/route");
      const req = {
        headers: new Headers(),
        json: async () => { jsonCalls++; return { events: [{ event: "forged" }] }; },
      } as unknown as Request;
      const response = await route.POST(req);
      assert.equal(response.status, 204);
      assert.equal(jsonCalls, 0, "unauthenticated analytics must not parse the body");
      assert.equal(insertCalls, 0, "forged identity must not insert analytics");
    } finally {
      (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = originalLoad;
    }
  });

  await asyncTest("all four private GET handlers reject when verified auth fails", async () => {
    const originalLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
    (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function (
      this: unknown, request: string, parent: unknown, isMain: boolean,
    ) {
      if (request.includes("server/authUser")) {
        return { getUserIdFromBearerOrCookies: async () => null };
      }
      return originalLoad.call(this, request, parent, isMain);
    } as never;
    try {
      for (const spec of [
        "../src/app/api/integrations/facebook/pages/route",
        "../src/app/api/social/connections/route",
        "../src/app/api/pinterest/boards/route",
        "../src/app/api/pinterest/status/route",
      ]) {
        const resolved = require.resolve(spec);
        delete require.cache[resolved];
        const route = await import(spec) as { GET: (req: Request) => Promise<Response> };
        const response = await route.GET(new Request(`https://vibepin.co${spec.split("/api")[1]}`));
        assert.equal(response.status, 401, `${spec} must reject forged/unverified identity`);
      }
    } finally {
      (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = originalLoad;
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
