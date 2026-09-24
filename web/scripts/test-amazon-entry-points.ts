/**
 * T4 — Amazon context + #ad disclosure on the Plan drawer and Batch Edit entry points,
 * and the glue the bulk runner uses (bulkCopyDrafts.ts).
 *
 *  - an Amazon Website URL is an Amazon card on EVERY entry point, even when the draft
 *    never passed through the Studio card that records amazonSource
 *  - Plan drawer / Batch Edit read THEIR unsaved URL (destinationUrlIsCurrent); the
 *    Studio card keeps reading the stored URL (unchanged T3 semantics)
 *  - the §2.3 product-name gate applies there too (refused before any request)
 *  - wiring: DraftDetailsDrawer → PinAICopyPanel → generatePinterestPinCopy, and the
 *    Batch Edit shared path, pass the current URL
 *  - manual edits mark touched; AI errors map onto the runner's vocabulary
 *
 * Run: npx tsx scripts/test-amazon-entry-points.ts
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

const URL_OK = "https://www.amazon.com/Stanley-Tumbler/dp/B0BSHF7WHW?tag=harriet-20";
const URL_OTHER = "https://www.amazon.com/dp/B07FZ8S74R";
const SHOP = "https://myshop.example/lamp";
const imageAnalysis = { imageSummary: "A tumbler", visibleObjects: ["tumbler"], colors: ["white"], style: "minimal", ocrText: "", category: "kitchen" };

async function main() {
  const gen = await import("../src/lib/ai-copy/generatePinCopy");
  const src = await import("../src/lib/studio/amazonCardSource");
  const store = await import("../src/lib/pinDraftStore");
  const glue = await import("../src/lib/studio/bulkCopyDrafts");
  const { AICopyV2ClientError } = await import("../src/lib/ai-copy/generatePinCopyV2");

  const draftWith = (patch: Record<string, unknown>) => {
    const d = store.createBoardDraft({ imageUrl: "https://x/a.png", source: "uploaded_image" });
    store.updateDraft(d.id, patch);
    return store.getDraft(d.id)!;
  };

  console.log("\n[resolveAmazonCopyContext on every entry point]");
  await test("Amazon URL without amazonSource (never on a Studio card) → Amazon context, #ad, name gate", () => {
    mem.clear(); store.__resetMemoryCacheForTests();
    const d = draftWith({ destinationUrl: URL_OK });
    assert.equal(d.amazonSource, undefined);
    const ctx = gen.resolveAmazonCopyContext({}, d);
    assert.ok(ctx, "is an Amazon card");
    assert.equal(ctx!.affiliateDisclosure, "ad_hashtag");
    assert.equal(ctx!.canGenerate, false, "no product name yet → §2.3 gate");
  });
  await test("Plan / Batch Edit: the caller's unsaved URL decides (destinationUrlIsCurrent)", () => {
    mem.clear(); store.__resetMemoryCacheForTests();
    const d = draftWith({ destinationUrl: SHOP });
    assert.ok(gen.resolveAmazonCopyContext({ destinationUrl: URL_OK, destinationUrlIsCurrent: true }, d), "typed Amazon URL counts");
    assert.equal(gen.resolveAmazonCopyContext({ destinationUrl: URL_OK }, d), null, "Studio card semantics unchanged: stored URL wins");
    const amazonStored = draftWith({ destinationUrl: URL_OK });
    assert.equal(gen.resolveAmazonCopyContext({ destinationUrl: SHOP, destinationUrlIsCurrent: true }, amazonStored), null, "URL changed away from Amazon → not Amazon");
  });
  await test("stored manual facts are carried to the URL being generated for", () => {
    mem.clear(); store.__resetMemoryCacheForTests();
    const source = { ...src.amazonSourceForUrl(URL_OK, undefined)!, manual: { productName: "Tumbler", brand: "Stanley" } };
    const d = draftWith({ destinationUrl: URL_OK, amazonSource: source });
    const same = gen.resolveAmazonCopyContext({ destinationUrl: URL_OK, destinationUrlIsCurrent: true }, d)!;
    assert.equal(same.canGenerate, true);
    assert.equal(same.product.vendor, "Stanley");
    const other = gen.resolveAmazonCopyContext({ destinationUrl: URL_OTHER, destinationUrlIsCurrent: true }, d)!;
    assert.equal(other.product.title, "Tumbler", "manual fields carried (amazonSourceForUrl)");
  });

  console.log("\n[generatePinterestPinCopy from Plan / Batch Edit]");
  const originalFetch = globalThis.fetch;
  const originalFlag = process.env.NEXT_PUBLIC_AI_COPY_V2;
  process.env.NEXT_PUBLIC_AI_COPY_V2 = "true";
  const okFetch = (draftId: string, bodies: Record<string, Record<string, unknown>>) => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.endsWith("/v2/analyze")) {
      bodies.analyze = body;
      return new Response(JSON.stringify({ ok: true, sessionId: "s1", factCard: { version: "fact-card-v1", sessionId: "s1", draftId, locale: "en", facts: [] }, keywordEvidence: { keywordSetId: "k", candidates: [], selectedKeywordIds: [], degradedMode: "no_keyword_demand_data" } }), { status: 200 });
    }
    bodies.generate = body;
    return new Response(JSON.stringify({ ok: true, result: { generationId: "g", sessionId: "s1", draftId, angleId: "default", keywordSetId: "k", title: "Stanley Tumbler", description: "Find it on Amazon. #ad", altText: "A tumbler", usedKeywordIds: [], factSummary: [], degradedMode: "no_keyword_demand_data", validationReport: { valid: true, issues: [] } } }), { status: 200 });
  }) as typeof fetch;

  await test("Plan drawer: Amazon URL typed (unsaved) over a shop URL → generate carries affiliateDisclosure", async () => {
    mem.clear(); store.__resetMemoryCacheForTests();
    const source = { ...src.amazonSourceForUrl(URL_OK, undefined)!, manual: { productName: "Tumbler" } };
    const d = draftWith({ destinationUrl: SHOP, amazonSource: source });
    const bodies: Record<string, Record<string, unknown>> = {};
    globalThis.fetch = okFetch(d.id, bodies);
    try {
      await gen.generatePinterestPinCopy({ draftId: d.id, imageUrl: "https://x/a.png", language: "en", destinationUrl: URL_OK, destinationUrlIsCurrent: true, imageAnalysis });
    } finally { globalThis.fetch = originalFetch; }
    assert.equal(bodies.generate?.affiliateDisclosure, "ad_hashtag");
    const pc = bodies.analyze?.productContext as Record<string, unknown>;
    assert.equal(pc.title, "Tumbler");
    assert.equal("price" in pc, false);
  });
  await test("Batch Edit row with a stored Amazon URL but no amazonSource and no name → refused, 0 requests", async () => {
    mem.clear(); store.__resetMemoryCacheForTests();
    const d = draftWith({ destinationUrl: URL_OK, title: "Keep me" });
    const before = JSON.stringify(store.getDraft(d.id));
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("{}"); }) as typeof fetch;
    try {
      await assert.rejects(
        gen.generatePinterestPinCopy({ draftId: d.id, imageUrl: "https://x/a.png", language: "en", destinationUrl: URL_OK, destinationUrlIsCurrent: true, imageAnalysis }),
        (e: unknown) => (e as { code?: string }).code === gen.AMAZON_PRODUCT_NAME_REQUIRED,
      );
    } finally { globalThis.fetch = originalFetch; }
    assert.equal(calls, 0);
    assert.equal(JSON.stringify(store.getDraft(d.id)), before);
  });
  await test("non-Amazon current URL (Plan) → no affiliateDisclosure", async () => {
    mem.clear(); store.__resetMemoryCacheForTests();
    const d = draftWith({ destinationUrl: URL_OK, amazonSource: { ...src.amazonSourceForUrl(URL_OK, undefined)!, manual: { productName: "Tumbler" } } });
    const bodies: Record<string, Record<string, unknown>> = {};
    globalThis.fetch = okFetch(d.id, bodies);
    try {
      await gen.generatePinterestPinCopy({ draftId: d.id, imageUrl: "https://x/a.png", language: "en", destinationUrl: SHOP, destinationUrlIsCurrent: true, imageAnalysis });
    } finally { globalThis.fetch = originalFetch; }
    assert.equal("affiliateDisclosure" in (bodies.generate ?? {}), false);
  });
  if (originalFlag == null) delete process.env.NEXT_PUBLIC_AI_COPY_V2; else process.env.NEXT_PUBLIC_AI_COPY_V2 = originalFlag;

  console.log("\n[wiring]");
  await test("Plan drawer passes its current URL to the shared panel, and the panel forwards the flag", () => {
    const plan = readFileSync("src/components/plan/DraftDetailsDrawer.tsx", "utf8");
    assert.match(plan, /<PinAICopyPanel[\s\S]*?destinationUrl=\{destinationUrl\}[\s\S]*?destinationUrlIsCurrent[\s\S]*?\/>/);
    const panel = readFileSync("src/components/pins/PinAICopyPanel.tsx", "utf8");
    assert.match(panel, /props\.destinationUrlIsCurrent \? \{ destinationUrlIsCurrent: true \}/);
  });
  await test("Batch Edit shared path sends each row's current URL and uses the shared runner", () => {
    const batch = readFileSync("src/components/studio/BatchEditDrawer.tsx", "utf8");
    assert.match(batch, /destinationUrl: getVal\(pin, edits, "destinationUrl"\),\s*destinationUrlIsCurrent: true,/);
    assert.match(batch, /runBulkGenerateCopy\(\{/);
    assert.match(batch, /mergeGeneratedCopy\(bulkCardFor\(pin, current\), generated, \{ replaceTouched \}\)/, "merge reads FRESH row state");
  });

  console.log("\n[bulk glue]");
  await test("manualCopyTouched: only changed copy fields become touched; unchanged → null", () => {
    assert.equal(glue.manualCopyTouched({ title: "a", description: "b", altText: "c" }, { title: "a", description: "b", altText: "c" }), null);
    assert.deepEqual(glue.manualCopyTouched({ title: "a", description: "b", metadataTouched: { destinationUrlTouched: true } }, { title: "a!", description: "b" }), { destinationUrlTouched: true, titleTouched: true });
  });
  await test("classifyBulkCopyError maps 402 / 429 / name gate / busy / other", () => {
    assert.deepEqual(glue.classifyBulkCopyError(new AICopyV2ClientError("ai_text_limit_reached", 402, "limit", null)), { kind: "text_limit" });
    assert.deepEqual(glue.classifyBulkCopyError(new AICopyV2ClientError("rate_limited", 429, "slow", 12)), { kind: "rate_limited", retryAfterSeconds: 12 });
    assert.deepEqual(glue.classifyBulkCopyError(new gen.PinCopyError(gen.AMAZON_PRODUCT_NAME_REQUIRED, "name")), { kind: "needs_product_name" });
    assert.deepEqual(glue.classifyBulkCopyError(new glue.BulkCopyBusyError()), { kind: "busy" });
    assert.deepEqual(glue.classifyBulkCopyError(new AICopyV2ClientError("validation_failed", 422, "Copy failed checks", null)), { kind: "failed", message: "Copy failed checks" });
  });
  await test("Studio card typing marks touched; Batch Edit typing records copyTouched; host folds it in", () => {
    const card = readFileSync("src/components/studio/PinBoardCard.tsx", "utf8");
    assert.match(card, /const copyTouched = manualCopyTouched\(current, \{ title: f\.title, description: f\.description, altText: f\.altText \}\)/);
    const batch = readFileSync("src/components/studio/BatchEditDrawer.tsx", "utf8");
    assert.match(batch, /if \("title" in patch \|\| "description" in patch \|\| "altText" in patch\) \{\s*nextEdit\.copyTouched/);
    const board = readFileSync("src/components/studio/StudioBoard.tsx", "utf8");
    assert.match(board, /if \(edit\.copyTouched && Object\.values\(edit\.copyTouched\)\.some\(Boolean\)\)/);
    assert.match(board, /\.\.\.existing\?\.metadataTouched, \.\.\.patch\.metadataTouched, destinationUrlTouched: true/, "URL-touch merge no longer drops copy flags");
  });

  console.log(`\nAmazon entry points: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
