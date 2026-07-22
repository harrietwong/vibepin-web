/**
 * AI provider route auth boundary (Phase 1B PR1).
 * Run: npx tsx scripts/test-ai-provider-auth-boundary.ts
 *
 * /api/ai-copy, /api/ai-copy/analyze and /api/quality-judge each call a paid AI
 * provider on every request. They had NO authentication at all, so an anonymous
 * caller could spend provider money at will.
 *
 * These tests pin the boundary itself, not just the status code: for an
 * unauthenticated request the provider seams (fetchImageAsDataUrl / chatJson /
 * analyzeImageStructured / judgeImageQuality) must be invoked EXACTLY ZERO times.
 * A 401 that still burned a vision call would pass a status-code-only test and
 * still cost money.
 *
 * Also pinned: auth runs BEFORE body parsing (a malformed body with no auth is a
 * 401, never a parse error), and both accepted credential shapes — verified
 * bearer token and verified SSR cookie session — still reach the provider.
 *
 * Fakes are injected through Module._load (same idiom as
 * test-creem-billing-status.ts). No network, no DB, no provider key needed.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";

export {};

import { Module } from "node:module";

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
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// ── Provider seam spies ─────────────────────────────────────────────────────────
// Every outbound-spend entry point these three routes can reach. Counting them is
// the whole point of this suite.

const calls = {
  fetchImageAsDataUrl: 0,
  chatJson: 0,
  analyzeImageStructured: 0,
  judgeImageQuality: 0,
  generateCopyFromAnalysis: 0,
  analyzeAndWriteCopy: 0,
  retrievePinterestKeywords: 0,
};
function resetCalls() {
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k] = 0;
}
/** Total provider-spend calls across all four required seams. */
function providerCalls(): number {
  return calls.fetchImageAsDataUrl + calls.chatJson + calls.analyzeImageStructured + calls.judgeImageQuality;
}

// ── Injected auth state ─────────────────────────────────────────────────────────
// The routes call getUserIdFromBearerOrCookies(req). The fake reproduces that
// helper's real contract: bearer header first, then the SSR cookie session; a
// token/cookie is only accepted when it is one the (fake) Auth server verifies.

const VALID_BEARER = "valid-access-token";
const VALID_COOKIE = "sb-session=valid-cookie-session";
const authSeen: Array<{ bearer: string | null; cookie: string | null }> = [];

