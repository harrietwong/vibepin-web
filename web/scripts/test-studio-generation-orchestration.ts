import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/components/studio/StudioBoard.tsx", "utf8");
const helperSource = readFileSync("src/lib/studio/generateAiVersions.ts", "utf8");
const attemptStoreSource = readFileSync("src/lib/studio/generationSetupStore.ts", "utf8");
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
  assert.match(handler, /generate: \(\{ styleReference, batchRequestId, groupIndex, generationIntentId, setup: groupSetup, placeholderIds \}\)/);
  assert.match(handler, /dispatchGenerationGroup\(\{[\s\S]*?source: parent,[\s\S]*?setup: groupSetup,[\s\S]*?styleReference,[\s\S]*?batchRequestId,[\s\S]*?groupIndex,[\s\S]*?generationIntentId,[\s\S]*?placeholderIds/);
});

test("inline mode consumes the same dispatch response without a second request", () => {
  assert.match(helperSource, /if \(dispatched\.mode === "inline"\) return dispatched\.result;/);
  assert.doesNotMatch(handler, /firstGroupResult|workerProbe/);
});

test("worker mode stamps each group's recovery job and local slot before polling", () => {
  assert.match(handler, /onIntentPrepared:[\s\S]*?generationIntentId: intentId,[\s\S]*?generationIntentPayload: payload/);
  assert.match(handler, /onIntentPrepared: \(intentId, payload, ownerId, ids\)[\s\S]*?generationIntentOwnerId: ownerId/);
  assert.match(handler, /onWorkerJob: \(jobId, _slots, ids\) => ids\.forEach\(\(id, slot\) => \{[\s\S]*?generationJobId: jobId,[\s\S]*?generationSlot: slot/);
  assert.match(helperSource, /opts\.onWorkerJob\(dispatched\.jobId, dispatched\.slots, opts\.placeholderIds\)/);
  assert.match(helperSource, /return awaitGenerationJob\(dispatched\.jobId, dispatched\.slots, \{[\s\S]*?headers: authContext\.headers,[\s\S]*?shouldContinue:/);
  assert.doesNotMatch(handler, /pollGenerationJob\(/);
});

test("ambiguous owner-bound intent reconciles before any Try Again can create a new action", () => {
  assert.match(source, /if \(d\.generationRecoveryPending && d\.generationIntentId && d\.generationIntentPayload\) \{[\s\S]*?reconcileGeneratingDrafts\(\{ onAttemptState: presentGenerationAttempt \}\);[\s\S]*?return;/);
});

test("visible setup and attempt are committed before the generation run can create placeholders", () => {
  assert.match(handler, /prepareGenerationAttempt\([\s\S]*?await runAiGeneration\(\{ parent, opts, requestId: attemptId, setupKey \}/);
  assert.match(source, /onGenerate=\{\(opts, setup\) => handleAiGenerate\(opts, undefined, setup\)\}/);
  assert.match(handler, /const setup = committedSetup \?\? setupFromGenerationOptions\(opts\);/);
});

test("creative setup is the only generic restore path; generation store is attempt-only", () => {
  assert.match(source, /loadCreativeSetup\(/);
  assert.match(source, /saveCreativeSetup\(/);
  assert.doesNotMatch(source, /aiSetupCache|setAiSetupCache/, "no unscoped in-memory setup restore can cross owner/workspace");
  assert.match(source, /drawerForScope[\s\S]*?initialSetup=\{aiSetupKey \? loadCreativeSetup\(aiSetupKey\)/, "drawer restore reads the scoped store directly");
  assert.doesNotMatch(source, /loadGenerationSetup|saveGenerationSetup|clearGenerationSetup/);
  assert.doesNotMatch(helperSource, /loadGenerationSetup|saveGenerationSetup|clearGenerationSetup/);
});

test("owner/workspace transition closes the ephemeral drawer before B can see A's product", () => {
  assert.match(source, /ownerScopeKey/);
  assert.match(source, /aiDrawerScopeKey === ownerScopeKey/);
  assert.match(source, /setAiDrawer\(null\)[\s\S]*?setLimitPrompt\(null\)/);
  assert.match(source, /initialProductSelection=\{drawerForScope\.product \?\? null\}/);
});

test("card retry restores one failed reference group at count one", () => {
  const start = source.indexOf("const handleTryAgain");
  const end = source.indexOf("// Persist failure is re-read", start);
  const retry = source.slice(start, end);
  assert.match(retry, /setupForSingleCardRetry\(attemptSetup, groupReference\)/);
  assert.match(attemptStoreSource, /referenceImages: exactReferences\.map/);
  assert.match(attemptStoreSource, /referenceSelections: exactReferences/);
  assert.match(attemptStoreSource, /count: 1/);
});

test("intent persistence and owner guards precede worker callbacks", () => {
  assert.match(handler, /onIntentPrepared:[\s\S]*?hasPersistFailure\(\)[\s\S]*?return persisted/);
  assert.match(handler, /ownerStillActive: ownerId =>/);
  assert.match(helperSource, /if \(persisted === false\) throw new GenerationIntentPersistenceError\(\);[\s\S]*?send\("\/api\/generate"/);
  assert.match(helperSource, /if \(opts\.ownerStillActive && !opts\.ownerStillActive\(authContext\.ownerId\)\) \{[\s\S]*?GenerationOwnerChangedError/);
  assert.match(handler, /ownerChangedMidFlight = result\.ownerChanged/);
  assert.match(handler, /if \(ownerChangedMidFlight\) \{[\s\S]*?aiGenerationLockRef\.current = null;[\s\S]*?\} else if \(!keepBlockedForUnknown\)/);
});

test("generation failure analytics carries only stable fields and fixed machine codes", () => {
  const events = [...source.matchAll(/track\("generation_attempt_failed", \{([\s\S]*?)\}\);/g)].map(match => match[1]);
  assert.equal(events.length, 2, "persist and intent failures each emit one event");
  for (const event of events) {
    assert.match(event, /requestId:/);
    assert.match(event, /stage:/);
    assert.match(event, /code:/);
    assert.match(event, /expectedCount(?::|,)/);
    assert.doesNotMatch(event, /prompt|directionBrief|imageUrl|error\.message/);
  }
  assert.match(source, /code: "generation_attempt_persist_failed"/);
  assert.match(source, /result\.errorCode/);
});

test("pending and terminal feedback share the stable attempt toast id", () => {
  assert.match(source, /generationToastCommand\(summary\)/);
  assert.doesNotMatch(handler, /toast\.success\(totalPins === 1/);
  assert.match(handler, /summary\.state === "unknown"/);
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
