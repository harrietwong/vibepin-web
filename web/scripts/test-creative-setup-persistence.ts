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
  referenceImages: ["https://cdn/ref.jpg"],
  referenceSelections: [{ id: "ref-1", imageUrl: "https://cdn/ref.jpg", source: "recommended_pin" as const, sourceUrl: "https://pinterest.example/pin/1", role: "style_reference" as const }],
  count: 2,
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

  pinDraftStore.setPinDraftOwnerScope("owner-b", "workspace-1");
  assert.equal(setupStore.loadCreativeSetup("draft-1"), undefined, "owner B cannot see owner A's setup");
  assert.equal(setupStore.saveCreativeSetup("draft-1", { ...setup, directionBrief: "Owner B" }), true);

  pinDraftStore.setPinDraftOwnerScope("owner-a", "workspace-1");
  assert.equal(setupStore.loadCreativeSetup("draft-1")?.directionBrief, "Committed direction only", "switching back restores owner A, not B");
  assert.notEqual(
    setupStore.creativeSetupStorageKeyForTest("owner-a", "workspace-1"),
    setupStore.creativeSetupStorageKeyForTest("owner-b", "workspace-1"),
  );

  const serialized = JSON.stringify(setupStore.loadCreativeSetup("draft-1"));
  for (const forbidden of ["generationJobId", "placeholder", "toast", "usage", "reservation", "providerResponse"]) {
    assert.ok(!serialized.includes(forbidden), `setup persistence must not create ${forbidden}`);
  }

  console.log("Creative setup persistence: 6 passed, 0 failed");
}

main().catch(error => { console.error(error); process.exit(1); });
