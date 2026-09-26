import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createVideoBatchState, selectVisibleVideoQueueItems, videoBatchErrorMessage, type VideoBatchItem } from "../src/lib/studio/videoBatchUpload";

const source = readFileSync("src/components/studio/StudioBoard.tsx", "utf8");
const card = readFileSync("src/components/studio/VideoUploadPlaceholderCard.tsx", "utf8");
let passed = 0;
function test(name: string, run: () => void) { run(); passed++; console.log(`  OK ${name}`); }

console.log("\nVideo batch upload Studio wiring\n");

test("the file input is image-only while the public video flag is off", () => {
  assert.match(source, /const fileAccept = videoBatchUploadEnabled \? VIDEO_AND_IMAGE_ACCEPT : IMAGE_ACCEPT/);
  assert.match(source, /accept=\{fileAccept\}/);
});

test("video and mixed selections bypass the carousel chooser and take the separate orchestration path", () => {
  const start = source.indexOf("const handleFiles = useCallback");
  const end = source.indexOf("const continueMultiUpload", start);
  const handler = source.slice(start, end);
  assert.match(source, /validateVideoBatchSelection\(arr, true\)/);
  assert.match(handler, /selection\.kind !== "image"\) \{ void processMixedVideoSelection\(arr\); return; \}/);
  assert.ok(handler.indexOf("selection.kind !== \"image\"") < handler.indexOf("setPendingUploadFiles(arr)"), "the video branch must return before the carousel chooser");
});

test("the Studio creates a single discriminated video draft only after private finalize", () => {
  assert.match(source, /finalize: finalizeVideoDirectUpload/);
  assert.match(source, /kind: "video"/);
  assert.match(source, /url: finalized\.proxyUrl/);
  assert.match(source, /idempotencyKey: item\.draftIdempotencyKey/);
  assert.doesNotMatch(source, /imageUrl:\s*finalized\.proxyUrl/);
});

test("the active queue shows a compact status chip (not a top-of-page panel) and keeps picker entry points enabled", () => {
  assert.doesNotMatch(source, /Video uploads · Active/);
  assert.match(source, /data-testid="video-upload-batch" role="status"/);
  assert.match(source, /tr\("studioBoard\.videoUpload\.chip"\)/);
  assert.match(source, /tr\("studioBoard\.videoUpload\.chipFailed"\)/);
  assert.doesNotMatch(source, /data-testid="board-upload-more"[^>]*disabled=\{uploading\}/);
  assert.doesNotMatch(source, /data-testid="board-upload-primary"[^>]*disabled=\{uploading\}/);
});

test("retry and cancel are per-item queue actions on placeholder cards and display only safe error fields", () => {
  assert.match(source, /queue\.retry\(id\)/);
  assert.match(source, /queue\.cancel\(id\)/);
  assert.match(source, /onCancel=\{cancelVideoItem\} onRetry=\{retryVideoItem\} onDismiss=\{dismissVideoItem\}/);
  assert.match(source, /data-testid="video-upload-cancel-all"/);
  assert.match(card, /data-testid=\{`video-upload-retry-\$\{item\.id\}`\}/);
  assert.match(card, /data-testid=\{`video-upload-cancel-\$\{item\.id\}`\}/);
  assert.match(card, /data-testid=\{`video-upload-dismiss-\$\{item\.id\}`\}/);
  assert.match(card, /videoBatchErrorMessage\(item\.error\?\.code/);
  // requestId is kept as evidence in attributes, never in visible copy.
  assert.match(card, /data-request-id=\{item\.error\?\.requestId/);
  assert.doesNotMatch(card, />\s*\{?[^<]*Request \$\{item\.error/);
  assert.doesNotMatch(source, /signedUrl.*video-batch|video-batch.*signedUrl/);
  assert.doesNotMatch(source, /privatePath.*video-batch|video-batch.*privatePath/);
});
test("the Studio gives video_too_large a clear Preview size-limit message", () => {
  assert.match(source, /videoBatchErrorMessage/);
  assert.equal(videoBatchErrorMessage("video_too_large"), "Video exceeds the Preview 50 MiB limit.");
});

test("placeholders show in-flight and undismissed failed items, never cancelled ones", () => {
  const items = Array.from({ length: 11 }, (_, index): VideoBatchItem => ({
    id: `terminal-${index}`,
    ordinal: 0,
    file: { name: `terminal-${index}.mp4`, type: "video/mp4", size: 1 } as File,
    state: index % 2 ? "cancelled" : "failed",
    ...(index % 2 ? {} : { error: { code: "video_upload_failed" } }),
  }));
  assert.equal(selectVisibleVideoQueueItems(createVideoBatchState("ui-reachability", items)).length, 11);
  assert.match(source, /selectVisibleVideoQueueItems\(videoBatch\)/);
  const start = source.indexOf("const placeholderVideoItems");
  const filter = source.slice(start, source.indexOf(");", start));
  assert.match(filter, /item\.state === "queued" \|\| item\.state === "uploading"/);
  assert.match(filter, /item\.state === "failed" && !dismissedVideoItemIds\.has\(item\.id\)/);
  assert.doesNotMatch(filter, /cancelled/);
  assert.match(source, /placeholderVideoItems\.map\(/);
  assert.doesNotMatch(source, /filter\(item => item\.state !== "succeeded"\)\.slice\(0, 8\)/);
});
test("a single-video card shows Edit cover inside the preview on hover, with no media strip; the dialog is a filmstrip picker", () => {
  const card = readFileSync("src/components/studio/PinBoardCard.tsx", "utf8");
  assert.match(card, /const singleVideo = cover\?\.kind === "video" && contentMedia\(draft\)\.length === 1 \? cover : null;/);
  assert.match(card, /data-testid="card-media" className="group"/);
  assert.match(card, /\{!generating && singleVideo && \(\s*<VideoCoverEditButton/);
  assert.match(card, /\{!generating && !singleVideo && <ContentMediaStrip /);
  const button = readFileSync("src/components/studio/VideoCoverEditButton.tsx", "utf8");
  assert.match(button, /group-hover:opacity-100/);
  assert.match(button, /position: "absolute"/);
  const dialog = readFileSync("src/components/studio/VideoCoverFrameDialog.tsx", "utf8");
  assert.match(dialog, /data-testid="video-cover-filmstrip"/);
  assert.match(dialog, /buildFilmstrip\(media\.url, durationMs, lifetime\.signal\)/);
  assert.match(dialog, /confirmVideoCoverFrame\(draftId, media, videoRef\.current, timeMs, undefined, signal\)/);
});
test("queue ownership disposes on replacement and unmount and gates state by queue identity", () => {
  assert.match(source, /existing\?\.queue\.dispose\(\)/);
  assert.match(source, /holder\?\.queue\.dispose\(\)/);
  assert.match(source, /videoQueueRef\.current\?\.queue !== queue/);
});

console.log(`\n${passed} Studio video batch UI checks passed.\n`);
