/**
 * Facebook Page discovery (/me/accounts) + permission/task parsing unit tests.
 * Run: npx tsx scripts/test-facebook-pages.ts
 *
 * Everything is mocked at globalThis.fetch — no real Graph call is ever made and
 * no token in this file is real. Covers the cases that made the live connect flow
 * mis-report "you have no Facebook Page":
 *   1. one Page returned
 *   2. several Pages returned
 *   3. paging.next followed and the two pages merged + de-duped
 *   4. Profile Plus (PROFILE_PLUS_*) task names counted as publishable
 *   5. a declined pages_show_list caught by missingRequiredScopes
 *   6. a Graph OAuthException (HTTP 400 + error body) raised as FacebookApiError
 *   7. a genuinely empty data array returned as []
 */

import { randomBytes } from "node:crypto";
// Type-only: erased at compile time, so it cannot trigger the module's
// import-time env reads (the runtime module is still loaded dynamically in main).
import type { FacebookApiError } from "../src/lib/server/facebook/service";

// Env must be set BEFORE the server modules load (config reads env at call time,
// but crypto-backed modules read at import time — mirror test-pinterest-oauth.ts).
process.env.FACEBOOK_TOKEN_ENC_KEY = randomBytes(32).toString("base64");
process.env.FACEBOOK_APP_ID = "test-fb-app-id";
process.env.FACEBOOK_APP_SECRET = "test-fb-app-secret";
process.env.FACEBOOK_REDIRECT_URI = "http://localhost:3000/api/auth/facebook/callback";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
// Keep the diagnostic fbDebug logging quiet during the test run. NODE_ENV is typed
// read-only, so assign through an index signature (the value is what matters).
(process.env as Record<string, string | undefined>).NODE_ENV = "production";

export {};

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

/** Fake token — never a real credential. */
const USER_TOKEN = "TEST-USER-TOKEN-not-a-real-credential";

type MockResponse = { status?: number; body: unknown };

/**
 * Install a mock globalThis.fetch that answers from a queue, and record every URL
 * it was called with so a test can assert on pagination/cursor behaviour.
 */
function mockFetch(queue: MockResponse[]): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : String(input));
    const next = queue[i++];
    if (!next) throw new Error(`mock fetch: unexpected extra request #${i}`);
    const status = next.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => next.body,
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function pageRow(id: string, name: string, tasks: string[]) {
  return { id, name, tasks, access_token: `PAGE-TOKEN-${id}` };
}

