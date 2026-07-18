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
import { resolveFailureMediaUrl, isDegenerateDataUrl, type FailureMediaDraft } from "../src/lib/studio/failureMedia";

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
