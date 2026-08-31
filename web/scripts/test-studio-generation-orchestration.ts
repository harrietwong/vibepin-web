import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/components/studio/StudioBoard.tsx", "utf8");
const helperSource = readFileSync("src/lib/studio/generateAiVersions.ts", "utf8");
const start = source.indexOf("const handleAiGenerate = useCallback");
const end = source.indexOf("// ── Bulk actions", start);

assert.ok(start >= 0 && end > start, "handleAiGenerate source block must remain discoverable");
const handler = source.slice(start, end);

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

console.log("\nStudio generation orchestration\n");

test("one orchestration performs exactly one enqueue call per planned reference group", () => {
  assert.equal(
    handler.match(/dispatchGenerationGroup\s*\(/g)?.length ?? 0,
    1,
    "the group callback must contain one consumed dispatch and no probe dispatch",
  );
  assert.equal(handler.match(/runAiGeneration\s*\(/g)?.length ?? 0, 1);
  assert.doesNotMatch(handler, /enqueueGeneration\s*\(/);
  assert.equal(helperSource.match(/const dispatched = await enqueueGeneration\s*\(/g)?.length ?? 0, 1);
});

test("the group dispatch carries its reference and shared batch identity", () => {
  assert.match(handler, /generate: \(\{ styleReference, batchRequestId, groupIndex, generationIntentId, setup, placeholderIds \}\)/);
  assert.match(handler, /dispatchGenerationGroup\(\{[\s\S]*?source: parent,[\s\S]*?setup,[\s\S]*?styleReference,[\s\S]*?batchRequestId,[\s\S]*?groupIndex,[\s\S]*?generationIntentId,[\s\S]*?placeholderIds/);
});

test("inline mode consumes the same dispatch response without a second request", () => {
  assert.match(helperSource, /if \(dispatched\.mode === "inline"\) return dispatched\.result;/);
  assert.doesNotMatch(handler, /firstGroupResult|workerProbe/);
});

test("worker mode stamps each group's recovery job and local slot before polling", () => {
  assert.match(handler, /onIntentPrepared:[\s\S]*?generationIntentId: intentId,[\s\S]*?generationIntentPayload: payload/);
  assert.match(handler, /onWorkerJob: \(jobId, _slots, ids\) => ids\.forEach\(\(id, slot\) => \{[\s\S]*?generationJobId: jobId,[\s\S]*?generationSlot: slot/);
  assert.match(helperSource, /opts\.onWorkerJob\(dispatched\.jobId, dispatched\.slots, opts\.placeholderIds\)/);
  assert.match(helperSource, /return awaitGenerationJob\(dispatched\.jobId, dispatched\.slots, opts\.poll\)/);
  assert.doesNotMatch(handler, /pollGenerationJob\(/);
});

test("the component does not maintain a second worker-only placeholder implementation", () => {
  assert.doesNotMatch(handler, /const placeholders = Array\.from|const setupSnapshot =/);
  assert.doesNotMatch(handler, /generateAiVersions\(/);
});

test("Batch Edit stays hidden until at least two Pins are selected", () => {
  assert.match(source, /\{selectedIds\.size >= 2 && \(/);
  assert.doesNotMatch(source, /\{selectedIds\.size > 0 && \(/);
});

console.log(`\n${passed} orchestration checks passed.\n`);
