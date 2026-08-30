/**
 * AI-copy TEXT model fail-closed in production (product decision #12, 2026-08-28).
 * Run: npx tsx scripts/test-ai-copy-model-config.ts   (registered in CORE)
 *
 * providerConfig()'s `textModel` used to silently fall back to a hardcoded default
 * (gemini-2.5-flash / gpt-4o-mini) whenever AI_COPY_TEXT_MODEL was unset — including
 * in PRODUCTION, where that default can drift out of sync with whatever model was
 * actually vetted/priced for prod traffic. Now:
 *
 *   - production + AI_COPY_TEXT_MODEL unset -> accessing `.textModel` throws a typed
 *     CopyError("ai_copy_model_unset", 503) instead of silently substituting.
 *   - production + AI_COPY_TEXT_MODEL set   -> unchanged, uses the configured model.
 *   - non-production + unset                -> unchanged, the hardcoded fallback stays.
 *
 * `visionModel` is NOT touched by this change (see the dedicated case below) — its
 * fallback chain (AI_COPY_VISION_MODEL / LINAPI_ANALYSIS_MODEL /
 * OPENAI_AI_COPY_VISION_MODEL / hardcoded default) is not the same trivial code path
 * as textModel's single-fallback resolution, so it was deliberately left alone.
 *
 * The throw is implemented as a LAZY GETTER (not an eager throw inside
 * providerConfig()) so providerConfig() itself never throws — callers that only need
 * `.key`/`.visionModel` (analyze, quality-judge routes) are unaffected — and the throw
 * fires exactly at the point of use, inside the caller's try/catch. The integration
 * case below proves this end-to-end through the REAL generateCopyFromAnalysis (the
 * one function that actually spends money on the text model), asserting the provider
 * network seam (fetch, inside chatJson) is never reached.
 *
 * ── ROUTE-LEVEL regression (Codex round-4 fix #1, 2026-08-28) ──────────────────
 * The two cases above only prove the getter itself is fail-closed. They do NOT prove
 * every call site actually reads it: the VISION-FALLBACK branch of POST /api/ai-copy
 * (taken when the client has no cached analysis) built its prompt and called
 * analyzeAndWriteCopy() without ever touching `.textModel` — that function only reads
 * `.visionModel` — so in production with AI_COPY_TEXT_MODEL unset, a request with no
 * cached analysis sailed straight past the guard and still reached the provider. The
 * fast-path (cached-analysis) branch was never exposed because generateCopyFromAnalysis
 * already reads `.textModel` internally. The fix forces the getter once, unconditionally,
 * at the top of the route's try block — before either branch — so both are covered.
 * These cases load the REAL route handler (Module._load fakes, same idiom as
 * test-ai-copy-provider-boundary.ts) to prove it end-to-end at the HTTP boundary.
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
    console.log(`  ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL - ${name}\n      ${(e as Error).message}`);
  }
}
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// -- Env isolation: each case gets a pristine, restored env ---------------------
const ENV_KEYS = ["LINAPI_KEY", "OPENAI_API_KEY", "AI_COPY_TEXT_MODEL", "AI_COPY_VISION_MODEL", "VERCEL_ENV"] as const;
async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// -- Route-level fakes (Module._load), same idiom as test-ai-copy-provider-boundary --
// Only the money-spending seams and the two auth exports are faked. `providerConfig`
// is deliberately left as the REAL implementation (not stubbed to a fixed pair) so the
// production/unset fail-closed behaviour under test is the real code path, not a mock.

const routeSeen = {
  chatJsonCalls: 0,
  analyzeImageStructuredCalls: 0,
  analyzeAndWriteCopyCalls: 0,
  generateCopyFromAnalysisCalls: 0,
  generateCopyFromAnalysisModels: [] as string[],
};
function resetRouteSeen() {
  routeSeen.chatJsonCalls = 0;
  routeSeen.analyzeImageStructuredCalls = 0;
  routeSeen.analyzeAndWriteCopyCalls = 0;
  routeSeen.generateCopyFromAnalysisCalls = 0;
  routeSeen.generateCopyFromAnalysisModels = [];
}

const routeCopyStub = {
  title: "A cozy handmade ceramic mug for slow mornings",
  description: "A cozy handmade ceramic mug photographed on a linen surface, perfect for slow mornings at home.",
  altText: "White ceramic mug on linen",
  imageSummary: "A test image summary",
  visibleObjects: ["mug"],
  colors: ["white"],
  style: "minimal",
  keywords: ["ceramic mug"],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request.includes("server/authUser")) {
    return {
      getUserIdFromBearerOrCookies: () => Promise.resolve("user-1"),
      getUserIdFromSameOriginSession: () => Promise.resolve("user-1"),
    };
  }
  if (request.includes("server/rateLimit")) {
    // Real rateLimit hits a live Supabase client (slow, network-dependent) even on
    // its fail-open path. Faked here purely for test speed/hermeticity — this fix
    // does not touch rate limiting.
    return {
      consumeRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
      RATE_LIMITED_ERROR: "rate_limited",
      RATE_LIMITED_MESSAGE: "rate limited",
    };
  }
  if (request.includes("ai-copy/keywordContext")) {
    return {
      retrievePinterestKeywords: async () => ({ queryTerms: [], candidates: [], recommended: [], rejected: [], poolSize: 0 }),
    };
  }
  if (request.includes("ai-copy/visionServer")) {
    // Wrap the REAL module: providerConfig, CopyError and every pure helper keep
    // their real behaviour. Only the four provider-spend seams are replaced.
    const real = originalLoad.call(this, request, parent, isMain);
    return {
      ...real,
      fetchImageAsDataUrl: async () => ({ dataUrl: "data:image/png;base64,AAAA", bytes: 4, latencyMs: 1 }),
      chatJson: async () => {
        routeSeen.chatJsonCalls++;
        return { title: "Refined title", description: "Refined description" };
      },
      analyzeImageStructured: async () => {
        routeSeen.analyzeImageStructuredCalls++;
        return { ...routeCopyStub };
      },
      analyzeAndWriteCopy: async () => {
        routeSeen.analyzeAndWriteCopyCalls++;
        return { ...routeCopyStub };
      },
      generateCopyFromAnalysis: async (a: { cfg: { textModel: string } }) => {
        routeSeen.generateCopyFromAnalysisCalls++;
        routeSeen.generateCopyFromAnalysisModels.push(a.cfg.textModel);
        return { ...routeCopyStub };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const AI_COPY_ROUTE_SPEC = "../src/app/api/ai-copy/route";
const AI_COPY_URL = "https://vibepin.co/api/ai-copy";

async function loadAiCopyRoute(): Promise<{ POST: (req: Request) => Promise<Response> }> {
  // Under tsx, dynamic imports resolve through the CJS require cache keyed on the
  // resolved file path — evict it so each case re-evaluates the route (and therefore
  // re-runs providerConfig() against whatever env withEnv has set for this case).
  delete require.cache[require.resolve(AI_COPY_ROUTE_SPEC)];
  return import(AI_COPY_ROUTE_SPEC) as Promise<{ POST: (req: Request) => Promise<Response> }>;
}

/** No `imageAnalysis.imageSummary` -> the route takes the VISION-FALLBACK branch. */
function visionFallbackBody(): Record<string, unknown> {
  return { draftId: "d1", imageUrl: "https://cdn.example/img.png", language: "en" };
}

