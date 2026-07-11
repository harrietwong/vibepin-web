/**
 * Product-level generation recovery / audit / language regression tests.
 *
 * Run:
 *   npx tsx scripts/test-generation-recovery-audit-language.ts
 *
 * This does not call the image API. It validates the persisted records and UI
 * data contracts that live generation depends on:
 *   - setupSnapshot + categoryAudit survive local/DB reload
 *   - Remix recovery uses the batch/pin snapshot, not current composer state
 *   - Weekly Plan handoff carries the original setup
 *   - Product linking supports Primary + tagged products
 *   - AI content language follows contentLanguage, not UI language
 */

import {
  addHistory,
  clearHistory,
  createRunningSessionInDb,
  fetchGenerationsFromDb,
  loadHistory,
  updateSessionInDb,
  type CategoryAudit,
  type HistoryEntry,
  type SetupSnapshot,
} from "../src/lib/studioPersistence";
import {
  getGenerationSetupSnapshot,
  resolvePinDetail,
  type PinDetailEntry,
  type PinDetailSession,
} from "../src/components/studio/pinDetails";
import {
  addProductToDraft,
  cleanProductTitle,
  generateBatchMetadataDraft,
  generatePinMetadataDraft,
  metadataReadinessLabel,
  promoteProductToPrimary,
  removeProductFromDraft,
  resolvePinProducts,
  setPrimaryProductUrl,
  type LinkedProduct,
  type PinMetadataDraft,
} from "../src/lib/pinMetadata";
import { buildWeeklyPlanItemFromGeneratedPin } from "../src/lib/weeklyPlanHandoff";

type TestFn = () => void | Promise<void>;

let passed = 0;
let failed = 0;
const fullOutput: string[] = [];

function log(line: string) {
  fullOutput.push(line);
  console.log(line);
}

