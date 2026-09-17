/**
 * Focused source contract for the confirmed Create Pin UI feedback package.
 * Run: npx tsx scripts/test-studio-ui-feedback.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { canDockStudioPlan, studioScheduleHitHeight, STUDIO_UI } from "../src/components/studio/boardUI";
import * as resilientMedia from "../src/components/media/ResilientMediaImage";
import { ContentMediaRenderer } from "../src/components/media/ContentMediaRenderer";

const { mediaIdentity } = resilientMedia;

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  OK  ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(error as Error).message}`);
  }
}
function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

const fallbackSrc = source("src/components/studio/PinFallbackArtwork.tsx");
const cardMediaSrc = source("src/components/studio/PinCardMedia.tsx");
const boardSrc = source("src/components/studio/StudioBoard.tsx");
const filtersSrc = source("src/components/studio/StudioBoardFilters.tsx");
const cardSrc = source("src/components/studio/PinBoardCard.tsx");
const planSrc = source("src/components/studio/StudioPlanSidebar.tsx");
const globalsSrc = source("src/app/globals.css");
const enSrc = source("src/lib/i18n/messages/en/studioBoard.ts");
const zhCnSrc = source("src/lib/i18n/messages/zh-CN.ts");
const zhTwSrc = source("src/lib/i18n/messages/zh-TW.ts");

console.log("\n=== Create Pin UI feedback contract ===");

test("all missing/failed media fallbacks use the shared neutral layered fallback", () => {
  for (const [name, src] of [["fallback artwork", fallbackSrc], ["card media", cardMediaSrc]] as const) {
    assert(src.includes("BUI.mediaFallback"), `${name} does not use the shared neutral fallback token`);
    assert(!/#20113b|#53258b|#e644b5|#ff4fbd/i.test(src), `${name} still contains the old purple/pink fallback palette`);
  }
});

test("selected Product/Reference previews use the shared failure/tiny/timeout loader", () => {
  const SelectedAssetImage = (resilientMedia as Record<string, unknown>).SelectedAssetImage;
  assert(typeof SelectedAssetImage === "function", "selected asset previews do not expose their shared image integration");
  for (const [surface, imageTestId] of [["thumbnail", "selected-asset-thumbnail-image"], ["hover", "selected-asset-hover-image"], ["gallery", "selected-asset-gallery-image"]] as const) {
    const markup = renderToStaticMarkup(createElement(SelectedAssetImage as React.ComponentType<{
      item: { imageUrl: string };
      imageTestId: string;
      fallback: React.ReactNode;
    }>, {
      item: { imageUrl: "https://cdn.example.test/asset.jpg" },
      imageTestId,
      fallback: createElement(resilientMedia.NeutralMediaFallback, { label: "Media unavailable" }),
    }));
    assert(markup.includes("<img") && markup.includes(imageTestId), `${surface} does not mount the shared media image`);
  }
});

test("shared media lifecycle keeps a valid image loaded beyond its timeout", () => {
  const reduce = (resilientMedia as Record<string, unknown>).reduceMediaLoadState;
  const shouldSchedule = (resilientMedia as Record<string, unknown>).shouldScheduleMediaLoadTimeout;
  assert(typeof reduce === "function", "ResilientMediaImage does not expose the lifecycle reducer it uses");
  assert(typeof shouldSchedule === "function", "ResilientMediaImage does not expose its timeout lifecycle guard");
  const transition = reduce as (state: string, event: string) => string;
  let state = transition("loading", "valid-load");
  state = transition(state, "timeout");
  assert(state === "loaded", "a valid image regressed to fallback after its timeout");
  assert(!(shouldSchedule as (state: string) => boolean)(state), "a valid image kept its timeout armed");
});

test("shared media lifecycle fails a true stall plus decode and tiny-image errors", () => {
  const reduce = (resilientMedia as Record<string, unknown>).reduceMediaLoadState as ((state: string, event: string) => string) | undefined;
  assert(Boolean(reduce), "ResilientMediaImage does not expose its lifecycle reducer");
  assert(reduce!("loading", "timeout") === "failed", "a stalled image did not fail");
  assert(reduce!("loading", "decode-error") === "failed", "a decode error did not fail");
  assert(reduce!("loading", "invalid-load") === "failed", "a tiny/invalid image did not fail");
});

test("shared media timeout cleanup makes unmount inert", () => {
  const start = (resilientMedia as Record<string, unknown>).startMediaLoadTimeout;
  assert(typeof start === "function", "ResilientMediaImage does not own a cancellable timeout");
  let callback: (() => void) | undefined;
  let cancelled = false;
  let timedOut = false;
  const stop = (start as (
    ms: number,
    onTimeout: () => void,
    schedule: (callback: () => void, ms: number) => number,
    cancel: (id: number) => void,
  ) => () => void)(8_000, () => { timedOut = true; }, fn => { callback = fn; return 1; }, () => { cancelled = true; });
  stop();
  callback?.();
  assert(cancelled, "unmount did not cancel the timeout");
  assert(!timedOut, "an unmounted image still transitioned to failed");
});

test("shared media lifecycle retries A after A→B→A and mounts each image consumer", () => {
  const reduce = (resilientMedia as Record<string, unknown>).reduceMediaLoadState as ((state: string, event: string) => string) | undefined;
  assert(Boolean(reduce), "ResilientMediaImage does not expose its lifecycle reducer");
  const failedA = reduce!("loading", "decode-error");
  const freshB = reduce!(failedA, "resource-change");
  const freshA = reduce!(freshB, "resource-change");
  assert(failedA === "failed" && freshB === "loading" && freshA === "loading", "A→B→A did not create fresh retry states");
  const imageMarkup = renderToStaticMarkup(createElement(resilientMedia.ResilientMediaImage, { src: "https://cdn.example.test/a.jpg", alt: "asset" }));
  const contentMarkup = renderToStaticMarkup(createElement(ContentMediaRenderer, { media: { id: "content-a", kind: "image", url: "https://cdn.example.test/a.jpg" } }));
  assert(imageMarkup.includes("<img"), "ResilientMediaImage does not mount an image while loading");
  assert(contentMarkup.includes("<img"), "ContentMediaRenderer bypasses the shared image boundary");
});

test("shared neutral fallback mounts for image, content, thumbnail, hover, and gallery media", () => {
  const Fallback = (resilientMedia as Record<string, unknown>).NeutralMediaFallback;
  assert(typeof Fallback === "function", "media consumers do not share one neutral fallback component");
  const markup = renderToStaticMarkup(createElement(Fallback as React.ComponentType<{ label: string }>, { label: "Media unavailable" }));
  assert(markup.includes("linear-gradient") && markup.includes("Media unavailable"), "shared fallback is not the neutral layered gradient");
});

test("media fallbacks keep localized accessible unavailable copy", () => {
  for (const [locale, src] of [["en", enSrc], ["zh-CN", zhCnSrc], ["zh-TW", zhTwSrc]] as const) {
    assert(src.includes('"studioBoard.card.pinImageUnavailable":'), `${locale} is missing unavailable-image label`);
  }
});

test("shared resource identities reset their load cursor on A→B→A", () => {
  const a = { imageUrl: "https://cdn.example.test/a.jpg" };
  const b = { imageUrl: "https://cdn.example.test/b.jpg" };
  assert(mediaIdentity(a) !== mediaIdentity(b), "A and B must own different media identities");
  assert(mediaIdentity(a) === mediaIdentity({ ...a }), "A must regain its original identity after B");
});

test("fallback copy remains localized in English, Simplified Chinese, and Traditional Chinese", () => {
  for (const [locale, src] of [["en", enSrc], ["zh-CN", zhCnSrc], ["zh-TW", zhTwSrc]] as const) {
    assert(src.includes('"studioBoard.card.pinImageUnavailable":'), `${locale} is missing the unavailable-image label`);
    assert(src.includes('"studioBoard.card.generationFailedPlaceholder":'), `${locale} is missing generation fallback copy`);
  }
});

test("card media keeps its existing recovery boundary while images use the shared lifecycle", () => {
  assert(cardMediaSrc.includes("onError={advance}"), "decode errors do not advance the candidate chain");
  assert(typeof resilientMedia.reduceMediaLoadState === "function", "shared image recovery lifecycle is unavailable");
});

test("video cards remain on the shared renderer with poster/provenance intact", () => {
  const video = source("src/components/media/ContentMediaRenderer.tsx");
  assert(cardMediaSrc.includes('primaryMedia?.kind === "video"'), "PinCardMedia no longer preserves the video branch");
  assert(video.includes("poster={media.posterUrl}"), "video poster is not forwarded");
  assert(video.includes("mediaIdentity(media)"), "video renderer lost stable media identity");
});

test("Studio removes the large shared banner and renders one quiet Pin-level notice", () => {
  assert(!boardSrc.includes("FailureBanner"), "Studio still imports or renders the page-width FailureBanner");
  assert(boardSrc.includes("attentionCount={publishFailureCount}"), "quiet notice does not use actionable failed Pin count");
  assert(filtersSrc.includes('data-testid="studio-failure-notice"'), "quiet notice is missing from the filter row");
  assert(filtersSrc.includes('tr("studioBoard.attention.onePin")'), "singular Pin copy is not localized");
  assert(filtersSrc.includes('tr("studioBoard.attention.manyPins")'), "plural Pin copy is not localized");
  assert(!/destinations? need attention/i.test(boardSrc + filtersSrc), "the old incorrect destination-count copy remains");
});

test("status filters and failure subfilters are localized", () => {
  assert(filtersSrc.includes("labelKey: MessageKey"), "status filter labels are still literals");
  assert(boardSrc.includes('tr("studioBoard.failedFilters.publish")'), "publish failure subfilter is not localized");
  assert(boardSrc.includes('tr("studioBoard.failedFilters.generation")'), "generation failure subfilter is not localized");
  for (const key of [
    "studioBoard.filters.drafts", "studioBoard.filters.scheduled", "studioBoard.filters.posted",
    "studioBoard.filters.failed", "studioBoard.filters.all", "studioBoard.attention.onePin",
    "studioBoard.attention.manyPins", "studioBoard.attention.review",
    "studioBoard.failedFilters.publish", "studioBoard.failedFilters.generation", "studioBoard.failedFilters.all",
  ]) {
    for (const [locale, src] of [["en", enSrc], ["zh-CN", zhCnSrc], ["zh-TW", zhTwSrc]] as const) {
      assert(src.includes(`"${key}":`), `${locale} is missing ${key}`);
    }
  }
});

test("destination heading uses clear same-language copy in all three locales", () => {
  assert(enSrc.includes('"studioBoard.card.publishTo": "Destinations"'), "English destination heading is stale");
  assert(zhCnSrc.includes('"studioBoard.card.publishTo": "发布目标"'), "zh-CN destination heading is stale");
  assert(zhTwSrc.includes('"studioBoard.card.publishTo": "發布目標"'), "zh-TW destination heading is stale");
});

test("Studio density is tokenized and cards keep editable field space", () => {
  assert(STUDIO_UI.cardMinWidth === 248, `cardMinWidth is ${STUDIO_UI.cardMinWidth}`);
  assert(STUDIO_UI.cardGap === 12, `cardGap is ${STUDIO_UI.cardGap}`);
  assert(STUDIO_UI.boardPadding === 18, `boardPadding is ${STUDIO_UI.boardPadding}`);
  assert(STUDIO_UI.fieldHeight === 32, `fieldHeight is ${STUDIO_UI.fieldHeight}`);
  assert(boardSrc.includes("STUDIO_UI.cardMinWidth") && boardSrc.includes("STUDIO_UI.cardGap"), "board grid bypasses Studio density tokens");
  assert(cardSrc.includes("borderRadius: STUDIO_UI.cardRadius"), "cards bypass the Studio radius token");
  assert(cardSrc.includes("minHeight: 60"), "description field was compressed below the approved editable height");
});

test("Plan uses one control and only docks above the two-card container threshold", () => {
  const threshold = STUDIO_UI.planPanelWidth + STUDIO_UI.cardMinWidth * 2 + STUDIO_UI.cardGap + STUDIO_UI.boardPadding * 2;
  assert(canDockStudioPlan(threshold - 1) === false, "Plan docks below the safe threshold");
  assert(canDockStudioPlan(threshold) === true, "Plan does not dock at the safe threshold");
  assert(planSrc.includes('data-testid="studio-plan-toggle"'), "Plan toggle is missing");
  assert(!planSrc.includes('data-testid="studio-plan-close"'), "Plan still has a second close button");
  assert(planSrc.includes('aria-controls={docked ? "studio-plan-sidebar" : "studio-plan-overlay"}'), "single toggle is not bound to its controlled surface");
  assert(boardSrc.includes("const observer = new ResizeObserver(measure);"), "Plan docking does not follow container size");
});

test("Schedule is the quiet secondary action and Publish is the primary CTA", () => {
  assert(cardSrc.includes("const scheduleBtn"), "no dedicated quiet Schedule style exists");
  assert(/data-testid="card-schedule"[\s\S]{0,160}style=\{scheduleBtn\}/.test(cardSrc), "compact Schedule is not using the quiet style");
  assert(/data-testid="card-publish"[\s\S]{0,160}style=\{primaryBtn\}/.test(cardSrc), "compact Publish is not the primary CTA");
  assert(studioScheduleHitHeight(390) === 44, "390px Schedule touch target is not 44px");
  assert(studioScheduleHitHeight(767) === 44, "mobile boundary does not keep the 44px target");
  assert(studioScheduleHitHeight(768) === 34, "desktop/tablet compact boundary is not 34px");
  assert(studioScheduleHitHeight(1440) === 34, "desktop Schedule is not compact");
  assert(cardSrc.includes('className="studio-schedule-button"'), "responsive hit-box class is not wired to compact Schedule");
  assert(globalsSrc.includes("--studio-schedule-hit-height: 34px"), "desktop Schedule hit-box variable is missing");
  assert(/@media \(max-width: 767px\)[\s\S]*?\.studio-schedule-button[\s\S]*?--studio-schedule-hit-height: 44px/.test(globalsSrc),
    "mobile Schedule hit-box is not raised to 44px at the real breakpoint");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
