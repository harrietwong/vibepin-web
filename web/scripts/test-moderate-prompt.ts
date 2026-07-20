/**
 * moderatePrompt unit tests (Creem AI-compliance).
 * Run: npx tsx scripts/test-moderate-prompt.ts
 *
 * Uses an INJECTED fetch mock — no live Creem call. Verifies the fail-closed
 * decision mapping, base-URL selection by key prefix, x-api-key header, and that
 * the API key is NEVER written to the structured log output.
 */

export {};

import { moderatePrompt, moderationBaseUrl, type ModeratePromptDeps } from "../src/lib/server/creem/moderatePrompt";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

// A fetch that returns a JSON body with a given status.
function fetchReturning(status: number, body: unknown, capture?: { headers?: Record<string, string>; url?: string }): ModeratePromptDeps["fetchImpl"] {
  return (async (url: string, init?: RequestInit) => {
    if (capture) {
      capture.url = url;
      capture.headers = (init?.headers ?? {}) as Record<string, string>;
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
}

// A fetch whose json() throws (malformed body).
function fetchMalformed(status = 200): ModeratePromptDeps["fetchImpl"] {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => { throw new Error("not json"); },
  } as unknown as Response)) as unknown as typeof fetch;
}

// A fetch that throws (network error) or an AbortError (timeout).
function fetchThrowing(errName?: string): ModeratePromptDeps["fetchImpl"] {
  return (async () => {
    const err = new Error("boom");
    if (errName) err.name = errName;
    throw err;
  }) as unknown as typeof fetch;
}

// Capture console.log + console.error output for a call.
async function withCapturedLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

