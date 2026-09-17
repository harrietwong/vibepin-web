/**
 * Unit tests for resolveFailureMediaUrl / isDegenerateDataUrl (board cards must always
 * show the original input image, never a blank/broken image, and never a giant solid
 * color block from a junk placeholder — see src/lib/studio/failureMedia.ts).
 * Run: npx tsx scripts/test-generation-failure-media.ts
 *
 * Covers the 5-step priority chain (generatedImage → sourceImageUrl → product input →
 * reference input → parent draft → placeholder), the blob-URL skip rule, the
 * degenerate tiny-data-URL skip rule (isDegenerateDataUrl + its wiring into the chain),
 * the regenerate-parent case, the prompt-only (nothing resolvable) case, and confirms
 * the resolver operates purely on PERSISTED fields (no reliance on in-memory-only
 * state) — plus resolver-level ordering assertions for publish-failed cards (they now
 * render through the SAME chain/component as generation-failed cards, starting at
 * imageUrl so the genuine final generated image is always preferred; PinCardMedia's
 * onError/onLoad-junk-pixel runtime advancement is the component-level complement to
 * this ordering, exercised interactively rather than by this pure resolver test).
 */

import assert from "node:assert";
import { resolveFailureMediaUrl, isDegenerateDataUrl, isQaFixtureMediaId, classifyLoadedMedia, reduceMediaCursor, resolveFailureMediaCandidates, failureMediaRenderModel, type FailureMediaDraft } from "../src/lib/studio/failureMedia";

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

function draft(partial: Partial<FailureMediaDraft>): FailureMediaDraft {
  return {
    imageUrl: "",
    sourceImageUrl: undefined,
    parentDraftId: undefined,
    setupSnapshot: undefined,
    ...partial,
  };
}

const LEGACY_MEDIA_URL = "https://cdn.example.test/history/pin.jpg";
const PRODUCT_SOLID_PINK = "https://cdn.example.test/products/solid-pink.jpg";
const REFERENCE_SOLID = "https://cdn.example.test/references/solid-gray.jpg";
const media = (id: string, url: string, source: "legacy" | "product" | "ai" | "upload" = "legacy", width?: number, height?: number) => ({
  id, kind: "image" as const, url, source, ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }),
});

// ── Historical pink placeholder identity ───────────────────────────────────────

test("only strict QA fixture ids are identity signals, never URL words or colors", () => {
  assert.equal(isQaFixtureMediaId("qa-slide-1"), true);
  assert.equal(isQaFixtureMediaId("qa-slide-01"), true);
  assert.equal(isQaFixtureMediaId("catalog-pink-product"), false);
  assert.equal(isQaFixtureMediaId("qa-slide-one"), false);
});

test("legacy placeholder advances to the persisted product input", () => {
  const d = draft({
    imageUrl: LEGACY_MEDIA_URL,
    source: "legacy_placeholder",
    assetError: "legacy_placeholder",
    media: [media("legacy-main", LEGACY_MEDIA_URL)],
    setupSnapshot: { selectedProducts: [{ imageUrl: PRODUCT_SOLID_PINK }] } as never,
  });
  assert.equal(resolveFailureMediaUrl(d), PRODUCT_SOLID_PINK);
});

test("legacy placeholder advances product placeholder to the persisted reference", () => {
  const d = draft({
    imageUrl: LEGACY_MEDIA_URL,
    source: "legacy_placeholder",
    media: [media("legacy-main", LEGACY_MEDIA_URL), media("qa-slide-1", PRODUCT_SOLID_PINK)],
    setupSnapshot: {
      selectedProducts: [{ imageUrl: PRODUCT_SOLID_PINK }],
      selectedReferences: [{ imageUrl: REFERENCE_SOLID }],
    } as never,
  });
  assert.equal(resolveFailureMediaUrl(d), REFERENCE_SOLID);
});

