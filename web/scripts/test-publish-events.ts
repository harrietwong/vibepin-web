/**
 * Unit tests for the server-side Pinterest publish instrumentation (no DB / HTTP).
 * Run: npx tsx scripts/test-publish-events.ts   (from web/)
 *
 * Covers:
 *   - sanitizeErrorMessage: Bearer/token/key=value stripping, bare token-run redaction,
 *     length cap, and that ordinary prose survives,
 *   - extractErrorCode: prefers .code, falls back to snake-cased error name, else "unknown",
 *   - recordPublishEvent best-effort contract: an insert that throws or returns an error
 *     NEVER propagates (the wrapper resolves), and the correct row is built for all three
 *     event names with a mocked insert,
 *   - buildFailedProps: assembles a failed-event payload with a sanitized message + code.
 */

import assert from "node:assert";
import {
  sanitizeErrorMessage,
  extractErrorCode,
  buildFailedProps,
  recordPublishEvent,
  newPublishAttemptId,
  MAX_ERROR_MESSAGE_LENGTH,
  PUBLISH_EVENT_ATTEMPTED,
  PUBLISH_EVENT_SUCCEEDED,
  PUBLISH_EVENT_FAILED,
  type PublishEventBase,
} from "../src/lib/server/publishEvents";

let passed = 0, failed = 0;
const pending: Promise<void>[] = [];

/** Register a sync or async test; async ones are awaited before the summary. */
function test(name: string, fn: () => void | Promise<void>): void {
  const run = (async () => {
    try { await fn(); passed++; console.log(`  OK ${name}`); }
    catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
  })();
  pending.push(run);
}

// ── sanitizeErrorMessage ─────────────────────────────────────────────────────────
test("sanitize: strips a Bearer token, keeps the scheme", () => {
  const out = sanitizeErrorMessage("Request failed: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc123def456ghi789");
  assert.ok(!out.includes("eyJhbGci"), "token body must be gone");
  assert.ok(out.includes("Bearer [REDACTED]"), `expected redacted scheme, got: ${out}`);
});

test("sanitize: strips access_token / refresh_token / api_key key=value pairs", () => {
  const out = sanitizeErrorMessage("failed access_token=pina_AMA7abc123XYZ890longtoken refresh_token=rt_9988abcXYZ api_key=sk-liveKEY12345678");
  assert.ok(!out.includes("pina_AMA7abc123XYZ890longtoken"), "access_token value gone");
  assert.ok(!out.includes("rt_9988abcXYZ"), "refresh_token value gone");
  assert.ok(!out.includes("sk-liveKEY12345678"), "api_key value gone");
  assert.ok(out.includes("access_token=[REDACTED]"), `got: ${out}`);
  assert.ok(out.includes("refresh_token=[REDACTED]"), `got: ${out}`);
});

test("sanitize: strips a bare long token-ish run (no label)", () => {
  const secret = "Ab12Cd34Ef56Gh78Ij90Kl12Mn34"; // 28 chars, letters+digits
  const out = sanitizeErrorMessage(`Upstream rejected the credential ${secret} at the edge`);
  assert.ok(!out.includes(secret), `bare token must be redacted, got: ${out}`);
  assert.ok(out.includes("[REDACTED]"));
});

test("sanitize: leaves ordinary prose (and short/word-only tokens) intact", () => {
  const msg = "Board not found on the connected Pinterest account";
  assert.equal(sanitizeErrorMessage(msg), msg);
  // A long all-letters word (no digit) is NOT a token → survives.
  const wordy = "Pinterest connection expired please reconnect immediately nowwww";
  assert.equal(sanitizeErrorMessage(wordy), wordy);
});

test("sanitize: caps length at MAX_ERROR_MESSAGE_LENGTH with an ellipsis", () => {
  const long = "x".repeat(1000);
  const out = sanitizeErrorMessage(long);
  assert.ok(out.length <= MAX_ERROR_MESSAGE_LENGTH, `len ${out.length}`);
  assert.ok(out.endsWith("…"));
});

test("sanitize: non-string input is coerced safely", () => {
  assert.equal(sanitizeErrorMessage(null), "");
  assert.equal(sanitizeErrorMessage(undefined), "");
  assert.equal(sanitizeErrorMessage(42), "42");
});

// ── extractErrorCode ───────────────────────────────────────────────────────────
test("extractErrorCode: prefers an explicit string .code", () => {
  assert.equal(extractErrorCode({ code: "needs_reconnect" }), "needs_reconnect");
  assert.equal(extractErrorCode(Object.assign(new Error("x"), { code: "board_not_owned" })), "board_not_owned");
});

test("extractErrorCode: falls back to snake-cased error name", () => {
  const e = new Error("boom");
  e.name = "PinterestApiError";
  assert.equal(extractErrorCode(e), "pinterest_api");
});

test("extractErrorCode: plain Error / unknown → 'unknown'", () => {
  assert.equal(extractErrorCode(new Error("boom")), "unknown");
  assert.equal(extractErrorCode("just a string"), "unknown");
  assert.equal(extractErrorCode(null), "unknown");
});

// ── buildFailedProps ─────────────────────────────────────────────────────────────
const BASE: PublishEventBase = {
  publishAttemptId: "attempt-1",
  userId: "user-1",
  draftId: "draft-1",
  boardId: "board-1",
  source: "immediate",
};

