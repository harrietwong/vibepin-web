import assert from "node:assert/strict";
import {
  buildManualBrief,
  buildSelectedCreativeAssets,
  getRecommendedCreativeDirections,
  inferCreativeCategory,
  normalizeCategory,
  type GuidedControls,
} from "../src/lib/studio/creativeDirections";
import type { AssetItem } from "../src/lib/assetStore";
import type { CreatePinsPrefill } from "../src/lib/createPinsPrefill";

function asset(partial: Partial<AssetItem> & Pick<AssetItem, "role" | "imageUrl" | "source">): AssetItem {
  return {
    id: partial.id ?? `asset-${Math.random()}`,
    createdAt: "2026-06-15T00:00:00.000Z",
    lastUsedAt: "2026-06-15T00:00:00.000Z",
    ...partial,
  };
}

const stored = [
  asset({
    id: "prod-1",
    role: "product",
    source: "product_ideas",
    imageUrl: "https://example.com/jeans.png",
    title: "Wide leg jeans",
    category: "fashion",
    keyword: "summer outfit",
    productUrl: "https://shop.example/jeans",
  }),
  asset({
    id: "ref-1",
    role: "style_reference",
    source: "viral_pin",
    imageUrl: "https://example.com/mirror.png",
    title: "Mirror outfit reference",
    category: "fashion",
    visualFormat: "mirror_selfie",
  }),
];

const prefill: CreatePinsPrefill = {
  source: "viral_pins",
  pinReferences: [{
    id: "ref-prefill",
    imageUrl: "https://example.com/editorial.png",
    source: "viral_pins",
    title: "Editorial lookbook",
    category: "fashion",
    keyword: "boho outfit styling",
    visualFormat: "lookbook",
    humanPresence: "visible_person",
  }],
};

const selected = buildSelectedCreativeAssets({
  productUrls: ["https://example.com/jeans.png", "https://example.com/uploaded.png"],
  referenceUrls: ["https://example.com/mirror.png", "https://example.com/editorial.png"],
  storedAssets: stored,
  prefill,
});

assert.equal(selected.length, 4);
assert.equal(selected[0].metadataConfidence, "stored");
assert.equal(selected[0].role, "product");
assert.equal(selected[1].metadataConfidence, "url_only");
assert.equal(selected[1].role, "product");
assert.equal(selected[2].metadataConfidence, "stored");
assert.equal(selected[2].role, "reference");
assert.equal(selected[3].metadataConfidence, "prefill");
assert.equal(selected[3].role, "reference");

assert.equal(normalizeCategory(""), "generic");
assert.equal(normalizeCategory("summer outfit board"), "fashion");
assert.equal(inferCreativeCategory({ explicitCategory: "", assets: selected }), "fashion");

const fashionRecs = getRecommendedCreativeDirections({ category: "fashion", assets: selected });
assert.equal(fashionRecs.length, 3);
assert.ok(fashionRecs.every(r => r.category === "fashion"));
const fashionText = fashionRecs.map(r => `${r.title} ${r.summary}`).join(" ").toLowerCase();
for (const forbidden of ["bedroom", "living room", "room decor", "sofa", "bed", "vase"]) {
  assert.equal(fashionText.includes(forbidden), false, `fashion recommendation leaked ${forbidden}`);
}
// New architecture: Direction 1 is reference-driven (the mirror/lookbook refs read as
// on-model), Direction 2 is product-focused, Direction 3 is an alternative format.
assert.equal(fashionRecs[0].kind, "closest_to_reference");
assert.equal(fashionRecs[1].kind, "product_focused");
assert.equal(fashionRecs[2].kind, "alternative");
// The mirror/lookbook refs read as an outfit-oriented direction (on-model / mirror
// outfit / street-style) — never a flat lay or a generic scene.
assert.match(fashionRecs[0].title, /on-model|outfit|mirror|street-style|lookbook/i);
assert.ok(!/generic/i.test(fashionRecs[0].title), "fashion direction title must not say 'generic'");
assert.notEqual(fashionRecs[0].confidence, "low", "fashion outfit closest direction must not be LOW confidence");
assert.ok(fashionRecs.every(r => !!r.whyThisDirection && !!r.confidence && r.source === "creative_intelligence"));

const genericRecs = getRecommendedCreativeDirections({ category: "", assets: [] });
assert.ok(genericRecs.every(r => r.category === "generic"));

const controls: GuidedControls = { composition: "Flat lay", lighting: "Soft natural", mood: "Boho" };
const brief = buildManualBrief({
  selected: fashionRecs[0],
  guidedControls: controls,
  customInstructions: "no text overlay",
  opportunityContext: {
    enabled: true,
    removable: true,
    keyword: "summer outfit board",
    evidenceSentence: "Rising saves",
  },
});

assert.ok(brief.includes(fashionRecs[0].title), "brief must lead with the selected direction title");
assert.match(brief, /composition: Flat lay/);
assert.match(brief, /Custom instructions: no text overlay/);
assert.match(brief, /Market angle: summer outfit board/);

console.log("Creative Direction V2 tests passed");