test("legacy placeholder at every persisted step ends in the neutral fallback", () => {
  const d = draft({
    imageUrl: LEGACY_MEDIA_URL,
    sourceImageUrl: LEGACY_MEDIA_URL,
    source: "legacy_placeholder",
    assetError: "legacy_placeholder",
    media: [media("legacy-main", LEGACY_MEDIA_URL), media("qa-slide-1", PRODUCT_SOLID_PINK), media("qa-slide-2", REFERENCE_SOLID)],
    setupSnapshot: {
      selectedProducts: [{ imageUrl: PRODUCT_SOLID_PINK }],
      selectedReferences: [{ imageUrl: REFERENCE_SOLID }],
    } as never,
  });
  assert.equal(resolveFailureMediaUrl(d), null);
});

test("valid remote solid-color product art is never rejected by color or average pixels", () => {
  const d = draft({ imageUrl: PRODUCT_SOLID_PINK, source: "uploaded_image", media: [media("catalog-pink", PRODUCT_SOLID_PINK, "product", 1200, 1200)] });
  assert.equal(resolveFailureMediaUrl(d), PRODUCT_SOLID_PINK);
  assert.equal(classifyLoadedMedia({
    id: "catalog-pink", width: 1200, height: 1200, provenance: "product",
  }), "valid");
});

test("known 1x1 and 2x2 media advance without inspecting color", () => {
  for (const dimensions of [[1, 1], [2, 2], [1, 2], [2, 1]] as const) {
    assert.equal(classifyLoadedMedia({
      id: "catalog-tiny", width: dimensions[0], height: dimensions[1], provenance: "product",
    }), "tiny", `${dimensions.join("x")} should advance`);
  }
});

test("larger single-color images remain valid even when their pixels are uniform", () => {
  assert.equal(classifyLoadedMedia({
    id: "catalog-pink", width: 2_000, height: 2_000, provenance: "product",
  }), "valid");
});

test("QA fixture identity advances while valid legacy/product media remain renderable", () => {
  assert.equal(classifyLoadedMedia({
    id: "qa-slide-1", width: 1200, height: 1200, provenance: "qa",
  }), "placeholder");
  assert.equal(classifyLoadedMedia({
    id: "legacy-pink", width: 1200, height: 1200, provenance: "legacy",
  }), "valid");
  assert.equal(classifyLoadedMedia({
    id: "catalog-pink", width: 1200, height: 1200, provenance: "product",
  }), "valid");
});

test("generation-failed, publish-failed, and healthy cards share the same safe media contract", () => {
  const generationFailed = draft({
    imageUrl: LEGACY_MEDIA_URL, failureType: "generation", generationStatus: "failed", source: "legacy_placeholder",
    media: [media("legacy-main", LEGACY_MEDIA_URL)],
    setupSnapshot: { selectedProducts: [{ imageUrl: PRODUCT_SOLID_PINK }] } as never,
  });
  const publishFailed = draft({
    imageUrl: LEGACY_MEDIA_URL, failureType: "publish", postedAt: undefined, source: "legacy_placeholder",
    media: [media("legacy-main", LEGACY_MEDIA_URL)],
    setupSnapshot: { selectedReferences: [{ imageUrl: REFERENCE_SOLID }] } as never,
  });
  const healthy = draft({ imageUrl: PRODUCT_SOLID_PINK, generationStatus: "completed" });
  assert.equal(resolveFailureMediaUrl(generationFailed), PRODUCT_SOLID_PINK);
  assert.equal(resolveFailureMediaUrl(publishFailed), REFERENCE_SOLID);
  assert.equal(resolveFailureMediaUrl(healthy), PRODUCT_SOLID_PINK);
});

test("media cursor state machine resets A→B→A even when B never advances", () => {
  let state = { identity: "A", index: 0 };
  state = reduceMediaCursor(state, { type: "advance" });
  assert.deepEqual(state, { identity: "A", index: 1 });
  state = reduceMediaCursor(state, { type: "sync", identity: "B" });
  assert.deepEqual(state, { identity: "B", index: 0 });
  state = reduceMediaCursor(state, { type: "sync", identity: "A" });
  assert.deepEqual(state, { identity: "A", index: 0 });
});