function fakeGetUserIdFromBearerOrCookies(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const cookie = req.headers.get("cookie");
  authSeen.push({ bearer, cookie });
  if (bearer === VALID_BEARER) return Promise.resolve("user-bearer-1");
  if (cookie === VALID_COOKIE) return Promise.resolve("user-cookie-1");
  return Promise.resolve(null);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request.includes("server/authUser")) {
    return { getUserIdFromBearerOrCookies: fakeGetUserIdFromBearerOrCookies };
  }
  if (request.includes("ai-copy/visionServer")) {
    // Wrap the REAL module so pure helpers (CopyError, normalizeCopyLength,
    // LENGTH_LIMITS, toImageContext, qualityIssues, ...) keep their real behaviour;
    // only the seams that spend money are replaced with counting stubs.
    const real = originalLoad.call(this, request, parent, isMain);
    return {
      ...real,
      providerConfig: () => ({
        provider: "test",
        key: "test-key",
        baseUrl: "https://provider.example",
        textModel: "test-text",
        visionModel: "test-vision",
      }),
      fetchImageAsDataUrl: async () => {
        calls.fetchImageAsDataUrl++;
        return { dataUrl: "data:image/png;base64,AAAA", bytes: 4, latencyMs: 1 };
      },
      chatJson: async () => {
        calls.chatJson++;
        return { title: "Refined title", description: "Refined description" };
      },
      analyzeImageStructured: async () => {
        calls.analyzeImageStructured++;
        return {
          imageSummary: "A test image summary",
          visibleObjects: ["mug"],
          colors: ["white"],
          style: "minimal",
          ocrText: "",
          category: "home",
        };
      },
      analyzeAndWriteCopy: async () => {
        calls.analyzeAndWriteCopy++;
        return {
          title: "A cozy handmade ceramic mug for slow mornings",
          description: "A cozy handmade ceramic mug photographed on a linen surface, perfect for slow mornings at home.",
          altText: "White ceramic mug on linen",
          imageSummary: "A test image summary",
          visibleObjects: ["mug"],
          colors: ["white"],
          style: "minimal",
          keywords: ["ceramic mug"],
        };
      },
      generateCopyFromAnalysis: async () => {
        calls.generateCopyFromAnalysis++;
        return {
          title: "A cozy handmade ceramic mug for slow mornings",
          description: "A cozy handmade ceramic mug photographed on a linen surface, perfect for slow mornings at home.",
          altText: "White ceramic mug on linen",
          imageSummary: "A test image summary",
          visibleObjects: ["mug"],
          colors: ["white"],
          style: "minimal",
          keywords: ["ceramic mug"],
        };
      },
    };
  }
  if (request.includes("ai-copy/qualityJudgeServer")) {
    return {
      judgeImageQuality: async () => {
        calls.judgeImageQuality++;
        return {
          scores: { relevance: 4, composition: 4, realism: 4, text: 4, safety: 5 },
          reasons: ["internal"],
        };
      },
    };
  }
  if (request.includes("ai-copy/keywordContext")) {
    return {
      retrievePinterestKeywords: async () => {
        calls.retrievePinterestKeywords++;
        return { queryTerms: [], candidates: [], recommended: [], rejected: [], poolSize: 0 };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// ── Route loading ───────────────────────────────────────────────────────────────
// Under tsx these dynamic imports resolve through the CJS require cache, which is
// keyed on the RESOLVED FILE PATH and ignores any `?x=` cache-buster. Evicting the
// entry is what actually forces re-evaluation.

const ROUTES = {
  "ai-copy": "../src/app/api/ai-copy/route",
  analyze: "../src/app/api/ai-copy/analyze/route",
  "quality-judge": "../src/app/api/quality-judge/route",
} as const;
type RouteName = keyof typeof ROUTES;

const URLS: Record<RouteName, string> = {
  "ai-copy": "https://vibepin.co/api/ai-copy",
  analyze: "https://vibepin.co/api/ai-copy/analyze",
  "quality-judge": "https://vibepin.co/api/quality-judge",
};

async function loadRoute(name: RouteName): Promise<{ POST: (req: Request) => Promise<Response> }> {
  const spec = ROUTES[name];
  delete require.cache[require.resolve(spec)];
  return import(spec) as Promise<{ POST: (req: Request) => Promise<Response> }>;
}

type Creds = "none" | "bearer" | "cookie" | "bad-bearer";

/** A body each route accepts on its happy path. */
function happyBody(name: RouteName): unknown {
  if (name === "ai-copy") {
    return {
      draftId: "d1",
      imageUrl: "https://cdn.example/img.png",
      language: "en",
      // Cached analysis → fast text path (one generateCopyFromAnalysis call).
      imageAnalysis: {
        status: "ready",
        imageSummary: "A test image summary",
        visibleObjects: ["mug"],
        colors: ["white"],
        style: "minimal",
        ocrText: "",
        category: "home",
      },
      recommendedKeywords: ["ceramic mug"],
    };
  }
  return { draftId: "d1", imageUrl: "https://cdn.example/img.png" };
}

function makeReq(name: RouteName, creds: Creds, rawBody?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (creds === "bearer") headers.authorization = `Bearer ${VALID_BEARER}`;
  if (creds === "bad-bearer") headers.authorization = "Bearer forged-token";
  if (creds === "cookie") headers.cookie = VALID_COOKIE;
  return new Request(URLS[name], {
    method: "POST",
    headers,
    body: rawBody !== undefined ? rawBody : JSON.stringify(happyBody(name)),
  });
}

async function callRoute(name: RouteName, creds: Creds, rawBody?: string) {
  resetCalls();
  const route = await loadRoute(name);
  const res = await route.POST(makeReq(name, creds, rawBody));
  const json = (await res.json()) as { ok?: boolean; error?: string; userMessage?: string };
  return { res, json };
}

const ALL: RouteName[] = ["ai-copy", "analyze", "quality-judge"];

async function main() {
  console.log("\nAI provider route auth boundary\n");

  // ── 1. Unauthenticated → 401, and ZERO provider spend ────────────────────────

  for (const name of ALL) {
    await test(`${name}: anonymous request → 401`, async () => {
      const { res, json } = await callRoute(name, "none");
      assertEq(res.status, 401, "status");
      assertEq(json.ok, false, "ok flag");
      assertEq(json.error, "unauthenticated", "error code");
      assert(typeof json.userMessage === "string" && json.userMessage.length > 0, "userMessage present");
      assert(!/unauthenticated/i.test(json.userMessage ?? ""), "userMessage is user-safe, not the raw code");
    });

    await test(`${name}: anonymous request invokes ZERO provider seams`, async () => {
      await callRoute(name, "none");
      assertEq(calls.fetchImageAsDataUrl, 0, "fetchImageAsDataUrl calls");
      assertEq(calls.chatJson, 0, "chatJson calls");
      assertEq(calls.analyzeImageStructured, 0, "analyzeImageStructured calls");
      assertEq(calls.judgeImageQuality, 0, "judgeImageQuality calls");
      assertEq(providerCalls(), 0, "total provider calls");
      // Nothing further downstream ran either.
      assertEq(calls.generateCopyFromAnalysis, 0, "generateCopyFromAnalysis calls");
      assertEq(calls.analyzeAndWriteCopy, 0, "analyzeAndWriteCopy calls");
      assertEq(calls.retrievePinterestKeywords, 0, "retrievePinterestKeywords calls");
    });

    await test(`${name}: forged bearer token → 401, zero provider spend`, async () => {
      const { res, json } = await callRoute(name, "bad-bearer");
      assertEq(res.status, 401, "status");
      assertEq(json.error, "unauthenticated", "error code");
      assertEq(providerCalls(), 0, "total provider calls");
    });

    // ── 2. Auth precedes body parsing ──────────────────────────────────────────
    await test(`${name}: malformed body + no auth → 401, not a parse error`, async () => {
      const { res, json } = await callRoute(name, "none", "{not json at all");
      assertEq(res.status, 401, "status");
      assertEq(json.error, "unauthenticated", "error code");
      assertEq(providerCalls(), 0, "total provider calls");
    });
  }

  // ── 3. Verified credentials still reach the provider ─────────────────────────

  await test("ai-copy: verified bearer → 200 and reaches the provider", async () => {
    const { res, json } = await callRoute("ai-copy", "bearer");
    assertEq(res.status, 200, "status");
    assertEq(json.ok, true, "ok flag");
    assertEq(calls.generateCopyFromAnalysis, 1, "provider copy call");
  });

  await test("ai-copy: verified cookie session → 200 and reaches the provider", async () => {
    const { res, json } = await callRoute("ai-copy", "cookie");
    assertEq(res.status, 200, "status");
    assertEq(json.ok, true, "ok flag");
    assertEq(calls.generateCopyFromAnalysis, 1, "provider copy call");
  });

  await test("analyze: verified bearer → 200, vision seam invoked once", async () => {
    const { res, json } = await callRoute("analyze", "bearer");
    assertEq(res.status, 200, "status");
    assertEq(json.ok, true, "ok flag");
    assertEq(calls.fetchImageAsDataUrl, 1, "image fetch calls");
    assertEq(calls.analyzeImageStructured, 1, "analyzeImageStructured calls");
  });

  await test("analyze: verified cookie session → 200, vision seam invoked once", async () => {
    const { res, json } = await callRoute("analyze", "cookie");
    assertEq(res.status, 200, "status");
    assertEq(json.ok, true, "ok flag");
    assertEq(calls.analyzeImageStructured, 1, "analyzeImageStructured calls");
  });

  await test("quality-judge: verified bearer → 200, judge seam invoked once", async () => {
    const { res, json } = await callRoute("quality-judge", "bearer");
    assertEq(res.status, 200, "status");
    assertEq(json.ok, true, "ok flag");
    assertEq(calls.fetchImageAsDataUrl, 1, "image fetch calls");
    assertEq(calls.judgeImageQuality, 1, "judgeImageQuality calls");
  });

  await test("quality-judge: verified cookie session → 200, judge seam invoked once", async () => {
    const { res, json } = await callRoute("quality-judge", "cookie");
    assertEq(res.status, 200, "status");
    assertEq(json.ok, true, "ok flag");
    assertEq(calls.judgeImageQuality, 1, "judgeImageQuality calls");
  });

  // ── 4. The auth helper actually used is the network-verifying one ────────────

  await test("routes use the verified bearer-or-cookies helper (not the local-only one)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const spec of Object.values(ROUTES)) {
      const file = path.resolve(__dirname, `${spec}.ts`);
      const src = fs.readFileSync(file, "utf8");
      assert(src.includes("getUserIdFromBearerOrCookies"), `${spec} imports the verifying helper`);
      assert(
        !src.includes("getUserIdFromCookieSession"),
        `${spec} must NOT use getUserIdFromCookieSession (local-only, unsafe for authorization)`,
      );
    }
  });

  await test("auth is resolved before the body is read (both credential shapes seen)", async () => {
    assert(authSeen.some(a => a.bearer === VALID_BEARER), "a bearer request reached the auth helper");
    assert(authSeen.some(a => a.cookie === VALID_COOKIE), "a cookie request reached the auth helper");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Module as any)._load = originalLoad;
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
