/**
 * Pin metadata draft generation tests
 * Run: npx tsx scripts/test-pin-metadata.ts
 */
import {
  generatePinMetadataDraft,
  generateBatchMetadataDraft,
  resolveMetadataTopic,
  computePlanningStatusFromFields,
  isSearchInformedContext,
  isImageOnlyContext,
  getTitleCandidateEntries,
  shouldShowLowConfidenceHint,
  pinNeedsDetailsGeneration,
  EMPTY_TOUCHED,
} from "../src/lib/pinMetadata";
import type { SetupSnapshot } from "../src/lib/studioPersistence";

export {};

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  OK ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${(e as Error).message}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

const baseSetup: SetupSnapshot = {
  mode: "product_led",
  keyword: "cozy bedroom decor",
  category: "home-decor",
  opportunityTitle: "Cozy Bedroom Decor",
  noTextOverlay: true,
  imagesPerReference: 2,
  selectedProducts: [],
  selectedReferences: [{ imageUrl: "https://x/r.png", visualFormat: "flat_lay" }],
  promptSnapshot: "Create a cozy bedroom scene with warm lighting.",
  createdFrom: "studio",
};

test("Metadata prioritizes opportunity over reference", () => {
  const topic = resolveMetadataTopic({
    opportunityTitle: "Cozy Bedroom Decor",
    setupSnapshot: { ...baseSetup, selectedReferences: [{ imageUrl: "x", title: "Mirror selfie ref" }] },
    promptSnapshot: "generic prompt",
  });
  assert(topic === "Cozy Bedroom Decor", `expected opportunity topic, got ${topic}`);
});

test("Product title beats reference for topic when no opportunity", () => {
  const setup = {
    ...baseSetup,
    opportunityTitle: undefined,
    selectedProducts: [{ imageUrl: "p.png", title: "Linen Throw Pillow", source: "product_signals", productUrl: "https://shop.com/pillow" }],
  };
  const draft = generatePinMetadataDraft({ setupSnapshot: setup, category: "home-decor" });
  assert(draft.selectedTitle.toLowerCase().includes("linen") || draft.selectedTitle.toLowerCase().includes("pillow"), "title should reflect product");
  assert(draft.confidence === "high", "imported product should be high confidence");
});

test("Uploaded product without metadata yields warning and low/medium confidence", () => {
  const setup = {
    ...baseSetup,
    selectedProducts: [{ imageUrl: "upload.png", title: "", source: "uploaded" }],
  };
  const draft = generatePinMetadataDraft({ setupSnapshot: setup, promptSnapshot: "Cozy scene" });
  assert(draft.confidence === "low" || draft.confidence === "medium", `confidence ${draft.confidence}`);
  assert(draft.sourceReasons.some(r => r.includes("Product name missing")), "missing product warning");
});

test("Single product URL auto-fills destinationUrl", () => {
  const setup = {
    ...baseSetup,
    selectedProducts: [{ imageUrl: "p.png", title: "Pillow", source: "url_import", productUrl: "https://shop.example/pillow" }],
  };
  const draft = generatePinMetadataDraft({ setupSnapshot: setup });
  assert(draft.destinationUrl === "https://shop.example/pillow", "destination URL not set");
});

test("Multiple product URLs do not auto-select destination", () => {
  const setup = {
    ...baseSetup,
    selectedProducts: [
      { imageUrl: "a.png", title: "A", productUrl: "https://a.com" },
      { imageUrl: "b.png", title: "B", productUrl: "https://b.com" },
    ],
  };
  const draft = generatePinMetadataDraft({ setupSnapshot: setup });
  assert(!draft.destinationUrl, "should not pick random URL");
  assert(draft.sourceReasons.some(r => r.includes("Multiple product URLs")), "multi URL reason");
});

test("Title candidates max 100 characters", () => {
  const draft = generatePinMetadataDraft({
    opportunityTitle: "A".repeat(80),
    setupSnapshot: baseSetup,
    category: "home-decor",
  });
  draft.titleCandidates.forEach(t => assert(t.length <= 100, `title too long: ${t.length}`));
  assert(draft.selectedTitle.length <= 100, "selected title too long");
});

test("Description max 800 characters", () => {
  const draft = generatePinMetadataDraft({
    promptSnapshot: "x".repeat(900),
    setupSnapshot: baseSetup,
    category: "home-decor",
  });
  assert(draft.selectedDescription.length <= 800, "description too long");
  draft.descriptionCandidates.forEach(d => assert(d.length <= 800, "candidate too long"));
});

test("Alt text max 500 characters", () => {
  const draft = generatePinMetadataDraft({ setupSnapshot: baseSetup, imageCaption: "y".repeat(600) });
  assert(draft.altText.length <= 500, "alt text too long");
});

