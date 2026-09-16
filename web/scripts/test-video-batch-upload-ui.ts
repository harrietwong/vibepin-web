import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

test("retry and cancel use the batch state machine and display only safe error fields", () => {
  assert.match(source, /queueFailedVideoItems\(videoBatch\)/);
  assert.match(source, /videoBatchAbortRef\.current\?\.abort\(\)/);
  assert.match(source, /item\.error\?\.code/);
  assert.match(source, /item\.error\.requestId/);
  assert.doesNotMatch(source, /signedUrl.*video-batch|video-batch.*signedUrl/);
  assert.doesNotMatch(source, /privatePath.*video-batch|video-batch.*privatePath/);
});

console.log(`\n${passed} Studio video batch UI checks passed.\n`);