test("draft-level legacy marker drops only the marked primary and preserves real sourceImageUrl", () => {
  const d = draft({
    imageUrl: LEGACY_MEDIA_URL,
    sourceImageUrl: "https://cdn.example.test/source/real-parent.png",
    source: "legacy_placeholder",
    assetError: "legacy_placeholder",
    media: [media("legacy-main", LEGACY_MEDIA_URL)],
  });
  assert.equal(resolveFailureMediaUrl(d), "https://cdn.example.test/source/real-parent.png");
  assert.deepEqual(resolveFailureMediaCandidates(d).map(candidate => candidate.url), [
    "https://cdn.example.test/source/real-parent.png",
  ]);
});

test("candidate chain dedupes one bad URL across different provenance and roles", () => {
  const repeated = "https://CDN.example.test/source/real-parent.png#same-resource";
  const d = draft({
    imageUrl: repeated,
    sourceImageUrl: " https://cdn.example.test/source/real-parent.png ",
    source: "uploaded_image",
    setupSnapshot: { selectedProducts: [{ imageUrl: repeated }] } as never,
  });
  const candidates = resolveFailureMediaCandidates(d);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, repeated);
});

test("persisted media metadata matches canonical URL identities on both sides", () => {
  const persistedPlaceholder = "https://CDN.example.test/media/placeholder.png#fixture";
  const d = draft({
    imageUrl: "https://cdn.example.test/media/placeholder.png",
    source: "uploaded_image",
    media: [media("qa-slide-1", persistedPlaceholder, "legacy", 1200, 1200)],
    setupSnapshot: { selectedProducts: [{ imageUrl: PRODUCT_SOLID_PINK }] } as never,
  });
  assert.equal(resolveFailureMediaUrl(d), PRODUCT_SOLID_PINK);
});

test("qa slot identity does not reject a real product/generated replacement", () => {
  assert.equal(classifyLoadedMedia({ id: "qa-slide-1", width: 1200, height: 1200, provenance: "product" }), "valid");
  assert.equal(classifyLoadedMedia({ id: "qa-slide-1", width: 1200, height: 1200, provenance: "generated" }), "valid");
  const d = draft({
    imageUrl: PRODUCT_SOLID_PINK,
    source: "uploaded_image",
    media: [media("qa-slide-1", PRODUCT_SOLID_PINK, "product", 1200, 1200)],
  });
  assert.equal(resolveFailureMediaUrl(d), PRODUCT_SOLID_PINK);
  const generated = draft({
    imageUrl: PRODUCT_SOLID_PINK,
    source: "legacy_placeholder",
    assetError: "legacy_placeholder",
    media: [media("qa-slide-2", PRODUCT_SOLID_PINK, "ai", 1200, 1200)],
  });
  assert.equal(resolveFailureMediaUrl(generated), PRODUCT_SOLID_PINK);
});

test("render model marks the product fallback after primary filtering from candidate role", () => {
  const d = draft({
    imageUrl: LEGACY_MEDIA_URL,
    source: "legacy_placeholder",
    assetError: "legacy_placeholder",
    media: [media("legacy-main", LEGACY_MEDIA_URL)],
    setupSnapshot: { selectedProducts: [{ imageUrl: PRODUCT_SOLID_PINK }] } as never,
  });
  const model = failureMediaRenderModel(d, 0);
  assert.equal(model.current?.url, PRODUCT_SOLID_PINK);
  assert.equal(model.showOriginalBadge, true);
});

// ── Step 1: draft.imageUrl wins when present and usable ─────────────────────────

test("step 1: imageUrl present and non-blob → used directly", () => {
  const d = draft({ imageUrl: "https://cdn/a.png", sourceImageUrl: "https://cdn/parent.png" });
  assert.equal(resolveFailureMediaUrl(d), "https://cdn/a.png");
});

// ── Step 2: sourceImageUrl (parent snapshot at generation time) ─────────────────

test("step 2: imageUrl empty → falls back to sourceImageUrl", () => {
  const d = draft({ imageUrl: "", sourceImageUrl: "https://cdn/source.png" });
  assert.equal(resolveFailureMediaUrl(d), "https://cdn/source.png");
});

// ── Step 3: product input image (product-image generation failure) ──────────────

