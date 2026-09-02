/** Owner-scoped, setup-only persistence for the Reference drawer. */
import assert from "node:assert";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  get length() { return this.values.size; }
}

const storage = new MemoryStorage();
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = storage;
(globalThis as unknown as { window: { dispatchEvent: () => boolean; addEventListener: () => void } }).window = {
  dispatchEvent: () => true,
  addEventListener: () => undefined,
};

const setup = {
  productImages: ["https://cdn/product.jpg"],
  productSelections: [{
    id: "shopify-product-1", title: "A linked product", source: "shopify" as const,
    imageUrl: "https://cdn/product.jpg", publicUrl: "https://shop.example/products/1",
    storeDomain: "shop.example", selectionOrigin: "explicit_picker" as const, asPrimary: true,
  }],
  referenceImages: ["https://cdn/ref.jpg", "https://cdn/ref-2.jpg"],
  referenceSelections: [
    { id: "ref-1", imageUrl: "https://cdn/ref.jpg", source: "recommended_pin" as const, sourceUrl: "https://pinterest.example/pin/1", reason: "palette", patternTags: { palette: ["warm"] }, role: "style_reference" as const },
    { id: "ref-2", imageUrl: "https://cdn/ref-2.jpg", source: "upload" as const, role: "style_reference" as const },
  ],
  count: 4,
  format: "Pinterest 2:3",
  modelKey: "gemini_image",
  variationMode: "distinct" as const,
  selectedDirectionId: "direction-1",
  selectedTagIds: ["style-clean"],
  directionBrief: "Committed direction only",
  briefManuallyEdited: true,
};

async function main(): Promise<void> {
  const pinDraftStore = await import("../src/lib/pinDraftStore");
  const setupStore = await import("../src/lib/studio/creativeSetupStore");

  pinDraftStore.setPinDraftOwnerScope("owner-a", "workspace-1");
  assert.equal(setupStore.saveCreativeSetup("draft-1", setup), true);
  assert.deepEqual(setupStore.loadCreativeSetup("draft-1"), setup, "close/reopen restores provenance and committed direction");

  const stored = setupStore.loadCreativeSetup("draft-1")!;
  assert.equal(stored.productSelections?.[0]?.id, "shopify-product-1", "product id provenance survives reopen");
  assert.equal(stored.productSelections?.[0]?.publicUrl, "https://shop.example/products/1", "product link provenance survives reopen");
  assert.equal(stored.productSelections?.[0]?.selectionOrigin, "explicit_picker", "selection origin survives reopen");
  assert.equal(stored.referenceSelections?.[0]?.source, "recommended_pin", "reference source survives reopen");
  assert.equal(stored.referenceSelections?.[0]?.sourceUrl, "https://pinterest.example/pin/1", "reference linkback survives reopen");
  assert.deepEqual(stored.referenceSelections?.[0]?.patternTags, { palette: ["warm"] }, "reference pattern provenance survives reopen");
  assert.equal(stored.referenceSelections?.length, 2, "all selected references survive reopen");
  assert.equal(stored.count, 4, "count 4 survives reopen");
  stored.directionBrief = "local mutation";
  const mutableTags = stored.referenceSelections![0].patternTags as { palette?: string[] };
  mutableTags.palette![0] = "local mutation";
  assert.equal(setupStore.loadCreativeSetup("draft-1")?.directionBrief, "Committed direction only", "loaded objects cannot mutate the persisted setup");
  assert.deepEqual(setupStore.loadCreativeSetup("draft-1")?.referenceSelections?.[0]?.patternTags, { palette: ["warm"] });

  pinDraftStore.setPinDraftOwnerScope("owner-a", "workspace-2");
  assert.equal(setupStore.loadCreativeSetup("draft-1"), undefined, "workspace 2 cannot see workspace 1 setup");

  pinDraftStore.setPinDraftOwnerScope("owner-b", "workspace-1");
  assert.equal(setupStore.loadCreativeSetup("draft-1"), undefined, "owner B cannot see owner A's setup");
  assert.equal(setupStore.saveCreativeSetup("draft-1", { ...setup, directionBrief: "Owner B" }), true);

  pinDraftStore.setPinDraftOwnerScope("owner-a", "workspace-1");
  assert.equal(setupStore.loadCreativeSetup("draft-1")?.directionBrief, "Committed direction only", "switching back restores owner A, not B");
  assert.notEqual(
    setupStore.creativeSetupStorageKeyForTest("owner-a", "workspace-1"),
    setupStore.creativeSetupStorageKeyForTest("owner-b", "workspace-1"),
  );

  const scratchProduct = {
    title: "Scratch", imageUrl: "https://cdn/scratch.jpg", source: "manual" as const,
    publicUrl: "https://merchant.example/product/42",
  };
  const scratchKey = setupStore.creativeSetupKeyForScratchProduct(scratchProduct);
  assert.equal(scratchKey, setupStore.creativeSetupKeyForScratchProduct({ ...scratchProduct }), "scratch key is stable for the same product");
  assert.match(scratchKey, /^scratch:digest:[0-9a-f]{8}$/, "URL-only scratch identity uses an opaque digest");
  assert.doesNotMatch(scratchKey, /merchant\.example|scratch\.jpg/i, "scratch key never exposes merchant URL or image URL");
  assert.notEqual(
    scratchKey,
    setupStore.creativeSetupKeyForScratchProduct({ ...scratchProduct, publicUrl: "https://merchant.example/product/43" }),
    "different URL-only products do not share scratch state",
  );
  assert.equal(setupStore.creativeSetupKeyForScratchProduct({ ...scratchProduct, id: "stable-product-id" }), "scratch:product:stable-product-id", "stable product id gets a readable non-URL key");

  // Runtime A→B→A coverage for every scratch key shape used by StudioBoard. The
  // drawer may remain mounted during an auth/workspace transition, so this must be
  // proven through the scoped store rather than only a source-string guard.
  const scratchSetups = [
    ["scratch:empty", "A empty scratch"],
    ["scratch:product:stable-product-id", "A stable-product scratch"],
    [scratchKey, "A digest scratch"],
  ] as const;
  for (const [key, directionBrief] of scratchSetups) {
    assert.equal(setupStore.saveCreativeSetup(key, { ...setup, directionBrief }), true);
  }
  pinDraftStore.setPinDraftOwnerScope("owner-b", "workspace-2");
  for (const [key] of scratchSetups) assert.equal(setupStore.loadCreativeSetup(key), undefined, `B cannot read A ${key}`);
  assert.equal(setupStore.saveCreativeSetup("scratch:product:stable-product-id", { ...setup, directionBrief: "B scratch" }), true);
  pinDraftStore.setPinDraftOwnerScope("owner-a", "workspace-1");
  for (const [key, directionBrief] of scratchSetups) {
    assert.equal(setupStore.loadCreativeSetup(key)?.directionBrief, directionBrief, `A restores its own ${key}`);
  }

  const serialized = JSON.stringify(setupStore.loadCreativeSetup("draft-1"));
  for (const forbidden of ["generationJobId", "placeholder", "toast", "usage", "reservation", "providerResponse"]) {
    assert.ok(!serialized.includes(forbidden), `setup persistence must not create ${forbidden}`);
  }

  console.log("Creative setup persistence: 27 passed, 0 failed");
}

main().catch(error => { console.error(error); process.exit(1); });
