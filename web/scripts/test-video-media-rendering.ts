/**
 * Video Pin P0 rendering contract.
 *
 * These are source-level integration checks because the repository's node-only
 * test runner does not mount React DOM. They protect the observable boundaries:
 * a single renderer owns video semantics and every Studio/Plan surface delegates
 * to it instead of treating the private video URL as an image.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPinReady } from "../src/lib/pinReadiness";
import { draftReadiness } from "../src/lib/weeklyPlanStats";
import { isMediaActivationKey, mediaIdentity, stopMediaActivation } from "../src/components/media/ContentMediaRenderer";
import type { PinDraft } from "../src/lib/pinDraftStore";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  OK ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}`); console.error(`       ${(error as Error).message}`); failed++; }
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function source(path: string) { return readFileSync(join(process.cwd(), path), "utf8"); }

const rendererPath = "src/components/media/ContentMediaRenderer.tsx";
const consumerPaths = [
  "src/components/studio/ContentMediaStrip.tsx",
  "src/components/studio/PinCardMedia.tsx",
  "src/components/plan/WeeklyPlanWorkspace.tsx",
  "src/components/plan/PlanListView.tsx",
  "src/components/plan/DraftDetailsDrawer.tsx",
  "src/components/plan/PinHoverPreview.tsx",
];

console.log("Video media rendering contract");

test("one shared renderer owns video playback and accessible error behavior", () => {
  const renderer = source(rendererPath);
  assert(renderer.includes("ContentMediaRenderer"), "shared media renderer missing");
  assert(/<video[\s\S]*\bcontrols\b[\s\S]*\bmuted\b[\s\S]*\bplaysInline\b[\s\S]*preload="metadata"/.test(renderer), "video lacks safe playback attributes");
  assert(!/\bautoPlay\b/.test(renderer), "video renderer must not autoplay");
  assert(renderer.includes("poster={media.posterUrl}"), "video poster is not forwarded when present");
  assert(renderer.includes('aria-live="polite"'), "video load failures need a polite live region");
  assert(renderer.includes("data-testid=\"content-media-video\""), "video renderer needs a stable runtime hook");
});

test("Studio and Plan paths delegate media display to the shared renderer", () => {
  for (const path of consumerPaths) {
    const file = source(path);
    assert(file.includes("ContentMediaRenderer"), `${path} bypasses the shared media renderer`);
  }
});

test("image-only readiness has a media-aware video path", () => {
  const readiness = source("src/lib/pinReadiness.ts");
  const schedule = source("src/lib/smartSchedule.ts");
  assert(readiness.includes("isPublishableContentMedia"), "missing media-aware readiness selector");
  assert(schedule.includes("isPublishableContentMedia(draft)"), "smart scheduling still rejects finalized video drafts");
});

test("image-only operations do not receive a binary video URL", () => {
  const workspace = source("src/components/plan/WeeklyPlanWorkspace.tsx");
  assert(workspace.includes("mediaDownloadUrl"), "Plan download has no media-safe selector");
  assert(!workspace.includes("downloadFile(toProxyUrl(draft.imageUrl)"), "Plan download still treats every draft image alias as downloadable media");
});

test("Batch rows preserve discriminated media through their thumbnail, detail, and label boundaries", () => {
  const batch = source("src/components/studio/BatchEditDrawer.tsx");
  const studio = source("src/components/studio/StudioBoard.tsx");
  const plan = source("src/components/plan/WeeklyPlanWorkspace.tsx");
  assert(batch.includes("function rowMedia"), "Batch has no discriminated row-media selector");
  assert(batch.includes("ContentMediaRenderer"), "Batch thumbnails and details bypass the shared media renderer");
  assert(batch.includes("video"), "Batch has no video-aware media label");
  assert(studio.includes("media: draft.media"), "Studio Batch projection drops media");
  assert(plan.includes("media: d.media"), "Plan Batch projection drops media");
});

test("Draft Details accepts its discriminated media projection at the canonical readiness wrapper", () => {
  const drawer = source("src/components/plan/DraftDetailsDrawer.tsx");
  const model = source("src/lib/pinDetailsModel.ts");
  assert(drawer.includes("media: activeDraft.media"), "Draft Details drops media before readiness");
  assert(model.includes("media?: ContentMedia[]"), "Draft Details readiness wrapper rejects discriminated media");
});

test("video-only draft readiness survives the Weekly Plan projection", () => {
  const videoDraft = {
    id: "video-draft",
    imageUrl: "",
    boardId: "board-1",
    media: [{ id: "video-1", kind: "video", url: "https://app.example.test/api/storage-media?id=video-1", source: "upload" }],
  } as PinDraft;
  assert(isPinReady(draftReadiness(videoDraft)), "Weekly Plan projection wrongly blocks a video-only draft");
});

test("Plan preserves the established image thumbnail contract while sharing video rendering", () => {
  const plan = source("src/components/plan/WeeklyPlanWorkspace.tsx");
  const hover = source("src/components/plan/PinHoverPreview.tsx");
  assert(plan.includes("<PinThumbnail"), "Plan image thumbnails lost their skeleton/load recovery component");
  assert(hover.includes("<PinThumbnail"), "Hover preview image path no longer uses PinThumbnail");
  assert(hover.includes("preloadImage(toThumbUrl(media.url))"), "hover warmup is not keyed to the rendered image media");
});

test("video controls isolate card, hover, and lightbox activation", () => {
  const renderer = source(rendererPath);
  const strip = source("src/components/studio/ContentMediaStrip.tsx");
  const hover = source("src/components/plan/PinHoverPreview.tsx");
  const workspace = source("src/components/plan/WeeklyPlanWorkspace.tsx");
  assert(renderer.includes("data-content-media-controls"), "video controls have no event boundary");
  assert(strip.includes("VideoMediaItem"), "video cover selection still nests controls in a generic thumbnail button");
  assert(hover.includes("isMediaControlEvent"), "hover trigger still handles video-control activation");
  assert(workspace.includes("previewMedia"), "View Pins lightbox still stores an image URL instead of discriminated media");
});

test("video key isolation preserves Escape and Tab while stopping only activation keys", () => {
  assert(isMediaActivationKey("Enter"), "Enter must stay isolated from card activation");
  assert(isMediaActivationKey(" "), "Space must stay isolated from card activation");
  assert(!isMediaActivationKey("Escape"), "Escape must bubble to drawer/sidebar close handlers");
  assert(!isMediaActivationKey("Tab"), "Tab must retain focus-navigation propagation");

  for (const event of [
    { type: "click" },
    { type: "keydown", key: "Enter" },
    { type: "keydown", key: " " },
  ]) {
    let stopped = false;
    stopMediaActivation({ ...event, stopPropagation: () => { stopped = true; } });
    assert(stopped, `${event.type}/${event.key || "pointer"} must not activate the parent card`);
  }
  for (const event of [
    { type: "keydown", key: "Escape" },
    { type: "keydown", key: "Tab" },
  ]) {
    let stopped = false;
    stopMediaActivation({ ...event, stopPropagation: () => { stopped = true; } });
    assert(!stopped, `${event.key} must bubble to the drawer/sidebar`);
  }
});

test("media resource state is remounted for A-to-B-to-A retries", () => {
  const a = { id: "a", kind: "video" as const, url: "https://app.example.test/a.mp4" };
  const b = { id: "b", kind: "video" as const, url: "https://app.example.test/b.mp4" };
  assert(mediaIdentity(a) !== mediaIdentity(b), "distinct media must own distinct load state");
  const renderer = source(rendererPath);
  assert(renderer.includes("<MediaResource key={mediaIdentity(media)}"), "renderer does not remount failed media state on identity transitions");
});

test("interactive triggers receive noninteractive video thumbnails", () => {
  const batch = source("src/components/studio/BatchEditDrawer.tsx");
  const sidebar = source("src/components/studio/StudioPlanSidebar.tsx");
  assert(batch.includes('videoControls={false}'), "Batch button still contains playable video controls");
  assert(sidebar.includes('videoControls={false}'), "Sidebar navigation link still contains playable video controls");
  const renderer = source(rendererPath);
  assert(renderer.includes("controls={videoControls}"), "renderer cannot disable native controls inside parent triggers");
  assert(renderer.includes("tabIndex={videoControls ? undefined : -1}"), "noninteractive video previews must not enter the nested tab order");
  assert(/<button[\s\S]{0,900}ContentMediaRenderer[\s\S]{0,180}videoControls=\{false\}/.test(batch), "Batch detail button does not own the noninteractive preview");
  assert(/<Link[\s\S]{0,2000}ContentMediaRenderer[\s\S]{0,180}videoControls=\{false\}/.test(sidebar), "Sidebar navigation link does not own the noninteractive preview");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