async function main() {
  console.log("\nmoderatePrompt unit tests\n");

  // Ensure the mock env seam is OFF so tests exercise the real fetch path.
  delete process.env.ALLOW_GENERATION_MOCK_PROVIDER;
  delete process.env.MODERATION_MOCK_DECISION;
  process.env.CREEM_API_KEY = "creem_test_fake";

  await test("allow → { ok: true, resultId }", async () => {
    const r = await moderatePrompt({ prompt: "cozy mug" }, { fetchImpl: fetchReturning(200, { id: "mr_1", decision: "allow" }) });
    assert(r.ok, "should be ok");
    if (r.ok) assertEq(r.resultId, "mr_1", "resultId");
  });

  await test("flag → { ok:false, reason:rejected }", async () => {
    const r = await moderatePrompt({ prompt: "x" }, { fetchImpl: fetchReturning(200, { id: "mr_2", decision: "flag" }) });
    assert(!r.ok, "not ok");
    if (!r.ok) { assertEq(r.reason, "rejected", "reason"); assertEq(r.resultId, "mr_2", "resultId carried"); }
  });

  await test("deny → { ok:false, reason:rejected }", async () => {
    const r = await moderatePrompt({ prompt: "x" }, { fetchImpl: fetchReturning(200, { id: "mr_3", decision: "deny" }) });
    assert(!r.ok, "not ok");
    if (!r.ok) assertEq(r.reason, "rejected", "reason");
  });

  await test("unknown decision → unavailable (unknown blocks)", async () => {
    const r = await moderatePrompt({ prompt: "x" }, { fetchImpl: fetchReturning(200, { id: "mr_4", decision: "sideways" }) });
    assert(!r.ok, "not ok");
    if (!r.ok) assertEq(r.reason, "unavailable", "reason");
  });

  await test("missing decision field → unavailable", async () => {
    const r = await moderatePrompt({ prompt: "x" }, { fetchImpl: fetchReturning(200, { id: "mr_5" }) });
    assert(!r.ok, "not ok");
    if (!r.ok) assertEq(r.reason, "unavailable", "reason");
  });

  await test("allow with missing id → unavailable (malformed)", async () => {
    const r = await moderatePrompt({ prompt: "x" }, { fetchImpl: fetchReturning(200, { decision: "allow" }) });
    assert(!r.ok, "not ok");
    if (!r.ok) assertEq(r.reason, "unavailable", "reason");
  });

  await test("non-2xx → unavailable", async () => {
    const r = await moderatePrompt({ prompt: "x" }, { fetchImpl: fetchReturning(500, { error: "boom" }) });
    assert(!r.ok, "not ok");
    if (!r.ok) assertEq(r.reason, "unavailable", "reason");
  });

  await test("network throw → unavailable", async () => {
    const r = await moderatePrompt({ prompt: "x" }, { fetchImpl: fetchThrowing() });
    assert(!r.ok, "not ok");
    if (!r.ok) assertEq(r.reason, "unavailable", "reason");
  });

  await test("timeout (AbortError) → unavailable", async () => {
    const r = await moderatePrompt({ prompt: "x" }, { fetchImpl: fetchThrowing("AbortError") });
    assert(!r.ok, "not ok");
    if (!r.ok) assertEq(r.reason, "unavailable", "reason");
  });

  await test("timeout (TimeoutError) → unavailable", async () => {
    const r = await moderatePrompt({ prompt: "x" }, { fetchImpl: fetchThrowing("TimeoutError") });
    assert(!r.ok, "not ok");
    if (!r.ok) assertEq(r.reason, "unavailable", "reason");
  });

  await test("malformed / non-JSON body → unavailable", async () => {
    const r = await moderatePrompt({ prompt: "x" }, { fetchImpl: fetchMalformed() });
    assert(!r.ok, "not ok");
    if (!r.ok) assertEq(r.reason, "unavailable", "reason");
  });

  await test("missing CREEM_API_KEY → unavailable (does not throw)", async () => {
    const saved = process.env.CREEM_API_KEY;
    delete process.env.CREEM_API_KEY;
    try {
      const r = await moderatePrompt({ prompt: "x" }, { fetchImpl: fetchReturning(200, { id: "z", decision: "allow" }) });
      assert(!r.ok, "not ok");
      if (!r.ok) assertEq(r.reason, "unavailable", "reason");
    } finally {
      process.env.CREEM_API_KEY = saved;
    }
  });

  await test("base URL = test endpoint for a creem_test_ key", async () => {
    assertEq(moderationBaseUrl("creem_test_abc"), "https://test-api.creem.io", "test base");
  });

  await test("base URL = prod endpoint for a live key", async () => {
    assertEq(moderationBaseUrl("creem_live_abc"), "https://api.creem.io", "prod base");
    assertEq(moderationBaseUrl("creem_prod_xyz"), "https://api.creem.io", "prod base 2");
  });

  await test("api key sent in x-api-key header; base URL matches key prefix", async () => {
    const cap: { headers?: Record<string, string>; url?: string } = {};
    process.env.CREEM_API_KEY = "creem_test_headercheck";
    await moderatePrompt({ prompt: "x" }, { fetchImpl: fetchReturning(200, { id: "h", decision: "allow" }, cap) });
    assertEq(cap.headers?.["x-api-key"], "creem_test_headercheck", "x-api-key header");
    assert((cap.url ?? "").startsWith("https://test-api.creem.io/v1/moderation/prompt"), `url is test moderation endpoint (got ${cap.url})`);
  });

  await test("API key NEVER appears in the logged output", async () => {
    process.env.CREEM_API_KEY = "creem_test_SUPERSECRETKEY";
    const { logs } = await withCapturedLogs(async () =>
      moderatePrompt({ prompt: "secret prompt text" }, { fetchImpl: fetchReturning(200, { id: "s", decision: "allow" }) }),
    );
    const joined = logs.join("\n");
    assert(joined.length > 0, "expected at least one log line");
    assert(!joined.includes("SUPERSECRETKEY"), "api key must not be logged");
    assert(!joined.includes("secret prompt text"), "raw prompt must not be logged");
    assert(joined.includes("prompt_moderation"), "structured event present");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
