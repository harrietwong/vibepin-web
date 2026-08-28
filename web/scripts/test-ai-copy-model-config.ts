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
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";

export {};

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

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