async function test(name: string, fn: TestFn) {
  try {
    await fn();
    passed++;
    log(`  OK ${name}`);
  } catch (error) {
    failed++;
    log(`  FAIL ${name}`);
    log(`       ${(error as Error).message}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEq<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertNoDataUrl(value: unknown, message: string) {
  const raw = JSON.stringify(value);
  assert(!raw.includes("data:image/"), message);
}

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string) { return this.store.get(key) ?? null; }
  setItem(key: string, value: string) { this.store.set(key, String(value)); }
  removeItem(key: string) { this.store.delete(key); }
  clear() { this.store.clear(); }
}

Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  configurable: true,
});

function setupSnapshot(category: string, opts: {
  prompt?: string;
  products?: number;
  refs?: number;
  dataUrl?: boolean;
  model?: string;
  format?: string;
} = {}): SetupSnapshot {
  const products = opts.products ?? 1;
  const refs = opts.refs ?? 1;
  const img = (kind: string, i: number) => opts.dataUrl
    ? `data:image/png;base64,${Buffer.from(`${category}-${kind}-${i}`).toString("base64")}`
    : `https://cdn.vibepin.test/${category}/${kind}-${i}.png`;
  return {
    mode: "product_led",
    keyword: `${category || "generic"} validation`,
    category,
    opportunityTitle: `${category || "generic"} validation`,
    noTextOverlay: true,
    imagesPerReference: 1,
    selectedProducts: Array.from({ length: products }, (_, i) => ({
      productId: `${category || "generic"}-prod-${i + 1}`,
      imageUrl: img("product", i + 1),
      title: productTitleForCategory(category, i),
      source: "my_products",
      productUrl: `https://shop.example.com/${category || "generic"}/p-${i + 1}`,
      sourceDomain: "shop.example.com",
    })),
    selectedReferences: Array.from({ length: refs }, (_, i) => ({
      referenceId: `${category || "generic"}-ref-${i + 1}`,
      imageUrl: img("reference", i + 1),
      title: `${category || "generic"} reference ${i + 1}`,
      source: "validation",
      visualFormat: category === "fashion" ? "flat_lay" : category === "home-decor" ? "room_scene" : "product_scene",
    })),
    promptSnapshot: opts.prompt ?? promptForCategory(category),
    createdFrom: "studio",
    format: opts.format ?? "Pinterest 2:3",
    model: opts.model ?? "GPT Image 2",
    modelKey: "gpt_image",
  };
}

function productTitleForCategory(category: string, i: number): string {
  const titles: Record<string, string> = {
    fashion: i === 0 ? "Boho Denim Handbag Outfit Set" : "Layered Linen Outfit",
    "home-decor": i === 0 ? "Ceramic Vase and Throw Blanket" : "Oak Accent Chair",
    beauty: i === 0 ? "Glow Serum and Moisturizer" : "Rose Lip Tint",
    "food-and-drink": i === 0 ? "Iced Coffee and Pastry Pairing" : "Cafe Syrup Bottle",
    "digital-products": i === 0 ? "Printable Planner Template" : "Notion Dashboard Pack",
  };
  return titles[category] ?? `Minimal Product ${i + 1}`;
}

function promptForCategory(category: string): string {
  switch (category) {
    case "fashion": return "boho outfit styling flat lay";
    case "home-decor": return "warm neutral living room styling";
    case "beauty": return "glowy skincare routine";
    case "food-and-drink": return "iced coffee pastry pairing";
    case "digital-products": return "printable planner mockup";
    default: return "minimal product showcase";
  }
}

function auditForCategory(category: string, frontendCategory = category): CategoryAudit {
  const fashion = category === "fashion";
  return {
    frontendCategory,
    detectedCategory: category,
    effectiveCategory: category,
    inferredCategory: category,
    outputType:
      category === "fashion" ? "editorial"
      : category === "beauty" ? "beauty-lifestyle"
      : category === "food-and-drink" ? "food-lifestyle"
      : category === "digital-products" ? "digital-mockup"
      : category === "home-decor" ? "lifestyle"
      : "editorial",
    productImageCount: 1,
    referenceImageCount: 1,
    finalPrompt:
      category === "home-decor"
        ? "Create warm neutral shelf, room, interior, cozy styling."
        : `Create ${category} product styling. No home decor drift.`,
    homeDriftTerms: category === "home-decor" ? ["living room"] : [],
    fashionSafetyApplied: fashion,
    enhancerFailed: false,
    categorySource: frontendCategory ? "frontend" : "generator_inference",
  };
}

function historyEntry(category: string, opts: { dataUrl?: boolean; categoryAudit?: CategoryAudit; products?: number; refs?: number } = {}): HistoryEntry {
  const setup = setupSnapshot(category, { dataUrl: opts.dataUrl, products: opts.products, refs: opts.refs });
  return {
    id: `session-${category || "generic"}-${Math.random().toString(36).slice(2, 7)}`,
    savedAt: "2026-06-13T08:00:00.000Z",
    keyword: setup.keyword ?? "",
    category,
    source: "studio",
    groups: [{
      refUrl: setup.selectedReferences[0]?.imageUrl ?? null,
      images: ["https://cdn.vibepin.test/generated/pin-1.png"],
      visualFormat: setup.selectedReferences[0]?.visualFormat,
    }],
    refCount: setup.selectedReferences.length,
    productCount: setup.selectedProducts.length,
    totalPins: 1,
    status: "completed",
    expectedTotal: 1,
    imagesPerRef: 1,
    promptExcerpt: setup.promptSnapshot.slice(0, 120),
    promptFull: setup.promptSnapshot,
    setupSnapshot: setup,
    categoryAudit: opts.categoryAudit ?? auditForCategory(category),
  };
}

function detailFromEntry(entry: HistoryEntry) {
  const session: PinDetailSession = {
    id: entry.id,
    savedAt: entry.savedAt,
    keyword: entry.keyword,
    category: entry.category,
    source: entry.source,
    status: entry.status ?? "completed",
    promptFull: entry.promptFull,
    setupSnapshot: entry.setupSnapshot,
    groups: entry.groups.map((g, idx) => ({ refUrl: g.refUrl, refIndex: idx, status: "done" })),
    categoryAudit: entry.categoryAudit,
    model: entry.setupSnapshot?.model,
    format: entry.setupSnapshot?.format,
  };
  const pin = {
    id: `${entry.id}-pin-1`,
    url: entry.groups[0]?.images[0] ?? "",
    planningStatus: "not_added",
    title: "",
    description: "",
    setupSnapshot: entry.setupSnapshot,
    generationSetup: entry.setupSnapshot,
    batchId: entry.id,
    requestId: `${entry.id}-pin-1`,
    createdAt: entry.savedAt,
  };
  const detailEntry: PinDetailEntry = {
    key: pin.id,
    sessionId: entry.id,
    groupIdx: 0,
    pinIdx: 0,
    pin,
    status: "completed",
    refLabel: "Reference 1",
    createdAt: entry.savedAt,
  };
  return resolvePinDetail(session, detailEntry, entry);
}

function makeFakeSupabase(rows: Record<string, unknown>[] = []) {
  return {
    rows,
    auth: {
      async getUser() {
        return { data: { user: { id: "user-test" } } };
      },
    },
    from() {
      return {
        async insert(row: Record<string, unknown>) {
          rows.push({ id: `db-${rows.length + 1}`, created_at: "2026-06-13T08:00:00.000Z", ...row });
          return { data: null, error: null };
        },
        update(patch: Record<string, unknown>) {
          return {
            async eq(_col: string, val: unknown) {
              const hit = rows.find(r => r.session_id === val);
              if (hit) Object.assign(hit, patch);
              return { data: null, error: null };
            },
          };
        },
        select() {
          return {
            eq() {
              return {
                order() {
                  return {
                    async limit() {
                      return { data: rows, error: null };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

function englishOnly(s: string) {
  return !/[\u4e00-\u9fff]/.test(s);
}

function hasChinese(s: string) {
  return /[\u4e00-\u9fff]/.test(s);
}

function emptyDraft(): PinMetadataDraft {
  return {
    titleCandidates: [],
    selectedTitle: "",
    descriptionCandidates: [],
    selectedDescription: "",
    altText: "",
    confidence: "medium",
    sourceReasons: [],
    updatedAt: "2026-06-13T08:00:00.000Z",
  };
}

async function main() {
log("Generation recovery/category/language regression");
log(`Working directory: ${process.cwd()}`);

await test("Category audit persists for fashion after reload", () => {
  clearHistory();
  const entry = historyEntry("fashion", { categoryAudit: auditForCategory("fashion", "") });
  addHistory(entry);
  const restored = loadHistory()[0];
  const detail = detailFromEntry(restored);
  const gen = getGenerationSetupSnapshot(detail);
  assertEq(detail.categoryAudit?.detectedCategory, "fashion", "detectedCategory");
  assertEq(detail.categoryAudit?.effectiveCategory, "fashion", "effectiveCategory");
  assert(detail.categoryAudit?.categorySource, "categorySource visible");
  assert(detail.categoryAudit?.outputType.includes("editorial"), "fashion output type");
  assert((detail.categoryAudit?.productImageCount ?? 0) > 0, "productImageCount > 0");
  assert((detail.categoryAudit?.referenceImageCount ?? 0) > 0, "referenceImageCount > 0");
  assert(detail.categoryAudit?.finalPrompt, "finalPromptPreview exists");
  assertEq(detail.categoryAudit?.fashionSafetyApplied, true, "fashion safety");
  assertEq(gen.recoveryQuality, "full", "setup recovered fully");
});

await test("Category audit persists for home decor after reload", () => {
  clearHistory();
  const entry = historyEntry("home-decor");
  addHistory(entry);
  const detail = detailFromEntry(loadHistory()[0]);
  assertEq(detail.categoryAudit?.detectedCategory, "home-decor", "detectedCategory");
  assertEq(detail.categoryAudit?.effectiveCategory, "home-decor", "effectiveCategory");
  assert(detail.categoryAudit?.finalPrompt.includes("room"), "home decor prompt can include room styling");
});

for (const category of ["beauty", "food-and-drink", "digital-products"] as const) {
  await test(`Category audit persists for ${category}`, () => {
    clearHistory();
    const entry = historyEntry(category);
    addHistory(entry);
    const detail = detailFromEntry(loadHistory()[0]);
    assertEq(detail.categoryAudit?.detectedCategory, category, "detectedCategory");
    assertEq(detail.categoryAudit?.effectiveCategory, category, "effectiveCategory");
    assert(detail.categoryAudit?.finalPrompt, "final prompt exists");
    assertEq(detail.categoryAudit?.homeDriftTerms.length, 0, "no home drift terms");
  });
}

await test("DB persisted record contains setupSnapshot and categoryAudit", async () => {
  const fake = makeFakeSupabase();
  const entry = historyEntry("fashion", { categoryAudit: auditForCategory("fashion", "") });
  await createRunningSessionInDb(fake, entry);
  await updateSessionInDb(fake, entry.id, {
    groups_json: entry.groups,
    pin_urls: entry.groups.flatMap(g => g.images),
    total_pins: 1,
    status: "completed",
    category_audit: entry.categoryAudit,
  });
  const fetched = await fetchGenerationsFromDb(fake);
  assertEq(fetched.length, 1, "fetched row count");
  assert(fetched[0].setupSnapshot, "setupSnapshot exists");
  assert(fetched[0].categoryAudit, "categoryAudit exists");
  assertEq(fetched[0].categoryAudit?.effectiveCategory, "fashion", "effective category fetched");
  assert(fetched[0].setupSnapshot!.selectedProducts.length > 0, "selectedProducts persisted");
  assert(fetched[0].setupSnapshot!.selectedReferences.length > 0, "selectedReferences persisted");
});

await test("Local upload DB compact snapshot strips data URLs but preserves counts", async () => {
  const fake = makeFakeSupabase();
  const entry = historyEntry("fashion", { dataUrl: true });
  await createRunningSessionInDb(fake, entry);
  const inserted = fake.rows[0];
  assertNoDataUrl(inserted.setup_snapshot, "DB setup_snapshot must not store large data URLs");
  const setup = inserted.setup_snapshot as SetupSnapshot;
  assertEq(setup.selectedProducts.length, 1, "product count preserved");
  assertEq(setup.selectedReferences.length, 1, "reference count preserved");
});

await test("Remix immediate restore uses original batch snapshot", () => {
  const entry = historyEntry("fashion", { products: 2, refs: 2 });
  const detail = detailFromEntry(entry);
  const gen = getGenerationSetupSnapshot(detail);
  assertEq(gen.productImages.length, 2, "2 product images restored");
  assertEq(gen.pinReferences.length, 2, "2 references restored");
  assertEq(gen.prompt, entry.setupSnapshot!.promptSnapshot, "creative direction restored");
  assertEq(gen.aspectRatio, "Pinterest 2:3", "format restored");
  assertEq(gen.model, "GPT Image 2", "model restored");
  assertEq(gen.recoveryQuality, "full", "no partial recovery banner");
});

await test("Remix after current composer changes still uses original snapshot", () => {
  const original = historyEntry("fashion", { products: 1, refs: 1 });
  const currentComposer = setupSnapshot("home-decor", { products: 1, refs: 1 });
  const detail = detailFromEntry(original);
  const gen = getGenerationSetupSnapshot(detail);
  assert(!gen.productImages.includes(currentComposer.selectedProducts[0].imageUrl!), "does not use current product");
  assert(!gen.pinReferences.includes(currentComposer.selectedReferences[0].imageUrl), "does not use current reference");
  assert(gen.prompt.includes("boho outfit"), "uses original prompt");
});

await test("Weekly Plan handoff preserves setupSnapshot visual inputs", () => {
  const entry = historyEntry("fashion", { products: 2, refs: 2 });
  const pin = {
    id: "pin-weekly",
    url: entry.groups[0].images[0],
    planningStatus: "not_added",
    title: "Boho Outfit Ideas",
    description: "A polished outfit board.",
    altText: "Boho outfit flat lay.",
    setupSnapshot: entry.setupSnapshot,
  };
  const payload = buildWeeklyPlanItemFromGeneratedPin({
    pin,
    session: entry,
    groupStatus: "done",
    autoPlannedDate: "2026-06-15",
  });
  assert(payload, "payload created");
  assertEq(payload.setupSnapshot?.selectedProducts.length, 2, "products carried");
  assertEq(payload.setupSnapshot?.selectedReferences.length, 2, "refs carried");
  assertEq(payload.category, "fashion", "category carried");
});

await test("Product linking supports primary and additional tagged products", () => {
  const primary: LinkedProduct = { title: "Primary Bag", productUrl: "https://shop.example.com/bag", imageUrl: "https://img/bag.png", source: "my_products", linkType: "manual" };
  const second: LinkedProduct = { title: "Tagged Jeans", productUrl: "https://shop.example.com/jeans", imageUrl: "https://img/jeans.png", source: "my_products", linkType: "manual" };
  let draft = addProductToDraft(emptyDraft(), primary, true);
  draft = addProductToDraft(draft, second, false);
  let products = resolvePinProducts(draft);
  assertEq(products.primary?.title, "Primary Bag", "primary remains primary");
  assertEq(products.tagged.length, 1, "second product tagged");
  draft = promoteProductToPrimary(draft, "https://shop.example.com/jeans");
  products = resolvePinProducts(draft);
  assertEq(products.primary?.title, "Tagged Jeans", "tagged can become primary");
  const removed = removeProductFromDraft(draft, "https://shop.example.com/jeans");
  products = resolvePinProducts(removed.draft);
  assertEq(products.primary?.title, "Primary Bag", "old primary promoted back after removal");
});

await test("Destination URL uses primary product URL only when requested", () => {
  const primary: LinkedProduct = { title: "Primary Bag", productUrl: "https://shop.example.com/bag", imageUrl: "https://img/bag.png", source: "my_products", linkType: "manual" };
  let draft = addProductToDraft(emptyDraft(), primary, true);
  assertEq(draft.destinationUrl ?? "", "", "destination not auto-filled by manual add");
  draft = setPrimaryProductUrl(draft, primary.productUrl!);
  assertEq(resolvePinProducts(draft).primary?.productUrl, primary.productUrl, "primary URL stored");
});

await test("Batch metadata fills missing fields without overwriting touched custom URLs", () => {
  const setup = setupSnapshot("fashion", { products: 1, refs: 1 });
  const drafts = generateBatchMetadataDraft([
    { pinId: "empty-url", category: "fashion", setupSnapshot: setup, touched: {} },
    {
      pinId: "custom-url",
      category: "fashion",
      setupSnapshot: setup,
      touched: { destinationUrlTouched: true },
      existingDraft: { destinationUrl: "https://custom.example.com" },
    },
  ], { sharedDestinationUrl: "https://shared.example.com", overwriteEdited: false });
  assertEq(drafts["empty-url"].destinationUrl, "https://shared.example.com", "empty URL filled");
  assertEq(drafts["custom-url"].destinationUrl, "https://custom.example.com", "custom URL preserved");
});

await test("AI content language English remains English with Chinese app UI", () => {
  const draft = generatePinMetadataDraft({
    category: "fashion",
    setupSnapshot: setupSnapshot("fashion"),
    contentLanguage: "en",
  });
  assert(englishOnly(draft.selectedTitle), "title should be English only");
  assert(englishOnly(draft.selectedDescription), "description should be English only");
  assert(englishOnly(draft.altText), "alt text should be English only");
});

await test("AI content language Chinese can generate Chinese metadata", () => {
  const draft = generatePinMetadataDraft({
    category: "fashion",
    setupSnapshot: setupSnapshot("fashion"),
    contentLanguage: "zh-CN",
  });
  assert(hasChinese(draft.selectedTitle) || hasChinese(draft.selectedDescription) || hasChinese(draft.altText), "Chinese content expected");
});

await test("Product title cleanup removes domains, slugs, and bilingual fragments", () => {
  const cleaned = cleanProductTitle("Tonal Blue Paisley Mesh Butterfly Top | Cojira — motelrocks-com-us搭配灵感", "en");
  assert(!/motelrocks|com-us|搭配|灵感/i.test(cleaned), `domain/CJK fragments remain: ${cleaned}`);
  assert(!cleaned.includes("EditorialTonal"), "malformed EditorialTonal remains");
});

await test("Generated card workflow labels are not meaningless Ready", () => {
  assertEq(metadataReadinessLabel({ planningStatus: "not_added", title: "", description: "", plannedDate: "" }), "Missing title", "missing title label");
  assertEq(metadataReadinessLabel({ planningStatus: "not_added", title: "T", description: "D", plannedDate: "" }), "Needs date", "needs date label");
  assertEq(metadataReadinessLabel({ planningStatus: "added_to_plan", title: "T", description: "D", plannedDate: "" }), "Added to Plan", "added label");
});

log(`\nGeneration recovery/category/language: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