test("step 3: no imageUrl/sourceImageUrl → falls back to first product input image", () => {
  const d = draft({
    imageUrl: "", sourceImageUrl: undefined,
    setupSnapshot: {
      mode: "board_ai_scratch", noTextOverlay: true, imagesPerReference: 1,
      selectedProducts: [{ imageUrl: "https://cdn/product.png", title: "Product" }],
      selectedReferences: [], promptSnapshot: "",
    } as FailureMediaDraft["setupSnapshot"],
  });
  assert.equal(resolveFailureMediaUrl(d), "https://cdn/product.png");
});

// ── Step 4: reference input image (reference-image generation failure) ──────────

test("step 4: no product image → falls back to first reference input image", () => {
  const d = draft({
    imageUrl: "", sourceImageUrl: undefined,
    setupSnapshot: {
      mode: "board_ai_scratch", noTextOverlay: true, imagesPerReference: 1,
      selectedProducts: [], selectedReferences: [{ imageUrl: "https://cdn/reference.png" }],
      promptSnapshot: "",
    } as FailureMediaDraft["setupSnapshot"],
  });
  assert.equal(resolveFailureMediaUrl(d), "https://cdn/reference.png");
});

test("step 3 beats step 4: product image preferred over reference image when both exist", () => {
  const d = draft({
    imageUrl: "", sourceImageUrl: undefined,
    setupSnapshot: {
      mode: "board_ai_scratch", noTextOverlay: true, imagesPerReference: 1,
      selectedProducts: [{ imageUrl: "https://cdn/product.png", title: "P" }],
      selectedReferences: [{ imageUrl: "https://cdn/reference.png" }],
      promptSnapshot: "",
    } as FailureMediaDraft["setupSnapshot"],
  });
  assert.equal(resolveFailureMediaUrl(d), "https://cdn/product.png");
});

// ── Step 5: regenerate-parent case ───────────────────────────────────────────────

test("step 5: regenerate failure — sourceImageUrl dead (blob) → resolves through parentDraftId", () => {
  const parent: FailureMediaDraft = draft({ imageUrl: "https://cdn/parent-real.png" });
  const child = draft({
    imageUrl: "", sourceImageUrl: "blob:http://localhost/dead-parent-snapshot",
    parentDraftId: "parent-1",
  });
  const lookup = (id: string) => (id === "parent-1" ? parent : null);
  assert.equal(resolveFailureMediaUrl(child, lookup), "https://cdn/parent-real.png");
});

test("step 5: parent has no direct imageUrl → parent's own product image is used", () => {
  const parent: FailureMediaDraft = draft({
    imageUrl: "",
    setupSnapshot: {
      mode: "board_ai_scratch", noTextOverlay: true, imagesPerReference: 1,
      selectedProducts: [{ imageUrl: "https://cdn/grandparent-product.png", title: "P" }],
      selectedReferences: [], promptSnapshot: "",
    } as FailureMediaDraft["setupSnapshot"],
  });
  const child = draft({ imageUrl: "", sourceImageUrl: "", parentDraftId: "parent-2" });
  const lookup = (id: string) => (id === "parent-2" ? parent : null);
  assert.equal(resolveFailureMediaUrl(child, lookup), "https://cdn/grandparent-product.png");
});

test("step 5: parentDraftId set but lookup returns null (deleted parent) → falls through to placeholder", () => {
  const child = draft({ imageUrl: "", sourceImageUrl: "", parentDraftId: "gone" });
  const lookup = () => null;
  assert.equal(resolveFailureMediaUrl(child, lookup), null);
});

test("step 5: no lookupParent supplied at all → parentDraftId is simply skipped (no throw)", () => {
  const child = draft({ imageUrl: "", sourceImageUrl: "", parentDraftId: "parent-1" });
  assert.equal(resolveFailureMediaUrl(child), null);
});

// ── Blob-URL skip rule ────────────────────────────────────────────────────────────

test("blob URL at step 1 is skipped, falls through to step 2", () => {
  const d = draft({ imageUrl: "blob:http://localhost/dead", sourceImageUrl: "https://cdn/source.png" });
  assert.equal(resolveFailureMediaUrl(d), "https://cdn/source.png");
});

