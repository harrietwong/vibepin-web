/**
 * AI-copy provider boundary hardening.
 * Run: npx tsx scripts/test-ai-copy-provider-boundary.ts
 *
 * Three invariants at the boundary between our routes and the paid AI provider:
 *
 *  1. STRUCTURED OUTPUT SHAPE — parseJsonLoose accepts ONLY a non-null, non-array
 *     JSON object. An array/scalar/null parses fine but is not the agreed shape; it
 *     used to flow into normalizeVision, silently yield all-empty fields, and fail
 *     the quality gate as `generic_title` — surfacing a misleading 422 ("we couldn't
 *     generate good copy for this image") for what is really an upstream fault. Every
 *     wrong shape must take the provider-facing 502 `provider_unparseable_response`.
 *
 *  2. BASE-URL / CREDENTIAL PAIRING — when LinAPI is the selected provider and
 *     LINAPI_BASE_URL is missing or blank, the base URL must default to the LinAPI
 *     host, never to api.openai.com. Sending a LinAPI key to OpenAI's endpoint is
 *     both a guaranteed 401 and a credential disclosed to the wrong vendor.
 *
 *  3. CLIENT-MODEL ISOLATION (characterization) — the model is resolved SERVER-side
 *     by providerConfig(). None of the three AI routes declare model/modelId/
 *     modelKey/provider in their body types and none spread the request body, so a
 *     client cannot pick the model it spends our money on. There is no production
 *     code that "ignores" those fields because there is nothing to ignore; this test
 *     pins that fact so a future `...body` spread fails loudly here.
 *
 * Fakes are injected through Module._load (same idiom as
 * test-ai-provider-auth-boundary.ts). No network, no DB, no provider key needed.
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
function assertThrowsCopyError(fn: () => unknown, code: string, status: number, msg: string) {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  if (thrown === undefined) throw new Error(`${msg}: expected a throw, got a return value`);
  const err = thrown as { code?: string; status?: number; userMessage?: string };
  assertEq(err.code, code, `${msg}: error code`);
  assertEq(err.status, status, `${msg}: http status`);
  assert(
    typeof err.userMessage === "string" && err.userMessage.length > 0,
    `${msg}: carries a user-safe message`,
  );
}

// ── Env isolation ───────────────────────────────────────────────────────────────
// providerConfig() reads process.env at call time. Each case gets a pristine env so
// no case can leak configuration into the next one.

const AI_ENV_KEYS = [
  "LINAPI_KEY",
  "LINAPI_BASE_URL",
  "OPENAI_API_KEY",
  "AI_COPY_TEXT_MODEL",
  "AI_COPY_VISION_MODEL",
  "LINAPI_ANALYSIS_MODEL",
  "OPENAI_AI_COPY_VISION_MODEL",
] as const;

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of AI_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of AI_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const OPENAI_HOST = "api.openai.com";
const LINAPI_HOST = "api.linapi.net";

// ── Part 3 scaffolding: route loading with a spying visionServer ────────────────
// Wrap the REAL visionServer so pure helpers keep real behaviour; override only
// providerConfig (to a known, server-resolved pair of model names) and the seams
// that would spend money — recording the model each seam was handed.

const seen = {
  textModels: [] as string[],
  visionModels: [] as string[],
  chatJsonModels: [] as string[],
};
function resetSeen() {
  seen.textModels = [];
  seen.visionModels = [];
  seen.chatJsonModels = [];
}

const SERVER_TEXT_MODEL = "test-text";
const SERVER_VISION_MODEL = "test-vision";

type Cfg = { textModel: string; visionModel: string };
const analysisStub = {
  imageSummary: "A test image summary",
  visibleObjects: ["mug"],
  colors: ["white"],
  style: "minimal",
  ocrText: "",
  category: "home",
};
const copyStub = {
  title: "A cozy handmade ceramic mug for slow mornings",
  description: "A cozy handmade ceramic mug photographed on a linen surface, perfect for slow mornings at home.",
  altText: "White ceramic mug on linen",
  ...analysisStub,
  keywords: ["ceramic mug"],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request.includes("server/authUser")) {
    return { getUserIdFromBearerOrCookies: () => Promise.resolve("user-1") };
  }
  if (request.includes("ai-copy/visionServer")) {
    const real = originalLoad.call(this, request, parent, isMain);
    return {
      ...real,
      providerConfig: () => ({
        provider: "test",
        key: "test-key",
        baseUrl: "https://provider.example",
        textModel: SERVER_TEXT_MODEL,
        visionModel: SERVER_VISION_MODEL,
      }),
      fetchImageAsDataUrl: async () => ({ dataUrl: "data:image/png;base64,AAAA", bytes: 4, latencyMs: 1 }),
      chatJson: async (opts: { model: string }) => {
        seen.chatJsonModels.push(opts.model);
        return { title: "Refined title", description: "Refined description" };
      },
      analyzeImageStructured: async (a: { cfg: Cfg }) => {
        seen.visionModels.push(a.cfg.visionModel);
        return { ...analysisStub };
      },
      analyzeAndWriteCopy: async (a: { cfg: Cfg }) => {
        seen.visionModels.push(a.cfg.visionModel);
        return { ...copyStub };
      },
      generateCopyFromAnalysis: async (a: { cfg: Cfg }) => {
        seen.textModels.push(a.cfg.textModel);
        return { ...copyStub };
      },
    };
  }
  if (request.includes("ai-copy/qualityJudgeServer")) {
    return {
      judgeImageQuality: async (a: { cfg: Cfg }) => {
        seen.visionModels.push(a.cfg.visionModel);
        return { scores: { relevance: 4, composition: 4, realism: 4, text: 4, safety: 5 }, reasons: ["internal"] };
      },
    };
  }
  if (request.includes("ai-copy/keywordContext")) {
    return {
      retrievePinterestKeywords: async () => ({ queryTerms: [], candidates: [], recommended: [], rejected: [], poolSize: 0 }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

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
  // Under tsx these dynamic imports resolve through the CJS require cache, keyed on
  // the RESOLVED FILE PATH — a `?x=` cache-buster does nothing. Evict the entry.
  delete require.cache[require.resolve(spec)];
  return import(spec) as Promise<{ POST: (req: Request) => Promise<Response> }>;
}

/** A body each route accepts on its happy path. */
function happyBody(name: RouteName): Record<string, unknown> {
  if (name === "ai-copy") {
    return {
      draftId: "d1",
      imageUrl: "https://cdn.example/img.png",
      language: "en",
      // Cached analysis → fast TEXT path, so the text model is the one exercised.
      imageAnalysis: { status: "ready", ...analysisStub },
      recommendedKeywords: ["ceramic mug"],
    };
  }
  return { draftId: "d1", imageUrl: "https://cdn.example/img.png" };
}