/** A cached analysis present -> the route takes the FAST-PATH (text-only) branch. */
function fastPathBody(): Record<string, unknown> {
  return {
    draftId: "d1",
    imageUrl: "https://cdn.example/img.png",
    language: "en",
    imageAnalysis: { status: "ready", ...routeCopyStub },
    recommendedKeywords: ["ceramic mug"],
  };
}

async function postAiCopy(body: Record<string, unknown>) {
  const route = await loadAiCopyRoute();
  const res = await route.POST(
    new Request(AI_COPY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer valid" },
      body: JSON.stringify(body),
    }),
  );
  const json = (await res.json()) as { ok?: boolean; error?: string };
  return { res, json };
}

async function main() {
  console.log("\nAI-copy TEXT model fail-closed in production (decision #12)\n");

  const { providerConfig, generateCopyFromAnalysis, CopyError } = await import("../src/lib/ai-copy/visionServer");

  const analysisStub = {
    imageSummary: "A test image summary",
    visibleObjects: ["mug"],
    colors: ["white"],
    style: "minimal",
    ocrText: "",
    category: "home",
  };

  // -- Unit: providerConfig() / textModel resolution ------------------------------

  await test("UNIT: production + AI_COPY_TEXT_MODEL unset -> accessing .textModel throws ai_copy_model_unset (503)", async () => {
    const cfg = await withEnv({ LINAPI_KEY: "lin-abc", VERCEL_ENV: "production" }, () => providerConfig());
    let thrown: unknown;
    try {
      void cfg.textModel;
    } catch (e) {
      thrown = e;
    }
    assert(thrown instanceof CopyError, "throws a CopyError, not a bare Error");
    const err = thrown as InstanceType<typeof CopyError>;
    assertEq(err.code, "ai_copy_model_unset", "code");
    assertEq(err.status, 503, "http status");
    assert(typeof err.userMessage === "string" && err.userMessage.length > 0, "carries a user-safe message");
  });

  await test("UNIT: providerConfig() itself does NOT throw in production + unset (lazy - only .textModel access throws)", async () => {
    // Callers that never touch .textModel (analyze, quality-judge routes) must be
    // completely unaffected by this change.
    const cfg = await withEnv({ LINAPI_KEY: "lin-abc", VERCEL_ENV: "production" }, () => providerConfig());
    assertEq(cfg.provider, "linapi", "cfg resolves normally");
    assert(typeof cfg.visionModel === "string" && cfg.visionModel.length > 0, "visionModel resolves normally, no throw");
  });

  await test("UNIT: production + AI_COPY_TEXT_MODEL set -> uses it, no throw", async () => {
    const cfg = await withEnv(
      { LINAPI_KEY: "lin-abc", VERCEL_ENV: "production", AI_COPY_TEXT_MODEL: "prod-text-model-1" },
      () => providerConfig(),
    );
    assertEq(cfg.textModel, "prod-text-model-1", "explicit model used, not the hardcoded fallback");
  });

  await test("UNIT: non-production + AI_COPY_TEXT_MODEL unset -> falls back to the hardcoded default (unchanged)", async () => {
    const cfgLinapi = await withEnv({ LINAPI_KEY: "lin-abc" }, () => providerConfig()); // VERCEL_ENV unset => not production
    assertEq(cfgLinapi.textModel, "gemini-2.5-flash", "linapi fallback unchanged outside prod");
    const cfgOpenai = await withEnv({ OPENAI_API_KEY: "sk-abc" }, () => providerConfig());
    assertEq(cfgOpenai.textModel, "gpt-4o-mini", "openai fallback unchanged outside prod");
  });

  await test("UNIT: preview VERCEL_ENV (not literally production) is treated as non-production -> fallback used", async () => {
    const cfg = await withEnv({ LINAPI_KEY: "lin-abc", VERCEL_ENV: "preview" }, () => providerConfig());
    assertEq(cfg.textModel, "gemini-2.5-flash", "only VERCEL_ENV === production triggers fail-closed");
  });

  await test("UNIT: visionModel is unaffected by an unset AI_COPY_TEXT_MODEL in production (vision left alone)", async () => {
    const cfg = await withEnv({ LINAPI_KEY: "lin-abc", VERCEL_ENV: "production" }, () => providerConfig());
    assertEq(cfg.visionModel, "gemini-2.5-flash", "vision keeps its own (multi-source) fallback chain, no throw");
  });

  // -- Codex round 5: a NONBLANK but implausible id must behave exactly like unset --
  await test("UNIT: production + IMPLAUSIBLE AI_COPY_TEXT_MODEL (embedded space) -> accessing .textModel throws ai_copy_model_unset (503)", async () => {
    const cfg = await withEnv({ LINAPI_KEY: "lin-abc", VERCEL_ENV: "production", AI_COPY_TEXT_MODEL: "not a model" }, () => providerConfig());
    let thrown: unknown;
    try { void cfg.textModel; } catch (e) { thrown = e; }
    assert(thrown instanceof CopyError, "throws a CopyError");
    const err = thrown as { code: string; status: number };
    assertEq(err.code, "ai_copy_model_unset", "same code as unset — one fail-closed path");
    assertEq(err.status, 503, "http status");
  });

  await test("UNIT: production + 121-char AI_COPY_TEXT_MODEL -> throws ai_copy_model_unset", async () => {
    const cfg = await withEnv({ LINAPI_KEY: "lin-abc", VERCEL_ENV: "production", AI_COPY_TEXT_MODEL: "a".repeat(121) }, () => providerConfig());
    let thrown: unknown;
    try { void cfg.textModel; } catch (e) { thrown = e; }
    assert(thrown instanceof CopyError, "throws a CopyError");
    assertEq((thrown as { code: string }).code, "ai_copy_model_unset", "code");
  });

  await test("UNIT: production + plausible-but-unusual id (slash/colon) -> used as-is (no allow-list)", async () => {
    const cfg = await withEnv({ LINAPI_KEY: "lin-abc", VERCEL_ENV: "production", AI_COPY_TEXT_MODEL: "openai/gpt-4o-mini:latest" }, () => providerConfig());
    assertEq(cfg.textModel, "openai/gpt-4o-mini:latest", "syntactically plausible ids pass; semantic validity is the provider's call");
  });

  await test("UNIT: non-production + IMPLAUSIBLE AI_COPY_TEXT_MODEL -> falls back to the hardcoded default", async () => {
    const cfg = await withEnv({ LINAPI_KEY: "lin-abc", AI_COPY_TEXT_MODEL: "not a model" }, () => providerConfig());
    assertEq(cfg.textModel, "gemini-2.5-flash", "outside production an implausible id falls back (with a log), never throws");
  });

  // -- Integration: the actual text-generation call site never reaches the provider -

  const realFetch = global.fetch;
  let fetchCalls = 0;
  async function withFetchSpy<T>(fn: () => Promise<T>): Promise<T> {
    fetchCalls = 0;
    // Never forwards to the real network - hermetic. If code reaches fetch when it
    // should not have, this throws too (chatJson wraps it into a provider_network_error
    // CopyError), so a bug here fails LOUDLY rather than making a real network call.
    global.fetch = (async () => {
      fetchCalls++;
      throw new Error("fetch must not be called - the model-unset guard must fire first");
    }) as typeof fetch;
    try {
      return await fn();
    } finally {
      global.fetch = realFetch;
    }
  }

  await test("INTEGRATION: production + unset -> generateCopyFromAnalysis throws 503, ZERO provider seam calls", async () => {
    await withEnv({ LINAPI_KEY: "lin-abc", VERCEL_ENV: "production" }, async () => {
      const cfg = providerConfig();
      let thrown: unknown;
      await withFetchSpy(async () => {
        try {
          await generateCopyFromAnalysis({
            cfg,
            analysis: analysisStub,
            recommendedKeywords: [],
            language: "en",
            mode: "initial",
          });
        } catch (e) {
          thrown = e;
        }
      });
      assert(thrown instanceof CopyError, "throws a CopyError");
      const err = thrown as InstanceType<typeof CopyError>;
      assertEq(err.code, "ai_copy_model_unset", "code");
      assertEq(err.status, 503, "http status");
      assertEq(fetchCalls, 0, "zero provider seam (fetch) calls - the throw fires before any network call");
    });
  });

  await test("INTEGRATION: production + set -> generateCopyFromAnalysis proceeds to the provider seam", async () => {
    await withEnv({ LINAPI_KEY: "lin-abc", VERCEL_ENV: "production", AI_COPY_TEXT_MODEL: "prod-text-model-1" }, async () => {
      const cfg = providerConfig();
      await withFetchSpy(async () => {
        let thrown: unknown;
        try {
          await generateCopyFromAnalysis({
            cfg,
            analysis: analysisStub,
            recommendedKeywords: [],
            language: "en",
            mode: "initial",
          });
        } catch (e) {
          thrown = e;
        }
        // The fetch spy itself throws (hermetic - no real network), so the call is
        // expected to fail too, but via the PROVIDER seam, not the model-unset guard.
        assert(thrown instanceof CopyError, "still throws (fetch spy rejects), but past the guard");
        assert((thrown as InstanceType<typeof CopyError>).code !== "ai_copy_model_unset", "did NOT hit the model-unset guard");
      });
      assertEq(fetchCalls, 1, "the provider seam WAS reached exactly once");
    });
  });

  // -- ROUTE-LEVEL: the vision-fallback branch is covered too (fix #1) ------------

  await test(
    "ROUTE (vision-fallback, no cached analysis): production + unset -> 503 ai_copy_model_unset, ZERO provider calls",
    async () => {
      resetRouteSeen();
      await withEnv({ LINAPI_KEY: "lin-abc", VERCEL_ENV: "production" }, async () => {
        const { res, json } = await postAiCopy(visionFallbackBody());
        assertEq(res.status, 503, "http status");
        assertEq(json.error, "ai_copy_model_unset", "error code");
        assertEq(json.ok, false, "ok flag");
      });
      assertEq(routeSeen.analyzeAndWriteCopyCalls, 0, "analyzeAndWriteCopy never called");
      assertEq(routeSeen.analyzeImageStructuredCalls, 0, "analyzeImageStructured never called");
      assertEq(routeSeen.chatJsonCalls, 0, "chatJson never called");
      assertEq(routeSeen.generateCopyFromAnalysisCalls, 0, "generateCopyFromAnalysis never called (fast path not taken)");
    },
  );

  await test(
    "ROUTE (fast path, cached analysis): production + unset -> 503 ai_copy_model_unset, ZERO provider calls",
    async () => {
      // The fast path was already covered indirectly (generateCopyFromAnalysis reads
      // .textModel internally) — pinned here too so both branches have an explicit
      // route-level case side by side.
      resetRouteSeen();
      await withEnv({ LINAPI_KEY: "lin-abc", VERCEL_ENV: "production" }, async () => {
        const { res, json } = await postAiCopy(fastPathBody());
        assertEq(res.status, 503, "http status");
        assertEq(json.error, "ai_copy_model_unset", "error code");
      });
      assertEq(routeSeen.generateCopyFromAnalysisCalls, 0, "generateCopyFromAnalysis never called");
    },
  );

  await test(
    "ROUTE (vision-fallback): production + IMPLAUSIBLE AI_COPY_TEXT_MODEL -> 503 ai_copy_model_unset, ZERO provider calls (Codex round 5)",
    async () => {
      resetRouteSeen();
      await withEnv({ LINAPI_KEY: "lin-abc", VERCEL_ENV: "production", AI_COPY_TEXT_MODEL: "not a model" }, async () => {
        const { res, json } = await postAiCopy(visionFallbackBody());
        assertEq(res.status, 503, "http status");
        assertEq(json.error, "ai_copy_model_unset", "error code");
      });
      assertEq(routeSeen.analyzeAndWriteCopyCalls, 0, "analyzeAndWriteCopy never called");
      assertEq(routeSeen.analyzeImageStructuredCalls, 0, "analyzeImageStructured never called");
      assertEq(routeSeen.chatJsonCalls, 0, "chatJson never called");
      assertEq(routeSeen.generateCopyFromAnalysisCalls, 0, "generateCopyFromAnalysis never called");
    },
  );

  await test("ROUTE (vision-fallback): production + AI_COPY_TEXT_MODEL set -> proceeds (200)", async () => {
    resetRouteSeen();
    await withEnv({ LINAPI_KEY: "lin-abc", VERCEL_ENV: "production", AI_COPY_TEXT_MODEL: "prod-text-model-1" }, async () => {
      const { res, json } = await postAiCopy(visionFallbackBody());
      assertEq(res.status, 200, "http status");
      assertEq(json.ok, true, "ok flag");
    });
    assertEq(routeSeen.analyzeAndWriteCopyCalls, 1, "vision-fallback seam reached exactly once");
  });

  await test("ROUTE (fast path): production + AI_COPY_TEXT_MODEL set -> proceeds (200)", async () => {
    resetRouteSeen();
    await withEnv({ LINAPI_KEY: "lin-abc", VERCEL_ENV: "production", AI_COPY_TEXT_MODEL: "prod-text-model-1" }, async () => {
      const { res, json } = await postAiCopy(fastPathBody());
      assertEq(res.status, 200, "http status");
      assertEq(json.ok, true, "ok flag");
    });
    assertEq(routeSeen.generateCopyFromAnalysisCalls, 1, "fast-path seam reached exactly once");
    assertEq(routeSeen.generateCopyFromAnalysisModels[0], "prod-text-model-1", "the configured model was used");
  });

  await test("ROUTE (vision-fallback): non-production + unset -> proceeds with the hardcoded fallback (200)", async () => {
    resetRouteSeen();
    await withEnv({ LINAPI_KEY: "lin-abc" }, async () => {
      // VERCEL_ENV unset => not production.
      const { res, json } = await postAiCopy(visionFallbackBody());
      assertEq(res.status, 200, "http status");
      assertEq(json.ok, true, "ok flag");
    });
    assertEq(routeSeen.analyzeAndWriteCopyCalls, 1, "vision-fallback seam reached exactly once");
  });

  await test("ROUTE (fast path): non-production + unset -> proceeds with the hardcoded fallback (200)", async () => {
    resetRouteSeen();
    await withEnv({ LINAPI_KEY: "lin-abc" }, async () => {
      const { res, json } = await postAiCopy(fastPathBody());
      assertEq(res.status, 200, "http status");
      assertEq(json.ok, true, "ok flag");
    });
    assertEq(routeSeen.generateCopyFromAnalysisCalls, 1, "fast-path seam reached exactly once");
    assertEq(routeSeen.generateCopyFromAnalysisModels[0], "gemini-2.5-flash", "the hardcoded linapi fallback was used");
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