test("blob URL at every step (nothing else resolvable) → null (placeholder)", () => {
  const d = draft({ imageUrl: "blob:http://localhost/a", sourceImageUrl: "blob:http://localhost/b" });
  assert.equal(resolveFailureMediaUrl(d), null);
});

test("data: URL is treated like a normal usable candidate when long enough to be a real image (only blob: / tiny-degenerate are skipped)", () => {
  const longDataUrl = "data:image/png;base64,AAAA" + "A".repeat(200);
  const d = draft({ imageUrl: "", sourceImageUrl: longDataUrl });
  assert.equal(resolveFailureMediaUrl(d), longDataUrl);
});

// ── Prompt-only (nothing resolvable) → placeholder ───────────────────────────────

test("prompt-only / scratch mode with no inputs at all → null (renders placeholder)", () => {
  const d = draft({
    imageUrl: "", sourceImageUrl: undefined, parentDraftId: undefined,
    setupSnapshot: {
      mode: "board_ai_scratch", noTextOverlay: true, imagesPerReference: 1,
      selectedProducts: [], selectedReferences: [], promptSnapshot: "a cozy reading nook",
    } as FailureMediaDraft["setupSnapshot"],
  });
  assert.equal(resolveFailureMediaUrl(d), null);
});

test("completely empty draft (no setupSnapshot at all) → null", () => {
  const d = draft({});
  assert.equal(resolveFailureMediaUrl(d), null);
});

// ── Whitespace-only values are treated as absent ─────────────────────────────────

test("whitespace-only imageUrl is treated as empty, falls through", () => {
  const d = draft({ imageUrl: "   ", sourceImageUrl: "https://cdn/source.png" });
  assert.equal(resolveFailureMediaUrl(d), "https://cdn/source.png");
});

// ── Persisted-fields-only guarantee (refresh / cross-device) ────────────────────
// The resolver takes ONLY plain data (FailureMediaDraft is a subset of the
// PERSISTED PinDraft shape) and an optional pure lookup function — there is no
// window/localStorage/React state dependency inside failureMedia.ts itself, so the
// same input always resolves the same way regardless of session/tab. This is a
// structural guarantee (no mutable module state is read), asserted here by calling
// the resolver twice with fresh draft literals and confirming identical results.

test("pure/deterministic: same persisted fields → same result across repeated calls", () => {
  const d = draft({ imageUrl: "", sourceImageUrl: "https://cdn/source.png" });
  const r1 = resolveFailureMediaUrl(draft({ ...d }));
  const r2 = resolveFailureMediaUrl(draft({ ...d }));
  assert.equal(r1, r2);
  assert.equal(r1, "https://cdn/source.png");
});

// ── Degenerate (tiny) data: URL skip rule ────────────────────────────────────────
// A real-world bug: a 1x1 solid-color PNG data URL "loads successfully" (it is a
// genuinely decodable image) but renders as a giant solid block — worse than falling
// back further down the chain. Only `data:` URLs are length-checked; http(s) URLs of
// any length are untouched by this rule (their liveness is a runtime/onError concern,
// not something a byte-length heuristic can judge).

test("isDegenerateDataUrl: tiny 1x1 PNG data URL (~120 chars) is degenerate", () => {
  const tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  assert.ok(tiny.length < 200, "fixture sanity: tiny PNG really is under 200 chars");
  assert.equal(isDegenerateDataUrl(tiny), true);
});

test("isDegenerateDataUrl: long data URL (thousands of chars, a real image) is NOT degenerate", () => {
  const long = "data:image/png;base64," + "A".repeat(5000);
  assert.equal(isDegenerateDataUrl(long), false);
});

test("isDegenerateDataUrl: non-data URL (http/https) is never flagged, regardless of length", () => {
  assert.equal(isDegenerateDataUrl("https://cdn/a.png"), false);
  assert.equal(isDegenerateDataUrl("https://cdn/" + "a".repeat(5)), false);
});

test("isDegenerateDataUrl: empty/null/undefined is not degenerate (absent, not junk)", () => {
  assert.equal(isDegenerateDataUrl(""), false);
  assert.equal(isDegenerateDataUrl(null), false);
  assert.equal(isDegenerateDataUrl(undefined), false);
});

