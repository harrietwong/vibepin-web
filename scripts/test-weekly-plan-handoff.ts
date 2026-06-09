/**
 * Weekly Plan handoff tests
 * Run: npx tsx scripts/test-weekly-plan-handoff.ts
 */
import {
  buildWeeklyPlanItemFromGeneratedPin,
  canAddGeneratedPinToPlan,
  sanitizeHandoffField,
} from "../src/lib/weeklyPlanHandoff";
import { EMPTY_TOUCHED } from "../src/lib/pinMetadata";
import * as pinDraftStore from "../src/lib/pinDraftStore";

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

const basePin = {
  id: "sess_g0_p0",
  url: "https://example.com/pin.png",
  title: "Cozy Bedroom Ideas",
  description: "Save these cozy bedroom ideas for your home.",
  altText: "Cozy bedroom pin",
  destinationUrl: "",
  plannedDate: "",
  metadataTouched: EMPTY_TOUCHED,
  metadataDraft: {
    titleCandidates: ["Cozy Bedroom Ideas"],
    selectedTitle: "Cozy Bedroom Ideas",
    descriptionCandidates: ["Save these cozy bedroom ideas for your home."],
    selectedDescription: "Save these cozy bedroom ideas for your home.",
    altText: "Cozy bedroom pin",
    confidence: "high" as const,
    sourceReasons: ["Used opportunity keyword as primary topic."],
    updatedAt: new Date().toISOString(),
  },
};

const baseSession = {
  id: "sess_001",
  keyword: "cozy bedroom",
  category: "home-decor",
  source: "studio",
  status: "completed",
  savedAt: "2026-06-06T10:00:00.000Z",
  promptFull: "Create a cozy bedroom scene.",
  model: "GPT Image 2",
  format: "Pinterest 2:3",
  setupSnapshot: {
    mode: "keyword_led",
    keyword: "cozy bedroom",
    category: "home-decor",
    opportunityTitle: "Cozy Bedroom Decor",
    noTextOverlay: true,
    imagesPerReference: 2,
    selectedProducts: [],
    selectedReferences: [{ imageUrl: "https://x/r.png" }],
    promptSnapshot: "Create a cozy bedroom scene.",
    createdFrom: "studio",
  },
};

test("buildWeeklyPlanItemFromGeneratedPin maps metadata correctly", () => {
  const item = buildWeeklyPlanItemFromGeneratedPin({
    pin: basePin,
    session: baseSession,
    groupStatus: "done",
    autoPlannedDate: "2026-06-10",
  });
  assert(!!item, "payload null");
  assert(item!.title === "Cozy Bedroom Ideas", "title mismatch");
  assert(item!.description.includes("cozy bedroom"), "description mismatch");
  assert(item!.altText === "Cozy bedroom pin", "altText mismatch");
  assert(item!.metadataDraft?.selectedTitle === "Cozy Bedroom Ideas", "metadataDraft dropped");
  assert(item!.setupSnapshot?.opportunityTitle === "Cozy Bedroom Decor", "setup snapshot dropped");
  assert(item!.promptSnapshot === "Create a cozy bedroom scene.", "prompt dropped");
  assert(item!.generationStatus === "completed", "generation status wrong");
  assert(item!.planningStatus === "ready", "should be ready with date");
});

test("completed pin with title + description + plannedDate becomes ready", () => {
  const item = buildWeeklyPlanItemFromGeneratedPin({
    pin: { ...basePin, plannedDate: "2026-06-12" },
    session: baseSession,
    groupStatus: "done",
  });
  assert(item!.planningStatus === "ready", `got ${item!.planningStatus}`);
});

test("completed pin missing plannedDate becomes needs_review", () => {
  const item = buildWeeklyPlanItemFromGeneratedPin({
    pin: basePin,
    session: baseSession,
    groupStatus: "done",
  });
  assert(item!.planningStatus === "needs_review", `got ${item!.planningStatus}`);
});

test("completed pin missing title becomes needs_review", () => {
  const item = buildWeeklyPlanItemFromGeneratedPin({
    pin: { ...basePin, title: "", metadataDraft: undefined },
    session: baseSession,
    groupStatus: "done",
    autoPlannedDate: "2026-06-10",
  });
  assert(item!.planningStatus === "needs_review", `got ${item!.planningStatus}`);
});

test("missing destinationUrl does not block ready", () => {
  const item = buildWeeklyPlanItemFromGeneratedPin({
    pin: { ...basePin, destinationUrl: "", plannedDate: "2026-06-10" },
    session: baseSession,
    groupStatus: "done",
  });
  assert(item!.planningStatus === "ready", "destination should not block ready");
  assert(item!.destinationUrl === "", "empty destination preserved");
});

test("failed/generating pins are skipped", () => {
  assert(!canAddGeneratedPinToPlan("failed", basePin), "failed group should skip");
  assert(!canAddGeneratedPinToPlan("generating", basePin), "generating group should skip");
  assert(!buildWeeklyPlanItemFromGeneratedPin({ pin: basePin, session: baseSession, groupStatus: "failed" }), "failed returns null");
});

test("duplicate Add to Plan is ignored via canAddGeneratedPinToPlan", () => {
  assert(!canAddGeneratedPinToPlan("done", { ...basePin, planningStatus: "needs_review" }), "already added");
  assert(!canAddGeneratedPinToPlan("done", { ...basePin, planningStatus: "ready" }), "already added ready");
});

test("setup_snapshot is preserved in payload", () => {
  const item = buildWeeklyPlanItemFromGeneratedPin({ pin: basePin, session: baseSession, groupStatus: "done" });
  assert(item!.setupSnapshot?.selectedReferences.length === 1, "references missing");
  assert(item!.opportunity === "Cozy Bedroom Decor", "opportunity missing");
});

test("metadataDraft is preserved in payload", () => {
  const item = buildWeeklyPlanItemFromGeneratedPin({ pin: basePin, session: baseSession, groupStatus: "done" });
  assert(item!.metadataDraft?.confidence === "high", "metadata draft missing");
});

test("pinDraftStore.createFromHandoff persists extended fields", () => {
  if (typeof localStorage === "undefined") return;
  localStorage.clear();
  const item = buildWeeklyPlanItemFromGeneratedPin({
    pin: basePin,
    session: baseSession,
    groupStatus: "done",
    autoPlannedDate: "2026-06-11",
  })!;
  const draft = pinDraftStore.createFromHandoff(item);
  assert(!!draft, "draft not created");
  assert(draft!.pinId === basePin.id, "pinId not stored");
  assert(draft!.setupSnapshot?.keyword === "cozy bedroom", "setup not stored");
  assert(draft!.metadataDraft?.selectedTitle === "Cozy Bedroom Ideas", "metadataDraft not stored");
  const dup = pinDraftStore.createFromHandoff(item);
  assert(dup!.id === draft!.id, "duplicate not ignored");
});

test("recomputeDraftStatus after clearing title", () => {
  assert(
    pinDraftStore.recomputeDraftStatus({ title: "A", description: "B", scheduledDate: "2026-06-10" }) === "ready",
    "title+desc+date should be ready",
  );
  assert(
    pinDraftStore.recomputeDraftStatus({ title: "", description: "B", scheduledDate: "2026-06-10" }) === "needs_review",
    "missing title should be needs_review",
  );
});

test("sanitizeHandoffField strips nullish strings", () => {
  assert(sanitizeHandoffField("null") === "", "null string");
  assert(sanitizeHandoffField("  hello ") === "hello", "trim");
});

console.log(`\nWeekly Plan handoff: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