async function main() {
  const service = await import("../src/lib/server/facebook/service");
  const config = await import("../src/lib/server/facebook/config");

  console.log("\nFacebook Page discovery tests\n");

  // 1. Exactly one managed Page.
  await test("fetchManagedPages returns a single managed Page", async () => {
    const m = mockFetch([{ body: { data: [pageRow("111", "VibePin Page", ["CREATE_CONTENT", "MANAGE"])] } }]);
    try {
      const pages = await service.fetchManagedPages(USER_TOKEN);
      assertEq(pages.length, 1, "page count");
      assertEq(pages[0].pageId, "111", "pageId");
      assertEq(pages[0].pageName, "VibePin Page", "pageName");
      assertEq(pages[0].pageAccessToken, "PAGE-TOKEN-111", "page-scoped token passed through");
      assertEq(service.canPublishToPage(pages[0].tasks), true, "canPublish");
    } finally {
      m.restore();
    }
  });

  // 2. Several managed Pages — all returned, order preserved.
  await test("fetchManagedPages returns every Page when several are managed", async () => {
    const m = mockFetch([{
      body: {
        data: [
          pageRow("111", "Page One", ["CREATE_CONTENT"]),
          pageRow("222", "Page Two", ["MANAGE"]),
          pageRow("333", "Page Three", []),
        ],
      },
    }]);
    try {
      const pages = await service.fetchManagedPages(USER_TOKEN);
      assertEq(pages.length, 3, "page count");
      assertEq(pages.map(p => p.pageId).join(","), "111,222,333", "ids in Graph order");
      // A Page with NO tasks must still be a candidate (only canPublish is false).
      assertEq(service.canPublishToPage(pages[2].tasks), false, "empty tasks → not publishable");
    } finally {
      m.restore();
    }
  });

  // 3. paging.next followed; overlapping rows de-duped by pageId.
  await test("fetchManagedPages follows paging.next and de-dupes by pageId", async () => {
    const m = mockFetch([
      {
        body: {
          data: [pageRow("111", "Page One", ["MANAGE"]), pageRow("222", "Page Two", ["MANAGE"])],
          paging: { next: "https://graph.facebook.com/v25.0/me/accounts?after=CURSOR2&access_token=x" },
        },
      },
      {
        // "222" repeats across the cursor boundary — must NOT produce a duplicate.
        body: { data: [pageRow("222", "Page Two", ["MANAGE"]), pageRow("333", "Page Three", ["MANAGE"])] },
      },
    ]);
    try {
      const pages = await service.fetchManagedPages(USER_TOKEN);
      assertEq(m.calls.length, 2, "followed the cursor exactly once");
      assertEq(pages.length, 3, "merged page count after de-dupe");
      assertEq(pages.map(p => p.pageId).sort().join(","), "111,222,333", "unique ids");
    } finally {
      m.restore();
    }
  });

  // 4. New Pages Experience ("Profile Plus") task naming.
  await test("canPublishToPage accepts PROFILE_PLUS_* task names", () => {
    assertEq(service.canPublishToPage(["PROFILE_PLUS_CREATE_CONTENT"]), true, "PROFILE_PLUS_CREATE_CONTENT");
    assertEq(service.canPublishToPage(["PROFILE_PLUS_MANAGE"]), true, "PROFILE_PLUS_MANAGE");
    assertEq(service.canPublishToPage(["PROFILE_PLUS_MODERATE"]), true, "PROFILE_PLUS_MODERATE");
    assertEq(service.canPublishToPage(["PROFILE_PLUS_FULL_CONTROL"]), true, "PROFILE_PLUS_FULL_CONTROL");
    assertEq(service.canPublishToPage(["PROFILE_PLUS_FACEBOOK_ACCESS"]), true, "PROFILE_PLUS_FACEBOOK_ACCESS");
    // Classic naming still works.
    assertEq(service.canPublishToPage(["CREATE_CONTENT"]), true, "classic CREATE_CONTENT");
    assertEq(service.canPublishToPage(["MODERATE"]), true, "classic MODERATE");
    // Non-publishing roles stay false.
    assertEq(service.canPublishToPage(["ANALYZE"]), false, "ANALYZE is read-only");
    assertEq(service.canPublishToPage(["PROFILE_PLUS_ANALYZE"]), false, "PROFILE_PLUS_ANALYZE is read-only");
    assertEq(service.canPublishToPage([]), false, "no tasks");
  });

  // 5. A declined required permission is detected from /me/permissions.
  await test("declined pages_show_list is caught by missingRequiredScopes", async () => {
    const m = mockFetch([{
      body: {
        data: [
          { permission: "public_profile", status: "granted" },
          { permission: "pages_show_list", status: "declined" },
          { permission: "pages_manage_posts", status: "granted" },
          { permission: "pages_read_engagement", status: "granted" },
        ],
      },
    }]);
    try {
      const granted = await service.fetchGrantedPermissions(USER_TOKEN);
      assert(!granted.includes("pages_show_list"), "declined scope must not count as granted");
      const missing = config.missingRequiredScopes(granted);
      assertEq(missing.join(","), "pages_show_list", "missing required scopes");
    } finally {
      m.restore();
    }
  });

  // 6. Graph OAuthException → FacebookApiError (never a silent empty list).
  await test("Graph OAuthException (HTTP 400) raises FacebookApiError", async () => {
    const m = mockFetch([{
      status: 400,
      body: {
        error: {
          message: "Error validating access token: Session has expired.",
          type: "OAuthException",
          code: 190,
          error_subcode: 463,
        },
      },
    }]);
    try {
      let caught: unknown = null;
      try {
        await service.fetchManagedPages(USER_TOKEN);
      } catch (e) {
        caught = e;
      }
      assert(caught instanceof service.FacebookApiError, "must throw FacebookApiError");
      assertEq((caught as InstanceType<typeof service.FacebookApiError>).status, 400, "status carried through");
      assertEq(
        (caught as InstanceType<typeof service.FacebookApiError>).code,
        "accounts_fetch_failed",
        "error code",
      );
    } finally {
      m.restore();
    }
  });

  // 6b. HTTP 200 carrying an `error` object is still a failure, not "no Pages".
  await test("HTTP 200 with an error body still raises FacebookApiError", async () => {
    const m = mockFetch([{
      status: 200,
      body: { error: { message: "Unknown path components", type: "GraphMethodException", code: 2500 } },
    }]);
    try {
      let caught: unknown = null;
      try {
        await service.fetchManagedPages(USER_TOKEN);
      } catch (e) {
        caught = e;
      }
      assert(caught instanceof service.FacebookApiError, "200-with-error must throw, not return []");
    } finally {
      m.restore();
    }
  });

  // 7. A genuinely empty data array is the ONLY honest "no Pages" case.
  await test("empty data array returns [] without throwing", async () => {
    const m = mockFetch([{ body: { data: [] } }]);
    try {
      const pages = await service.fetchManagedPages(USER_TOKEN);
      assertEq(pages.length, 0, "no pages");
      assert(Array.isArray(pages), "returns an array");
    } finally {
      m.restore();
    }
  });

  // Guard rail: the token fingerprint must never leak the token itself.
  await test("tokenFingerprint never contains the token", () => {
    const fp = service.tokenFingerprint(USER_TOKEN);
    assert(!fp.includes(USER_TOKEN), "fingerprint must not embed the token");
    assert(fp.includes(`len=${USER_TOKEN.length}`), "fingerprint reports length");
    assert(/sha8=[0-9a-f]{8}/.test(fp), "fingerprint reports an 8-hex-char sha head");
    assertEq(service.tokenFingerprint(USER_TOKEN), fp, "fingerprint is stable for one token");
    assert(service.tokenFingerprint("other-token") !== fp, "different tokens differ");
  });

  // ── fetchPageById (manual Page connect fallback) ────────────────────────────

  await test("fetchPageById returns id/name/token on success", async () => {
    const m = mockFetch([{ body: { id: "555", name: "My Biz Page", access_token: "PAGE-TOKEN-555" } }]);
    try {
      const page = await service.fetchPageById(USER_TOKEN, "555");
      assertEq(page.pageId, "555", "pageId");
      assertEq(page.pageName, "My Biz Page", "pageName");
      assertEq(page.pageAccessToken, "PAGE-TOKEN-555", "pageAccessToken");
    } finally {
      m.restore();
    }
  });

  await test("fetchPageById direct request never asks for tasks", async () => {
    // tasks is a /me/accounts-edge-only field; requesting it on a Page node is a
    // Graph 400 ("Tried accessing nonexisting field"). Guard the request shape.
    const m = mockFetch([{ body: { id: "555", name: "P", access_token: "T" } }]);
    try {
      await service.fetchPageById(USER_TOKEN, "555");
      assertEq(m.calls.length, 1, "exactly one request");
      assert(!m.calls[0].includes("tasks"), "request URL must not contain tasks");
    } finally {
      m.restore();
    }
  });

  await test("fetchPageById rejects an id mismatch as not-found", async () => {
    const m = mockFetch([{ body: { id: "999", name: "Other Page", access_token: "T" } }]);
    try {
      await service.fetchPageById(USER_TOKEN, "555");
      assert(false, "should have thrown");
    } catch (e) {
      const err = e as FacebookApiError;
      assert(err instanceof service.FacebookApiError, "FacebookApiError expected");
      assert(
        err.code === "page_not_found" || err.code === "page_id_mismatch",
        `not-found-class code expected, got ${err.code}`,
      );
    } finally {
      m.restore();
    }
  });

  await test("fetchPageById without access_token is access-denied class", async () => {
    const m = mockFetch([{ body: { id: "555", name: "Read-Only Page" } }]);
    try {
      await service.fetchPageById(USER_TOKEN, "555");
      assert(false, "should have thrown");
    } catch (e) {
      const err = e as FacebookApiError;
      assert(err instanceof service.FacebookApiError, "FacebookApiError expected");
      assert(
        err.code === "page_access_denied" || err.code === "page_no_access_token",
        `access-denied-class code expected, got ${err.code}`,
      );
    } finally {
      m.restore();
    }
  });

  await test("fetchPageById surfaces an OAuthException as access-denied class", async () => {
    const m = mockFetch([{
      status: 400,
      body: { error: { message: "(#10) Permission denied", type: "OAuthException", code: 10 } },
    }]);
    try {
      await service.fetchPageById(USER_TOKEN, "555");
      assert(false, "should have thrown");
    } catch (e) {
      const err = e as FacebookApiError;
      assert(err instanceof service.FacebookApiError, "FacebookApiError expected");
      assert(
        err.code === "page_access_denied",
        `page_access_denied expected, got ${err.code}`,
      );
    } finally {
      m.restore();
    }
  });

  await test("fetchPageById maps an unknown-object error to not-found", async () => {
    const m = mockFetch([{
      status: 404,
      body: { error: { message: "(#803) Some of the aliases you requested do not exist", type: "OAuthException", code: 803 } },
    }]);
    try {
      await service.fetchPageById(USER_TOKEN, "555");
      assert(false, "should have thrown");
    } catch (e) {
      const err = e as FacebookApiError;
      assert(err.code === "page_not_found", `page_not_found expected, got ${err.code}`);
    } finally {
      m.restore();
    }
  });

  await test("fetchPageById error message never embeds the user token", async () => {
    // Even if Meta echoed something token-shaped, the thrown message must not
    // carry OUR user token (the URL embeds it — a naive "include the URL in the
    // error" would leak it).
    const m = mockFetch([{
      status: 400,
      body: { error: { message: "Bad signature", type: "OAuthException", code: 190 } },
    }]);
    try {
      await service.fetchPageById(USER_TOKEN, "555");
      assert(false, "should have thrown");
    } catch (e) {
      assert(!(e as Error).message.includes(USER_TOKEN), "error message must not contain the token");
    } finally {
      m.restore();
    }
  });

  // ── restorePreviousPage (reconnect auto-restore) ────────────────────────────

  await test("restorePreviousPage returns the page when the saved id verifies", async () => {
    const m = mockFetch([{ body: { id: "777", name: "Saved Page", access_token: "PAGE-TOKEN-777" } }]);
    try {
      const page = await service.restorePreviousPage(USER_TOKEN, "777");
      assert(page !== null, "restore should succeed");
      assertEq(page!.pageId, "777", "pageId");
      assertEq(page!.pageName, "Saved Page", "pageName");
      assertEq(page!.pageAccessToken, "PAGE-TOKEN-777", "fresh page token");
    } finally {
      m.restore();
    }
  });

  await test("restorePreviousPage returns null on a saved/returned id mismatch", async () => {
    const m = mockFetch([{ body: { id: "999", name: "Different Page", access_token: "T" } }]);
    try {
      assertEq(await service.restorePreviousPage(USER_TOKEN, "777"), null, "id mismatch → null");
    } finally {
      m.restore();
    }
  });

  await test("restorePreviousPage returns null when the page has no access_token", async () => {
    const m = mockFetch([{ body: { id: "777", name: "Read-Only Page" } }]);
    try {
      assertEq(await service.restorePreviousPage(USER_TOKEN, "777"), null, "no token → null");
    } finally {
      m.restore();
    }
  });

  await test("restorePreviousPage returns null on a Graph OAuthException (never throws)", async () => {
    const m = mockFetch([{
      status: 400,
      body: { error: { message: "(#190) token expired", type: "OAuthException", code: 190 } },
    }]);
    try {
      assertEq(await service.restorePreviousPage(USER_TOKEN, "777"), null, "OAuthException → null");
    } finally {
      m.restore();
    }
  });

  await test("restorePreviousPage request carries no tasks field and swallows token-free", async () => {
    const m = mockFetch([{ body: { id: "777", name: "P", access_token: "SECRET-PAGE-TOKEN" } }]);
    try {
      await service.restorePreviousPage(USER_TOKEN, "777");
      assertEq(m.calls.length, 1, "one request");
      assert(!m.calls[0].includes("tasks"), "no tasks field in the URL");
    } finally {
      m.restore();
    }
  });

  // ── publishToPage (Page publishing + permalink) ─────────────────────────────

  const PAGE_TOKEN = "TEST-PAGE-TOKEN-not-a-real-credential";

  await test("publishToPage text-only posts to /feed and returns id+permalink", async () => {
    const m = mockFetch([
      { body: { id: "965_111" } },
      { body: { id: "965_111", permalink_url: "https://www.facebook.com/965/posts/111" } },
    ]);
    try {
      const r = await service.publishToPage(PAGE_TOKEN, "965", { message: "hello" });
      assertEq(r.externalPostId, "965_111", "post id");
      assertEq(r.permalink, "https://www.facebook.com/965/posts/111", "permalink");
      assertEq(r.permalinkFallback, false, "no fallback needed");
      assert(m.calls[0].includes("/965/feed"), "first call posts to /feed");
      assert(!m.calls[0].includes("photos"), "text post must not hit /photos");
    } finally {
      m.restore();
    }
  });

  await test("publishToPage with an image posts to /photos and uses post_id", async () => {
    const m = mockFetch([
      { body: { id: "photo-node-9", post_id: "965_222" } },
      { body: { id: "965_222", permalink_url: "https://www.facebook.com/965/posts/222" } },
    ]);
    try {
      const r = await service.publishToPage(PAGE_TOKEN, "965", {
        message: "with pic",
        imageUrl: "https://cdn.example.com/pic.jpg",
      });
      assert(m.calls[0].includes("/965/photos"), "image post hits /photos");
      assertEq(r.externalPostId, "965_222", "post_id (feed post) preferred over photo node id");
      assert(m.calls[1].includes("965_222"), "permalink queried for the FEED post id");
    } finally {
      m.restore();
    }
  });

  await test("publishToPage falls back to a constructed URL when permalink fails", async () => {
    const m = mockFetch([
      { body: { id: "965_333" } },
      { status: 400, body: { error: { message: "perm lookup failed", type: "OAuthException", code: 100 } } },
    ]);
    try {
      const r = await service.publishToPage(PAGE_TOKEN, "965", { message: "x" });
      assertEq(r.externalPostId, "965_333", "post id survives");
      assert(r.permalink.includes("965_333"), "fallback URL embeds the post id");
      assertEq(r.permalinkFallback, true, "flagged as fallback");
    } finally {
      m.restore();
    }
  });

  await test("publishToPage surfaces a Graph publish failure without leaking the token", async () => {
    const m = mockFetch([
      { status: 403, body: { error: { message: "(#200) Requires pages_manage_posts", type: "OAuthException", code: 200 } } },
    ]);
    try {
      await service.publishToPage(PAGE_TOKEN, "965", { message: "x" });
      assert(false, "should have thrown");
    } catch (e) {
      const err = e as FacebookApiError;
      assert(err instanceof service.FacebookApiError, "FacebookApiError expected");
      assert(!err.message.includes(PAGE_TOKEN), "error message must not contain the page token");
    } finally {
      m.restore();
    }
  });

  await test("publishToPage rejects a non-public image URL before any Graph call", async () => {
    const m = mockFetch([]);
    try {
      await service.publishToPage(PAGE_TOKEN, "965", {
        message: "x",
        imageUrl: "http://localhost:9000/internal.jpg",
      });
      assert(false, "should have thrown");
    } catch (e) {
      const err = e as FacebookApiError;
      assertEq(err.code, "publish_image_not_public", "SSRF-guard code");
      assertEq(m.calls.length, 0, "no Graph request was made");
    } finally {
      m.restore();
    }
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

void main();
