import assert from "node:assert/strict";
import { detectCreatePins } from "../src/lib/assistant/detectors/createPins";
import {
  detectBatch,
  buildBatchFindings,
  countBatchIssues,
  similarTitleGroups,
  titleSimilarity,
  normalizeTitle,
  type BatchPinLike,
} from "../src/lib/assistant/detectors/batchEdit";
import { detectSinglePin } from "../src/lib/assistant/detectors/singlePin";
import { respondToChat } from "../src/lib/assistant/chat";
import { matchKnowledge } from "../src/lib/assistant/knowledge";
import { deriveDefaultContext } from "../src/lib/assistant/pageContext";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

const id = (f: { id: string }) => f.id;

// ── Create Pins ───────────────────────────────────────────────────────────────
test("createPins: empty setup flags incomplete + always offers angles", () => {
  const f = detectCreatePins({ creativeDirection: "", productCount: 0, productsMissingLink: 0, referenceCount: 0 });
  assert.ok(f.map(id).includes("create:setup"));
  assert.ok(f.map(id).includes("create:angles"));
  // Nothing is falsely an "issue" when there's no data.
  assert.equal(f.filter((x) => x.severity === "issue").length, 0);
});

test("createPins: missing product links is a real issue", () => {
  const f = detectCreatePins({ creativeDirection: "a rich detailed brief with plenty of words here", productCount: 2, productsMissingLink: 2, referenceCount: 0 });
  const links = f.find((x) => x.id === "create:missing-links");
  assert.ok(links);
  assert.equal(links!.severity, "issue");
  assert.match(links!.title, /2 products are missing links/);
});

test("createPins: short direction flagged only when there is setup", () => {
  const withSetup = detectCreatePins({ creativeDirection: "too short", productCount: 1, productsMissingLink: 0, referenceCount: 0 });
  assert.ok(withSetup.map(id).includes("create:direction-short"));
  const noSetup = detectCreatePins({ creativeDirection: "too short", productCount: 0, productsMissingLink: 0, referenceCount: 0 });
  assert.ok(!noSetup.map(id).includes("create:direction-short"));
});

test("createPins: small reference flagged only under threshold", () => {
  const small = detectCreatePins({ creativeDirection: "brief brief brief brief brief brief", productCount: 0, productsMissingLink: 0, referenceCount: 1, smallestReferenceMinDim: 400 });
  assert.ok(small.map(id).includes("create:ref-small"));
  const big = detectCreatePins({ creativeDirection: "brief brief brief brief brief brief", productCount: 0, productsMissingLink: 0, referenceCount: 1, smallestReferenceMinDim: 1200 });
  assert.ok(!big.map(id).includes("create:ref-small"));
});

// ── Title similarity ──────────────────────────────────────────────────────────
test("titleSimilarity: identical titles ~1, unrelated ~0", () => {
  assert.ok(titleSimilarity(normalizeTitle("cozy fall home decor"), normalizeTitle("cozy fall home decor")) >= 0.99);
  assert.ok(titleSimilarity(normalizeTitle("cozy fall home decor"), normalizeTitle("industrial kitchen gadgets")) < 0.2);
});

test("similarTitleGroups: clusters near-duplicates, ignores singletons", () => {
  const pins: BatchPinLike[] = [
    p({ id: "1", title: "Cozy fall home decor ideas" }),
    p({ id: "2", title: "Cozy fall home decor tips" }),
    p({ id: "3", title: "Modern minimalist office setup" }),
  ];
  const groups = similarTitleGroups(pins);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sort(), ["1", "2"]);
});

// ── Batch Edit ────────────────────────────────────────────────────────────────
function p(over: Partial<BatchPinLike>): BatchPinLike {
  return {
    id: "x", title: "Title", description: "A perfectly adequate description that is long enough.",
    boardId: "b1", destinationUrl: "https://example.com", imageUrl: "https://cdn/x.jpg",
    hasProduct: false, ...over,
  };
}

