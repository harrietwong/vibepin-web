import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createVideoBatchState, selectVisibleVideoQueueItems, videoBatchErrorMessage, type VideoBatchItem } from "../src/lib/studio/videoBatchUpload";

const source = readFileSync("src/components/studio/StudioBoard.tsx", "utf8");
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

test("the active queue keeps picker entry points enabled and reports aggregate counts", () => {
  assert.match(source, /Video uploads · Active \{videoQueueSummary\?\.active/);
  assert.match(source, /Queued \{videoQueueSummary\?\.queued/);
  assert.match(source, /Completed \{videoQueueSummary\?\.completed/);
  assert.match(source, /Failed \{videoQueueSummary\?\.failed/);
  assert.doesNotMatch(source, /data-testid="board-upload-more"[^>]*disabled=\{uploading\}/);
  assert.doesNotMatch(source, /data-testid="board-upload-primary"[^>]*disabled=\{uploading\}/);
});

test("retry and cancel are per-item queue actions and display only safe error fields", () => {
  assert.match(source, /queue\.retry\(id\)/);
  assert.match(source, /queue\.cancel\(id\)/);
  assert.match(source, /data-testid=\{index === 0 \? "video-upload-retry"/);
  assert.match(source, /data-testid=\{index === 0 \? "video-upload-cancel"/);
  assert.match(source, /data-testid="video-upload-cancel-all"/);
  assert.match(source, /item\.error\?\.code/);
  assert.match(source, /item\.error\?\.requestId/);
  assert.doesNotMatch(source, /signedUrl.*video-batch|video-batch.*signedUrl/);
  assert.doesNotMatch(source, /privatePath.*video-batch|video-batch.*privatePath/);
});

test("the Studio gives video_too_large a clear Preview size-limit message", () => {
  assert.match(source, /videoBatchErrorMessage/);
  assert.equal(videoBatchErrorMessage("video_too_large"), "Video exceeds the Preview 50 MiB limit.");
});

test("later terminal rows remain reachable in an accessible bounded queue region", () => {
  const items = Array.from({ length: 11 }, (_, index): VideoBatchItem => ({
    id: `terminal-${index}`,
    ordinal: 0,
    file: { name: `terminal-${index}.mp4`, type: "video/mp4", size: 1 } as File,
    state: index % 2 ? "cancelled" : "failed",
    ...(index % 2 ? {} : { error: { code: "video_upload_failed" } }),
  }));
  assert.equal(selectVisibleVideoQueueItems(createVideoBatchState("ui-reachability", items)).length, 11);
  assert.match(source, /selectVisibleVideoQueueItems\(videoBatch\)/);
  assert.match(source, /aria-label="Video uploads needing attention"/);
  assert.match(source, /overflowY: "auto"/);
  assert.doesNotMatch(source, /filter\(item => item\.state !== "succeeded"\)\.slice\(0, 8\)/);
});

test("queue ownership disposes on replacement and unmount and gates state by queue identity", () => {
  assert.match(source, /existing\?\.queue\.dispose\(\)/);
  assert.match(source, /holder\?\.queue\.dispose\(\)/);
  assert.match(source, /videoQueueRef\.current\?\.queue !== queue/);
});

console.log(`\n${passed} Studio video batch UI checks passed.\n`);
