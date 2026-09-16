import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildAICopyV2AnalyzePayload,
  AICopyV2ClientError,
  generatePinterestPinCopyV2,
  isAICopyV2ClientEnabled,
  keywordProvenanceLabel,
  shouldConfirmAICopyV2Overwrite,
} from "../src/lib/ai-copy/generatePinCopyV2";
import { generatePinterestPinCopy, isRateLimitError, isTextLimitReachedError } from "../src/lib/ai-copy/generatePinCopy";

async function main() {
  assert.equal(isAICopyV2ClientEnabled("true"), true);
  assert.equal(isAICopyV2ClientEnabled("false"), false);
  assert.equal(isAICopyV2ClientEnabled(undefined), false);
  assert.equal(keywordProvenanceLabel("official"), "Official");
  assert.equal(keywordProvenanceLabel("estimated"), "Estimated");
  assert.equal(keywordProvenanceLabel("unknown"), "Data unknown");
  assert.equal(shouldConfirmAICopyV2Overwrite(["Existing title"], true), true);
  assert.equal(shouldConfirmAICopyV2Overwrite(["Existing title"], false), false, "flag-off Batch keeps the legacy no-confirm behavior");
  assert.equal(shouldConfirmAICopyV2Overwrite(["", "  ", undefined], true), false);

  const originalClientFlag = process.env.NEXT_PUBLIC_AI_COPY_V2;
  const originalFetch = globalThis.fetch;
  let legacyBody: Record<string, unknown> = {};
  process.env.NEXT_PUBLIC_AI_COPY_V2 = "false";
  globalThis.fetch = (async (_input, init) => {
    legacyBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({
      ok: true,
      output: { title: "Legacy title", description: "Legacy description", altText: "Legacy alt", tags: [] },
      context: { keywordContext: [] },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await generatePinterestPinCopy({
      draftId: "legacy-flag-off", imageUrl: "https://example.test/legacy.png", language: "en",
      imageAnalysis: { imageSummary: "A lamp", visibleObjects: ["lamp"], colors: ["white"], style: "minimal", ocrText: "", category: "decor" },
    });
    assert.equal("country" in legacyBody, false, "flag-off legacy request does not gain a default country");
  } finally {
    if (originalClientFlag == null) delete process.env.NEXT_PUBLIC_AI_COPY_V2;
    else process.env.NEXT_PUBLIC_AI_COPY_V2 = originalClientFlag;
    globalThis.fetch = originalFetch;
  }

  const payload = buildAICopyV2AnalyzePayload({
    draftId: "draft-1", locale: "en", country: "us", idempotencyKey: "analyze-1",
    product: { title: "Oak desk", category: "Furniture", vendor: "Acme", price: "USD 99", availability: "in stock", tags: ["office"] },
    image: { imageSummary: "A desk in a bright office", visibleObjects: ["desk"], colors: ["brown"], style: "minimal", ocrText: "", category: "office" },
    board: { name: "Home office", description: "Workspace ideas" },
    userKeywords: ["desk setup"],
  });
  assert.equal(payload.country, "US");
  assert.equal(payload.productContext?.productType, "Furniture");
  assert.equal(payload.imageObserved?.summary, "A desk in a bright office");
  assert.deepEqual(payload.userKeywords, ["desk setup"]);
  assert.ok(!("userId" in payload), "client payload never accepts identity");

  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input); const body = JSON.parse(String(init?.body ?? "{}")); calls.push({ url, body });
    if (url.endsWith("/analyze")) return new Response(JSON.stringify({
      ok: true, sessionId: "session-1", degradedMode: "none",
      factCard: { version: "fact-card-v1", sessionId: "session-1", draftId: "draft-1", locale: "en", facts: [{ id: "f1", key: "product_title", value: "Oak desk", source: "product_catalog", trustLevel: "asserted", claimPolicy: "copy_allowed" }] },
      keywordEvidence: { keywordSetId: "ks1", candidates: [
        { id: "kw1", phrase: "home office ideas", provenance: "official", relevanceEvidence: [], status: "accepted" },
        { id: "kw2", phrase: "desk setup", provenance: "estimated", relevanceEvidence: [], status: "accepted" },
      ], selectedKeywordIds: ["kw1", "kw2"], degradedMode: "none" },
    }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ ok: true, result: {
      generationId: "gen-1", sessionId: "session-1", draftId: "draft-1", angleId: "default", keywordSetId: "ks1",
      title: "Oak Desk Ideas", description: "Create a calm home office.", altText: "Oak desk in a bright office", usedKeywordIds: ["kw1"],
      factSummary: [{ factId: "f1", key: "product_title", value: "Oak desk", source: "product_catalog", trustLevel: "asserted" }],
      degradedMode: "none", validationReport: { valid: true, issues: [] },
    } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const stages: string[] = [];
  const result = await generatePinterestPinCopyV2({
    draftId: "draft-1", locale: "en", country: "US", length: "standard",
    product: { title: "Oak desk", category: "Furniture" }, image: null,
    board: { name: "Home office" }, userKeywords: ["desk setup"], fetcher: fakeFetch,
    createId: (() => { const ids = ["analyze-1", "generate-1"]; return () => ids.shift()!; })(),
    onStage: stage => stages.push(stage),
  });
  assert.deepEqual(calls.map(c => c.url), ["/api/ai-copy/v2/analyze", "/api/ai-copy/v2/generate"]);
  assert.ok(!("userId" in calls[0].body));
  assert.deepEqual(stages, ["analyzing", "generating", "checking"]);
  assert.equal(result.fields.title, "Oak Desk Ideas");
  assert.equal(result.evidence.primaryKeyword?.label, "Official");
  assert.deepEqual(result.evidence.selectedKeywords.map(keyword => keyword.id), ["kw1"], "evidence reports only keywords actually present in generated copy");
  assert.equal(result.evidence.validationReport.valid, true);

  const fallbackCalls: string[] = [];
  const fallbackFetch: typeof fetch = async (input, init) => {
    const url = String(input); fallbackCalls.push(url);
    if (url === "/api/ai-copy/analyze") return new Response(JSON.stringify({ ok: true, analysis: { imageSummary: "A blue chair", visibleObjects: ["chair"], colors: ["blue"], style: "modern", ocrText: "", category: "decor" } }), { status: 200 });
    if (url.endsWith("/v2/analyze")) {
      const body = JSON.parse(String(init?.body)); assert.equal(body.imageObserved.summary, "A blue chair");
      return new Response(JSON.stringify({ ok: true, sessionId: "session-fallback", factCard: { version: "fact-card-v1", sessionId: "session-fallback", draftId: "draft-fallback", locale: "en", facts: [] }, keywordEvidence: { keywordSetId: "ks", candidates: [], selectedKeywordIds: [], degradedMode: "no_keyword_demand_data" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: { generationId: "g", sessionId: "session-fallback", draftId: "draft-fallback", angleId: "default", keywordSetId: "ks", title: "Blue Chair", description: "A modern chair idea.", altText: "Blue chair", usedKeywordIds: [], factSummary: [], degradedMode: "no_keyword_demand_data", validationReport: { valid: true, issues: [] } } }), { status: 200 });
  };
  await generatePinterestPinCopyV2({ draftId: "draft-fallback", locale: "en", image: null, imageUrl: "https://example.test/chair.jpg", fetcher: fallbackFetch, createId: () => "idem" });
  assert.deepEqual(fallbackCalls, ["/api/ai-copy/analyze", "/api/ai-copy/v2/analyze", "/api/ai-copy/v2/generate"], "missing cached analysis uses the existing vision preprocessor before v2");

  const degradedFetch: typeof fetch = async input => {
    if (String(input).endsWith("/analyze")) return new Response(JSON.stringify({
      ok: true, sessionId: "session-2",
      factCard: { version: "fact-card-v1", sessionId: "session-2", draftId: "draft-2", locale: "zh-CN", facts: [] },
      keywordEvidence: { keywordSetId: "ks2", candidates: [], selectedKeywordIds: [], degradedMode: "no_keyword_demand_data" },
    }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, result: {
      generationId: "gen-2", sessionId: "session-2", draftId: "draft-2", angleId: "default", keywordSetId: "ks2",
      title: "书桌布置灵感", description: "为工作区营造整洁氛围。", altText: "明亮工作区中的书桌", usedKeywordIds: [], factSummary: [],
      degradedMode: "no_keyword_demand_data", validationReport: { valid: true, issues: [] },
    } }), { status: 200 });
  };
  const degraded = await generatePinterestPinCopyV2({ draftId: "draft-2", locale: "zh-CN", image: null, fetcher: degradedFetch, createId: () => "idem" });
  assert.equal(degraded.evidence.primaryKeyword, undefined);
  assert.equal(degraded.evidence.degradedMode, "no_keyword_demand_data");

  const failedFetch: typeof fetch = async () => new Response(JSON.stringify({ ok: false }), { status: 502 });
  await assert.rejects(
    generatePinterestPinCopyV2({ draftId: "draft-3", locale: "en", image: null, fetcher: failedFetch, createId: () => "idem" }),
    /grounded copy right now/,
  );

  const v2FailureFetch = (status: number, payload: Record<string, unknown>, retryAfter?: string): typeof fetch => async input => {
    if (String(input).endsWith("/analyze")) return new Response(JSON.stringify({
      ok: true, sessionId: "session-error", factCard: { version: "fact-card-v1", sessionId: "session-error", draftId: "draft-error", locale: "en", facts: [] },
      keywordEvidence: { keywordSetId: "ks", candidates: [], selectedKeywordIds: [], degradedMode: "no_keyword_demand_data" },
    }), { status: 200 });
    return new Response(JSON.stringify(payload), { status, headers: retryAfter ? { "retry-after": retryAfter } : {} });
  };
  await assert.rejects(
    generatePinterestPinCopyV2({ draftId: "draft-error", locale: "en", image: null, fetcher: v2FailureFetch(429, { ok: false, error: "rate_limited", message: "slow down" }, "17"), createId: () => "id" }),
    error => error instanceof AICopyV2ClientError && error.status === 429 && error.code === "rate_limited" && error.retryAfterSeconds === 17 && isRateLimitError(error),
    "v2 429 preserves structured error and is recognized by shared Batch guard",
  );
  await assert.rejects(
    generatePinterestPinCopyV2({ draftId: "draft-error", locale: "en", image: null, fetcher: v2FailureFetch(402, { ok: false, error: "ai_text_limit_reached", code: "ai_text_limit_reached", userMessage: "limit" }), createId: () => "id" }),
    error => error instanceof AICopyV2ClientError && error.status === 402 && error.code === "ai_text_limit_reached" && error.retryAfterSeconds === null && isTextLimitReachedError(error),
    "v2 402 preserves structured error and stops shared Batch work",
  );

  const legacyAnalyzeLimitedFetch: typeof fetch = async input => {
    assert.equal(String(input), "/api/ai-copy/analyze", "missing cached analysis uses the legacy vision endpoint first");
    return new Response(JSON.stringify({ ok: false, error: "rate_limited", code: "rate_limited", message: "slow down" }), {
      status: 429,
      headers: { "retry-after": "23" },
    });
  };
  await assert.rejects(
    generatePinterestPinCopyV2({ draftId: "legacy-limit", locale: "en", image: null, imageUrl: "https://example.test/image.jpg", fetcher: legacyAnalyzeLimitedFetch, createId: () => "id" }),
    error => error instanceof AICopyV2ClientError && error.status === 429 && error.code === "rate_limited" && error.retryAfterSeconds === 23 && isRateLimitError(error),
    "legacy vision fallback preserves a 429 as the structured Batch-stop error",
  );

  const panel = readFileSync(resolve(process.cwd(), "src/components/pins/PinAICopyPanel.tsx"), "utf8");
  assert.match(panel, /data-testid="ai-copy-v2-evidence"/);
  assert.match(panel, /confirmedReplace/);
  const layout = readFileSync(resolve(process.cwd(), "src/app/app/layout.tsx"), "utf8");
  assert.match(layout, /NEXT_PUBLIC_HIDE_LEGACY_DISCOVERY/);
  assert.match(layout, /keyword-trends/);
  assert.match(layout, /viral-pins/);
  const sharedHelper = readFileSync(resolve(process.cwd(), "src/lib/ai-copy/generatePinCopy.ts"), "utf8");
  assert.match(sharedHelper, /if \(isAICopyV2ClientEnabled\(\)\)/, "v2 branches in the Studio\/Plan\/Batch shared helper");
  assert.match(sharedHelper, /fetch\("\/api\/ai-copy"/, "legacy endpoint remains available when the flag is off");
  assert.match(sharedHelper, /if \(isAICopyV2ClientEnabled\(\)\) \{\s+const country = input\.country \?\? readPinterestRegionFromStorage\(\)/, "v2 uses the user's Pinterest region instead of silently defaulting to US");
  assert.match(sharedHelper, /fetch\("\/api\/ai-copy"[\s\S]*?country: input\.country,/, "flag-off legacy request keeps its original optional country semantics");
  const batch = readFileSync(resolve(process.cwd(), "src/components/studio/BatchEditDrawer.tsx"), "utf8");
  assert.match(batch, /generatePinterestPinCopy\(/, "Batch keeps using the shared helper");
  assert.match(batch, /if \(isTextLimitReachedError\(err\)\) \{\s*textLimitReached = true;\s*break;\s*\}/, "Batch stops immediately on 402 and tracks it independently from rate limiting");
  assert.match(batch, /if \(isRateLimitError\(err\)\) \{\s*rateLimited = true;\s*break;\s*\}/, "Batch keeps the 429 stop path independently");
  assert.match(batch, /if \(textLimitReached\) \{\s*toast\.message\(tr\("studioBoard\.limit\.text\.allUsed"\)\)/, "Batch shows the plan text-limit message for 402 instead of a retry prompt");
  assert.match(batch, /else if \(rateLimited\) \{\s*toast\.message\(tr\("history\.error\.rateLimited\.label"\), \{ description: tr\("studio\.error\.serviceBusy\.body"\) \}\)/, "Batch keeps the retry-oriented 429 message");
  assert.match(batch, /pinsWithExistingCopy/, "Batch detects generated copy that would overwrite existing user copy");
  assert.match(batch, /pinForm\.replaceExistingTitle/, "Batch reuses the explicit overwrite confirmation before generation");
  assert.match(batch, /if \(!isAICopyV2ClientEnabled\(\)\) \{\s+void runGenerateCopyBatch\(\)/, "flag-off Batch preserves the legacy immediate generation path");

  console.log("AI Copy v2 UI/client tests passed");
}

main().catch(error => { console.error(error); process.exit(1); });
