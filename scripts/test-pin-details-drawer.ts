/**
 * Pin Details Drawer — source + logic tests
 * Run: npx tsx scripts/test-pin-details-drawer.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePinDetail, resolveStatusLabel } from "../src/components/studio/pinDetails";
import type { SetupSnapshot } from "../src/lib/studioPersistence";

export {};

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  OK ${name}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${(error as Error).message}`);
    failed++;
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const studioSource = readFileSync(join(process.cwd(), "src/app/app/studio/page.tsx"), "utf8");
const drawerSource = readFileSync(join(process.cwd(), "src/components/studio/PinDetailsDrawer.tsx"), "utf8");
const pinDetailsSource = readFileSync(join(process.cwd(), "src/components/studio/pinDetails.ts"), "utf8");

const snap: SetupSnapshot = {
  mode: "keyword_led",
  keyword: "cozy bedroom",
  category: "home-decor",
  opportunityTitle: "Cozy bedroom decor",
  noTextOverlay: true,
  imagesPerReference: 2,
  selectedProducts: [{ imageUrl: "https://example.com/p.png", title: "Pillow" }],
  selectedReferences: [{ imageUrl: "https://example.com/r.png" }],
  promptSnapshot: "Create a cozy Pinterest pin with warm lighting.",
  createdFrom: "studio",
};

const baseSession = {
  id: "sess_001",
  savedAt: "2026-06-06T10:00:00.000Z",
  keyword: "cozy bedroom",
  category: "home-decor",
  source: "studio",
  status: "completed",
  promptFull: "Create a cozy Pinterest pin with warm lighting.",
  setupSnapshot: snap,
  model: "GPT Image 2",
  format: "Pinterest 2:3",
  textOverlay: "Off",
  groups: [{ refUrl: "https://example.com/r.png", refIndex: 0, status: "done" }],
};

test("PinCard opens PinDetailsDrawer via onOpenDetails", () => {
  assert(studioSource.includes("onOpenDetails"), "onOpenDetails prop missing on PinCard");
  assert(studioSource.includes("onClick={onOpenDetails}"), "PinCard article click handler missing");
  assert(studioSource.includes("<PinDetailsDrawer"), "PinDetailsDrawer not rendered in feed");
});

test("Clicking completed PinCard opens drawer (state wiring)", () => {
  assert(studioSource.includes("pinDetailSelection"), "pinDetailSelection state missing");
  assert(studioSource.includes("onOpenPinDetail"), "onOpenPinDetail handler missing");
  assert(studioSource.includes('"generated-pin-card"'), "generated-pin-card test id missing");
});

test("Clicking failed PinCard opens drawer (not blocked)", () => {
  assert(studioSource.includes('placeholderVariant: "failed"'), "failed placeholder entries missing");
  assert(studioSource.includes("onClick={onOpenDetails}"), "failed cards must share open-details click");
  assert(!studioSource.includes("isPlaceholder") || !studioSource.match(/isPlaceholder[\s\S]{0,80}return null/), "failed cards should not early-return before click");
});

test("Clicking generating PinCard opens drawer", () => {
  assert(studioSource.includes("placeholderVariant: variant"), "generating placeholder missing");
  assert(drawerSource.includes("Still generating"), "generating drawer label missing");
});

test("Drawer displays status badge", () => {
  assert(drawerSource.includes('data-testid="pin-details-status-badge"'), "status badge test id missing");
  assert(drawerSource.includes("Pin Details"), "drawer header title missing");
});

test("Drawer displays prompt snapshot", () => {
  assert(drawerSource.includes('data-testid="pin-details-prompt"'), "prompt section test id missing");
  assert(drawerSource.includes("Setup snapshot unavailable"), "prompt fallback missing");
});

test("Drawer displays setup snapshot context", () => {
  assert(drawerSource.includes('data-testid="pin-details-setup-opportunity"'), "context section test id missing");
  assert(drawerSource.includes("Opportunity"), "opportunity context missing");
});

test("Failed drawer displays error reason or Unknown generation error fallback", () => {
  assert(drawerSource.includes('data-testid="pin-details-error-reason"'), "error reason test id missing");
  assert(drawerSource.includes("Unknown generation error."), "error fallback missing");
  const failed = resolvePinDetail(baseSession, {
    key: "fail-1", sessionId: "sess_001", groupIdx: 0, status: "failed",
    refLabel: "Reference 1", createdAt: baseSession.savedAt, placeholderVariant: "failed",
  });
  assert(failed.statusLabel === "Failed", "failed status label wrong");
});

test("Completed drawer shows Save / Add to Plan / Download / Regenerate", () => {
  assert(drawerSource.includes('data-testid="pin-details-save"'), "save action missing");
  assert(drawerSource.includes('data-testid="pin-details-add-to-plan"'), "add to plan action missing");
  assert(drawerSource.includes('data-testid="pin-details-download"'), "download action missing");
  assert(drawerSource.includes('data-testid="pin-details-regenerate"'), "regenerate action missing");
  assert(drawerSource.includes('data-testid="pin-details-editor"'), "pin details editor missing");
});

test("Failed drawer shows Retry this Pin", () => {
  assert(drawerSource.includes('data-testid="pin-details-retry-pin"'), "retry pin action missing");
  assert(drawerSource.includes("Retry this Pin"), "retry pin label missing");
});

test("Drawer close button closes the drawer", () => {
  assert(drawerSource.includes('data-testid="pin-details-close"'), "close button test id missing");
  assert(studioSource.includes("onClosePinDetail"), "close handler wired in page");
  assert(drawerSource.includes('e.key === "Escape"'), "escape key closes drawer");
});

test("Drawer is right-side inspector, not centered modal", () => {
  assert(drawerSource.includes('position: "absolute", right: 0'), "drawer positioned on right inside feed");
  assert(!drawerSource.includes('position: "fixed"'), "drawer must not be fixed centered modal");
  assert(studioSource.includes('position: "relative"'), "feed container is relative for drawer overlay");
});

test("resolvePinDetail uses real prompt from session", () => {
  const detail = resolvePinDetail(baseSession, {
    key: "pin-1", sessionId: "sess_001", groupIdx: 0, pinIdx: 0,
    pin: { id: "pin-1", url: "https://example.com/g.png", planningStatus: "not_added", title: "", description: "" },
    status: "completed", refLabel: "Reference 1", createdAt: baseSession.savedAt,
  });
  assert(detail.promptSnapshot === snap.promptSnapshot, "prompt snapshot not resolved from session");
  assert(detail.setupSnapshot?.opportunityTitle === "Cozy bedroom decor", "setup snapshot not attached");
});

test("resolveStatusLabel covers all feed states", () => {
  assert(resolveStatusLabel({ key: "a", sessionId: "s", groupIdx: 0, status: "completed", refLabel: "R1", createdAt: "" }) === "Completed", "completed label");
  assert(resolveStatusLabel({ key: "b", sessionId: "s", groupIdx: 0, status: "failed", refLabel: "R1", createdAt: "", placeholderVariant: "failed" }) === "Failed", "failed label");
  assert(resolveStatusLabel({ key: "c", sessionId: "s", groupIdx: 0, status: "generating", refLabel: "R1", createdAt: "", placeholderVariant: "generating" }) === "Generating", "generating label");
  assert(resolveStatusLabel({ key: "d", sessionId: "s", groupIdx: 0, status: "generating", refLabel: "R1", createdAt: "", placeholderVariant: "queued" }) === "Queued", "queued label");
});

test("pinDetails module exports resolvePinDetail", () => {
  assert(pinDetailsSource.includes("export function resolvePinDetail"), "resolvePinDetail export missing");
});

test("UI does not expose metadata text to users", () => {
  const quotedStrings = [...drawerSource.matchAll(/"([^"\\]|\\.)*"/g)].map(m => m[0]);
  const userCopy = quotedStrings.join(" ");
  assert(!/\bmetadata\b/i.test(userCopy), `drawer user copy exposes metadata: ${userCopy}`);
  assert(!studioSource.includes(">Generate metadata<") && !studioSource.includes('"Generate metadata"'), "studio still says Generate metadata");
  assert(studioSource.includes("Generate Pin Details"), "batch toolbar should say Generate Pin Details");
  assert(studioSource.includes("Batch Edit Details"), "batch toolbar should say Batch Edit Details");
});

test("Drawer shows loading state while generating Pin details", () => {
  assert(drawerSource.includes('data-testid="pin-details-generating"'), "generating state missing");
  assert(drawerSource.includes("Generating Pin details"), "generating copy missing");
});

test("Failed Pin Details generation shows retry", () => {
  assert(drawerSource.includes('data-testid="pin-details-generate-error"'), "error state missing");
  assert(drawerSource.includes("Could not generate Pin details"), "error copy missing");
  assert(drawerSource.includes('data-testid="pin-details-retry-generate"'), "retry button missing");
});

test("Save changes disabled until user edits", () => {
  assert(drawerSource.includes("disabled={!isDirty}"), "save must be disabled when not dirty");
  assert(drawerSource.includes('data-testid="pin-details-saved-confirmation"'), "saved confirmation missing");
});

test("Title candidates show source labels", () => {
  assert(drawerSource.includes("pin-details-title-source"), "title source label test id missing");
  assert(drawerSource.includes("Suggested"), "suggested titles label missing");
});

test("Low confidence hint shown in drawer", () => {
  assert(drawerSource.includes('data-testid="pin-details-low-confidence-hint"'), "low confidence hint missing");
  assert(drawerSource.includes("Add an opportunity or keyword"), "hint copy missing");
});

test("Studio auto-generates Pin Details when drawer opens with missing fields", () => {
  assert(studioSource.includes("pinNeedsDetailsGeneration"), "needs generation check missing");
  assert(studioSource.includes("runPinDetailsGeneration"), "auto generation handler missing");
  assert(studioSource.includes("pinDetailsGenStatus"), "generation status state missing");
});

test("Readiness badge shown in drawer header", () => {
  assert(drawerSource.includes('data-testid="pin-details-readiness-badge"'), "readiness badge missing");
});

// ── New 3-tab structure (Preview / Remix / Plan) ──────────────────────────────

test("DrawerTab type is exported with three values", () => {
  assert(drawerSource.includes('export type DrawerTab = "preview" | "remix" | "plan"'), "DrawerTab type must be exported");
});

test("RemixDraftSetup type is exported with all fields", () => {
  assert(drawerSource.includes("export type RemixDraftSetup"), "RemixDraftSetup must be exported");
  assert(drawerSource.includes("selectedProducts"), "selectedProducts field missing");
  assert(drawerSource.includes("selectedReferences"), "selectedReferences field missing");
  assert(drawerSource.includes("imagesPerReference"), "imagesPerReference field missing");
  assert(drawerSource.includes("noTextOverlay"), "noTextOverlay field missing");
});

test("Tab bar has Preview, Remix, Plan tabs", () => {
  assert(drawerSource.includes('"pin-details-tab-bar"'), "tab-bar testId missing");
  assert(drawerSource.includes('"pin-details-tab-preview"'), "preview tab testId missing");
  assert(drawerSource.includes('"pin-details-tab-remix"'), "remix tab testId missing");
  assert(drawerSource.includes('"pin-details-tab-plan"'), "plan tab testId missing");
  assert(!drawerSource.includes('"Result"'), 'Old "Result" tab label must not appear');
  assert(!drawerSource.includes('"Setup"'), 'Old "Setup" tab label must not appear');
});

test("Preview tab has image, meta, and action sections", () => {
  assert(drawerSource.includes('"pin-details-preview"'), "pin-details-preview section missing");
  assert(drawerSource.includes('"pin-details-preview-image"'), "preview image testId missing");
  assert(drawerSource.includes('"pin-details-result-meta"'), "result meta section missing");
  assert(drawerSource.includes('"pin-details-actions"'), "actions section missing");
  assert(drawerSource.includes('"pin-details-reuse-in-remix"'), "Reuse in Remix button missing");
});

test("Remix tab has editable prompt, settings, and action buttons", () => {
  assert(drawerSource.includes('"pin-details-remix-prompt"'), "remix prompt textarea testId missing");
  assert(drawerSource.includes('"pin-details-setup-settings"'), "settings section missing");
  assert(drawerSource.includes('"pin-details-regenerate-with-remix"'), "Regenerate with changes button missing");
  assert(drawerSource.includes('"pin-details-remix-reset"'), "Reset to original button missing");
  assert(drawerSource.includes('"pin-details-remix-cancel"'), "Cancel button missing");
  assert(drawerSource.includes("Reset to original"), "Reset to original label missing");
  assert(drawerSource.includes("Regenerate with changes"), "Regenerate with changes label missing");
});

test("Remix draft never mutates original snapshot", () => {
  assert(drawerSource.includes("initRemixFromSnapshot"), "initRemixFromSnapshot helper must exist");
  assert(drawerSource.includes("setRemixDraft"), "setRemixDraft must be used for edits");
  assert(!drawerSource.includes("detail.setupSnapshot.prompt ="), "Must not mutate detail.setupSnapshot.prompt");
  assert(drawerSource.includes("JSON.stringify"), "remixIsDirty must use JSON.stringify comparison");
});

test("Plan tab has form fields and action buttons", () => {
  assert(drawerSource.includes('"pin-details-editor"'), "plan editor section missing");
  assert(drawerSource.includes('"pin-details-title"'), "title field missing");
  assert(drawerSource.includes('"pin-details-description"'), "description field missing");
  assert(drawerSource.includes('"pin-details-planned-date"'), "planned-date field missing");
  assert(drawerSource.includes('"pin-details-mark-as-posted"'), "Mark as posted button missing");
  assert(drawerSource.includes('"pin-details-copy-details"'), "Copy details button missing");
});

test("No Publish or Ready to publish in drawer", () => {
  assert(!drawerSource.includes("Ready to publish"), "Must not say 'Ready to publish'");
  assert(!drawerSource.includes("No reference: No product"), "Must not show old reference placeholder text");
});

test("MasonryPinFeed wires initialTab and onRegenerateWithRemix correctly", () => {
  assert(studioSource.includes("pinDetailInitialTab: DrawerTab"), "pinDetailInitialTab prop missing from MasonryPinFeed type");
  assert(studioSource.includes("onPinDetailRegenerateWithRemix: (remixSetup: RemixDraftSetup) => void"), "onPinDetailRegenerateWithRemix prop type missing");
  assert(studioSource.includes("initialTab={pinDetailInitialTab}"), "initialTab must use the MasonryPinFeed prop");
  assert(studioSource.includes("onRegenerateWithRemix={onPinDetailRegenerateWithRemix}"), "onRegenerateWithRemix not wired in MasonryPinFeed");
});

test("Card View button opens Preview tab, Remix button opens Remix tab", () => {
  assert(studioSource.includes('"pin-card-view-btn"'), "pin-card-view-btn testId missing");
  assert(studioSource.includes('"pin-card-remix-btn"'), "pin-card-remix-btn testId missing");
  assert(studioSource.includes('onOpenPinDetail(session.id, entry.key, "remix")'), "Remix must open remix tab");
  assert(studioSource.includes('onOpenPinDetail(session.id, entry.key, "plan")'), "Add to Plan must open plan tab");
});

console.log(`\nPin Details Drawer: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
