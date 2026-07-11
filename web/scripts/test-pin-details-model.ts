/**
 * test-pin-details-model.ts
 * P1-A Phase 1: Tests for PinDetailsDraft model and mappers.
 * Focuses on the four highest-risk mapping rules:
 *   1. boardSuggestion must never become boardId
 *   2. destinationUrl must not be overwritten by productUrl
 *   3. plannedDate and plannedTime must be preserved separately
 *   4. needs_date / scheduled status rules
 */

import assert from "node:assert/strict";
import {
  mapStudioPinToDetailsDraft,
  mapPinDraftToDetailsDraft,
  type StudioPinLike,
  type PinDraftLike,
} from "../src/lib/pinDetailsModel";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK  ${name}`);
}

// ── Shared base fixtures ──────────────────────────────────────────────────────

const STUDIO_BASE: StudioPinLike = {
  url: "https://cdn.example.com/pin.jpg",
  title: "Studio Pin Title",
  description: "Studio description",
  altText: "Studio alt text",
  destinationUrl: "https://example.com/product",
  plannedDate: "",
  plannedTime: "",
  plannedAt: "",
  planningStatus: "not_added",
  metadataDraft: null,
};

const DRAFT_BASE: PinDraftLike = {
  imageUrl: "https://cdn.example.com/pin.jpg",
  title: "Draft Pin Title",
  description: "Draft description",
  altText: "Draft alt text",
  destinationUrl: "https://example.com/product",
  scheduledDate: "",
  scheduledTime: "",
  plannedAt: "",
  addedToPlanAt: "",
  postedAt: "",
  boardId: "",
  boardName: "",
  linkedProducts: [],
  primaryProductId: "",
  metadataDraft: null,
};

// ── 1. boardSuggestion must never become boardId ──────────────────────────────

console.log("\n=== Board safety ===");

test("Studio: boardSuggestion in metadataDraft does not become boardId", () => {
  const result = mapStudioPinToDetailsDraft({
    ...STUDIO_BASE,
    metadataDraft: {
      confidence: "low",
      sourceReasons: [],
      updatedAt: "",
      boardSuggestion: "Fashion & Style",
      boardId: undefined,
      boardName: undefined,
    } as never,
  });
  assert.equal(result.boardId, "", "boardId must be empty when no real board selected");
  assert.equal(result.boardSuggestion, "Fashion & Style", "boardSuggestion preserved for display");
});

test("Studio: real boardId from metadataDraft maps correctly", () => {
  const result = mapStudioPinToDetailsDraft({
    ...STUDIO_BASE,
    metadataDraft: {
      confidence: "high",
      sourceReasons: [],
      updatedAt: "",
      boardId: "real_board_123",
      boardName: "My Board",
      boardSuggestion: "ignored",
    } as never,
  });
  assert.equal(result.boardId, "real_board_123");
  assert.equal(result.boardName, "My Board");
  assert.equal(result.boardSuggestion, "ignored", "suggestion still preserved for display");
});

test("Draft: boardId from draft takes precedence, never from boardSuggestion", () => {
  const result = mapPinDraftToDetailsDraft({
    ...DRAFT_BASE,
    boardId: "plan_board_456",
    boardName: "Plan Board",
    metadataDraft: { confidence: "low", sourceReasons: [], updatedAt: "", boardSuggestion: "should not be boardId" } as never,
  });
  assert.equal(result.boardId, "plan_board_456");
  assert.equal(result.boardName, "Plan Board");
  assert.equal(result.boardSuggestion, "should not be boardId");
});

test("Draft: boardId empty when neither draft nor metadataDraft has one", () => {
  const result = mapPinDraftToDetailsDraft({
    ...DRAFT_BASE,
    boardId: "",
    metadataDraft: { confidence: "low", sourceReasons: [], updatedAt: "", boardSuggestion: "Fashion" } as never,
  });
  assert.equal(result.boardId, "", "boardSuggestion must not fill boardId");
});

test("Draft: boardId falls back to metadataDraft.boardId when draft.boardId is empty", () => {
  const result = mapPinDraftToDetailsDraft({
    ...DRAFT_BASE,
    boardId: "",
    metadataDraft: { confidence: "high", sourceReasons: [], updatedAt: "", boardId: "meta_board_789", boardName: "Meta Board", boardSuggestion: "" } as never,
  });
  assert.equal(result.boardId, "meta_board_789");
  assert.equal(result.boardName, "Meta Board");
});

// ── 2. destinationUrl vs productUrl ──────────────────────────────────────────

console.log("\n=== Destination URL vs product URL ===");

test("Studio: destinationUrl is preserved as-is", () => {
  const result = mapStudioPinToDetailsDraft({
    ...STUDIO_BASE,
    destinationUrl: "https://custom.example.com/landing",
  });
  assert.equal(result.destinationUrl, "https://custom.example.com/landing");
});

test("Studio: empty destinationUrl stays empty (productUrl is not substituted)", () => {
  const result = mapStudioPinToDetailsDraft({
    ...STUDIO_BASE,
    destinationUrl: "",
    metadataDraft: {
      confidence: "high",
      sourceReasons: [],
      updatedAt: "",
      primaryProduct: { title: "Product", source: "my_products", linkType: "auto", productUrl: "https://shop.example.com/p" },
    } as never,
  });
  assert.equal(result.destinationUrl, "", "productUrl must not fill empty destinationUrl");
});

test("Draft: custom destinationUrl is preserved unchanged", () => {
  const result = mapPinDraftToDetailsDraft({
    ...DRAFT_BASE,
    destinationUrl: "https://custom.example.com/landing",
    linkedProducts: [{ title: "P", source: "my_products", linkType: "auto", productUrl: "https://shop.example.com/p" }],
  });
  assert.equal(result.destinationUrl, "https://custom.example.com/landing");
});

test("Draft: empty destinationUrl stays empty (linkedProduct.productUrl not substituted)", () => {
  const result = mapPinDraftToDetailsDraft({
    ...DRAFT_BASE,
    destinationUrl: "",
    linkedProducts: [{ title: "P", source: "my_products", linkType: "auto", productUrl: "https://shop.example.com/p" }],
  });
  assert.equal(result.destinationUrl, "");
});

// ── 3. plannedDate and plannedTime preserved separately ───────────────────────

console.log("\n=== Planned date/time ===");

test("Studio: plannedDate and plannedTime preserved as separate fields", () => {
  const result = mapStudioPinToDetailsDraft({
    ...STUDIO_BASE,
    plannedDate: "2026-07-15",
    plannedTime: "14:30",
    plannedAt: "2026-07-15T14:30",
  });
  assert.equal(result.plannedDate, "2026-07-15");
  assert.equal(result.plannedTime, "14:30");
  assert.equal(result.plannedAt, "2026-07-15T14:30");
});

test("Studio: date-only (no time) preserved without inventing a time", () => {
  const result = mapStudioPinToDetailsDraft({
    ...STUDIO_BASE,
    plannedDate: "2026-07-15",
    plannedTime: "",
    plannedAt: "",
  });
  assert.equal(result.plannedDate, "2026-07-15");
  assert.equal(result.plannedTime, "");
});

test("Draft: scheduledDate → plannedDate, scheduledTime → plannedTime", () => {
  const result = mapPinDraftToDetailsDraft({
    ...DRAFT_BASE,
    scheduledDate: "2026-08-01",
    scheduledTime: "09:00",
    plannedAt: "2026-08-01T09:00",
  });
  assert.equal(result.plannedDate, "2026-08-01");
  assert.equal(result.plannedTime, "09:00");
  assert.equal(result.plannedAt, "2026-08-01T09:00");
});

test("Draft: date-only record with no scheduledTime yields empty plannedTime", () => {
  const result = mapPinDraftToDetailsDraft({
    ...DRAFT_BASE,
    scheduledDate: "2026-08-01",
    scheduledTime: "",
    plannedAt: "",
  });
  assert.equal(result.plannedDate, "2026-08-01");
  assert.equal(result.plannedTime, "");
});

// ── 4. needs_date / scheduled / not_planned / posted status rules ─────────────

console.log("\n=== Plan status ===");

test("Studio: not_added → not_planned", () => {
  assert.equal(mapStudioPinToDetailsDraft({ ...STUDIO_BASE, planningStatus: "not_added" }).planStatus, "not_planned");
});

test("Studio: added_to_plan with no date → needs_date", () => {
  assert.equal(mapStudioPinToDetailsDraft({ ...STUDIO_BASE, planningStatus: "added_to_plan", plannedDate: "" }).planStatus, "needs_date");
});

test("Studio: needs_review with no date → needs_date", () => {
  assert.equal(mapStudioPinToDetailsDraft({ ...STUDIO_BASE, planningStatus: "needs_review", plannedDate: "" }).planStatus, "needs_date");
});

test("Studio: added_to_plan with plannedDate → scheduled", () => {
  assert.equal(mapStudioPinToDetailsDraft({ ...STUDIO_BASE, planningStatus: "added_to_plan", plannedDate: "2026-07-01" }).planStatus, "scheduled");
});

test("Studio: plannedDate alone (not_added state possible if legacy) → scheduled wins", () => {
  assert.equal(mapStudioPinToDetailsDraft({ ...STUDIO_BASE, planningStatus: "not_added", plannedDate: "2026-07-01" }).planStatus, "scheduled");
});

test("Studio: posted → posted", () => {
  assert.equal(mapStudioPinToDetailsDraft({ ...STUDIO_BASE, planningStatus: "posted" }).planStatus, "posted");
});

test("Draft: no addedToPlanAt, no scheduledDate → not_planned", () => {
  assert.equal(mapPinDraftToDetailsDraft({ ...DRAFT_BASE, addedToPlanAt: "", scheduledDate: "" }).planStatus, "not_planned");
});

test("Draft: addedToPlanAt set, no scheduledDate → needs_date", () => {
  assert.equal(mapPinDraftToDetailsDraft({ ...DRAFT_BASE, addedToPlanAt: "2026-06-23T10:00:00Z", scheduledDate: "" }).planStatus, "needs_date");
});

test("Draft: scheduledDate set → scheduled (wins over addedToPlanAt)", () => {
  assert.equal(mapPinDraftToDetailsDraft({ ...DRAFT_BASE, addedToPlanAt: "2026-06-23T10:00:00Z", scheduledDate: "2026-07-01" }).planStatus, "scheduled");
});

test("Draft: postedAt set → posted (wins over everything)", () => {
  assert.equal(mapPinDraftToDetailsDraft({ ...DRAFT_BASE, postedAt: "2026-06-20T12:00:00Z", scheduledDate: "2026-07-01" }).planStatus, "posted");
});

// ── 5. Core content fields ────────────────────────────────────────────────────

console.log("\n=== Core fields ===");

test("Studio: imageUrl maps from pin.url", () => {
  const result = mapStudioPinToDetailsDraft(STUDIO_BASE);
  assert.equal(result.imageUrl, "https://cdn.example.com/pin.jpg");
});

test("Draft: imageUrl maps from draft.imageUrl", () => {
  const result = mapPinDraftToDetailsDraft(DRAFT_BASE);
  assert.equal(result.imageUrl, "https://cdn.example.com/pin.jpg");
});

test("Studio: title / description / altText map correctly", () => {
  const result = mapStudioPinToDetailsDraft({ ...STUDIO_BASE, title: "T", description: "D", altText: "A" });
  assert.equal(result.title, "T");
  assert.equal(result.description, "D");
  assert.equal(result.altText, "A");
});

test("Draft: primaryProductId from draft.primaryProductId", () => {
  const result = mapPinDraftToDetailsDraft({ ...DRAFT_BASE, primaryProductId: "prod_abc" });
  assert.equal(result.primaryProductId, "prod_abc");
});

test("Draft: linkedProducts from draft.linkedProducts when present", () => {
  const product = { title: "Hat", source: "my_products" as const, linkType: "manual" as const };
  const result = mapPinDraftToDetailsDraft({ ...DRAFT_BASE, linkedProducts: [product] });
  assert.equal(result.linkedProducts.length, 1);
  assert.equal(result.linkedProducts[0].title, "Hat");
});

// ── 6. Details status ─────────────────────────────────────────────────────────

console.log("\n=== Details status ===");

test("Studio: missing title → need_details", () => {
  const result = mapStudioPinToDetailsDraft({ ...STUDIO_BASE, title: "" });
  assert.equal(result.detailsStatus, "need_details");
});

test("Studio: all publish fields present → ready", () => {
  const result = mapStudioPinToDetailsDraft({
    ...STUDIO_BASE,
    metadataDraft: { confidence: "high", sourceReasons: [], updatedAt: "", boardId: "board_123", boardName: "Board" } as never,
  });
  assert.equal(result.detailsStatus, "ready");
});

test("Draft: ready details status independent of plan status", () => {
  const result = mapPinDraftToDetailsDraft({
    ...DRAFT_BASE,
    boardId: "board_123",
    addedToPlanAt: "2026-06-23T10:00:00Z",
    scheduledDate: "",
  });
  assert.equal(result.detailsStatus, "ready");
  assert.equal(result.planStatus, "needs_date");
});

console.log(`\nPin Details Model (P1-A Phase 1): ${passed} passed, 0 failed\n`);