test("buildFailedProps: sanitizes message + carries code + timing + base", () => {
  const props = buildFailedProps(BASE, 1234, Object.assign(new Error("token=pina_SECRET1234567890abcXYZ leaked"), { code: "pinterest_error" }));
  assert.equal(props.publishAttemptId, "attempt-1");
  assert.equal(props.userId, "user-1");
  assert.equal(props.draftId, "draft-1");
  assert.equal(props.durationMs, 1234);
  assert.equal(props.errorCode, "pinterest_error");
  assert.ok(!props.errorMessage.includes("pina_SECRET1234567890abcXYZ"), `secret leaked: ${props.errorMessage}`);
  assert.ok(props.errorMessage.includes("[REDACTED]"));
});

test("buildFailedProps: bare/typeless error still yields a message + unknown code", () => {
  const props = buildFailedProps(BASE, 5, {});
  assert.equal(props.errorCode, "unknown");
  assert.equal(props.errorMessage, "Publish failed");
});

// ── recordPublishEvent best-effort contract ──────────────────────────────────────
type Captured = { table: string; row: Record<string, unknown> };

/** Minimal supabase-client stub: captures the insert row, configurable outcome. */
function mockDb(outcome: "ok" | "error" | "throw", sink: Captured[]): any {
  return {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          if (outcome === "throw") throw new Error("connection reset");
          sink.push({ table, row });
          if (outcome === "error") return Promise.resolve({ error: { message: "duplicate key" } });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

test("recordPublishEvent: attempted row shape (workspace/user/draft/event/payload)", async () => {
  const sink: Captured[] = [];
  await recordPublishEvent(mockDb("ok", sink), PUBLISH_EVENT_ATTEMPTED, BASE);
  assert.equal(sink.length, 1);
  const { table, row } = sink[0];
  assert.equal(table, "analytics_events");
  assert.equal(row.event_name, PUBLISH_EVENT_ATTEMPTED);
  assert.equal(row.user_id, "user-1");
  assert.equal(row.workspace_id, "user-1");
  assert.equal(row.draft_id, "draft-1");
  const payload = row.payload as Record<string, unknown>;
  assert.equal(payload.publishAttemptId, "attempt-1");
  assert.equal(payload.boardId, "board-1");
  assert.equal(payload.source, "immediate");
  // attempted carries NO timing / remote / error fields
  assert.ok(!("durationMs" in payload));
  assert.ok(!("remotePinId" in payload));
  assert.ok(!("errorCode" in payload));
});

test("recordPublishEvent: succeeded row carries duration + remote pin", async () => {
  const sink: Captured[] = [];
  await recordPublishEvent(mockDb("ok", sink), PUBLISH_EVENT_SUCCEEDED, {
    ...BASE, durationMs: 42, remotePinId: "pin-9", remotePinUrl: "https://pin/9",
  });
  const payload = sink[0].row.payload as Record<string, unknown>;
  assert.equal(payload.durationMs, 42);
  assert.equal(payload.remotePinId, "pin-9");
  assert.equal(payload.remotePinUrl, "https://pin/9");
  assert.ok(!("errorCode" in payload));
});

test("recordPublishEvent: failed row carries duration + code + message", async () => {
  const sink: Captured[] = [];
  await recordPublishEvent(mockDb("ok", sink), PUBLISH_EVENT_FAILED, {
    ...BASE, durationMs: 7, errorCode: "needs_reconnect", errorMessage: "reconnect required",
  });
  const payload = sink[0].row.payload as Record<string, unknown>;
  assert.equal(payload.errorCode, "needs_reconnect");
  assert.equal(payload.errorMessage, "reconnect required");
  assert.equal(payload.durationMs, 7);
});

test("recordPublishEvent: nullable draftId is passed through as null", async () => {
  const sink: Captured[] = [];
  await recordPublishEvent(mockDb("ok", sink), PUBLISH_EVENT_ATTEMPTED, { ...BASE, draftId: null });
  assert.strictEqual(sink[0].row.draft_id, null);
});

test("recordPublishEvent: an insert that RETURNS an error does NOT throw", async () => {
  // Best-effort: a DB-level error must resolve (swallowed with a warn), never reject.
  await recordPublishEvent(mockDb("error", []), PUBLISH_EVENT_ATTEMPTED, BASE);
  // reaching here (no throw) is the assertion
  assert.ok(true);
});

test("recordPublishEvent: an insert that THROWS does NOT propagate", async () => {
  // The whole body is try/catch-wrapped, so even a synchronous throw is contained.
  await recordPublishEvent(mockDb("throw", []), PUBLISH_EVENT_FAILED, {
    ...BASE, durationMs: 1, errorCode: "x", errorMessage: "y",
  });
  assert.ok(true);
});

test("recordPublishEvent: never parks non-primitive extras in the payload", async () => {
  const sink: Captured[] = [];
  // Sneak an object in via a cast — buildPayload must ignore anything non-primitive.
  await recordPublishEvent(mockDb("ok", sink), PUBLISH_EVENT_SUCCEEDED, {
    ...BASE, durationMs: 1, remotePinId: "p", remotePinUrl: "u",
    // @ts-expect-error intentional: prove object extras are dropped
    secretBlob: { token: "pina_LEAK" },
  });
  const payload = sink[0].row.payload as Record<string, unknown>;
  assert.ok(!("secretBlob" in payload), "object extras must never reach the payload");
});

test("newPublishAttemptId: returns a v4-shaped uuid", () => {
  const id = newPublishAttemptId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(newPublishAttemptId(), id);
});

// ── run (await every registered test, then summarize) ────────────────────────────
(async () => {
  await Promise.all(pending);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