test("detectBatch: counts missing boards, urls, product links, weak descriptions", () => {
  const pins: BatchPinLike[] = [
    p({ id: "1", boardId: "", destinationUrl: "", description: "short" }),
    p({ id: "2", hasProduct: true, productUrl: "" }),
    p({ id: "3" }),
  ];
  const r = detectBatch(pins);
  assert.deepEqual(r.missingBoards, ["1"]);
  assert.deepEqual(r.missingUrls, ["1"]);
  assert.deepEqual(r.productLinksToReview, ["2"]);
  assert.deepEqual(r.weakDescriptions, ["1"]);
});

test("detectBatch: duplicate images grouped; schedule conflicts need 3+ same board/day", () => {
  const pins: BatchPinLike[] = [
    p({ id: "1", imageUrl: "https://cdn/same.jpg", boardId: "b", plannedDate: "2026-07-10" }),
    p({ id: "2", imageUrl: "https://cdn/same.jpg", boardId: "b", plannedDate: "2026-07-10" }),
    p({ id: "3", imageUrl: "https://cdn/other.jpg", boardId: "b", plannedDate: "2026-07-10" }),
  ];
  const r = detectBatch(pins);
  assert.equal(r.duplicateImageGroups.length, 1);
  assert.equal(r.duplicateImageGroups[0].length, 2);
  assert.equal(r.scheduleConflicts.length, 1);
  assert.equal(r.scheduleConflicts[0].pinIds.length, 3);
});

test("buildBatchFindings: board finding downgrades to review without a safe apply", () => {
  const r = detectBatch([p({ id: "1", boardId: "" })]);
  // No preview handler → must be a review action, never an apply with no run.
  const f = buildBatchFindings(r, {});
  const boards = f.find((x) => x.id === "batch:boards");
  assert.ok(boards);
  assert.ok(boards!.actions.every((a) => a.kind !== "apply"));
});

test("buildBatchFindings: board finding offers preview-gated apply when safe", () => {
  const r = detectBatch([p({ id: "1", boardId: "" })]);
  const f = buildBatchFindings(r, {
    previewSuggestBoards: () => ({ title: "Suggest boards", changes: [{ label: "Pin", before: "No board", after: "Home Decor" }] }),
    applySuggestBoards: () => {},
  });
  const apply = f.find((x) => x.id === "batch:boards")!.actions.find((a) => a.kind === "apply");
  assert.ok(apply);
  assert.ok(apply!.preview, "apply action must carry a preview");
});

test("countBatchIssues: clean batch has zero issues (no fabricated findings)", () => {
  const r = detectBatch([
    p({ id: "1", imageUrl: "https://cdn/a.jpg" }),
    p({ id: "2", title: "Totally different heading", imageUrl: "https://cdn/b.jpg" }),
  ]);
  assert.equal(countBatchIssues(r), 0);
});

// ── Chat-first behavior ─────────────────────────────────────────────────────────
test("createPins: angles card is a hidden capability, not proactive", () => {
  const f = detectCreatePins({ creativeDirection: "a nice long detailed brief here indeed", productCount: 1, productsMissingLink: 0, referenceCount: 0 });
  const angles = f.find((x) => x.id === "create:angles");
  assert.ok(angles);
  assert.notEqual(angles!.proactive, true);
  assert.ok((angles!.triggers?.length ?? 0) > 0);
});

test("default settings context shows NO cards by default (all capabilities hidden)", () => {
  const ctx = deriveDefaultContext("/app/settings");
  assert.ok(ctx.greeting && ctx.greeting.length > 0);
  assert.ok((ctx.examplePrompts?.length ?? 0) > 0);
  assert.equal(ctx.findings.filter((f) => f.proactive === true).length, 0);
});

test("chat answers pricing WITHOUT routing to setup checks", () => {
  const ctx = deriveDefaultContext("/app/settings");
  const { reply, revealIds } = respondToChat("How should I price this?", ctx);
  assert.match(reply.toLowerCase(), /pric/);
  assert.equal(revealIds.length, 0);
});

test("chat reveals setup checks only when asked ('check my setup')", () => {
  const ctx = deriveDefaultContext("/app/settings");
  const { revealIds } = respondToChat("check my setup", ctx);
  assert.ok(revealIds.length >= 1, "should reveal at least one capability");
  // The revealed ids must correspond to hidden capabilities in the context.
  revealIds.forEach((id) => assert.ok(ctx.findings.some((f) => f.id === id && f.proactive !== true)));
});

