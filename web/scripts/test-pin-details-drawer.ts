/**
 * Pin Details Drawer source + logic tests
 * Run: npx tsx scripts/test-pin-details-drawer.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getGenerationSetupSnapshot, resolvePinDetail, resolveStatusLabel } from "../src/components/studio/pinDetails";
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
const sharedModalSource = readFileSync(join(process.cwd(), "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");
const pinDetailsSource = readFileSync(join(process.cwd(), "src/components/studio/pinDetails.ts"), "utf8");
const persistenceSource = readFileSync(join(process.cwd(), "src/lib/studioPersistence.ts"), "utf8");

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

test("Clicking completed PinCard opens shared details modal", () => {
  assert(studioSource.includes("detailsModalDraft"), "shared details modal state missing");
  assert(studioSource.includes("openSharedPinDetails"), "shared details modal handler missing");
  assert(studioSource.includes("<PinDetailsModal"), "shared PinDetailsModal not rendered");
  assert(studioSource.includes('"generated-pin-card"'), "generated-pin-card test id missing");
});

test("Failed PinCard exposes retry and edit inputs, not publishing details", () => {
  // The failed-card buttons live in the shared PinCardActions matrix.
  const actionsSource = readFileSync("src/components/studio/PinCardActions.tsx", "utf8");
  assert(actionsSource.includes('testId: "retry-failed-output"'), "failed retry action missing");
  assert(actionsSource.includes('testId: "edit-failed-inputs"'), "failed edit inputs action missing");
  // Studio still wires the failed-only retry/edit handlers.
  assert(studioSource.includes("entry.status === \"failed\""), "failed status branch missing");
});

test("Clicking generating PinCard opens drawer", () => {
  assert(studioSource.includes("placeholderVariant: variant"), "generating placeholder missing");
  assert(drawerSource.includes("Generating") || drawerSource.includes("Queued"), "generating drawer label missing");
});

test("Drawer displays status badge", () => {
  assert(drawerSource.includes('data-testid="pin-details-status-badge"'), "status badge test id missing");
  assert(drawerSource.includes("pinDrawer.dialogAriaLabel"), "drawer header title missing");
});

test("Drawer displays prompt snapshot", () => {
  assert(drawerSource.includes('data-testid="pin-details-prompt"'), "prompt section test id missing");
  assert(drawerSource.includes('data-testid="pin-details-remix-recovery-notice"'), "quality-aware recovery notice missing");
});

test("Drawer displays setup snapshot context", () => {
  assert(drawerSource.includes('data-testid="pin-details-setup-opportunity"'), "context section test id missing");
  assert(drawerSource.includes("Opportunity"), "opportunity context missing");
});

test("Failed drawer displays error reason or Unknown generation error fallback", () => {
  assert(drawerSource.includes('data-testid="pin-details-error-reason"'), "error reason test id missing");
  assert(drawerSource.includes("pinDrawer.unknownGenerationError"), "error fallback missing");
  const failed = resolvePinDetail(baseSession, {
    key: "fail-1", sessionId: "sess_001", groupIdx: 0, status: "failed",
    refLabel: "Reference 1", createdAt: baseSession.savedAt, placeholderVariant: "failed",
  });
  assert(failed.statusLabel === "Failed", "failed status label wrong");
});

test("Shared modal auto-saves + owns Schedule / Pin now / readiness", () => {
  // Simplified composer: auto-save indicator + one Schedule CTA; Pin now in overflow.
  assert(sharedModalSource.includes('data-testid="draft-save-state"'), "auto-save indicator missing");
  assert(sharedModalSource.includes('data-testid="draft-cta-schedule"'), "single Schedule CTA missing");
  assert(sharedModalSource.includes('data-testid="draft-overflow-pin-now"'), "Pin now (overflow) missing");
  assert(!sharedModalSource.includes('data-testid="draft-edit-save"'), "manual Save button should be gone");
  assert(!sharedModalSource.includes('data-testid="pin-details-add-to-plan"'), "Add to Plan should be gone");
  assert(sharedModalSource.includes("getPinReadiness"), "shared readiness helper missing");
});

test("Failed drawer shows Try again / Edit and retry", () => {
  assert(drawerSource.includes('data-testid="pin-details-retry-pin"'), "retry pin testId missing");
  assert(drawerSource.includes('data-testid="pin-details-edit-and-retry"'), "edit-and-retry testId missing");
  assert(drawerSource.includes("pinDetails.tryAgain"), "Try again label missing");
  assert(drawerSource.includes("pinDrawer.plan.editAndRetry"), "Edit and retry label missing");
  assert(!drawerSource.includes("Retry this Pin"), "Old 'Retry this Pin' label must be gone");
  assert(!drawerSource.includes("Retry this group"), "Old 'Retry this group' label must be gone");
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

test("Remix hydration Test A: new pin immediate open uses pin.setupSnapshot", () => {
  const detail = resolvePinDetail(
    { ...baseSession, setupSnapshot: undefined },
    {
      key: "pin-a", sessionId: "sess_001", groupIdx: 0, pinIdx: 0,
      pin: {
        id: "pin-a", url: "https://example.com/g.png", planningStatus: "not_added",
        title: "", description: "", setupSnapshot: snap, batchId: "sess_001", requestId: "pin-a",
      },
      status: "completed", refLabel: "Reference 1", createdAt: baseSession.savedAt,
    },
    null,
  );
  const recovered = getGenerationSetupSnapshot(detail);
  assert(detail.setupSnapshotSource === "pin.setupSnapshot", "pin.setupSnapshot must win");
  assert(recovered.productImages.length === 1, "product image not recovered from pin snapshot");
  assert(recovered.pinReferences.length === 1, "reference not recovered from pin snapshot");
  assert(!detail.isLegacyRecovery, "new pin must not be legacy recovery");
});

test("Remix hydration Test B: refresh/reopen can use pin.generationSetup", () => {
  const detail = resolvePinDetail(
    { ...baseSession, setupSnapshot: undefined },
    {
      key: "pin-b", sessionId: "sess_001", groupIdx: 0, pinIdx: 0,
      pin: {
        id: "pin-b", url: "https://example.com/g.png", planningStatus: "not_added",
        title: "", description: "", generationSetup: snap, batchId: "sess_001", requestId: "pin-b",
      },
      status: "completed", refLabel: "Reference 1", createdAt: baseSession.savedAt,
    },
    null,
  );
  assert(detail.setupSnapshotSource === "pin.generationSetup", "pin.generationSetup must be second priority");
  assert(getGenerationSetupSnapshot(detail).productImages.length === 1, "product image not recovered from generationSetup");
});

test("Remix hydration Test C: add-to-plan path falls back to batch setupSnapshot", () => {
  const detail = resolvePinDetail(baseSession, {
    key: "pin-c", sessionId: "sess_001", groupIdx: 0, pinIdx: 0,
    pin: { id: "pin-c", url: "https://example.com/g.png", planningStatus: "added_to_plan", title: "", description: "" },
    status: "added", refLabel: "Reference 1", createdAt: baseSession.savedAt,
  });
  assert(detail.setupSnapshotSource === "batch.setupSnapshot", "batch setupSnapshot must be third priority");
  assert(detail.statusLabel === "Added to Plan", "plan status should stay added");
  assert(getGenerationSetupSnapshot(detail).pinReferences.length === 1, "reference not recovered from batch setup");
});

test("Remix hydration Test D: local history snapshot is used when pin and batch lack setup", () => {
  const detail = resolvePinDetail(
    { ...baseSession, setupSnapshot: undefined },
    {
      key: "pin-d", sessionId: "sess_001", groupIdx: 0, pinIdx: 0,
      pin: { id: "pin-d", url: "https://example.com/g.png", planningStatus: "not_added", title: "", description: "" },
      status: "completed", refLabel: "Reference 1", createdAt: baseSession.savedAt,
    },
    { id: "sess_001", savedAt: baseSession.savedAt, keyword: "cozy bedroom", category: "home-decor", source: "studio", groups: [{ refUrl: null, images: ["https://example.com/g.png"] }], refCount: 1, productCount: 1, totalPins: 1, setupSnapshot: snap },
  );
  assert(detail.setupSnapshotSource === "local_history", "local history setupSnapshot must be fourth priority");
  assert(getGenerationSetupSnapshot(detail).productImages.length === 1, "product image not recovered from local history");
});

test("Remix hydration Test E: prompt-only recovers via session text (calm, not legacy)", () => {
  const detail = resolvePinDetail(
    { ...baseSession, promptFull: undefined, setupSnapshot: undefined, groups: [{ refUrl: null, refIndex: 0, status: "done" }] },
    {
      key: "pin-e", sessionId: "sess_001", groupIdx: 0, pinIdx: 0,
      pin: { id: "pin-e", url: "https://example.com/g.png", planningStatus: "not_added", title: "", description: "" },
      status: "completed", refLabel: "Reference 1", createdAt: baseSession.savedAt,
    },
    { id: "sess_001", savedAt: baseSession.savedAt, keyword: "cozy bedroom", category: "home-decor", source: "studio", groups: [{ refUrl: null, images: ["https://example.com/g.png"] }], refCount: 1, productCount: 0, totalPins: 1, promptFull: "Legacy prompt only" },
  );
  const recovered = getGenerationSetupSnapshot(detail);
  // When a keyword/prompt is recoverable, we synthesise a minimal setup rather than
  // showing the alarming legacy banner.
  assert(detail.setupSnapshotSource === "session_text_fallback", "prompt-only must recover via session_text_fallback");
  assert(!detail.isLegacyRecovery, "prompt-only must NOT be flagged legacy (no scary banner)");
  assert(recovered.productImages.length === 0, "must not invent product images");
  assert(recovered.pinReferences.length === 0, "must not invent references without group ref");
  assert(recovered.prompt === "Legacy prompt only", "prompt must be recovered");
  assert(recovered.recoveryQuality === "text_only", "quality must be text_only");
});

test("Remix hydration Test E2: truly empty setup is the only legacy/unavailable case", () => {
  const detail = resolvePinDetail(
    { ...baseSession, keyword: "", promptFull: undefined, setupSnapshot: undefined, groups: [{ refUrl: null, refIndex: 0, status: "done" }] },
    {
      key: "pin-e2", sessionId: "sess_001", groupIdx: 0, pinIdx: 0,
      pin: { id: "pin-e2", url: "https://example.com/g.png", planningStatus: "not_added", title: "", description: "" },
      status: "completed", refLabel: "Reference 1", createdAt: baseSession.savedAt,
    },
    { id: "sess_001", savedAt: baseSession.savedAt, keyword: "", category: "", source: "studio", groups: [{ refUrl: null, images: ["https://example.com/g.png"] }], refCount: 1, productCount: 0, totalPins: 1 },
  );
  const recovered = getGenerationSetupSnapshot(detail);
  assert(detail.setupSnapshotSource === "legacy_prompt_fallback", "no keyword/prompt anywhere → legacy fallback");
  assert(detail.isLegacyRecovery, "legacy flag true only when nothing recoverable");
  assert(recovered.recoveryQuality === "unavailable", "quality must be unavailable when nothing recovered");
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
  assert(studioSource.includes("studio.batch.generatePinDetails"), "batch toolbar should say Generate Pin Details");
  assert(studioSource.includes("studio.batch.editDetails"), "batch toolbar should say Batch Edit Details");
});

test("Drawer shows loading state while generating Pin details", () => {
  assert(drawerSource.includes('data-testid="pin-details-generating"'), "generating state missing");
  assert(drawerSource.includes("pinDrawer.plan.generatingDetails"), "generating copy missing");
});

test("Failed Pin Details generation shows retry", () => {
  assert(drawerSource.includes('data-testid="pin-details-generate-error"'), "error state missing");
  assert(drawerSource.includes("pinDrawer.plan.couldNotGenerateDetails"), "error copy missing");
  assert(drawerSource.includes('data-testid="pin-details-retry-generate"'), "retry button missing");
});

test("Save changes disabled until user edits", () => {
  assert(drawerSource.includes("disabled={!isDirty}"), "save must be disabled when not dirty");
  assert(drawerSource.includes('data-testid="pin-details-saved-confirmation"'), "saved confirmation missing");
});

test("Title candidates show source labels", () => {
  assert(drawerSource.includes("pin-details-title-source"), "title source label test id missing");
  assert(drawerSource.includes("sourceLabel"), "suggested title source labels missing");
  assert(drawerSource.includes("pinDrawer.titleSuggestions.viewMore"), "compact suggestion reveal missing");
});

test("Low confidence hint shown in drawer", () => {
  assert(drawerSource.includes('data-testid="pin-details-low-confidence-hint"'), "low confidence hint missing");
  assert(drawerSource.includes("pinDrawer.content.lowConfidenceHint"), "hint copy missing");
});

test("Studio auto-generates Pin Details when drawer opens with missing fields", () => {
  assert(studioSource.includes("pinNeedsDetailsGeneration"), "needs generation check missing");
  assert(studioSource.includes("runPinDetailsGeneration"), "auto generation handler missing");
  assert(studioSource.includes("pinDetailsGenStatus"), "generation status state missing");
});

test("Readiness badge shown in drawer header", () => {
  assert(drawerSource.includes('data-testid="pin-details-readiness-badge"'), "readiness badge missing");
});

// Retry uses snapshot, not current UI state.

test("handleRegenerateGroup reads prompt from setupSnapshot not current state", () => {
  assert(studioSource.includes("snap?.promptSnapshot"), "retry must read prompt from snapshot");
  assert(studioSource.includes("retryPrompt"), "retryPrompt variable must exist");
  assert(studioSource.includes("retryProducts"), "retryProducts variable must exist");
  assert(studioSource.includes("retryKeyword"), "retryKeyword variable must exist");
  assert(studioSource.includes("retryCategory"), "retryCategory variable must exist");
  assert(studioSource.includes("retryCount"), "retryCount variable must exist");
  assert(studioSource.includes("snap?.imagesPerReference ?? count"), "retryCount falls back to count");
});

test("handleRegenerateGroup uses snapshot products not current products state", () => {
  const retryBlock = studioSource.slice(studioSource.indexOf("handleRegenerateGroup"), studioSource.indexOf("handleRegenerateGroup") + 2500);
  assert(retryBlock.includes("snap?.selectedProducts"), "retry must use snap.selectedProducts");
  assert(retryBlock.includes("productImages: retryProducts"), "API call uses retryProducts");
  assert(!retryBlock.includes("productImages: products"), "retry API must NOT use live products state");
});

test("Regenerate action opens Remix instead of mutating the original Pin", () => {
  assert(studioSource.includes('onOpenPinDetail(session.id, entry.key, "remix")'), "Regenerate must open Remix drawer");
  assert(studioSource.includes("handleGenerateFromRemix"), "Remix must create a new generation session");
});

test("SetupSnapshot includes format and model fields", () => {
  assert(studioSource.includes("format,") && studioSource.includes("model,"), "snap creation includes format and model");
  assert(persistenceSource.includes("format?:") && persistenceSource.includes("model?:"), "SetupSnapshot type has format and model fields");
});

test("handleReuseSetup no longer hard-fails on missing snapshot", () => {
  const reuseBlock = studioSource.slice(studioSource.indexOf("function handleReuseSetup"), studioSource.indexOf("function handleReuseSetup") + 1800);
  assert(!reuseBlock.includes("toast.error"), "handleReuseSetup must not toast.error for missing snapshot");
  assert(reuseBlock.includes("if (snap)"), "handleReuseSetup guards snap-specific ops");
  assert(reuseBlock.includes("studio.toast.promptLoadedLegacy"), "handleReuseSetup always shows success with appropriate message");
});

test("onPinDetailRegenerateWithRemix calls handleGenerateFromRemix (no composer mutation)", () => {
  assert(studioSource.includes("handleGenerateFromRemix"), "handleGenerateFromRemix function must exist");
  assert(studioSource.includes("async function handleGenerateFromRemix"), "handleGenerateFromRemix must be async");
  // Use lastIndexOf to find the call-site handler (not the prop type declaration)
  const handlerStart = studioSource.lastIndexOf("onPinDetailRegenerateWithRemix");
  const remixHandler = studioSource.slice(handlerStart, handlerStart + 200);
  assert(remixHandler.includes("handleGenerateFromRemix"), "handler must call handleGenerateFromRemix");
  assert(!remixHandler.includes("handleReuseSetup"), "handler must NOT call handleReuseSetup (would mutate composer)");
});

// Remix init uses detail context, not just snapshot.

test("initRemixFromDetail helper exists and uses group refUrl fallback", () => {
  assert(drawerSource.includes("initRemixFromDetail"), "initRemixFromDetail must exist");
  assert(pinDetailsSource.includes("refFromGroup"), "group refUrl recovery must be present");
  assert(pinDetailsSource.includes("detail.session.groups[detail.groupIdx]"), "reads group refUrl from session");
  assert(drawerSource.includes("detail.promptSnapshot"), "falls back to detail.promptSnapshot for prompt");
  assert(drawerSource.includes("detail.session.keyword"), "falls back to session keyword");
});

test("Remix lazy-init uses initRemixFromDetail not initRemixFromSnapshot", () => {
  assert(drawerSource.includes("setRemixDraft(initRemixFromDetail(detail))"), "lazy-init uses initRemixFromDetail");
});

test("Remix prompt is never gated behind snapshot availability", () => {
  assert(!drawerSource.includes("!hasSetupSnapshot && !promptText"), "prompt must not be gated by snapshot presence");
  assert(drawerSource.includes("pin-details-remix-prompt"), "remix prompt textarea always rendered");
});

test("Recovery notice is calm and quality-aware (no alarming legacy banner)", () => {
  assert(drawerSource.includes('data-testid="pin-details-remix-recovery-notice"'), "calm recovery notice present");
  assert(drawerSource.includes("pinDrawer.recovery.textOnly.body"), "calm text_only copy present");
  assert(!drawerSource.includes("Older generation"), "alarming 'Older generation' banner must be gone");
  assert(!drawerSource.includes("Setup snapshot unavailable for this older"), "old blunt message removed from remix tab");
});

test("recoveryQuality drives the recovery notice", () => {
  assert(drawerSource.includes("recoveryQuality"), "recoveryQuality consumed in drawer");
  assert(pinDetailsSource.includes("recoveryQuality"), "recoveryQuality computed by normaliser");
  assert(pinDetailsSource.includes("export type RecoveryQuality"), "RecoveryQuality type exported");
  assert(drawerSource.includes('recoveryQuality === "text_only"'), "text_only branch present");
  assert(drawerSource.includes('recoveryQuality === "visual_partial"'), "visual_partial branch present");
  assert(drawerSource.includes('recoveryQuality === "unavailable"'), "unavailable branch present");
});
// Current drawer tab structure.

test("DrawerTab supports Remix and gated Debug", () => {
  assert(drawerSource.includes('export type DrawerTab = "plan" | "remix" | "debug"'), "DrawerTab type must be exported");
});

test("RemixDraftSetup type is exported with all fields", () => {
  assert(drawerSource.includes("export type RemixDraftSetup"), "RemixDraftSetup must be exported");
  assert(drawerSource.includes("selectedProducts"), "selectedProducts field missing");
  assert(drawerSource.includes("selectedReferences"), "selectedReferences field missing");
  assert(drawerSource.includes("imagesPerReference"), "imagesPerReference field missing");
  assert(drawerSource.includes("noTextOverlay"), "noTextOverlay field missing");
});

test("Drawer tab bar shows Remix and conditionally Debug, never Plan", () => {
  assert(drawerSource.includes('"pin-details-tab-bar"'), "tab-bar testId missing");
  assert(drawerSource.includes('"pin-details-tab-remix"'), "remix tab testId missing");
  assert(!drawerSource.includes('{ id: "plan",  label: "Plan"'), "plan tab must not be visible");
  assert(drawerSource.includes("canViewDebug ?"), "Debug tab must be gated");
  assert(!drawerSource.includes('"pin-details-tab-preview"'), "preview tab should not be present");
  assert(!drawerSource.includes('"Result"'), 'Old "Result" tab label must not appear');
  assert(!drawerSource.includes('"pin-details-tab-setup"'), 'Old "Setup" tab testId must not appear');
});

test("Drawer keeps preview as content, not as a tab", () => {
  assert(drawerSource.includes('"pin-details-preview"'), "pin preview content should exist");
  assert(!drawerSource.includes('"pin-details-tab-preview"'), "preview tab must not be reintroduced");
  assert(!drawerSource.includes('"pin-details-reuse-in-remix"'), "Old Reuse in Remix must be gone");
});

test("Remix tab has editable prompt, settings, and simplified action buttons", () => {
  assert(drawerSource.includes('"pin-details-remix-prompt"'), "remix prompt textarea testId missing");
  assert(drawerSource.includes('"pin-details-setup-settings"'), "settings section missing");
  assert(drawerSource.includes('"pin-details-regenerate-with-remix"'), "Generate again button testId missing");
  assert(drawerSource.includes('"pin-details-remix-reset"'), "Reset button testId missing");
  assert(drawerSource.includes("pinDrawer.setup.generateAgain"), "Generate again label missing");
  assert(drawerSource.includes("pinDrawer.setup.reset"), "Reset label missing");
  assert(!drawerSource.includes("Regenerate with changes"), "Old label must be gone");
  assert(!drawerSource.includes('"pin-details-remix-cancel"'), "Old Cancel button must be gone");
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

test("Card Details opens shared modal, Regenerate opens generation drawer", () => {
  // Card actions now live in the shared PinCardActions component.
  const actionsSource = readFileSync("src/components/studio/PinCardActions.tsx", "utf8");
  assert(actionsSource.includes('"pin-card-view-btn"'), "pin-card-view-btn testId missing");
  // The card More menu was simplified — Remix is no longer a standalone item.
  // Regenerate now opens the remix/generation flow.
  assert(actionsSource.includes('"pin-card-regenerate-btn"'), "pin-card-regenerate-btn testId missing");
  assert(!actionsSource.includes('"pin-card-remix-btn"'), "pin-card-remix-btn should not exist");
  assert(studioSource.includes('onOpenPinDetail(session.id, entry.key, "remix")'), "Regenerate must open remix tab");
  assert(studioSource.includes("openSharedPinDetails"), "Details must open shared modal");
});

console.log(`\nPin Details Drawer: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
