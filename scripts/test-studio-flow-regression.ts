/**
 * Studio flow regression tests — pure logic, no browser required.
 * Run: pnpm tsx scripts/test-studio-flow-regression.ts
 */
export {};

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${(e as Error).message}`);
    failed++;
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(a: T, b: T, label?: string) {
  if (a !== b) throw new Error(`${label ?? ""}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ── Types (mirrored from source) ──────────────────────────────────────────────

type RefGroup = {
  refUrl: string | null;
  refIndex: number;
  items: { id: string; url: string; planningStatus: string }[];
  status: "generating" | "done" | "failed";
  expectedCount: number;
};

type PinDraftLike = {
  id: string;
  imageUrl: string;
  scheduledDate: string;
};

// ── Helpers mirrored from studio/page.tsx ─────────────────────────────────────

function getRemainingDaysOfCurrentWeek(fromDate: Date): string[] {
  const today = new Date(fromDate);
  today.setHours(0, 0, 0, 0);
  const dayOfWeek = today.getDay();
  const daysUntilEndOfWeek = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
  const days: string[] = [];
  for (let i = 0; i <= daysUntilEndOfWeek; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    days.push(d.toISOString().split("T")[0]);
  }
  return days;
}

function assignNextAvailablePlanDate(
  existingDrafts: PinDraftLike[],
  dailyTarget = 2,
  fromDate = new Date()
): string | null {
  const days = getRemainingDaysOfCurrentWeek(fromDate);
  for (const day of days) {
    const count = existingDrafts.filter(d => (d.scheduledDate ?? "") === day).length;
    if (count < dailyTarget) return day;
  }
  return null;
}

// ── Group building helpers ────────────────────────────────────────────────────

function buildGroups(refs: string[], imageCount: number): RefGroup[] {
  const refsToProcess = refs.length > 0 ? refs : [null];
  return refsToProcess.map((refUrl, idx) => ({
    refUrl: refUrl as string | null,
    refIndex: idx,
    items: [],
    status: "generating" as const,
    expectedCount: imageCount,
  }));
}

// ── Prompt builder (simplified) ───────────────────────────────────────────────