/** Every field name a client might try to use to pick the model it spends our money on. */
const MALICIOUS_MODEL_FIELDS = {
  model: "attacker-model",
  modelId: "attacker-model-id",
  modelKey: "attacker-model-key",
  provider: "attacker-provider",
};

async function callRoute(name: RouteName, extra: Record<string, unknown>) {
  resetSeen();
  const route = await loadRoute(name);
  const res = await route.POST(
    new Request(URLS[name], {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer valid" },
      body: JSON.stringify({ ...happyBody(name), ...extra }),
    }),
  );
  const json = (await res.json()) as { ok?: boolean; error?: string };
  return { res, json };
}

async function main() {
  console.log("\nAI-copy provider boundary hardening\n");

  const vision = await import("../src/lib/ai-copy/visionServer");
  const { parseJsonLoose, providerConfig, normalizeVision, qualityIssues } = vision;

  // ── 1. parseJsonLoose accepts objects only ───────────────────────────────────

  await test("accepts a direct JSON object", () => {
    const out = parseJsonLoose('{"title":"hello","keywords":["a"]}');
    assertEq(out.title, "hello", "title survives");
    assert(Array.isArray(out.keywords), "arrays INSIDE the object are still fine");
  });

  await test("accepts a fenced JSON object (```json … ```)", () => {
    const out = parseJsonLoose('```json\n{"title":"fenced"}\n```');
    assertEq(out.title, "fenced", "unfenced and parsed");
  });

  await test("accepts a bare-fenced JSON object (``` … ```)", () => {
    assertEq(parseJsonLoose('```\n{"title":"bare"}\n```').title, "bare", "title");
  });

  await test("accepts a salvaged object (prose around first-{ / last-})", () => {
    const out = parseJsonLoose('Sure! Here is your copy:\n{"title":"salvaged","description":"d"}\nHope that helps.');
    assertEq(out.title, "salvaged", "salvaged from surrounding prose");
    assertEq(out.description, "d", "description survives salvage");
  });

  await test("accepts a nested object via salvage (last-} not first-})", () => {
    const out = parseJsonLoose('noise {"a":{"b":1},"c":2} tail');
    assertEq((out.c as number), 2, "outermost object captured");
  });

  // The regression: each of these PARSES successfully, so the old code returned it.
  for (const [label, payload] of [
    ["array", "[1,2]"],
    ["array of objects", '[{"title":"x"}]'],
    ["empty array", "[]"],
    ["string scalar", '"just a string"'],
    ["number scalar", "42"],
    ["boolean scalar", "true"],
    ["null", "null"],
  ] as const) {
    await test(`rejects ${label} with a 502 provider error`, () => {
      assertThrowsCopyError(
        () => parseJsonLoose(payload),
        "provider_unparseable_response",
        502,
        `${label} must not reach normalization`,
      );
    });
  }

  await test("rejects a fenced array (the fenced path is guarded too)", () => {
    assertThrowsCopyError(() => parseJsonLoose('```json\n[1,2]\n```'), "provider_unparseable_response", 502, "fenced array");
  });

  await test("rejects unparseable garbage with the same 502", () => {
    assertThrowsCopyError(() => parseJsonLoose("not json at all"), "provider_unparseable_response", 502, "garbage");
    assertThrowsCopyError(() => parseJsonLoose(""), "provider_unparseable_response", 502, "empty string");
  });

  await test("rejects a malformed brace span as 502, not a raw SyntaxError", () => {
    // first-{ / last-} exists but the span is invalid JSON. The old salvage branch
    // let JSON.parse throw a bare SyntaxError, which is NOT a CopyError and so would
    // not have carried the 502 + user-safe message to the route.
    assertThrowsCopyError(
      () => parseJsonLoose('prefix { not : valid json } suffix'),
      "provider_unparseable_response",
      502,
      "malformed brace span",
    );
  });

  await test("the 502 classification is what the route surfaces (not a 422)", () => {
    // Route-facing contract: CopyError.status is returned verbatim by all three
    // routes, so a non-object provider response is a provider fault (502), never the
    // "bad image / quality gate" 422 the user used to see.
    let err: { status?: number; code?: string } | undefined;
    try { parseJsonLoose("[1,2]"); } catch (e) { err = e as typeof err; }
    assertEq(err?.status, 502, "status is provider-facing");
    assert(err?.status !== 422, "must NOT be the image/quality-gate status");
    assert(err?.code?.startsWith("provider_"), "code is provider-namespaced");
  });

  await test("demonstrates the old failure mode is gone (array → empty copy → generic_title)", () => {
    // What USED to happen: the array flowed on, normalizeVision emptied every field,
    // and the quality gate reported generic_title → a misleading 422 to the user.
    const wouldHaveBeen = normalizeVision([1, 2] as never);
    assertEq(wouldHaveBeen.title, "", "normalization yields an empty title");
    assert(qualityIssues(wouldHaveBeen).includes("generic_title"), "which the quality gate calls generic_title");
    // Now unreachable: the parser rejects the array before normalization.
    assertThrowsCopyError(() => parseJsonLoose("[1,2]"), "provider_unparseable_response", 502, "guarded upstream");
  });

  // ── 2. LinAPI base-URL fallback never points at OpenAI ────────────────────────

  await test("LinAPI key + explicit base URL → that base URL is used", () => {
    const cfg = withEnv({ LINAPI_KEY: "lin-abc", LINAPI_BASE_URL: "https://custom.example/v1" }, providerConfig);
    assertEq(cfg.provider, "linapi", "provider");
    assertEq(cfg.baseUrl, "https://custom.example/v1", "explicit base URL wins");
  });

  await test("LinAPI key + explicit base URL with trailing slash → normalized", () => {
    const cfg = withEnv({ LINAPI_KEY: "lin-abc", LINAPI_BASE_URL: "https://custom.example/v1/" }, providerConfig);
    assertEq(cfg.baseUrl, "https://custom.example/v1", "trailing slash stripped");
  });

  await test("LinAPI key + MISSING base URL → LinAPI host, never OpenAI", () => {
    const cfg = withEnv({ LINAPI_KEY: "lin-abc" }, providerConfig);
    assertEq(cfg.provider, "linapi", "provider");
    assert(cfg.baseUrl.includes(LINAPI_HOST), `base URL points at LinAPI (got ${cfg.baseUrl})`);
    assert(!cfg.baseUrl.includes(OPENAI_HOST), "LinAPI credentials must NEVER be sent to OpenAI's endpoint");
  });

  await test("LinAPI key + BLANK base URL → LinAPI host, never OpenAI", () => {
    const cfg = withEnv({ LINAPI_KEY: "lin-abc", LINAPI_BASE_URL: "" }, providerConfig);
    assert(cfg.baseUrl.includes(LINAPI_HOST), `base URL points at LinAPI (got ${cfg.baseUrl})`);
    assert(!cfg.baseUrl.includes(OPENAI_HOST), "blank must not fall through to OpenAI");
  });

  await test("LinAPI key + WHITESPACE base URL → LinAPI host, never OpenAI", () => {
    const cfg = withEnv({ LINAPI_KEY: "lin-abc", LINAPI_BASE_URL: "   " }, providerConfig);
    assert(cfg.baseUrl.includes(LINAPI_HOST), `base URL points at LinAPI (got ${cfg.baseUrl})`);
    assert(!cfg.baseUrl.includes(OPENAI_HOST), "whitespace must not fall through to OpenAI");
    assertEq(cfg.baseUrl.trim(), cfg.baseUrl, "no stray whitespace in the base URL");
  });

  await test("LinAPI fallback host matches the rest of the repo", () => {
    // web/.env.example, backend/.env.example, api/.env.example, lib/support/* and
    // api/generate all use https://api.linapi.net/v1.
    const cfg = withEnv({ LINAPI_KEY: "lin-abc" }, providerConfig);
    assertEq(cfg.baseUrl, "https://api.linapi.net/v1", "repo-standard LinAPI base URL");
  });

  await test("OpenAI-only config → OpenAI host", () => {
    const cfg = withEnv({ OPENAI_API_KEY: "sk-abc" }, providerConfig);
    assertEq(cfg.provider, "openai", "provider");
    assertEq(cfg.baseUrl, "https://api.openai.com/v1", "OpenAI base URL");
  });

  await test("OpenAI-only config ignores a stray LINAPI_BASE_URL", () => {
    // LINAPI_BASE_URL is only meaningful when LinAPI is the selected provider.
    const cfg = withEnv({ OPENAI_API_KEY: "sk-abc", LINAPI_BASE_URL: "https://custom.example/v1" }, providerConfig);
    assertEq(cfg.provider, "openai", "provider");
    assertEq(cfg.baseUrl, "https://api.openai.com/v1", "OpenAI key keeps the OpenAI host");
  });

  await test("LinAPI key wins over an OpenAI key (provider selection unchanged)", () => {
    const cfg = withEnv({ LINAPI_KEY: "lin-abc", OPENAI_API_KEY: "sk-abc" }, providerConfig);
    assertEq(cfg.provider, "linapi", "linapi takes precedence");
    assertEq(cfg.key, "lin-abc", "the LinAPI key is the one used");
    assert(!cfg.baseUrl.includes(OPENAI_HOST), "and it is not sent to OpenAI");
  });

  await test("no credentials → provider none, no crash", () => {
    const cfg = withEnv({}, providerConfig);
    assertEq(cfg.provider, "none", "provider");
    assertEq(cfg.key, "", "no key");
  });

  await test("env is restored between cases (no leakage)", () => {
    withEnv({ LINAPI_KEY: "leak-check", LINAPI_BASE_URL: "https://leak.example/v1" }, () => {});
    assertEq(process.env.LINAPI_KEY, undefined, "LINAPI_KEY restored to its pre-test (unset) value");
    assertEq(process.env.LINAPI_BASE_URL, undefined, "LINAPI_BASE_URL restored");
  });

  await test("vision fallback chain is intact (not collapsed)", () => {
    assertEq(withEnv({ LINAPI_KEY: "k", AI_COPY_VISION_MODEL: "a" }, providerConfig).visionModel, "a", "explicit wins");
    assertEq(withEnv({ LINAPI_KEY: "k", LINAPI_ANALYSIS_MODEL: "b" }, providerConfig).visionModel, "b", "LINAPI_ANALYSIS_MODEL");
    assertEq(withEnv({ LINAPI_KEY: "k", OPENAI_AI_COPY_VISION_MODEL: "c" }, providerConfig).visionModel, "c", "OPENAI_AI_COPY_VISION_MODEL");
    assertEq(withEnv({ LINAPI_KEY: "k" }, providerConfig).visionModel, "gemini-2.5-flash", "linapi default");
    assertEq(withEnv({ OPENAI_API_KEY: "k" }, providerConfig).visionModel, "gpt-4o-mini", "openai default");
  });

  await test("text model resolves from AI_COPY_TEXT_MODEL with provider defaults", () => {
    assertEq(withEnv({ LINAPI_KEY: "k", AI_COPY_TEXT_MODEL: "t" }, providerConfig).textModel, "t", "explicit");
    assertEq(withEnv({ LINAPI_KEY: "k" }, providerConfig).textModel, "gemini-2.5-flash", "linapi default");
    assertEq(withEnv({ OPENAI_API_KEY: "k" }, providerConfig).textModel, "gpt-4o-mini", "openai default");
  });

  // ── 3. Client-supplied model fields cannot influence the model used ───────────
  // Characterization: no production code strips these — the routes simply never read
  // them. These tests fail the moment someone adds a `...body` spread or a model field.

  await test("ai-copy: malicious model fields → server-resolved TEXT model still used", async () => {
    const { res, json } = await callRoute("ai-copy", MALICIOUS_MODEL_FIELDS);
    assertEq(res.status, 200, "status");
    assertEq(json.ok, true, "ok flag");
    assertEq(seen.textModels.length, 1, "one copy call");
    assertEq(seen.textModels[0], SERVER_TEXT_MODEL, "server-resolved model");
    assert(
      ![...seen.textModels, ...seen.visionModels, ...seen.chatJsonModels].some(m =>
        Object.values(MALICIOUS_MODEL_FIELDS).includes(m),
      ),
      "no attacker-supplied value reached the provider",
    );
  });

  await test("analyze: malicious model fields → server-resolved VISION model still used", async () => {
    const { res, json } = await callRoute("analyze", MALICIOUS_MODEL_FIELDS);
    assertEq(res.status, 200, "status");
    assertEq(json.ok, true, "ok flag");
    assertEq(seen.visionModels.length, 1, "one vision call");
    assertEq(seen.visionModels[0], SERVER_VISION_MODEL, "server-resolved model");
  });

  await test("quality-judge: malicious model fields → server-resolved VISION model still used", async () => {
    const { res, json } = await callRoute("quality-judge", MALICIOUS_MODEL_FIELDS);
    assertEq(res.status, 200, "status");
    assertEq(json.ok, true, "ok flag");
    assertEq(seen.visionModels.length, 1, "one judge call");
    assertEq(seen.visionModels[0], SERVER_VISION_MODEL, "server-resolved model");
  });

  await test("analyze: the echoed analysis.model is the server model, not the client's", async () => {
    const route = await loadRoute("analyze");
    const res = await route.POST(
      new Request(URLS.analyze, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer valid" },
        body: JSON.stringify({ ...happyBody("analyze"), ...MALICIOUS_MODEL_FIELDS }),
      }),
    );
    const json = (await res.json()) as { analysis?: { model?: string } };
    assertEq(json.analysis?.model, SERVER_VISION_MODEL, "echoed model is server-resolved");
  });

  await test("ai-copy: a model field cannot divert the VISION fallback path either", async () => {
    // No cached analysis → vision one-call fallback. Still the server's vision model.
    const { res } = await callRoute("ai-copy", { ...MALICIOUS_MODEL_FIELDS, imageAnalysis: undefined, recommendedKeywords: undefined });
    assertEq(res.status, 200, "status");
    assertEq(seen.visionModels.length, 1, "vision fallback taken");
    assertEq(seen.visionModels[0], SERVER_VISION_MODEL, "server-resolved vision model");
    assertEq(seen.textModels.length, 0, "text path not taken");
  });

  await test("no AI route body type declares a client-selectable model field", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    // Source-level guard: the body TYPE is the contract. If a model field is ever
    // added to it, this fails even if the handler happens not to read it yet.
    for (const spec of Object.values(ROUTES)) {
      const file = path.resolve(__dirname, `${spec}.ts`);
      const src = fs.readFileSync(file, "utf8");
      // The body type block: from `type RequestBody = {` / `type Body = {` to its close.
      const m = src.match(/type (?:RequestBody|Body) = \{[\s\S]*?\n\};/);
      assert(m, `${spec}: found a request body type`);
      const bodyType = m![0];
      for (const field of ["model", "modelId", "modelKey", "provider"]) {
        assert(
          !new RegExp(`(^|[^A-Za-z])${field}\\??\\s*:`, "m").test(bodyType),
          `${spec}: request body type must not declare "${field}" (the model is server-resolved)`,
        );
      }
    }
  });

  await test("no AI route spreads the raw request body into a provider call", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const spec of Object.values(ROUTES)) {
      const file = path.resolve(__dirname, `${spec}.ts`);
      const src = fs.readFileSync(file, "utf8");
      assert(
        !/\.\.\.\s*body\b/.test(src),
        `${spec}: must not spread the request body (that would let a client inject provider params)`,
      );
    }
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
