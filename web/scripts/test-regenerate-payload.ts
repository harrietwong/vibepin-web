/**
 * Regenerate payload + error-handling regression tests.
 *
 * Covers the pure, shippable logic behind the "Regenerate" button: rebuilding the
 * generation request from a setup snapshot (products/references/brief/tags/model),
 * the missing-setup guard, count behavior, and P0 user-facing error copy.
 *
 * Run: npx tsx scripts/test-regenerate-payload.ts
 */
import { buildRegeneratePayload, regenerateErrorCopy, shouldBlockImagelessRetry, type RegenerateSnapshotLike } from "../src/lib/studio/regeneratePayload";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  OK   ${name}`); passed++; }
  else { console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); failed++; }
}

const fullSnap: RegenerateSnapshotLike = {
  selectedProducts: [
    { imageUrl: "https://cdn/p1.png", title: "blue paisley top", productUrl: "https://shop/p1" },
    { imageUrl: "https://cdn/p2.png", title: "flared jeans" },
  ],
  selectedReferences: [{ imageUrl: "https://cdn/ref.png" }],
  promptSnapshot: "Create an outdoor street-style fashion Pin…",
  category: "fashion",
  keyword: "Street Style",
  format: "2:3",
  modelKey: "gpt_image",
  noTextOverlay: true,
  creativeDirectionSnapshot: {
    hiddenPrompt: "REFERENCE REQUIREMENTS (HIGHEST PRIORITY): … full structured hidden prompt …",
    manualBrief: "Create an outdoor street-style fashion Pin…",
    creativeControls: {
      selectedTags: [{ id: "f-fmt-street", label: "Street-style outfit", group: "format" }],
      directionBrief: "Create an outdoor street-style fashion Pin…",
    },
  },
};

console.log("\n=== A. Regenerate with valid setup snapshot → full payload ===\n");
{
  const p = buildRegeneratePayload(fullSnap, { refUrl: "https://cdn/ref.png", fallbackKeyword: "kw", fallbackCategory: "fashion" });
  check("A: hasSetup is true", p.hasSetup);
  check("A: all products included (not just primary)", p.productImages.length === 2 && p.productImageCountRequested === 2);
  check("A: reference included as image input", p.styleRef === "https://cdn/ref.png" && p.referenceImageCountRequested === 1);
  check("A: prefers the stored hidden prompt (richer than the brief)", p.prompt.includes("REFERENCE REQUIREMENTS"));
  check("A: selectedTags preserved", !!p.selectedTags && p.selectedTags[0].label === "Street-style outfit");
  check("A: directionBrief preserved", (p.directionBrief ?? "").includes("street-style"));
  check("A: model preserved (gpt_image, not switched to gemini)", p.modelKey === "gpt_image");
  check("A: creative_direction_v2 mode", p.promptMode === "creative_direction_v2" && p.promptVersion === 2);
  check("A: product metadata carried (title/url)", p.productMetadata[0].productUrl === "https://shop/p1");
  check("A: count is exactly 1 (one new variation)", p.count === 1);
}

console.log("\n=== B. Regenerate missing setup snapshot → no provider call ===\n");
{
  const none = buildRegeneratePayload(null, {});
  check("B: hasSetup false when snapshot missing", none.hasSetup === false);
  const emptySnap = buildRegeneratePayload({ selectedProducts: [], selectedReferences: [], promptSnapshot: "" }, {});
  check("B: hasSetup false when snapshot has no products/refs/prompt", emptySnap.hasSetup === false);
  check("B: missing-setup copy matches Step 5", regenerateErrorCopy("missing_setup").title === "This Pin is missing its original setup");
}

console.log("\n=== E. Count behavior (single new variation, never the old batch count) ===\n");
{
  // Even if the original batch was count=8, Regenerate asks for ONE; the route's
  // MAX_IMAGES_PER_REQUEST then clamps anyway. The payload itself is always 1.
  const p = buildRegeneratePayload({ ...fullSnap }, { refUrl: "https://cdn/ref.png" });
  check("E: regenerate payload count is 1 regardless of original batch size", p.count === 1);
}

console.log("\n=== G. Setup persistence — text-only fallback impossible when images exist ===\n");
{
  const p = buildRegeneratePayload(fullSnap, { refUrl: "https://cdn/ref.png" });
  check("G: images are sent (so backend cannot text-only fallback)",
    p.productImages.length > 0 && p.referenceImageCountRequested === 1);
  // legacy snapshot (no v2 meta) still rebuilds from products + prompt
  const legacy = buildRegeneratePayload({
    selectedProducts: [{ imageUrl: "https://cdn/p.png", title: "thing" }],
    promptSnapshot: "make a nice pin", category: "home-decor", modelKey: "gemini_image",
  }, {});
  check("G: legacy snapshot → legacy mode, still has product image + prompt",
    legacy.hasSetup && legacy.promptMode === "legacy" && legacy.productImages.length === 1 && legacy.prompt.length > 0);
  check("G: legacy snapshot preserves its saved model", legacy.modelKey === "gemini_image");
}

console.log("\n=== D. P0 error copy (no raw provider JSON) ===\n");
{
  check("D: provider_busy copy", regenerateErrorCopy("provider_busy").title === "Generation is busy");
  check("D: user_generation_limit copy", regenerateErrorCopy("user_generation_limit").body.includes("already have a generation running"));
  check("D: configuration_error copy", regenerateErrorCopy("configuration_error").title === "Generation is not configured correctly");
  check("D: unknown falls back to safe generic copy", /Couldn’t generate this Pin/.test(regenerateErrorCopy("weird_provider_500").title));
  check("D: no raw JSON leaks for any code",
    ["provider_busy", "user_generation_limit", "configuration_error", "missing_setup", undefined]
      .every(c => { const m = regenerateErrorCopy(c as string); return !/\{|\}|inline_data|http_status/.test(m.title + m.body); }));
}

console.log("\n=== 1. Imageless-retry guard (no empty /api/generate request) ===\n");
{
  // Original batch = 2 products + 1 ref; recovery yielded ZERO images → block.
  check("guard: blocks when original used images but none recovered/sent",
    shouldBlockImagelessRetry(2, 1, 0, 0) === true);
  // Recovery restored the images → allow.
  check("guard: allows when product images recovered", shouldBlockImagelessRetry(2, 1, 2, 0) === false);
  check("guard: allows when only the reference recovered", shouldBlockImagelessRetry(2, 1, 0, 1) === false);
  // Original was text-only (no images) → never block on images.
  check("guard: text-only original is not blocked", shouldBlockImagelessRetry(0, 0, 0, 0) === false);
  check("missing-setup copy is the exact Step-5 text",
    regenerateErrorCopy("missing_setup").title === "This Pin is missing its original setup"
    && regenerateErrorCopy("missing_setup").body === "Please create a new generation instead.");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
