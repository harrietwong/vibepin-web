/**
 * T3 (Amazon URL → copy) — card source + fact-card mapping.
 *
 *  - amazonSourceForUrl / applyAmazonImportResult: fetch results never overwrite the
 *    user's manual fields, never produce title/description/destination patches, a
 *    failed fetch keeps earlier page text, stale responses are ignored
 *  - every failure reason → manual mode; generation gate needs a product name
 *  - buildAmazonCopyContext + buildAICopyV2AnalyzePayload: fetched text is
 *    pageContext (page_metadata), never productContext; no price/availability;
 *    fetched byline brand never becomes vendor; Brand/Material/Size → vendor /
 *    material / quantity exactly like Shopify
 *  - acceptance 4b with the REAL analyze mapping (buildFacts) + REAL validator:
 *    Brand "Stanley" + Size "40 oz" declared → passes; not declared → 422 codes
 *  - generatePinterestPinCopy: failed fetch + no name → refused with 0 requests and
 *    fields unchanged; ready card → generate body carries affiliateDisclosure
 *  - affiliate disclosure gate: v2 disabled + an Amazon card ready to generate is
 *    refused with 0 requests (v1 has no affiliateDisclosure plumbing, so it would
 *    silently ship undisclosed affiliate copy); non-Amazon cards are unaffected
 *
 * Run: npx tsx scripts/test-amazon-copy-mapping.ts
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service";

import assert from "node:assert/strict";

// Minimal window + localStorage shim so the localStorage-backed draft store runs in node.
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
};
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
};

let passed = 0, failed = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}\n    ${(error as Error).stack}`); }
}

const URL_OK = "https://www.amazon.com/Stanley-Tumbler/dp/B0BSHF7WHW?tag=harriet-20&ref_=abc";
const URL_OTHER = "https://www.amazon.com/dp/B07FZ8S74R";
const NOW = "2026-09-24T00:00:00.000Z";

async function main() {
  const src = await import("../src/lib/studio/amazonCardSource");
  const { buildAICopyV2AnalyzePayload } = await import("../src/lib/ai-copy/generatePinCopyV2");
  const gen = await import("../src/lib/ai-copy/generatePinCopy");
  const { buildFacts } = await import("../src/app/api/ai-copy/v2/analyze/analyzeHandler");
  const { createFactCardV1 } = await import("../src/lib/ai-copy/v2/factCard");
  const { validateCopy } = await import("../src/lib/ai-copy/v2/validateCopy");
  const store = await import("../src/lib/pinDraftStore");
  type Source = NonNullable<ReturnType<typeof src.amazonSourceForUrl>>;

  const fresh = (): Source => src.amazonSourceForUrl(URL_OK, undefined, NOW)!;
  const importOk = (extracted: { title?: string; bullets?: string[]; brand?: string }) => ({
    sourceUrl: URL_OK, normalizedUrl: "https://www.amazon.com/dp/B0BSHF7WHW?tag=harriet-20", status: "success",
    amazon: { linkStatus: "ok" as const, host: "amazon.com", marketplace: "US", asin: "B0BSHF7WHW", fetch: { status: "ok" as const }, extracted },
  });
  const importFail = (reason: string, status: "blocked" | "failed" = "failed") => ({
    sourceUrl: URL_OK, status,
    amazon: { linkStatus: "ok" as const, host: "amazon.com", marketplace: "US", asin: "B0BSHF7WHW", fetch: { status, reason: reason as never } },
  });

  console.log("\n[card source]");
  await test("non-Amazon URL → null; retail/short parse into link status", () => {
    assert.equal(src.amazonSourceForUrl("https://example.com/x", undefined), null);
    assert.equal(src.amazonSourceForUrl("", undefined), null);
    const s = fresh();
    assert.equal(s.linkStatus, "ok"); assert.equal(s.asin, "B0BSHF7WHW"); assert.equal(s.pastedUrl, URL_OK);
    assert.equal(s.fetch.status, "not_attempted");
    assert.equal(src.amazonSourceForUrl("https://www.amazon.com/s?k=lamp", undefined)!.linkStatus, "no_asin");
    assert.equal(src.amazonSourceForUrl("https://amzn.to/3abcDEF", undefined)!.linkStatus, "short_unexpanded");
  });
  await test("same URL keeps the source; a new URL keeps manual fields, drops page text", () => {
    let s = fresh();
    s = src.applyAmazonImportResult(s, importOk({ title: "Stanley Quencher", bullets: ["Keeps cold"] }), NOW);
    s = { ...s, manual: { ...s.manual, productName: "My tumbler", size: "40 oz" } };
    assert.equal(src.amazonSourceForUrl(URL_OK, s), s);
    const next = src.amazonSourceForUrl(URL_OTHER, s, NOW)!;
    assert.equal(next.manual.productName, "My tumbler"); assert.equal(next.manual.size, "40 oz");
    assert.equal(next.extracted, undefined); assert.equal(next.fetch.status, "not_attempted");
    assert.equal(next.pastedUrl, URL_OTHER);
  });
  await test("accepting the clean link for the same product keeps fetched data (no refetch)", () => {
    const fetched = src.applyAmazonImportResult({ ...fresh(), manual: { productName: "Mine" } }, importOk({ title: "Stanley Quencher" }), NOW);
    const clean = "https://www.amazon.com/dp/B0BSHF7WHW?tag=harriet-20";
    const next = src.amazonSourceForUrl(clean, fetched, NOW)!;
    assert.equal(next.pastedUrl, clean);
    assert.equal(next.fetch.status, "ok"); assert.equal(next.extracted?.title, "Stanley Quencher");
    assert.equal(next.manual.productName, "Mine");
  });
  await test("amazonClaimHints maps 422 claim codes to the Brand / Material / Size boxes", () => {
    const hints = src.amazonClaimHints({ issues: [
      { code: "UNSUPPORTED_BRAND_CLAIM", message: 'Unsupported brand claim: "Stanley"' },
      { code: "UNSUPPORTED_NUMERIC_CLAIM", message: 'Unsupported numeric_commercial claim: "40 oz"' },
      { code: "UNSUPPORTED_MATERIAL_CLAIM", message: 'Unsupported material claim: "leather"' },
      { code: "TITLE_TOO_LONG", message: "x" },
    ] });
    assert.deepEqual(hints, [{ field: "brand", value: "Stanley" }, { field: "size", value: "40 oz" }, { field: "material", value: "leather" }]);
    assert.deepEqual(src.amazonClaimHints(undefined), []);
  });
  await test("successful fetch fills page text and prefills an EMPTY Brand box only", () => {
    const s = src.applyAmazonImportResult(fresh(), importOk({ title: "Stanley Quencher 40 oz", bullets: ["Keeps cold 11h"], brand: "Stanley" }), NOW);
    assert.deepEqual(s.extracted, { title: "Stanley Quencher 40 oz", bullets: ["Keeps cold 11h"], brand: "Stanley" });
    assert.equal(s.manual.brand, "Stanley", "byline prefilled into the visible Brand box");
    assert.equal(s.manual.productName, undefined, "product name is NOT copied into manual");
    assert.equal(src.amazonCardMode(s).mode, "fetched");
    assert.equal(s.resolvedUrl, "https://www.amazon.com/dp/B0BSHF7WHW?tag=harriet-20");
  });
  await test("user-touched manual fields are never overwritten by a fetch", () => {
    const touched: Source = { ...fresh(), manual: { productName: "My words", sellingPoints: "A\nB", brand: "", material: "Steel", size: "30 oz" } };
    const s = src.applyAmazonImportResult(touched, importOk({ title: "Scraped title", bullets: ["x"], brand: "Stanley" }), NOW);
    assert.deepEqual(s.manual, touched.manual, "manual deep-equal after fetch (cleared Brand stays cleared)");
    const withBrand: Source = { ...fresh(), manual: { brand: "Mine" } };
    assert.equal(src.applyAmazonImportResult(withBrand, importOk({ title: "t", brand: "Stanley" }), NOW).manual.brand, "Mine");
  });
  await test("import patch never carries title / description / destinationUrl", () => {
    const s = src.applyAmazonImportResult(fresh(), importOk({ title: "t", bullets: ["b"] }), NOW) as Record<string, unknown>;
    for (const key of ["title", "description", "destinationUrl", "altText"]) assert.equal(key in s, false, `no ${key}`);
  });
  await test("every failure reason → manual mode, fields untouched, earlier page text kept", () => {
    const ok = src.applyAmazonImportResult({ ...fresh(), manual: { productName: "Mine" } }, importOk({ title: "Earlier" }), NOW);
    const reasons = ["bot_check", "http_error", "timeout", "network_error", "off_allowlist", "too_many_redirects", "no_product_fields", "short_link_unexpanded", "unsupported_marketplace", "not_product_page"];
    for (const reason of reasons) {
      const s = src.applyAmazonImportResult(ok, importFail(reason, reason === "bot_check" ? "blocked" : "failed"), NOW);
      const mode = src.amazonCardMode(s);
      assert.equal(mode.mode, "manual", reason); assert.equal(mode.reason, reason);
      assert.deepEqual(s.manual, ok.manual, `${reason}: manual unchanged`);
      assert.equal(s.extracted?.title, "Earlier", `${reason}: earlier extraction kept`);
    }
    const reqErr = src.applyAmazonImportError(fresh(), NOW);
    assert.equal(src.amazonCardMode(reqErr).mode, "manual");
    const partial = src.applyAmazonImportResult(fresh(), importOk({ bullets: ["only bullets"] }), NOW);
    assert.deepEqual(src.amazonCardMode(partial), { mode: "manual", reason: "no_title" }, "partial → name needed");
  });
  await test("stale response for a URL the card no longer holds is ignored", () => {
    const s = src.amazonSourceForUrl(URL_OTHER, undefined, NOW)!;
    assert.equal(src.applyAmazonImportResult(s, importOk({ title: "wrong product" }), NOW), s);
  });
  await test("generation gate: fetched title or manual name; a cleared name blocks", () => {
    assert.equal(src.canGenerateAmazonCopy(fresh()), false);
    assert.equal(src.canGenerateAmazonCopy(src.applyAmazonImportResult(fresh(), importFail("bot_check", "blocked"), NOW)), false);
    assert.equal(src.canGenerateAmazonCopy(src.applyAmazonImportResult(fresh(), importOk({ title: "T" }), NOW)), true);
    assert.equal(src.canGenerateAmazonCopy({ ...fresh(), manual: { productName: "  Tumbler " } }), true);
    const cleared = { ...src.applyAmazonImportResult(fresh(), importOk({ title: "T" }), NOW), manual: { productName: "" } };
    assert.equal(src.canGenerateAmazonCopy(cleared), false, "user cleared the prefilled name on purpose");
  });

  console.log("\n[card import runner]");
  const { runAmazonCardImport } = await import("../src/lib/studio/amazonCardImport");
  await test("runner: blocked result → manual mode persisted; only amazonSource written; in-flight manual edits kept", async () => {
    let stored: Source = fresh();
    const persisted: Source[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const run = runAmazonCardImport({
      getSource: () => stored,
      persist: next => { persisted.push(next); stored = next; },
      importFn: async urls => { assert.deepEqual(urls, [URL_OK]); await gate; return { results: [importFail("bot_check", "blocked")] }; },
    });
    stored = { ...stored, manual: { ...stored.manual, productName: "Typed while fetching" } };
    release();
    await run;
    assert.equal(persisted.length, 1);
    assert.equal(src.amazonCardMode(stored).mode, "manual");
    assert.equal(stored.manual.productName, "Typed while fetching", "edit made during the request survives");
  });
  await test("runner: request throws (401/429/offline) → manual mode, nothing else", async () => {
    let stored: Source = fresh();
    await runAmazonCardImport({ getSource: () => stored, persist: next => { stored = next; }, importFn: async () => { throw new Error("Import failed (429)"); } });
    assert.equal(stored.fetch.status, "failed"); assert.equal(stored.fetch.reason, "request_failed");
  });
  await test("runner: success → fetched mode with page text", async () => {
    let stored: Source = fresh();
    await runAmazonCardImport({ getSource: () => stored, persist: next => { stored = next; }, importFn: async () => ({ results: [importOk({ title: "Stanley Quencher", bullets: ["Cold 11h"] })] }) });
    assert.equal(src.amazonCardMode(stored).mode, "fetched"); assert.equal(src.canGenerateAmazonCopy(stored), true);
  });

  console.log("\n[fact-card mapping]");
  const payloadFor = (source: Source, destinationUrl = URL_OK) => {
    const draft = { destinationUrl, amazonSource: source } as unknown as Parameters<typeof gen.inferProductContext>[1];
    const product = gen.inferProductContext({ draftId: "d", imageUrl: "", language: "en", destinationUrl }, draft);
    const amazon = gen.resolveAmazonCopyContext({ destinationUrl }, draft);
    return JSON.parse(JSON.stringify(buildAICopyV2AnalyzePayload({
      draftId: "d", locale: "en", idempotencyKey: "k", product, ...(amazon?.page ? { page: amazon.page } : {}),
    }))) as { productContext?: Record<string, unknown>; pageContext?: Record<string, unknown> };
  };
  await test("fetched-only card: title/bullets in pageContext; no price/availability/vendor/title in productContext", () => {
    const s: Source = { ...fresh(), fetch: { status: "ok" }, extracted: { title: "Stanley Quencher", bullets: ["Keeps cold", "Fits cup holders"], brand: "Stanley" } };
    const p = payloadFor(s);
    assert.equal(p.pageContext?.title, "Stanley Quencher");
    assert.equal(p.pageContext?.description, "Keeps cold\nFits cup holders");
    for (const key of ["title", "price", "availability", "vendor", "material", "quantity"]) {
      assert.equal(key in (p.productContext ?? {}), false, `productContext has no ${key}`);
    }
  });
  await test("manual card: name/points/Brand/Material/Size map like Shopify; still no price/availability", () => {
    const s: Source = { ...fresh(), fetch: { status: "failed", reason: "bot_check" }, manual: {
      productName: "Stanley 40oz tumbler", sellingPoints: "- Keeps drinks cold\n• Fits cup holders\n\n", brand: "Stanley", material: "stainless steel", size: "40 oz",
    } };
    const p = payloadFor(s);
    assert.equal(p.productContext?.title, "Stanley 40oz tumbler");
    assert.deepEqual(p.productContext?.attributes, ["Keeps drinks cold", "Fits cup holders"]);
    assert.equal(p.productContext?.vendor, "Stanley");
    assert.equal(p.productContext?.material, "stainless steel");
    assert.equal(p.productContext?.quantity, "40 oz");
    assert.equal("price" in (p.productContext ?? {}), false); assert.equal("availability" in (p.productContext ?? {}), false);
    assert.equal(p.pageContext, undefined, "no page text when nothing was fetched");
  });
  await test("partial manual fields: only what the user filled; selling points capped at 10", () => {
    const points = Array.from({ length: 14 }, (_, i) => `Point ${i + 1}`).join("\n");
    const p = payloadFor({ ...fresh(), manual: { productName: "Lamp", sellingPoints: points, size: "2-pack" } });
    assert.equal((p.productContext?.attributes as string[]).length, 10);
    assert.equal(p.productContext?.quantity, "2-pack");
    assert.equal("vendor" in (p.productContext ?? {}), false); assert.equal("material" in (p.productContext ?? {}), false);
  });
  await test("stale amazonSource behind a non-Amazon URL is ignored (not an affiliate card)", () => {
    const s: Source = { ...fresh(), manual: { productName: "Old product", brand: "Stanley" } };
    const draft = { destinationUrl: "https://myshop.example/lamp", amazonSource: s } as unknown as Parameters<typeof gen.inferProductContext>[1];
    assert.equal(gen.resolveAmazonCopyContext({}, draft), null);
    const product = gen.inferProductContext({ draftId: "d", imageUrl: "", language: "en" }, draft);
    assert.equal(product.vendor, undefined); assert.equal(product.title, undefined);
  });

  console.log("\n[acceptance 4b: real analyze mapping + real validator]");
  const validateWith = (source: Source) => {
    const p = payloadFor(source);
    const factCard = createFactCardV1({ sessionId: "s", draftId: "d", locale: "en", facts: buildFacts({ draftId: "d", idempotencyKey: "k", ...p } as never) });
    return validateCopy({
      title: "Stanley 40 oz Tumbler for Road Trips",
      description: "Take the Stanley 40 oz tumbler on every drive. #ad",
      altText: "A tall tumbler on a car console",
      factCard,
      descriptionMax: 500,
      claimDetection: { status: "completed", claims: [
        { type: "brand", value: "Stanley", field: "title" },
        { type: "numeric_commercial", value: "40 oz", field: "title" },
      ] },
    });
  };
  const codes = (r: ReturnType<typeof validateCopy>) => r.issues.map(i => i.code).sort();
  await test("Brand + Size declared → copy naming Stanley / 40 oz validates", () => {
    const r = validateWith({ ...fresh(), manual: { productName: "Stanley 40oz tumbler", brand: "Stanley", size: "40 oz" } });
    assert.equal(r.valid, true, JSON.stringify(r.issues));
  });
  await test("name only (no Brand/Size) → UNSUPPORTED_BRAND_CLAIM + UNSUPPORTED_NUMERIC_CLAIM (the 422 the fields prevent)", () => {
    const r = validateWith({ ...fresh(), manual: { productName: "Stanley 40oz tumbler" } });
    assert.equal(r.valid, false);
    assert.ok(codes(r).includes("UNSUPPORTED_BRAND_CLAIM")); assert.ok(codes(r).includes("UNSUPPORTED_NUMERIC_CLAIM"));
  });
  await test("fetched page title mentioning the brand does NOT authorise it (page_metadata)", () => {
    const r = validateWith({ ...fresh(), fetch: { status: "ok" }, extracted: { title: "Stanley Quencher 40 oz", brand: "Stanley" } });
    assert.ok(codes(r).includes("UNSUPPORTED_BRAND_CLAIM"));
  });
  await test("Brand only → brand passes, size still flagged (field-level pointer)", () => {
    const r = validateWith({ ...fresh(), manual: { productName: "Tumbler", brand: "Stanley" } });
    assert.deepEqual(codes(r), ["UNSUPPORTED_NUMERIC_CLAIM"]);
  });

  console.log("\n[generatePinterestPinCopy]");
  const imageAnalysis = { imageSummary: "A tumbler", visibleObjects: ["tumbler"], colors: ["white"], style: "minimal", ocrText: "", category: "kitchen" };
  const originalFetch = globalThis.fetch;
  const originalFlag = process.env.NEXT_PUBLIC_AI_COPY_V2;
  await test("failed fetch + no product name → refused before any request; draft fields unchanged", async () => {
    mem.clear(); store.__resetMemoryCacheForTests();
    const d = store.createBoardDraft({ imageUrl: "https://x/a.png", source: "uploaded_image", title: "My title" });
    const blocked = src.applyAmazonImportResult(fresh(), importFail("bot_check", "blocked"), NOW);
    store.updateDraft(d.id, { destinationUrl: URL_OK, description: "My description", amazonSource: blocked });
    const before = JSON.stringify(store.getDraft(d.id));
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("{}"); }) as typeof fetch;
    process.env.NEXT_PUBLIC_AI_COPY_V2 = "true";
    try {
      await assert.rejects(
        gen.generatePinterestPinCopy({ draftId: d.id, imageUrl: "https://x/a.png", language: "en", destinationUrl: URL_OK, imageAnalysis }),
        (e: unknown) => (e as { code?: string }).code === gen.AMAZON_PRODUCT_NAME_REQUIRED,
      );
    } finally { globalThis.fetch = originalFetch; }
    assert.equal(calls, 0, "no analyze / generate / vision request");
    assert.equal(JSON.stringify(store.getDraft(d.id)), before, "draft unchanged field-for-field");
  });
  await test("manual-mode card generates: generate body carries affiliateDisclosure, analyze carries declared facts", async () => {
    mem.clear(); store.__resetMemoryCacheForTests();
    const d = store.createBoardDraft({ imageUrl: "https://x/b.png", source: "uploaded_image" });
    store.updateDraft(d.id, { destinationUrl: URL_OK, amazonSource: { ...fresh(), fetch: { status: "failed", reason: "bot_check" }, manual: { productName: "Tumbler", brand: "Stanley" } } });
    const bodies: Record<string, Record<string, unknown>> = {};
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const body = JSON.parse(String(init?.body ?? "{}"));
      if (url.endsWith("/v2/analyze")) {
        bodies.analyze = body;
        return new Response(JSON.stringify({ ok: true, sessionId: "s1", factCard: { version: "fact-card-v1", sessionId: "s1", draftId: d.id, locale: "en", facts: [] }, keywordEvidence: { keywordSetId: "k", candidates: [], selectedKeywordIds: [], degradedMode: "no_keyword_demand_data" } }), { status: 200 });
      }
      bodies.generate = body;
      return new Response(JSON.stringify({ ok: true, result: { generationId: "g", sessionId: "s1", draftId: d.id, angleId: "default", keywordSetId: "k", title: "Stanley Tumbler", description: "Find it on Amazon. #ad", altText: "A tumbler", usedKeywordIds: [], factSummary: [], degradedMode: "no_keyword_demand_data", validationReport: { valid: true, issues: [] } } }), { status: 200 });
    }) as typeof fetch;
    process.env.NEXT_PUBLIC_AI_COPY_V2 = "true";
    try {
      const res = await gen.generatePinterestPinCopy({ draftId: d.id, imageUrl: "https://x/b.png", language: "en", destinationUrl: URL_OK, imageAnalysis });
      assert.equal(res.fields.description, "Find it on Amazon. #ad");
    } finally { globalThis.fetch = originalFetch; }
    assert.equal(bodies.generate?.affiliateDisclosure, "ad_hashtag");
    const pc = bodies.analyze?.productContext as Record<string, unknown>;
    assert.equal(pc.title, "Tumbler"); assert.equal(pc.vendor, "Stanley");
    assert.equal("price" in pc, false); assert.equal("availability" in pc, false);
  });
  await test("non-Amazon card: generate body has no affiliateDisclosure", async () => {
    mem.clear(); store.__resetMemoryCacheForTests();
    const d = store.createBoardDraft({ imageUrl: "https://x/c.png", source: "uploaded_image" });
    store.updateDraft(d.id, { destinationUrl: "https://myshop.example/lamp" });
    let generateBody: Record<string, unknown> = {};
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v2/analyze")) return new Response(JSON.stringify({ ok: true, sessionId: "s1", factCard: { version: "fact-card-v1", sessionId: "s1", draftId: d.id, locale: "en", facts: [] }, keywordEvidence: { keywordSetId: "k", candidates: [], selectedKeywordIds: [], degradedMode: "no_keyword_demand_data" } }), { status: 200 });
      generateBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ ok: true, result: { title: "T", description: "D", altText: "A", usedKeywordIds: [], factSummary: [], degradedMode: "no_keyword_demand_data", validationReport: { valid: true, issues: [] } } }), { status: 200 });
    }) as typeof fetch;
    try {
      await gen.generatePinterestPinCopy({ draftId: d.id, imageUrl: "https://x/c.png", language: "en", imageAnalysis });
    } finally { globalThis.fetch = originalFetch; }
    assert.equal("affiliateDisclosure" in generateBody, false);
  });

  console.log("\n[affiliate disclosure gate: v2 off + Amazon card]");
  await test("v2 disabled + Amazon card ready to generate → refused before any request (no undisclosed #ad copy)", async () => {
    mem.clear(); store.__resetMemoryCacheForTests();
    delete process.env.NEXT_PUBLIC_AI_COPY_V2;
    const d = store.createBoardDraft({ imageUrl: "https://x/d.png", source: "uploaded_image", title: "My title" });
    // manual.productName set → canGenerateAmazonCopy() is true, so if this test still
    // threw AMAZON_PRODUCT_NAME_REQUIRED it would prove nothing about the v2 gate.
    store.updateDraft(d.id, { destinationUrl: URL_OK, amazonSource: { ...fresh(), manual: { productName: "Tumbler" } } });
    const before = JSON.stringify(store.getDraft(d.id));
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("{}"); }) as typeof fetch;
    try {
      await assert.rejects(
        gen.generatePinterestPinCopy({ draftId: d.id, imageUrl: "https://x/d.png", language: "en", destinationUrl: URL_OK, imageAnalysis }),
        (e: unknown) => (e as { code?: string }).code === gen.AMAZON_COPY_REQUIRES_V2,
      );
    } finally { globalThis.fetch = originalFetch; }
    assert.equal(calls, 0, "no analyze / generate / vision request");
    assert.equal(JSON.stringify(store.getDraft(d.id)), before, "draft unchanged field-for-field");
  });
  await test("v2 disabled + non-Amazon card → unaffected, still generates via v1", async () => {
    mem.clear(); store.__resetMemoryCacheForTests();
    delete process.env.NEXT_PUBLIC_AI_COPY_V2;
    const d = store.createBoardDraft({ imageUrl: "https://x/e.png", source: "uploaded_image" });
    store.updateDraft(d.id, { destinationUrl: "https://myshop.example/lamp" });
    let calls = 0;
    let requestedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls++;
      requestedUrl = String(input);
      return new Response(JSON.stringify({ ok: true, output: { title: "T", description: "D", altText: "A" } }), { status: 200 });
    }) as typeof fetch;
    let res: Awaited<ReturnType<typeof gen.generatePinterestPinCopy>>;
    try {
      res = await gen.generatePinterestPinCopy({ draftId: d.id, imageUrl: "https://x/e.png", language: "en", imageAnalysis });
    } finally { globalThis.fetch = originalFetch; }
    assert.equal(calls, 1, "the v1 request still happens for a non-Amazon card");
    assert.ok(requestedUrl.endsWith("/api/ai-copy"));
    assert.equal(res.fields.title, "T");
    assert.equal(res.fields.description, "D");
  });
  if (originalFlag == null) delete process.env.NEXT_PUBLIC_AI_COPY_V2; else process.env.NEXT_PUBLIC_AI_COPY_V2 = originalFlag;

  console.log(`\nAmazon copy mapping: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
