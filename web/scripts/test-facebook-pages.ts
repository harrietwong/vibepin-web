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
 *
 * Plus the MULTI-ACCOUNT storage contract (E1a-01), exercised for real against a
 * faked Supabase: with two Facebook rows the store must act on the row the caller
 * NAMES, and must refuse — never guess — when no row is named.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import Module from "node:module";
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

// ── Faked Supabase for the connection store ──────────────────────────────────
// The store builds its client through `createServerClient()` at call time, so
// intercepting the module gives a real behavioural seam: we can assert WHICH row
// a write landed on, not merely that the source mentions an id. Installed before
// any dynamic import below.
type FakeRow = Record<string, unknown> & { id: string };
type FakeOp = {
  op: "select" | "update" | "insert";
  eq: Array<[string, unknown]>;
  matched: string[];
};
let fakeRows: FakeRow[] = [];
let fakeOps: FakeOp[] = [];

function fakeServerClient() {
  return {
    from(_table: string) {
      const eq: Array<[string, unknown]> = [];
      let op: FakeOp["op"] = "select";
      let payload: Record<string, unknown> | undefined;
      const settle = () => {
        // Every recorded .eq() is applied — so a query that DROPPED .eq("user_id")
        // would visibly match rows it must not see.
        const matched = fakeRows.filter(r => eq.every(([col, val]) => r[col] === val));
        if (op === "update" && payload) for (const row of matched) Object.assign(row, payload);
        fakeOps.push({ op, eq: [...eq], matched: matched.map(r => r.id) });
        return Promise.resolve({
          data: op === "select" ? matched.map(r => ({ ...r })) : null,
          error: null,
        });
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (p: Record<string, unknown>) => { op = "update"; payload = p; return builder; },
        insert: (p: Record<string, unknown>) => { op = "insert"; payload = p; return settle(); },
        eq: (col: string, val: unknown) => { eq.push([col, val]); return builder; },
        then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => settle().then(ok, err),
      };
      return builder;
    },
  };
}

const origLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (
  this: unknown, request: string, parent: unknown, isMain: boolean
) {
  if (request.endsWith("/lib/supabase") || request.endsWith("@/lib/supabase")) {
    return { createServerClient: fakeServerClient, createClient: fakeServerClient };
  }
  return origLoad.call(this, request, parent, isMain);
} as never;

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

  // ── Multi-account storage (source assertions) ─────────────────────────────
  // Guards behaviour with no unit-testable seam — every path needs a live
  // Supabase client. A regression here means connecting a second Facebook account
  // silently overwrites the first, which no runtime test catches until data is
  // already lost.
  const storeSrc = readFileSync(
    new URL("../src/lib/server/facebook/connectionStore.ts", import.meta.url),
    "utf8",
  );

  await test("upsert resolves the row by Facebook account id, not by provider alone", async () => {
    // The rule now lives in pickRowForFacebookUser, shared with every read, so a
    // read and the write that follows it can never resolve to different rows.
    assert(
      storeSrc.includes("facebookUserIdOf(r) === facebookUserId"),
      "the row must be matched on metadata.facebook.facebookUserId",
    );
    // A Reconnect may additionally NAME the row it repairs, so the upsert goes
    // through pickRowForUpsert — which still delegates to the shared rule. What
    // matters is that no private copy of the matching logic appears here.
    assert(
      storeSrc.includes("pickRowForUpsert(allRows, input.accountId, targetConnectionId)"),
      "upsert must resolve the row through the shared picker, not a private copy of it",
    );
    assert(
      storeSrc.includes("return pickRowForFacebookUser(rows, facebookUserId);"),
      "pickRowForUpsert must fall back to the identity rule every READ also uses",
    );
    // The named target can only SELECT among rows identity already agrees with —
    // it must never override identity, or a forged id would repoint a connection.
    assert(
      storeSrc.includes("if (!recorded || recorded === facebookUserId) return target;"),
      "an explicit target is honoured only when its recorded identity is compatible",
    );
  });

  await test("a legacy row with no recorded account id is adopted, not orphaned", async () => {
    assert(
      storeSrc.includes("rows.length === 1 && !facebookUserIdOf(rows[0])"),
      "a single pre-multi-account row is reused rather than duplicated",
    );
  });

  await test("Instagram stores one row per account and refuses to guess", async () => {
    const igSrc = readFileSync(
      new URL("../src/lib/server/instagram/connectionStore.ts", import.meta.url),
      "utf8",
    );
    assert(
      igSrc.includes("r.provider_account_id === input.accountId"),
      "the row is matched on the IG user id, not on provider alone",
    );
    assert(
      igSrc.includes("publishable.length > 1 && !connectionId"),
      "with several connected accounts and no target, the store must return null",
    );
  });

  await test("publishing refuses to guess between several connected accounts", async () => {
    assert(
      storeSrc.includes("publishable.length > 1 && !connectionId"),
      "with several publishable accounts and no target, the store must return null",
    );
    assert(
      storeSrc.includes("connectionId?: string"),
      "getSelectedPageToken must accept the target connection id",
    );
  });

  // -- Multi-account storage (BEHAVIOURAL, against the faked Supabase) --------
  // E1a-01: four store reads used `.maybeSingle()`, which PostgREST fails outright
  // once a user holds two Facebook rows -- so connecting a SECOND account broke
  // BOTH (page selection, token lookup, manual connect, stored selection). These
  // run the real store functions and assert which row was read and written.
  const store = await import("../src/lib/server/facebook/connectionStore");
  const { createTokenCipher } = await import("../src/lib/server/crypto");
  // Same env var the store uses, so fixtures decrypt with the store's own key.
  const testCipher = createTokenCipher("FACEBOOK_TOKEN_ENC_KEY");

  const UID = "user-under-test";

  /** One social_connections row for `UID`, carrying one candidate Page. */
  function fbRow(id: string, fbUserId: string | null, pageId: string): FakeRow {
    return {
      id,
      user_id: UID,
      provider: "facebook",
      connection_status: "connected",
      access_token_encrypted: testCipher.encrypt(`USER-TOKEN-${id}`),
      metadata: {
        facebook: {
          authMethod: "facebook_login",
          connectionState: "page_selection_required",
          facebookUserId: fbUserId,
          facebookUserName: `fb-user-${id}`,
          selectedPageId: null,
          selectedPageName: null,
          selectedPageTokenEncrypted: null,
          lastKnownPageId: null,
          lastKnownPageName: null,
          candidatePages: [
            {
              pageId,
              pageName: `Page ${pageId}`,
              canPublish: true,
              source: "discovered",
              pageAccessTokenEncrypted: testCipher.encrypt(`PAGE-TOKEN-${pageId}`),
            },
          ],
          updatedAt: "2026-01-01T00:00:00Z",
        },
      },
    };
  }

  /** Reset the faked table. Two rows = the multi-account case that used to break. */
  function seed(rows: FakeRow[]) {
    fakeRows = rows;
    fakeOps = [];
  }

  const fbMeta = (id: string): Record<string, unknown> =>
    (fakeRows.find(r => r.id === id)!.metadata as { facebook: Record<string, unknown> }).facebook;

  async function expectThrow(fn: () => Promise<unknown>, message: string, what: string) {
    let thrown: Error | null = null;
    try { await fn(); } catch (e) { thrown = e as Error; }
    assert(thrown !== null, `${what}: expected a throw, got a value`);
    assertEq(thrown!.message, message, `${what}: error message`);
  }

  await test("selectFacebookPage: two rows + connectionId writes ONLY the named row", async () => {
    seed([fbRow("row-A", "fb-A", "page-a"), fbRow("row-B", "fb-B", "page-b")]);
    const result = await store.selectFacebookPage(UID, "page-b", "row-B");
    assertEq(result.pageId, "page-b", "returns the selected Page");
    assertEq(fbMeta("row-B").selectedPageId, "page-b", "the named row is the one selected");
    assertEq(fbMeta("row-A").selectedPageId, null, "the other account must not be touched");
    const updates = fakeOps.filter(o => o.op === "update");
    assertEq(updates.length, 1, "exactly one row written");
    assertEq(updates[0].matched.join(","), "row-B", "the write matched only the named row");
  });

  await test("selectFacebookPage: two rows + NO id fails closed and writes nothing", async () => {
    seed([fbRow("row-A", "fb-A", "page-a"), fbRow("row-B", "fb-B", "page-b")]);
    await expectThrow(
      () => store.selectFacebookPage(UID, "page-a"),
      "MULTIPLE_FACEBOOK_CONNECTIONS",
      "several accounts and no target",
    );
    assertEq(fakeOps.filter(o => o.op === "update").length, 0, "nothing may be written");
    assertEq(fbMeta("row-A").selectedPageId, null, "row A untouched");
    assertEq(fbMeta("row-B").selectedPageId, null, "row B untouched");
  });

  await test("selectFacebookPage: one row + no id still works (pre-multi-account contract)", async () => {
    seed([fbRow("row-A", "fb-A", "page-a")]);
    const result = await store.selectFacebookPage(UID, "page-a");
    assertEq(result.pageId, "page-a", "the sole row is used, exactly as before");
    assertEq(fbMeta("row-A").selectedPageId, "page-a", "selection persisted");
  });

  await test("every Facebook query stays scoped to the owner, even when an id is given", async () => {
    // connectionId arrives in a REQUEST BODY. If it ever REPLACED the owner filter
    // instead of narrowing it, a forged id would reach another user's connection.
    // So: user_id on every statement, no exceptions. `provider` is additionally
    // required on the READS (they scan the user's rows); the write is keyed by
    // primary key + user_id, where a provider filter would add nothing.
    seed([fbRow("row-A", "fb-A", "page-a"), fbRow("row-B", "fb-B", "page-b")]);
    await store.selectFacebookPage(UID, "page-b", "row-B");
    assert(fakeOps.length > 0, "the call must actually have touched the table");
    for (const op of fakeOps) {
      const cols = op.eq.map(([c]) => c);
      assert(cols.includes("user_id"), `${op.op} dropped the user_id filter`);
      if (op.op === "select") {
        assert(cols.includes("provider"), "a read dropped the provider filter");
      } else {
        assert(cols.includes("id"), `${op.op} must be keyed by the row id`);
      }
    }
    const reads = fakeOps.filter(o => o.op === "select");
    assert(
      reads.some(o => o.eq.some(([c, v]) => c === "id" && v === "row-B")),
      "the read must additionally narrow to the named connection id",
    );
  });

  await test("a connectionId belonging to ANOTHER user resolves to nothing", async () => {
    // The id is caller-supplied, so the decisive test is a real id owned by
    // someone else: the owner filter must make it match zero rows.
    const foreign = fbRow("row-X", "fb-X", "page-x");
    foreign.user_id = "someone-else";
    seed([fbRow("row-A", "fb-A", "page-a"), foreign]);
    await expectThrow(
      () => store.selectFacebookPage(UID, "page-x", "row-X"),
      "No Facebook connection to select a Page for",
      "forged connection id",
    );
    assertEq(fakeOps.filter(o => o.op === "update").length, 0, "nothing may be written");
    assertEq(fbMeta("row-X").selectedPageId, null, "the other user's row is untouched");
  });

  await test("getFacebookUserToken: two rows + id decrypts THAT row's token", async () => {
    seed([fbRow("row-A", "fb-A", "page-a"), fbRow("row-B", "fb-B", "page-b")]);
    assertEq(await store.getFacebookUserToken(UID, "row-B"), "USER-TOKEN-row-B", "row-B token");
    assertEq(await store.getFacebookUserToken(UID, "row-A"), "USER-TOKEN-row-A", "row-A token");
  });

  await test("getFacebookUserToken: two rows + no id THROWS (never reads as 'not connected')", async () => {
    // Returning null here would render "Connect Facebook first" to a customer who
    // has TWO Facebook accounts connected -- a plainly false statement.
    seed([fbRow("row-A", "fb-A", "page-a"), fbRow("row-B", "fb-B", "page-b")]);
    await expectThrow(
      () => store.getFacebookUserToken(UID),
      "MULTIPLE_FACEBOOK_CONNECTIONS",
      "token lookup with several accounts",
    );
  });

  await test("getFacebookUserToken: one row + no id returns the token (unchanged)", async () => {
    seed([fbRow("row-A", "fb-A", "page-a")]);
    assertEq(await store.getFacebookUserToken(UID), "USER-TOKEN-row-A", "sole row's token");
  });

  await test("connectFacebookPageManually: two rows + id attaches to the named account", async () => {
    seed([fbRow("row-A", "fb-A", "page-a"), fbRow("row-B", "fb-B", "page-b")]);
    const result = await store.connectFacebookPageManually(
      UID,
      { pageId: "page-manual", pageName: "Manually named Page", pageAccessToken: "PAGE-TOKEN-manual", tasks: [] },
      "row-A",
    );
    assertEq(result.pageId, "page-manual", "returns the attached Page");
    assertEq(fbMeta("row-A").selectedPageId, "page-manual", "attached to the named account");
    assertEq(fbMeta("row-B").selectedPageId, null, "the other account is untouched");
  });

  await test("connectFacebookPageManually: two rows + no id fails closed", async () => {
    seed([fbRow("row-A", "fb-A", "page-a"), fbRow("row-B", "fb-B", "page-b")]);
    await expectThrow(
      () => store.connectFacebookPageManually(
        UID,
        { pageId: "page-manual", pageName: null, pageAccessToken: "t", tasks: [] },
        undefined,
      ),
      "MULTIPLE_FACEBOOK_CONNECTIONS",
      "manual connect with several accounts",
    );
    assertEq(fakeOps.filter(o => o.op === "update").length, 0, "nothing may be written");
  });

  await test("getStoredFacebookSelection: scoped by facebookUserId reads that account", async () => {
    // The OAuth callback's identity: mid-callback the row may not exist yet, so
    // there is no connection id to pass. Restoring the OTHER account's Page would
    // hand this Facebook user a Page they may not administer.
    seed([fbRow("row-A", "fb-A", "page-a"), fbRow("row-B", "fb-B", "page-b")]);
    fbMeta("row-A").selectedPageId = "page-a";
    fbMeta("row-A").selectedPageName = "Page A";
    fbMeta("row-B").selectedPageId = "page-b";
    fbMeta("row-B").selectedPageName = "Page B";
    const a = await store.getStoredFacebookSelection(UID, { facebookUserId: "fb-A" });
    const b = await store.getStoredFacebookSelection(UID, { facebookUserId: "fb-B" });
    assertEq(a?.pageId, "page-a", "fb-A's own prior Page");
    assertEq(b?.pageId, "page-b", "fb-B's own prior Page");
  });

  await test("getStoredFacebookSelection: unknown facebookUserId returns null, never a guess", async () => {
    seed([fbRow("row-A", "fb-A", "page-a"), fbRow("row-B", "fb-B", "page-b")]);
    fbMeta("row-A").selectedPageId = "page-a";
    const restored = await store.getStoredFacebookSelection(UID, { facebookUserId: "fb-NEW" });
    assertEq(restored, null, "a first-time connect must not inherit another account's Page");
  });

  await test("getStoredFacebookSelection: two rows + no target fails closed", async () => {
    seed([fbRow("row-A", "fb-A", "page-a"), fbRow("row-B", "fb-B", "page-b")]);
    await expectThrow(
      () => store.getStoredFacebookSelection(UID),
      "MULTIPLE_FACEBOOK_CONNECTIONS",
      "stored selection with several accounts",
    );
  });

  await test("getStoredFacebookSelection: one row + no target works (unchanged)", async () => {
    seed([fbRow("row-A", null, "page-a")]);
    fbMeta("row-A").selectedPageId = "page-a";
    fbMeta("row-A").selectedPageName = "Page A";
    const restored = await store.getStoredFacebookSelection(UID);
    assertEq(restored?.pageId, "page-a", "the sole row is used, exactly as before");
  });

  // -- Caller contract: every caller NAMES the row it acts on -----------------
  // Fixing only the store would leave the bug reachable: a caller that still omits
  // the id gets the fail-closed error instead of the right row.
  await test("every Facebook store caller threads the connection id", async () => {
    const readSrc = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

    const selectRoute = readSrc("../src/app/api/integrations/facebook/select-page/route.ts");
    assert(
      selectRoute.includes("selectFacebookPage(uid, pageId, connectionId)"),
      "select-page must forward the connection id",
    );
    assert(
      selectRoute.includes("connectionId = rawConnectionId || undefined"),
      'an empty connectionId must become undefined -- .eq("id", "") matches nothing',
    );

    const connectRoute = readSrc("../src/app/api/integrations/facebook/connect-page/route.ts");
    assert(
      connectRoute.includes("getFacebookUserToken(uid, connectionId)"),
      "connect-page must read the token of the named account",
    );
    assert(
      connectRoute.includes("connectFacebookPageManually(uid, page, connectionId)"),
      "connect-page must attach the Page to the named account",
    );
    assert(
      connectRoute.includes("MULTIPLE_FACEBOOK_CONNECTIONS"),
      "connect-page must map the fail-closed error to its own code, not to 'no connection'",
    );

    const callback = readSrc("../src/app/api/auth/facebook/callback/route.ts");
    assertEq(
      callback.split("getStoredFacebookSelection(uid, { facebookUserId: fbUser.id })").length - 1,
      2,
      "both callback restore paths must scope the read to the Facebook user re-authing",
    );
    assert(
      !callback.includes("getStoredFacebookSelection(uid)"),
      "no unscoped restore read may remain",
    );

    const panel = readSrc("../src/components/social/SocialAccountsPanel.tsx");
    assert(
      panel.includes("body: JSON.stringify({ pageId, connectionId: account.id })"),
      "the Page picker must post the id of the account it is rendered for",
    );
    assert(
      panel.includes("<FacebookManualPageForm connectionId={account.id}"),
      "the manual-Page form must carry the account it belongs to",
    );
    assert(
      panel.includes("summary.accounts.map(acc => ("),
      "the panel must render one Facebook detail block per account, not accounts[0]",
    );
    assert(
      !panel.includes("readFacebookMeta(summary)"),
      "reading accounts[0] made the second account's picker unreachable",
    );

    const official = readSrc("../src/lib/social/providers/official.ts");
    assert(
      official.includes("getSelectedPageToken(userId, input.connection?.id)"),
      "publishing must name the account it publishes as",
    );
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

void main();
