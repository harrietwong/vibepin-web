/**
 * Website URL / destination link is OPTIONAL (recommended, never required).
 * Run: npx tsx scripts/test-optional-website-url.ts
 *
 * Covers: readiness gate (never blocks on URL), server-side optional-link
 * validation (empty/null/undefined ok; invalid rejected), and the Create Pin
 * payload builder omitting `link` entirely when empty.
 */

import assert from "node:assert";

import { randomBytes } from "node:crypto";

process.env.PINTEREST_TOKEN_ENC_KEY = randomBytes(32).toString("base64");
process.env.PINTEREST_APP_ID = "test-app-id";
process.env.PINTEREST_APP_SECRET = "test-app-secret";
process.env.PINTEREST_REDIRECT_URI = "http://localhost:3000/api/auth/pinterest/callback";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

let passed = 0, failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).message}`); }
}

async function main() {
  const readiness = await import("../src/lib/pinReadiness");
  const validate = await import("../src/lib/server/pinterest/validatePublish");
  const service = await import("../src/lib/server/pinterest/service");
  const { isPinReady, pinMissingFields, pinMissingFieldLabels } = readiness;
  type ReadinessInput = import("../src/lib/pinReadiness").ReadinessInput;

  const base: ReadinessInput = {
    imageUrl: "https://example.com/pin.jpg",
    title: "A title",
    description: "A description",
    altText: "Alt text",
    boardId: "board-123",
  };

  await test("Pin is Ready with NO destination URL", () => {
    assert.equal(isPinReady({ ...base, destinationUrl: "" }), true);
    assert.equal(isPinReady({ ...base, destinationUrl: undefined }), true);
    assert.equal(isPinReady({ ...base, destinationUrl: null }), true);
  });

  await test("Pin is Ready WITH a destination URL too", () => {
    assert.equal(isPinReady({ ...base, destinationUrl: "https://shop.example.com/p/1" }), true);
  });

  await test("Missing fields never include destination URL", () => {
    const missing = pinMissingFields({ imageUrl: "", title: "", description: "", altText: "", boardId: "" });
    assert.ok(!(missing as string[]).includes("destinationUrl"), "destinationUrl must not be a required field");
    assert.ok(!pinMissingFieldLabels(base).includes("Destination URL"));
  });

  await test("Still blocks on the real required fields", () => {
    assert.equal(isPinReady({ ...base, title: "" }), false);
    assert.equal(isPinReady({ ...base, boardId: "" }), false);
    assert.equal(isPinReady({ ...base, imageUrl: "" }), false);
  });

  await test("validateOptionalLink: empty / null / undefined -> ok, url undefined", () => {
    for (const raw of ["", "   ", null, undefined]) {
      const r = validate.validateOptionalLink(raw);
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.url, undefined);
    }
  });

  await test("validateOptionalLink: valid http(s) -> ok with normalized url", () => {
    const r = validate.validateOptionalLink("https://shop.example.com/p/1");
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.url, "https://shop.example.com/p/1");
  });

  await test("validateOptionalLink: invalid / non-public -> error", () => {
    assert.equal(validate.validateOptionalLink("not a url").ok, false);
    assert.equal(validate.validateOptionalLink("ftp://example.com").ok, false);
    assert.equal(validate.validateOptionalLink("http://localhost:3000/x").ok, false);
  });

  function capturingClient(sink: { body: Record<string, unknown> }) {
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      sink.body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ id: "pin-1", board_id: "board-123" }), { status: 201 });
    };
    return service.PinterestClient.forTest({ accessToken: "T", hooks: { fetchImpl } });
  }

  await test("createPin OMITS link when Website URL is empty", async () => {
    const sink = { body: {} as Record<string, unknown> };
    await capturingClient(sink).createPin({ boardId: "board-123", imageUrl: "https://example.com/pin.jpg", title: "T" });
    assert.ok(!("link" in sink.body), "link must not be present when empty");
  });

  await test("createPin INCLUDES link when a Website URL is provided", async () => {
    const sink = { body: {} as Record<string, unknown> };
    await capturingClient(sink).createPin({ boardId: "board-123", imageUrl: "https://example.com/pin.jpg", link: "https://shop.example.com/p/1" });
    assert.equal(sink.body.link, "https://shop.example.com/p/1");
  });

  console.log(`\nOptional Website URL: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
