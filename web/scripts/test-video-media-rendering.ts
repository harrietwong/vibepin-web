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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
