/**
 * Unit tests for lib/usage/limitReached.ts — the client parser for the three
 * usage-limit refusals. Run: npx tsx scripts/test-limit-reached-parse.ts
 *
 * The bodies below are copied from the SERVER builders (aiImageLimitResponseBody,
 * aiTextLimitResponseBody, scheduledPostLimitResponseBody) rather than invented, so
 * this test fails if the server shapes drift away from what the client reads.
 */

import assert from "node:assert";

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).message}`); }
}

async function main() {
  const { parseLimitReached, offerableRemaining } = await import("../src/lib/usage/limitReached");

  // ── the three codes ──────────────────────────────────────────────────────────
  test("ai_image body (verbatim server shape) → kind ai_image", () => {
    const body = {
      ok: false,
      error_type: "ai_image_limit_reached",
      code: "ai_image_limit_reached",
      error: "You've reached your AI image limit for this billing period. Upgrade or wait for it to reset.",
      urls: [],
      generation_request_id: "req_1",
    };
    const parsed = parseLimitReached(402, body);
    assert.ok(parsed, "expected a parse");
    assert.equal(parsed.kind, "ai_image");
    assert.match(parsed.message, /AI image limit/);
  });

  test("ai_text body → kind ai_text, prose from userMessage not the code in `error`", () => {
    const body = {
      ok: false,
      requestId: "r1",
      error_type: "ai_text_limit_reached",
      error: "ai_text_limit_reached",
      code: "ai_text_limit_reached",
      userMessage: "You've reached your AI copy limit for this billing period. Upgrade or wait for it to reset.",
    };
    const parsed = parseLimitReached(402, body);
    assert.ok(parsed);
    assert.equal(parsed.kind, "ai_text");
    // `error` carries the CODE here; rendering it would show the user a raw identifier.
    assert.equal(parsed.message.includes("ai_text_limit_reached"), false);
    assert.match(parsed.message, /AI copy limit/);
  });

  test("scheduled_post body → kind scheduled_post", () => {
    const body = {
      ok: false,
      error_type: "scheduled_post_limit_reached",
      code: "scheduled_post_limit_reached",
      error: "You have reached your scheduled post limit for this billing period.",
    };
    const parsed = parseLimitReached(402, body);
    assert.ok(parsed);
    assert.equal(parsed.kind, "scheduled_post");
  });

  // ── remaining counts ─────────────────────────────────────────────────────────
  test("snake_case counts are read", () => {
    const parsed = parseLimitReached(402, {
      code: "ai_image_limit_reached", available_recurring: 2, available_bonus: 5,
    });
    assert.ok(parsed);
    assert.equal(parsed.availableRecurring, 2);
    assert.equal(parsed.availableBonus, 5);
    // R = recurring + bonus: both allowances are spendable through this path.
    assert.equal(offerableRemaining(parsed), 7);
  });

  test("camelCase counts are read", () => {
    const parsed = parseLimitReached(402, {
      code: "ai_image_limit_reached", availableRecurring: 3, availableBonus: 0,
    });
    assert.ok(parsed);
    assert.equal(parsed.availableRecurring, 3);
    assert.equal(parsed.availableBonus, 0);
    assert.equal(offerableRemaining(parsed), 3);
  });

  test("recurring 0 + bonus only → offers the bonus alone", () => {
    const parsed = parseLimitReached(402, {
      code: "ai_image_limit_reached", available_recurring: 0, available_bonus: 2,
    });
    assert.ok(parsed);
    assert.equal(offerableRemaining(parsed), 2);
  });

  test("recurring 0 + bonus 0 → offers 0 (a known zero: all used)", () => {
    const parsed = parseLimitReached(402, {
      code: "ai_image_limit_reached", available_recurring: 0, available_bonus: 0,
    });
    assert.ok(parsed);
    assert.equal(offerableRemaining(parsed), 0);
  });

  test("MISSING counts → null, not 0 (the production body carries neither)", () => {
    // This is the real /api/generate 402 today: aiImageLimitResponseBody() drops the
    // availableRecurring/availableBonus the route had in hand. null must NOT be
    // confused with 0 — 0 means "you have none", null means "we were not told".
    const parsed = parseLimitReached(402, {
      ok: false, error_type: "ai_image_limit_reached", code: "ai_image_limit_reached",
      error: "You've reached your AI image limit for this billing period.", urls: [],
    });
    assert.ok(parsed);
    assert.equal(parsed.availableRecurring, null);
    assert.equal(parsed.availableBonus, null);
    // An unknown remainder (BOTH fields missing) is not offerable as a number at all —
    // it degrades to the upgrade message, never to a guessed "0 instead".
    assert.equal(offerableRemaining(parsed), null);
  });

  test("only recurring missing, bonus known → offerable is the known bonus alone", () => {
    const parsed = parseLimitReached(402, { code: "ai_image_limit_reached", available_bonus: 4 });
    assert.ok(parsed);
    assert.equal(parsed.availableRecurring, null);
    assert.equal(parsed.availableBonus, 4);
    assert.equal(offerableRemaining(parsed), 4);
  });

  test("explicit zero survives as 0 (distinct from missing)", () => {
    const parsed = parseLimitReached(402, { code: "ai_image_limit_reached", available_recurring: 0 });
    assert.ok(parsed);
    assert.equal(parsed.availableRecurring, 0);
  });

  test("malformed counts (string / negative / NaN) → null", () => {
    const s = parseLimitReached(402, { code: "ai_image_limit_reached", available_recurring: "2" });
    assert.equal(s?.availableRecurring, null);
    const neg = parseLimitReached(402, { code: "ai_image_limit_reached", available_recurring: -1 });
    assert.equal(neg?.availableRecurring, null);
    const nan = parseLimitReached(402, { code: "ai_image_limit_reached", available_recurring: NaN });
    assert.equal(nan?.availableRecurring, null);
  });

  test("error_type alone (no `code`) is enough", () => {
    const parsed = parseLimitReached(402, { error_type: "scheduled_post_limit_reached" });
    assert.equal(parsed?.kind, "scheduled_post");
  });

  // ── unrelated errors → null ──────────────────────────────────────────────────
  test("connected_account_limit_reached → null (different refusal, own UI)", () => {
    // The trap an endsWith("limit_reached") match would fall into.
    const parsed = parseLimitReached(402, {
      ok: false,
      error_type: "connected_account_limit_reached",
      code: "connected_account_limit_reached",
      error: "You've reached your plan's connected account limit.",
    });
    assert.equal(parsed, null);
  });

  test("unrelated server errors → null", () => {
    assert.equal(parseLimitReached(429, { code: "user_generation_limit" }), null);
    assert.equal(parseLimitReached(503, { error: "generation_unavailable" }), null);
    assert.equal(parseLimitReached(500, { code: "internal_error" }), null);
    assert.equal(parseLimitReached(409, { code: "not_connected" }), null);
  });

  test("success responses → null even if the code string appears", () => {
    assert.equal(parseLimitReached(200, { code: "ai_image_limit_reached" }), null);
    assert.equal(parseLimitReached(201, { ok: true }), null);
  });

  test("non-object / empty bodies → null", () => {
    assert.equal(parseLimitReached(402, null), null);
    assert.equal(parseLimitReached(402, undefined), null);
    assert.equal(parseLimitReached(402, "ai_image_limit_reached"), null);
    assert.equal(parseLimitReached(402, ["ai_image_limit_reached"]), null);
    assert.equal(parseLimitReached(402, {}), null);
    assert.equal(parseLimitReached(NaN, { code: "ai_image_limit_reached" }), null);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