test("Add to Plan sets ready when title + description + plannedDate exist", () => {
  const status = computePlanningStatusFromFields({
    title: "Cozy Bedroom Ideas",
    description: "Save these ideas for your space.",
    plannedDate: "2026-06-10",
    wasAdded: true,
  });
  assert(status === "ready", `expected ready, got ${status}`);
});

test("Add to Plan sets needs_review when required fields missing", () => {
  assert(
    computePlanningStatusFromFields({ title: "", description: "x", plannedDate: "2026-06-10", wasAdded: true }) === "needs_review",
    "empty title should be needs_review",
  );
  assert(
    computePlanningStatusFromFields({ title: "x", description: "", plannedDate: "2026-06-10", wasAdded: true }) === "needs_review",
    "empty description should be needs_review",
  );
  assert(
    computePlanningStatusFromFields({ title: "x", description: "y", plannedDate: "", wasAdded: true }) === "needs_review",
    "empty plannedDate should be needs_review",
  );
});

test("Batch metadata generates unique titles per pin", () => {
  const results = generateBatchMetadataDraft([
    { pinId: "p1", pinIndex: 0, setupSnapshot: baseSetup, category: "home-decor", keyword: "cozy bedroom" },
    { pinId: "p2", pinIndex: 1, setupSnapshot: baseSetup, category: "home-decor", keyword: "cozy bedroom" },
  ]);
  assert(results.p1.selectedTitle !== results.p2.selectedTitle, "titles should differ");
});

test("Search-informed label appears when opportunity keyword exists", () => {
  const draft = generatePinMetadataDraft({
    opportunityTitle: "Cozy Bedroom Decor",
    setupSnapshot: baseSetup,
    category: "home-decor",
  });
  const entries = getTitleCandidateEntries(draft);
  assert(entries.some(e => e.sourceLabel === "Search-informed" || e.sourceLabel === "Opportunity-based"), "expected search-backed label");
});

test("Image-only pins are marked Image-based or Low confidence", () => {
  const setup = {
    ...baseSetup,
    opportunityTitle: undefined,
    keyword: undefined,
    selectedProducts: [{ imageUrl: "upload.png", title: "", source: "uploaded" }],
    selectedReferences: [],
    promptSnapshot: "",
  };
  const draft = generatePinMetadataDraft({ setupSnapshot: setup, category: "home-decor" });
  const entries = getTitleCandidateEntries(draft);
  assert(entries.every(e => e.sourceLabel === "Image-based" || e.sourceLabel === "Low confidence"), `got ${entries.map(e => e.sourceLabel).join(",")}`);
  assert(isImageOnlyContext({ setupSnapshot: setup }), "should detect image-only");
  assert(!isSearchInformedContext({ setupSnapshot: setup }), "image-only is not search-informed");
});

test("pinNeedsDetailsGeneration detects missing fields", () => {
  assert(pinNeedsDetailsGeneration({ title: "", description: "x", altText: "y" }), "missing title");
  assert(!pinNeedsDetailsGeneration({ title: "a", description: "b", altText: "c", metadataDraft: generatePinMetadataDraft({ setupSnapshot: baseSetup }) }), "complete");
});

test("Low confidence hint when titles are not search-informed", () => {
  const setup = {
    ...baseSetup,
    opportunityTitle: undefined,
    keyword: undefined,
    selectedProducts: [{ imageUrl: "upload.png", title: "", source: "uploaded" }],
    selectedReferences: [],
    promptSnapshot: "",
  };
  const draft = generatePinMetadataDraft({ setupSnapshot: setup });
  assert(shouldShowLowConfidenceHint(draft), "should show hint");
});

test("metadataTouched fields are not overwritten unless allowed", () => {
  const existing = generatePinMetadataDraft({ setupSnapshot: baseSetup, pinIndex: 0 });
  const results = generateBatchMetadataDraft([{
    pinId: "p1",
    setupSnapshot: baseSetup,
    touched: { ...EMPTY_TOUCHED, titleTouched: true },
    existingDraft: { ...existing, selectedTitle: "My Custom Title" },
  }], { overwriteEdited: false });
  assert(results.p1.selectedTitle === "My Custom Title", "touched title overwritten");
  const forced = generateBatchMetadataDraft([{
    pinId: "p1",
    setupSnapshot: baseSetup,
    touched: { ...EMPTY_TOUCHED, titleTouched: true },
    existingDraft: { ...existing, selectedTitle: "My Custom Title" },
  }], { overwriteEdited: true });
  assert(forced.p1.selectedTitle !== "My Custom Title", "overwrite should apply");
});

console.log(`\nPin metadata: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