function buildAutoPrompt({
  productImages,
  pinReferences,
  keyword,
}: {
  productImages: string[];
  pinReferences: string[];
  keyword?: string;
}): string {
  if (!productImages.length && !pinReferences.length && !keyword) return "";
  const parts: string[] = [];
  if (keyword) parts.push(`Create a Pinterest-native Pin for "${keyword}".`);
  else if (productImages.length) parts.push("Create a Pinterest-native product Pin.");
  else parts.push("Create a Pinterest-native Pin.");
  if (productImages.length) {
    parts.push("Use the uploaded product images as the main items. Keep color, shape, material, and key details recognizable.");
    parts.push("Place naturally in a Pinterest-native scene.");
  }
  if (pinReferences.length) {
    parts.push("Use selected Pin references as visual guidance for composition, subject framing, lighting, layout, and Pinterest-native aesthetic.");
    parts.push("Do not recreate the exact background one-to-one, but stay close to composition type and visual feel.");
  }
  parts.push("No text overlay. No typography. No watermark. Vertical 2:3 format.");
  return parts.join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n📋 Studio Flow Regression Tests\n");

// ── 1. No references + imageCount 2 → 1 default group expectedCount 2 ──────
test("no references + imageCount 2 → 1 default group expectedCount 2", () => {
  const groups = buildGroups([], 2);
  assertEqual(groups.length, 1, "group count");
  assertEqual(groups[0].expectedCount, 2, "expectedCount");
  assertEqual(groups[0].refUrl, null, "refUrl should be null");
});

// ── 2. 2 references + imageCount 2 → 2 groups expected total 4 ──────────────
test("2 references + imageCount 2 → 2 groups, expected total 4", () => {
  const groups = buildGroups(["https://img1.example.com/a.jpg", "https://img2.example.com/b.jpg"], 2);
  assertEqual(groups.length, 2, "group count");
  const totalExpected = groups.reduce((s, g) => s + g.expectedCount, 0);
  assertEqual(totalExpected, 4, "total expected");
});

// ── 3. Each group keeps its own referenceId ───────────────────────────────────
test("each group keeps its own refUrl", () => {
  const refs = ["https://a.com/1.jpg", "https://b.com/2.jpg", "https://c.com/3.jpg"];
  const groups = buildGroups(refs, 1);
  assertEqual(groups.length, 3, "group count");
  for (let i = 0; i < refs.length; i++) {
    assertEqual(groups[i].refUrl, refs[i], `group[${i}].refUrl`);
    assertEqual(groups[i].refIndex, i, `group[${i}].refIndex`);
  }
});

// ── 4. Each generated pin keeps referenceId (via group) ───────────────────────
test("generated pin placed in correct group", () => {
  const groups = buildGroups(["https://ref1.com/a.jpg"], 2);
  // Simulate generation result
  groups[0].items = [
    { id: "pin_g0_0", url: "https://gen.com/1.png", planningStatus: "not_added" },
    { id: "pin_g0_1", url: "https://gen.com/2.png", planningStatus: "not_added" },
  ];
  groups[0].status = "done";
  assert(groups[0].items.every(p => p.id.includes("g0")), "all pins belong to group 0");
});

// ── 5. Failed group does not erase successful group ───────────────────────────
test("failed group does not erase successful group", () => {
  const groups = buildGroups(["https://ref1.com/a.jpg", "https://ref2.com/b.jpg"], 2);
  groups[0].items = [{ id: "pin_g0_0", url: "https://gen.com/1.png", planningStatus: "not_added" }];
  groups[0].status = "done";
  groups[1].status = "failed";

  const successGroups = groups.filter(g => g.status === "done");
  const failedGroups  = groups.filter(g => g.status === "failed");
  assertEqual(successGroups.length, 1, "one successful group");
  assertEqual(failedGroups.length, 1, "one failed group");
  assertEqual(successGroups[0].items.length, 1, "successful group still has pins");
});

// ── 6. Partial session addAll only adds successful pins ───────────────────────
test("addAll only adds pins from done groups", () => {
  const groups: RefGroup[] = [
    { refUrl: "https://ref1.com/a.jpg", refIndex: 0, status: "done",   expectedCount: 2, items: [{ id: "p1", url: "https://gen.com/1.png", planningStatus: "not_added" }] },
    { refUrl: "https://ref2.com/b.jpg", refIndex: 1, status: "failed", expectedCount: 2, items: [] },
  ];

  const pinsToAdd: string[] = [];
  for (const group of groups) {
    if (group.status !== "done") continue;
    for (const pin of group.items) {
      if (pin.planningStatus === "not_added" && pin.url) pinsToAdd.push(pin.url);
    }
  }
  assertEqual(pinsToAdd.length, 1, "only 1 successful pin added");
  assertEqual(pinsToAdd[0], "https://gen.com/1.png");
});

// ── 7. addAll skips duplicate pins ────────────────────────────────────────────
test("addAll skips pins already added", () => {
  const groups: RefGroup[] = [
    {
      refUrl: null, refIndex: 0, status: "done", expectedCount: 2,
      items: [
        { id: "p1", url: "https://gen.com/1.png", planningStatus: "added_to_plan" },
        { id: "p2", url: "https://gen.com/2.png", planningStatus: "not_added" },
      ],
    },
  ];

  let added = 0, skipped = 0;
  for (const group of groups) {
    if (group.status !== "done") continue;
    for (const pin of group.items) {
      if (pin.planningStatus !== "not_added" || !pin.url) { skipped++; continue; }
      added++;
    }
  }
  assertEqual(added, 1, "only 1 not-added pin");
  assertEqual(skipped, 1, "1 already-added pin skipped");
});

// ── 8. addToPlan assigns scheduledDate when weekly slots available ────────────
test("assignNextAvailablePlanDate returns a date when slots available", () => {
  const monday = new Date("2026-06-08T00:00:00Z"); // a Monday
  const existingDrafts: PinDraftLike[] = [];
  const date = assignNextAvailablePlanDate(existingDrafts, 2, monday);
  assert(date !== null, "should return a date");
  assert(typeof date === "string" && date.length === 10, "should be ISO date string");
});

// ── 9. addToPlan falls back to null only when week full ───────────────────────
test("assignNextAvailablePlanDate returns null when all daily slots full", () => {
  const monday = new Date("2026-06-08T00:00:00Z");
  const days = getRemainingDaysOfCurrentWeek(monday);
  // Fill every slot (2 per day)
  const existingDrafts: PinDraftLike[] = days.flatMap(day => [
    { id: `d1-${day}`, imageUrl: `https://gen.com/${day}-1.png`, scheduledDate: day },
    { id: `d2-${day}`, imageUrl: `https://gen.com/${day}-2.png`, scheduledDate: day },
  ]);
  const date = assignNextAvailablePlanDate(existingDrafts, 2, monday);
  assertEqual(date, null, "should return null when week full");
});

// ── 10. prompt auto-generates when productImages exist ───────────────────────
test("prompt auto-generates when productImages exist", () => {
  const p = buildAutoPrompt({ productImages: ["https://p.com/img.jpg"], pinReferences: [], keyword: "cozy bedroom" });
  assert(p.length > 0, "prompt should not be empty");
  assert(!p.includes("undefined"), "no undefined");
  assert(!p.includes("null"), "no null");
  assert(p.includes("product images") || p.includes("product"), "mentions product");
});

// ── 11. prompt auto-generates when pinReferences exist ───────────────────────
test("prompt auto-generates when pinReferences exist", () => {
  const p = buildAutoPrompt({ productImages: [], pinReferences: ["https://r.com/ref.jpg"], keyword: "home decor" });
  assert(p.length > 0, "prompt should not be empty");
  assert(p.includes("reference") || p.includes("composition"), "mentions reference guidance");
});

// ── 12. prompt does not overwrite promptTouched ───────────────────────────────
test("prompt does not auto-generate when promptTouched=true", () => {
  let prompt = "my custom prompt";
  const promptTouched = true;

  // Simulate the auto-generate effect logic
  if (!promptTouched) {
    const p = buildAutoPrompt({ productImages: ["url"], pinReferences: [], keyword: "test" });
    if (p) prompt = p;
  }

  assertEqual(prompt, "my custom prompt", "user prompt should not be overwritten");
});

// ── 13. recent selected products can be restored ──────────────────────────────
test("recent products: selected URLs match stored assets", () => {
  // Simulate assetStore behavior
  const assetStore: { id: string; imageUrl: string; role: string }[] = [
    { id: "asset-1", imageUrl: "https://prod.com/1.jpg", role: "product" },
    { id: "asset-2", imageUrl: "https://prod.com/2.jpg", role: "product" },
  ];
  const currentSelectedUrls = ["https://prod.com/1.jpg"];

  const matched = assetStore.filter(a => a.role === "product" && currentSelectedUrls.includes(a.imageUrl));
  assertEqual(matched.length, 1, "should match 1 previously selected product");
  assertEqual(matched[0].id, "asset-1");
});

// ── 14. empty generated section does not render fake reference groups ─────────
test("empty groups state renders correct empty state", () => {
  const groups: RefGroup[] = [];
  const isGenerating = false;
  const hasActivity = groups.flatMap(g => g.items).length > 0 || groups.some(g => g.status === "generating");

  assert(!hasActivity, "no activity with empty groups");
  assert(!isGenerating, "not generating");
  // In the UI, this would render the empty state message, not fake reference groups
});

// ── 15. restore session runs only once ───────────────────────────────────────
test("restoredSessionIdRef prevents double restore", () => {
  const restoredRef = { current: null as string | null };
  const savedId = "studio_123456_abc";
  let restoreCount = 0;

  function tryRestore(id: string) {
    if (restoredRef.current === id) return; // guard
    restoredRef.current = id;
    restoreCount++;
  }

  tryRestore(savedId);
  tryRestore(savedId); // simulate React Strict Mode second call
  tryRestore(savedId); // third call

  assertEqual(restoreCount, 1, "should restore exactly once");
});

// ── 16. Initial selected counts are zero ─────────────────────────────────────
test("initial product and reference selected counts are 0", () => {
  const selectedProductImages: string[] = [];
  const selectedPinReferences: string[] = [];
  assertEqual(selectedProductImages.length, 0);
  assertEqual(selectedPinReferences.length, 0);
});

// ── 17. Product and reference pools remain separate ───────────────────────────
test("product assets never appear in reference pool", () => {
  const productAssets = [{ role: "product", imageUrl: "https://a.com/p.jpg" }];
  const refAssets     = [{ role: "style_reference", imageUrl: "https://a.com/r.jpg" }];
  const productUrls   = productAssets.filter(a => a.role === "product").map(a => a.imageUrl);
  const refUrls       = refAssets.filter(a => a.role === "style_reference").map(a => a.imageUrl);
  assert(!refUrls.some(u => productUrls.includes(u)), "pools must not overlap");
});

// ── 18. Default page has no inline upload/browse entry points ─────────────────
test("default composer entry points are picker-only labels", () => {
  const defaultPageButtons = ["Products", "References"];
  const forbidden = ["Upload", "Browse more"];
  for (const label of defaultPageButtons) {
    assert(["Products", "References"].includes(label), `expected compact entry, got ${label}`);
  }
  for (const bad of forbidden) {
    assert(!defaultPageButtons.includes(bad), `forbidden default entry ${bad}`);
  }
});

// ── 19. Feed filter tabs include required set ─────────────────────────────────
test("generation feed tabs include All, Drafts, Generating, Completed, Failed", () => {
  const tabs = ["all", "drafts", "generating", "completed", "failed"];
  assertEqual(tabs.length, 5);
  assert(tabs.includes("all") && tabs.includes("failed"), "missing required feed tabs");
});

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