test("chat reveals only the affiliate capability for a targeted affiliate question", () => {
  const ctx = deriveDefaultContext("/app/settings");
  const { revealIds } = respondToChat("how should I set up affiliate links?", ctx);
  assert.ok(revealIds.includes("cap:affiliate"));
});

// ── Product knowledge (FAQ) + not-sure fallback ─────────────────────────────────
test("knowledge: high-risk topics have official answers and win ties", () => {
  assert.equal(matchKnowledge("can I get a refund?")?.id, "refunds");
  assert.equal(matchKnowledge("what is your refund policy")?.highRisk, true);
  assert.equal(matchKnowledge("can I use these images commercially?")?.id, "copyright");
});

test("knowledge: general FAQ answers connect/publish/getting-started", () => {
  assert.equal(matchKnowledge("how do I connect Pinterest?")?.id, "connect-pinterest");
  assert.equal(matchKnowledge("why can't I publish this pin")?.id, "publishing-readiness");
  assert.equal(matchKnowledge("how do I get started?")?.id, "onboarding");
});

test("knowledge: unknown question returns null (no fabrication)", () => {
  assert.equal(matchKnowledge("what's the weather in Paris tomorrow?"), null);
  assert.equal(matchKnowledge("write me a poem about cats"), null);
});

test("chat: VibePin pricing question routes to knowledge, not workflow", () => {
  const ctx = deriveDefaultContext("/app/settings");
  const r = respondToChat("what are your plans and pricing?", ctx);
  assert.equal(r.source, "knowledge");
  assert.match(r.reply, /Billing|Pricing/);
});

test("chat: unknown question yields the not-sure fallback with support pointer", () => {
  const ctx = deriveDefaultContext("/app/products");
  const r = respondToChat("what's the capital of Mongolia?", ctx);
  assert.equal(r.source, "fallback");
  assert.match(r.reply.toLowerCase(), /not sure/);
  assert.match(r.reply.toLowerCase(), /support|docs/);
});

test("chat: refund question gives the official answer and points to support", () => {
  const ctx = deriveDefaultContext("/app/settings");
  const r = respondToChat("I want a refund", ctx);
  assert.equal(r.source, "knowledge");
  assert.match(r.reply.toLowerCase(), /support/);
});

// ── Single Pin ────────────────────────────────────────────────────────────────
test("singlePin: ready when all managed fields present (board not managed)", () => {
  const f = detectSinglePin({
    imageUrl: "https://cdn/x.jpg", title: "T", description: "D", altText: "A",
    destinationUrl: "https://example.com", boardManaged: false,
  });
  assert.ok(f.some((x) => x.id === "single:ready"));
  assert.ok(!f.some((x) => x.id === "single:missing"));
});

test("singlePin: board not flagged when surface doesn't manage it", () => {
  const f = detectSinglePin({
    imageUrl: "https://cdn/x.jpg", title: "T", description: "D", altText: "A",
    destinationUrl: "https://example.com", boardId: "", boardManaged: false,
  });
  const missing = f.find((x) => x.id === "single:missing");
  assert.ok(!missing, "board should not make a studio pin 'need details'");
});

test("singlePin: missing schedule time surfaces its own issue", () => {
  const f = detectSinglePin({
    imageUrl: "https://cdn/x.jpg", title: "T", description: "D", altText: "A",
    destinationUrl: "https://example.com", boardManaged: false, scheduleTimeMissing: true,
  });
  assert.ok(f.some((x) => x.id === "single:schedule-time" && x.severity === "issue"));
});

test("singlePin: affiliate-ready shows a positive ready card", () => {
  const f = detectSinglePin({
    imageUrl: "https://cdn/x.jpg", title: "T", description: "D", altText: "A",
    destinationUrl: "https://example.com", boardManaged: false, hasProduct: true, affiliateReady: true,
  });
  const aff = f.find((x) => x.id === "single:affiliate");
  assert.ok(aff);
  assert.equal(aff!.severity, "ready");
});

console.log(`\nassistant-detectors: ${passed} passed`);