test("tiny 1x1 data URL at step 1 is skipped, falls through to step 2", () => {
  const tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const d = draft({ imageUrl: tiny, sourceImageUrl: "https://cdn/source.png" });
  assert.equal(resolveFailureMediaUrl(d), "https://cdn/source.png");
});

test("tiny data URL at every step (nothing else resolvable) → null (placeholder)", () => {
  const tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const d = draft({ imageUrl: tiny, sourceImageUrl: tiny });
  assert.equal(resolveFailureMediaUrl(d), null);
});

test("long (genuine) data URL is kept as a normal usable candidate", () => {
  const long = "data:image/png;base64," + "A".repeat(5000);
  const d = draft({ imageUrl: "", sourceImageUrl: long });
  assert.equal(resolveFailureMediaUrl(d), long);
});

// ── Resolver-level ordering: publish-failed cards must still PREFER the genuine
// final generated image over any fallback candidate (dead-URL runtime advancement
// itself is a PinCardMedia onError concern, exercised by the component, not this
// pure resolver — but the resolver's ordering contract that makes that fallback
// possible is asserted here). ─────────────────────────────────────────────────────

test("resolver ordering: a dead-looking (but non-blob, non-degenerate) http URL at imageUrl still wins step 1 — actual liveness is a runtime/onError concern, not the resolver's", () => {
  const d = draft({
    imageUrl: "https://qa.invalid.example.com/pin.png",
    sourceImageUrl: "https://cdn/source.png",
  });
  assert.equal(resolveFailureMediaUrl(d), "https://qa.invalid.example.com/pin.png");
});

test("resolver ordering: once imageUrl is cleared/unusable, sourceImageUrl is the next candidate the runtime onError chain would advance to", () => {
  const d = draft({
    imageUrl: "", // simulates PinCardMedia having advanced past a dead imageUrl at runtime
    sourceImageUrl: "https://cdn/source.png",
  });
  assert.equal(resolveFailureMediaUrl(d), "https://cdn/source.png");
});

// ── Per-group reference association (create-pin PRD Section G2, 2026-07-21) ────

test("group reference: a reference-group failure shows THAT group's reference", () => {
  const d = draft({
    imageUrl: "",
    referenceImageUrl: "https://cdn/ref-group-2.png",
    setupSnapshot: { selectedReferences: [{ imageUrl: "https://cdn/ref-group-1.png" }] } as never,
  });
  // The snapshot only records the batch's FIRST reference; group 2 must not show it.
  assert.equal(resolveFailureMediaUrl(d), "https://cdn/ref-group-2.png");
});

test("group reference: product image still outranks the reference", () => {
  const d = draft({
    imageUrl: "",
    referenceImageUrl: "https://cdn/ref.png",
    setupSnapshot: { selectedProducts: [{ imageUrl: "https://cdn/product.png" }] } as never,
  });
  assert.equal(resolveFailureMediaUrl(d), "https://cdn/product.png");
});

test("group reference: falls back to the snapshot reference when unset (legacy drafts)", () => {
  const d = draft({
    imageUrl: "",
    referenceImageUrl: undefined,
    setupSnapshot: { selectedReferences: [{ imageUrl: "https://cdn/ref-legacy.png" }] } as never,
  });
  assert.equal(resolveFailureMediaUrl(d), "https://cdn/ref-legacy.png");
});

test("group reference: a blob reference is skipped, not shown", () => {
  const d = draft({
    imageUrl: "",
    referenceImageUrl: "blob:https://app/abc-123",
    setupSnapshot: { selectedReferences: [{ imageUrl: "https://cdn/ref-real.png" }] } as never,
  });
  assert.equal(resolveFailureMediaUrl(d), "https://cdn/ref-real.png");
});

test("group reference: parent's group reference is reachable through the chain", () => {
  const child = draft({ imageUrl: "", parentDraftId: "p1" });
  const lookup = () => draft({ imageUrl: "", referenceImageUrl: "https://cdn/parent-ref.png" });
  assert.equal(resolveFailureMediaUrl(child, lookup), "https://cdn/parent-ref.png");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
