import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const boardSource = readFileSync("src/components/studio/StudioBoard.tsx", "utf8");
let passed = 0;
async function test(name: string, run: () => void | Promise<void>) {
  await run();
  passed++;
  console.log(`  OK ${name}`);
}

async function main() {
  console.log("\nImage upload batch state\n");

  await test("concurrent image batches do not reset all failures when a new batch starts", () => {
    const start = boardSource.indexOf("const processFiles = useCallback");
    const end = boardSource.indexOf("const executeVideoBatch", start);
    const processFiles = boardSource.slice(start, end);
    assert.ok(!processFiles.includes("setUploadFailures([])"), "starting a later image batch must not erase an earlier failure");
    assert.ok(!processFiles.includes("setUploadRetry(null)"), "starting a later image batch must not erase an earlier retry payload");
  });

  const state = await import("../src/lib/studio/imageUploadBatchState");
  const file = (name: string) => ({ name, type: "image/png", size: 1 }) as File;
  const detail = (requestId: string) => ({ stage: "upload" as const, code: "network", requestId });

  await test("a failed batch remains actionable after a concurrent batch succeeds", () => {
    let current = state.createImageUploadBatchState();
    current = state.beginImageUploadBatch(current, { batchId: "image-a" });
    current = state.beginImageUploadBatch(current, { batchId: "image-b" });
    current = state.completeImageUploadBatch(current, {
      batchId: "image-a",
      failures: [{ fileName: "a.png", detail: detail("request-a") }],
      retry: { files: [file("a.png")], mode: "separate" },
    });
    current = state.completeImageUploadBatch(current, { batchId: "image-b", failures: [] });

    assert.deepEqual(current.activeBatchIds, []);
    assert.deepEqual(current.failures.map(failure => [failure.batchId, failure.fileName, failure.detail.requestId]), [["image-a", "a.png", "request-a"]]);
    assert.deepEqual(current.retries.map(retry => [retry.batchId, retry.files.map(candidate => candidate.name), retry.mode]), [["image-a", ["a.png"], "separate"]]);
  });

  await test("retrying one failed batch removes only that batch's stale error and payload", () => {
    let current = state.createImageUploadBatchState();
    current = state.beginImageUploadBatch(current, { batchId: "image-a" });
    current = state.completeImageUploadBatch(current, {
      batchId: "image-a",
      failures: [{ fileName: "a.png", detail: detail("request-a") }],
      retry: { files: [file("a.png")], mode: "together" },
    });
    current = state.beginImageUploadBatch(current, { batchId: "image-b" });
    current = state.completeImageUploadBatch(current, {
      batchId: "image-b",
      failures: [{ fileName: "b.png", detail: detail("request-b") }],
      retry: { files: [file("b.png")], mode: "separate" },
    });

    current = state.beginImageUploadBatch(current, { batchId: "image-a-retry", retryBatchId: "image-a" });
    assert.deepEqual(current.failures.map(failure => failure.fileName), ["b.png"]);
    assert.deepEqual(current.retries.map(retry => [retry.batchId, retry.files[0].name]), [["image-b", "b.png"]]);
    assert.deepEqual(current.activeBatchIds, ["image-a-retry"]);
  });

  console.log(`\n${passed} image upload batch state checks passed.\n`);
}

void main();
