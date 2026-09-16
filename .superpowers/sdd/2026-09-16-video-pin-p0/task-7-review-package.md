# Review package: d7635c02b2bb010380c39d5c7777fbdadbcab8da..c449e73210872eb09362662b6c9b664c199aa66b

## Commits

c449e732 docs(video): record task 7 verification
8ef7b4dd docs(video): record task 7 verification
00d554dc feat(publish): route video through durable v76 pipeline

## Files changed

.../sdd/2026-09-16-video-pin-p0/progress.md | 10 +-
.../sdd/2026-09-16-video-pin-p0/task-7-brief.md | 46 ++
.../task-7-implementer-report.md | 94 +++++
web/scripts/test-publish-due-claim.ts | 17 +-
web/scripts/test-registry.ts | 1 +
web/scripts/test-v76-pinterest-video-publish.ts | 469 +++++++++++++++++++++
.../app/api/cron/publish-due/publishDueLogic.ts | 7 +-
web/src/app/api/cron/publish-due/route.ts | 86 +++-
web/src/app/api/pinterest/pins/route.ts | 24 +-
web/src/lib/server/pinterest/service.ts | 29 ++
web/src/lib/server/publish/confirmationReceipt.ts | 35 +-
.../server/publish/v76PinterestVideoBindings.ts | 113 +++++
.../server/publish/v76PinterestVideoImmediate.ts | 122 ++++++
.../lib/server/publish/v76PinterestVideoPublish.ts | 359 ++++++++++++++++
.../lib/server/publish/v76PinterestVideoRuntime.ts | 363 ++++++++++++++++
.../lib/server/publish/v76PinterestVideoServer.ts | 35 ++
web/src/lib/studio/publishConfirmation.ts | 27 +-
17 files changed, 1821 insertions(+), 16 deletions(-)

## Diff

diff --git a/.superpowers/sdd/2026-09-16-video-pin-p0/progress.md b/.superpowers/sdd/2026-09-16-video-pin-p0/progress.md
index a86a06be..6d052ae7 100644
--- a/.superpowers/sdd/2026-09-16-video-pin-p0/progress.md
+++ b/.superpowers/sdd/2026-09-16-video-pin-p0/progress.md
@@ -73,12 +73,20 @@ Implement batch Video Pin P0 without deployment: one video per draft, secure pri

## Task Status

- Task 0: complete (base `3f74653c`; plan commits `1bb3780d..654cf4f5`; baseline evidence above).
- Task 1: complete — `873a98db`, review fixes `644e4af1`, `b66746b5`, round-three hardening `f6a4f1f7`, and round-four privilege manifests `82584627`, implemented on `654cf4f5`. v77 now rejects drift in every owned ledger column/default/nullability/constraint, additive provenance column, standalone index, RLS/policy, table/column/function privilege, and client/server privilege boundary while accepting only the intentional active or rolled-back server manifests. PGlite (94 assertions), focused media-store coverage (23/23), and `tsc --noEmit` passed. Final integration must rebase/cherry-pick this reviewed Task 1 sequence onto official base `04b0ebe0`; this worktree has not been rebased. The v75 verifier still reports its pre-existing `deployment_blocked` broad Storage-policy evidence (65 assertions, no failures); Task 1 did not remove or mask it.
- Task 2: not started.
- Task 3: not started.
- Task 4: not started.
- Task 5: not started.
- Task 6: not started.
  -- Task 7: not started.
  +- Task 7: complete on isolated branch `codex/video-pin-p0-task7` — implementation

* commit `00d554dc` on base `d7635c02`. Immediate and due Pinterest video delivery now
* share v76 prepare/materialize/ready-claim/provider-attempt/settlement ordering with
* owner-authorized private bytes and Task 6's adapter. Unknown delivery is persisted
* distinctly and closed to blind retry; 201 success is replay-safe; legacy image
* publishing is unchanged and video bypasses fail closed. Focused Task 7 is 16/16,
* due 106/106, durable intent 23/23, confirmation 16/16, Task 6 adapter 16/16,
* v76 PGlite 280/280, v77 PGlite 94/94, scoped lint and typecheck pass. Full-suite
* baseline/environment blockers are recorded in `task-7-implementer-report.md`.

- Task 8: not started.
  diff --git a/.superpowers/sdd/2026-09-16-video-pin-p0/task-7-brief.md b/.superpowers/sdd/2026-09-16-video-pin-p0/task-7-brief.md
  new file mode 100644
  index 00000000..d5331e18
  --- /dev/null
  +++ b/.superpowers/sdd/2026-09-16-video-pin-p0/task-7-brief.md
  @@ -0,0 +1,46 @@
  +# Task 7 Brief — Bind Video Publishing To v76

*

+## Frozen Scope +
+- Base: `d7635c02b2bb010380c39d5c7777fbdadbcab8da` on `codex/video-pin-p0-task7`.
+- Implement one server-side Pinterest video publish orchestrator shared by immediate and due execution.
+- The orchestrator owns this exact order: owner/source validation, v76 confirm/prepare, destination materialization lease, item settlement, ready claim, durable provider-attempt start, Task 6 adapter dispatch, provider-attempt settlement.
+- Pinterest registration is inside the adapter call and therefore cannot occur before a ready destination claim and durable attempt.
+- Video delivery mode is `provider_bytes` from `generated-private`; no public copy or signed URL is returned or persisted.
+- A pre-existing `started` provider attempt is recovered as `delivery_unknown` and is never dispatched again. A successful 201 result is settled as success; if persistence fails after adapter success, callers receive an explicit do-not-retry/reconcile result.
+- Provider `unknown` settles v76 `unknown`; it is not retryable. Definite validation/rejection settles `failed`; sibling destination state is never rewritten.
+- Immediate and scheduled callers provide the same frozen media/destination/source identity. Scheduled callers are rejected before prepare/claim when the schedule is in the future or the run cannot safely start another destination.
+- Existing image publishing remains on its current path. The old image-only route returns `materialization_required` for video requests that cannot enter this orchestrator.
+- The legacy Python publisher, if present, must reject video explicitly. No Python Pinterest publishing entry point exists under `backend/` on this base, so the guarded legacy boundary is the existing image-only `publishPinForUser` path. +
+## Contract Decisions +
+- Confirmation fingerprints include media kind and video identity fields; the server validator normalizes image and video separately and verifies the exact submitted media snapshot.
+- The v76 receipt stored in Postgres remains bounded and secret-free: stable media id/kind/ordinal only. Private object location and verified facts come from owner-scoped v77 provenance/materialization, not caller-controlled locator fields.
+- Source bytes are resolved through an injected materializer. Production uses owner-scoped draft plus `media_asset_provenance` and private Storage download; tests mock only this external DB/Storage boundary.
+- The orchestrator speaks only existing v76 service-role RPCs: `publish_intent_confirm_prepare`, `publish_asset_lease_materialization`, `publish_asset_settle_item`, `publish_asset_claim_ready`, `publish_provider_attempt_start`, and `publish_provider_attempt_settle`.
+- Due execution may derive a deterministic immediate-form v76 receipt only after the row-level due/CAS claim has won. Its identity is frozen from the scheduled row revision, schedule instant, exact media, and destinations; merely scheduling never calls Pinterest.
+- Retry/replay first reads durable v76 state. `published` replays success, `delivery_unknown` blocks, and `started` is converted to unknown before any provider call. +
+## TDD Matrix +
+- Receipt: video normalization/fingerprint, source revision conflict, owner tampering, legacy image regression.
+- Orchestrator: lease competition, all-items-ready gate, provider-attempt idempotency, ready-claim-before-register, adapter success, adapter definite failure, adapter unknown, settlement failure after create, process-loss recovery, unknown anti-retry, sibling isolation.
+- Routes/due: immediate video uses shared orchestrator; due video uses the same function; future/out-of-window rows never prepare/claim/call provider; partial destinations persist independently; legacy video bypass returns `materialization_required`.
+- Database: retain and rerun v76/v77 PGlite lease, item readiness, attempt, unknown and owner/revision assertions; add Task 7 assertions only where an RPC invariant is missing.
+- No test may call real Pinterest, Storage, or a remote database. +
+## Baseline Evidence +
+- `test-publish-confirmation.ts`: 16 passed.
+- `test-publish-durable-intent.ts`: 23 passed.
+- `test-publish-due-claim.ts`: 105 passed.
+- `test-pinterest-video-adapter.ts`: 16 passed.
+- v76 PGlite: 280/280 assertions passed.
+- v77 PGlite: 94 assertions passed.
+- Dependencies are reused through junctions; no package installation or deletion is allowed. +
+## Explicit Non-Goals +
+- No upload/finalize API implementation, UI, renderer, AI Copy change, migration deployment, push, merge, production database/Storage access, token refresh, or real Pinterest request.
+- No second publish ledger and no direct client writes to v76/v77 tables.
diff --git a/.superpowers/sdd/2026-09-16-video-pin-p0/task-7-implementer-report.md b/.superpowers/sdd/2026-09-16-video-pin-p0/task-7-implementer-report.md
new file mode 100644
index 00000000..1717a6ee
--- /dev/null
+++ b/.superpowers/sdd/2026-09-16-video-pin-p0/task-7-implementer-report.md
@@ -0,0 +1,94 @@
+# Task 7 — Durable Video Publish Implementer Report +
+## Revision +
+- Base: `d7635c02b2bb010380c39d5c7777fbdadbcab8da`
+- Implementation commit: `00d554dc`
+- Branch: `codex/video-pin-p0-task7`
+- Worktree: `D:/vp-tmp/wt-video-pin-p0-task7` +
+## Delivered Contract +
+- Immediate and due Pinterest video delivery share one server orchestrator and the

- approved Task 6 adapter.
  +- Confirmation fingerprints now distinguish image and video identity, including
- duration/poster facts, while legacy image fingerprints remain compatible.
  +- The v76 order is enforced as prepare, private-byte materialization, all-items-ready
- destination claim, durable provider attempt, adapter dispatch, and settlement.
  +- Source bytes are owner/revision/provenance/checksum bound. The provider receives a
- private `Blob`; no public copy or signed URL is created or persisted.
  +- Provider registration is unreachable before a ready destination claim and durable
- attempt. Future and out-of-window due work performs no durable/provider I/O.
  +- A started attempt after process loss and every adapter-unknown outcome settles or
- remains `delivery_unknown`; replay is closed until reconciliation.
  +- Pinterest `201` success is never re-dispatched, including a response with a Pin id
- but no URL (a canonical Pinterest URL is derived where possible).
  +- Due outcome persistence keeps `delivery_unknown` distinct from `failed`, so sibling
- success remains published and unknown legs cannot be blindly retried.
  +- Legacy image publishing stays on its existing route. Mixed/multi-video legacy
- bypasses fail with `materialization_required` or defer before due claim/provider.
-

+No Python Pinterest publisher exists under `backend`; no second legacy video path was
+introduced. +
+## TDD Evidence +
+### RED +
+- The focused suite first failed with `MODULE_NOT_FOUND` for the missing durable

- orchestrator.
  +- The due regression proved `delivery_unknown` was being rewritten as `failed`.
  +- The post-attempt exception regression escaped as an ordinary throw before the
- orchestrator converted it to unknown.
  +- The due receipt test exposed the need to normalize PostgREST microsecond revisions
- to v76's canonical UTC-millisecond representation.
-

+### GREEN + +`text
+npx tsx scripts/test-v76-pinterest-video-publish.ts -> 16 passed, 0 failed
+npx tsx scripts/test-publish-due-claim.ts           -> 106 passed, 0 failed
+npx tsx scripts/test-publish-durable-intent.ts      -> 23 passed, 0 failed
+npx tsx scripts/test-publish-confirmation.ts        -> 16 passed, 0 failed
+npm run test:pinterest-video-adapter                 -> 16 passed, 0 failed
+` +
+The focused suite covers ordering, lease competition, all-items-ready, durable attempt
+idempotency, success-before-settle loss, unknown anti-retry, due/future windows,
+partial destinations, source revision conflict, owner/path tampering, legacy bypass,
+and canonical success evidence. All provider, Storage and database boundaries are
+mocked; no external call is possible in the suite. +
+## Verification +
+```text
+npm run typecheck -> exit 0
+npx eslint <Task 7 changed TS files> -> 0 errors, 0 warnings
+npx tsx scripts/check-test-registry.ts -> OK, 239 tracked / 231 run / 8 excluded
+node backend/tests/pglite_v37/verify-v76-publish-assets.mjs

-                                                       -> pass, 280/280, two rounds

+node backend/tests/pglite_v37/verify-v77-video-media.mjs

-                                                       -> pass, 94/94

+git diff --cached --check -> exit 0
+``` +
+The full `npm test` run reached and passed the new registered Task 7 suite. It also
+surfaced pre-existing base/environment failures outside this task: three stale static
+assertions in `test-publish-social-account-guard.ts` (the compared Pinterest key shape
+is byte-identical at base `d7635c02`), seven social retry cases whose fake Request has
+an invalid URL at unchanged `publish/social/route.ts:153`, and +`test-ai-copy-language-guardrail.ts` requiring an unset Supabase URL. The run was
+stopped after proving these unchanged blockers; focused and requested gates above are
+green. +
+## Risks / Handoff +
+- Task 7 relies on Task 2 producing the exact owner-first `/api/storage-media?path=…`

- locator and finalized v77 provenance facts. Task 2 is not present on this base, so
- no real end-to-end upload-to-publish run is possible in this worktree.
  +- Private intent-scoped publish copies are not public and store no signed locator.
- Their eventual cleanup continues to depend on the existing provenance/outbox
- operations policy.
  +- No independent reviewer subagent was dispatched because the active collaboration
- policy forbids unrequested subagent spawning; integration review remains required.
  +- No real Pinterest, Storage, database, deployment, push, or merge operation occurred.
  diff --git a/web/scripts/test-publish-due-claim.ts b/web/scripts/test-publish-due-claim.ts
  index b227cb1c..bbcf17e1 100644
  --- a/web/scripts/test-publish-due-claim.ts
  +++ b/web/scripts/test-publish-due-claim.ts
  @@ -291,20 +291,33 @@ test("payloadAfterOutcomes: nothing published ⇒ WP-B failure semantics + the l
  const after = payloadAfterOutcomes({ scheduledDate: "2026-08-27", scheduledTime: "09:30", plannedAt: "2026-08-27T09:30" }, [
  { provider: "pinterest", status: "failed", socialConnectionId: "pin_A", error: "Pinterest connection expired — please reconnect" },
  ], "2026-08-27T10:00:00.000Z");
  assert.equal(after.failureType, "publish");
  assert.equal(after.errorCategory, "auth");
  assert.equal(after.previousScheduledTime, "2026-08-27T09:30:00.000Z");
  assert.equal(after.postedAt, undefined);
  assert.equal(after.scheduledDate, "", "drops out of the due scan — no retry storm");
  });

+test("payloadAfterOutcomes: delivery_unknown stays closed to retry and is never rewritten as failed", () => {

- const after = payloadAfterOutcomes(
- { scheduledDate: "2026-08-27", plannedAt: "2026-08-27T09:30" },
- [{ provider: "pinterest", socialConnectionId: "pin_A", status: "delivery_unknown", error: "Reconcile first" }],
- "2026-08-27T10:00:00.000Z",
- null,
- "delivery_unknown",
- );
- const row = (after.destinationResults as Array<Record<string, unknown>>)[0];
- assert.equal(row.status, "delivery_unknown");
- assert.equal(after.publishError, "Reconcile first");
  +});
-

test("payloadAfterOutcomes: the failure CODE drives the category, not the wording", () => {
// The outcome rows carry only a user-facing message. Categorizing from that alone
// puts a differently-worded needs_reconnect in "transient" and offers the wrong fix.
const after = payloadAfterOutcomes({ scheduledDate: "2026-08-27" }, [
{ provider: "pinterest", status: "failed", socialConnectionId: "pin_A", error: "Something Pinterest said" },
], "2026-08-27T10:00:00.000Z", null, "needs_reconnect");
assert.equal(after.errorCategory, "auth");
assert.equal(after.publishErrorCode, "needs_reconnect");
});

@@ -651,22 +664,22 @@ test("each destination's outcome is stored the moment it is known", () => {
assert.match(routeSrc, /await mergeOutcomesIntoRow\(io, row, \[outcome\]\)/,
"one outcome, merged onto the row as it is now");
assert.match(routeSrc, /onOutcome: persistOne/,
"the fan-out must report each destination as it finishes, not the batch at the end");
const pinterestLoop = routeSrc.slice(
routeSrc.indexOf("for (const destination of pinterestTargets) {"),
routeSrc.indexOf("// Every attempted Pinterest destination was blocked"),
);
assert.ok(!/outcomes\.push\(/.test(pinterestLoop),
"a Pinterest outcome collected without being stored is one a process death loses");

- assert.equal((pinterestLoop.match(/await record\(/g) ?? []).length, 6,
- "every branch of the Pinterest loop must go through the recorder — trial-access included");

* assert.equal((pinterestLoop.match(/await record\(/g) ?? []).length, 11,
* "every image and video branch of the Pinterest loop must go through the recorder — unknown and trial-access included");
  const incremental = persistSrc.slice(persistSrc.indexOf("export async function mergeOutcomesIntoRow("));
  const upToFinal = incremental.slice(0, incremental.indexOf("export interface FinalWriteOptions"));
  assert.ok(!/scheduled_at|publish_claimed_at|postedAt/.test(upToFinal),
  "the incremental write records results ONLY — the Content is not finished yet");
  });

// ── the merge rules, against a fake row store ────────────────────────────────
// persistRow.ts reaches the database through two injected functions precisely so the
// rules above can be executed rather than pattern-matched.

diff --git a/web/scripts/test-registry.ts b/web/scripts/test-registry.ts
index 0e3aef72..97e05d07 100644
--- a/web/scripts/test-registry.ts
+++ b/web/scripts/test-registry.ts
@@ -40,20 +40,21 @@ export const CORE: string[] = [
"test-model-switch",
"test-assistant-detectors",
"test-analytics-events",
// Pinterest
"test-pinterest-oauth",
"test-pinterest-integrations-repair",
"test-pinterest-route-helpers",
"test-pinterest-connection-consistency",
"test-pinterest-client-dedupe",
"test-pinterest-video-adapter",

- "test-v76-pinterest-video-publish",
  "test-published-pin-summary",
  "test-social-provider-status",
  // Admin operator console (derivation layer + UI i18n)
  "test-admin-auth-security",
  "test-admin-account-kind",
  "test-admin-action-center",
  "test-activation-funnel",
  "test-ai-adoption",
  "test-admin-today-i18n",
  "test-account-quota",
  diff --git a/web/scripts/test-v76-pinterest-video-publish.ts b/web/scripts/test-v76-pinterest-video-publish.ts
  new file mode 100644
  index 00000000..75e64e56
  --- /dev/null
  +++ b/web/scripts/test-v76-pinterest-video-publish.ts
  @@ -0,0 +1,469 @@
  +/**
- - Durable Pinterest-video orchestration tests.
- -
- - DB, Storage and Pinterest are represented only at their explicit boundaries;
- - no test in this file can contact an external service.
- */
-

+import assert from "node:assert/strict";
+import {

- dispatchV76PinterestVideo,
- createV76RpcVideoPublishDependencies,
- type DurableVideoPublishDependencies,
- type DurableVideoPublishInput,
- type DurableVideoPublishState,
- type MaterializedVideoSource,
  +} from "../src/lib/server/publish/v76PinterestVideoPublish";
  +import { validateImmediatePublishReceipt } from "../src/lib/server/publish/confirmationReceipt";
  +import { publishConfirmationFingerprint } from "../src/lib/studio/publishConfirmation";
  +import {
- materializePrivateVideoSources,
- type PrivateVideoMaterializationBoundary,
  +} from "../src/lib/server/publish/v76PinterestVideoRuntime";
  +import {
- buildDueVideoReceipt,
- videoPublishHttpResult,
  +} from "../src/lib/server/publish/v76PinterestVideoBindings";
-

+const receipt = {

- intentId: "publish:content-1:action1234",
- priorIntentId: null,
- fingerprint: "a".repeat(64),
- draftId: "draft-1",
- contentId: "content-1",
- sourceUpdatedAt: "2026-09-16T12:00:00.000Z",
- title: "Video Pin",
- description: "Description",
- altText: "Demo video",
- destinationUrl: "https://shop.test/item",
- media: [{
- id: "video-1",
- kind: "video" as const,
- url: "/api/storage-media?path=owner-1%2Fuploads%2Fvideo.mp4",
- source: "upload" as const,
- durationMs: 8_000,
- }],
- mode: { kind: "now" as const },
- destinations: [{
- id: "pinterest:connection-1",
- provider: "pinterest" as const,
- socialConnectionId: "connection-1",
- boardId: "board-1",
- }],
- publishableDestinations: [{
- id: "pinterest:connection-1",
- provider: "pinterest" as const,
- socialConnectionId: "connection-1",
- boardId: "board-1",
- }],
- dispatchDestinationIds: ["pinterest:connection-1"],
- blockers: [],
- onlyPending: true,
- confirmedAt: "2026-09-16T12:00:01.000Z",
  +};
-

+const source: MaterializedVideoSource = {

- mediaId: "video-1",
- ordinal: 0,
- bucketId: "generated-private",
- objectPath: "owner-1/publish/content-1/video-1.mp4",
- contentType: "video/mp4",
- byteSize: 11,
- checksumSha256: "b".repeat(64),
- fileName: "video-1.mp4",
- file: new Blob(["video-data"], { type: "video/mp4" }),
  +};
-

+function input(overrides: Partial<DurableVideoPublishInput> = {}): DurableVideoPublishInput {

- return {
- uid: "owner-1",
- receipt,
- destination: receipt.publishableDestinations[0],
- nowMs: Date.parse("2026-09-16T12:00:02.000Z"),
- ...overrides,
- };
  +}
-

+function harness(state: DurableVideoPublishState = { kind: "missing" }) {

- const calls: string[] = [];
- let inspection = state;
- const deps: DurableVideoPublishDependencies = {
- inspect: async () => { calls.push("inspect"); return inspection; },
- confirmPrepare: async () => { calls.push("confirm"); },
- leaseMaterialization: async () => {
-      calls.push("lease");
-      return { leaseToken: "lease-1", deliveryId: "delivery-1" };
- },
- materializeSources: async () => { calls.push("materialize"); return [source]; },
- settleItem: async () => { calls.push("settle-item"); return { deliveryReady: true }; },
- claimReady: async () => { calls.push("claim"); return { claimToken: "claim-1" }; },
- startAttempt: async () => {
-      calls.push("attempt-start");
-      inspection = { kind: "attempt_started", attemptId: "attempt-1", claimToken: "claim-1" };
-      return { attemptId: "attempt-1", status: "started", replayed: false };
- },
- publishVideo: async () => {
-      calls.push("provider");
-      return {
-        outcome: "succeeded",
-        evidence: {
-          stage: "created",
-          classification: "succeeded",
-          mediaId: "provider-media-1",
-          pinId: "12345",
-          pinUrl: "https://www.pinterest.com/pin/12345/",
-        },
-      };
- },
- settleAttempt: async (_input, status) => { calls.push(`attempt-settle:${status}`); },
- };
- return { calls, deps, setState: (next: DurableVideoPublishState) => { inspection = next; } };
  +}
-

+let passed = 0;
+let failed = 0;
+async function test(name: string, fn: () => Promise<void>): Promise<void> {

- try {
- await fn();
- passed += 1;
- console.log(`  OK   ${name}`);
- } catch (error) {
- failed += 1;
- console.error(`  FAIL ${name}\n      ${(error as Error).stack ?? String(error)}`);
- }
  +}
-

+async function main(): Promise<void> {
+await test("confirmation fingerprints freeze media kind and video identity", async () => {

- const shared = {
- priorIntentId: null,
- draftId: "draft-1",
- contentId: "content-1",
- sourceUpdatedAt: "2026-09-16T12:00:00.000Z",
- title: "Video Pin",
- description: "Description",
- altText: "Demo video",
- destinationUrl: "https://shop.test/item",
- mode: { kind: "now" as const },
- destinations: receipt.destinations,
- dispatchDestinationIds: receipt.dispatchDestinationIds,
- blockers: [],
- onlyPending: true,
- };
- const image = publishConfirmationFingerprint({
- ...shared,
- media: [{ id: "video-1", url: receipt.media[0].url, kind: "image", durationMs: null }],
- } as Parameters<typeof publishConfirmationFingerprint>[0]);
- const video = publishConfirmationFingerprint({
- ...shared,
- media: [{ id: "video-1", url: receipt.media[0].url, kind: "video", durationMs: 8_000 }],
- } as Parameters<typeof publishConfirmationFingerprint>[0]);
- assert.notEqual(video, image);
  +});
-

+await test("server confirmation preserves an exact video media snapshot instead of coercing it to image", async () => {

- const raw = {
- ...receipt,
- fingerprint: publishConfirmationFingerprint({
-      ...receipt,
-      media: receipt.media,
- } as Parameters<typeof publishConfirmationFingerprint>[0]),
- };
- const result = validateImmediatePublishReceipt(raw, {
- draftId: receipt.draftId,
- title: receipt.title,
- description: receipt.description,
- destinationUrl: receipt.destinationUrl,
- altText: receipt.altText,
- imageUrls: [receipt.media[0].url],
- }, receipt.dispatchDestinationIds, Date.parse("2026-09-16T12:00:02.000Z"));
- assert.equal(result.ok, true);
- if (result.ok) assert.equal(result.receipt.media[0].kind, "video");
  +});
-

+await test("due execution rebuilds one deterministic now-mode receipt from the frozen database revision", async () => {

- const payload = {
- id: receipt.draftId,
- contentId: receipt.contentId,
- title: receipt.title,
- description: receipt.description,
- altText: receipt.altText,
- destinationUrl: receipt.destinationUrl,
- media: receipt.media,
- imageUrl: receipt.media[0].url,
- scheduledDestinations: receipt.destinations,
- };
- const first = buildDueVideoReceipt({
- draftId: receipt.draftId,
- updatedAt: receipt.sourceUpdatedAt,
- scheduledAt: "2026-09-16T12:00:00.000Z",
- payload,
- });
- const replay = buildDueVideoReceipt({
- draftId: receipt.draftId,
- updatedAt: receipt.sourceUpdatedAt,
- scheduledAt: "2026-09-16T12:00:00.000Z",
- payload,
- });
- assert.equal(first.intentId, replay.intentId);
- assert.deepEqual(first.mode, { kind: "now" });
- assert.equal(first.sourceUpdatedAt, receipt.sourceUpdatedAt);
- assert.equal(first.media[0].kind, "video");
- const precise = buildDueVideoReceipt({
- draftId: receipt.draftId,
- updatedAt: "2026-09-16T12:00:00.123456+00:00",
- scheduledAt: "2026-09-16T12:00:00.000Z",
- payload,
- });
- assert.equal(precise.sourceUpdatedAt, "2026-09-16T12:00:00.123Z");
  +});
-

+await test("HTTP binding exposes unknown as anti-retry reconciliation, not ordinary failure", async () => {

- assert.deepEqual(videoPublishHttpResult({
- outcome: "delivery_unknown",
- retryAllowed: false,
- reconcileRequired: true,
- evidence: { reason: "provider_settlement_unavailable" },
- }), {
- status: 409,
- body: {
-      ok: false,
-      error: "Delivery status is unknown. Reconcile the original intent before retrying.",
-      code: "delivery_unknown",
-      retryAllowed: false,
-      reconcileRequired: true,
-      remoteEvidence: { reason: "provider_settlement_unavailable" },
- },
- });
  +});
-

+await test("orders confirm, materialization, ready claim, durable attempt, provider, and success settlement", async () => {

- const { calls, deps } = harness();
- const result = await dispatchV76PinterestVideo(input(), deps);
- assert.equal(result.outcome, "published");
- assert.deepEqual(calls, [
- "inspect", "confirm", "lease", "materialize", "settle-item", "claim",
- "attempt-start", "provider", "attempt-settle:succeeded",
- ]);
  +});
-

+await test("the production RPC adapter uses only the existing v76 prepare, lease, item, claim, attempt and settlement entry points", async () => {

- const rpcNames: string[] = [];
- const deps = createV76RpcVideoPublishDependencies({
- inspect: async () => ({ kind: "missing" }),
- materializeSources: async () => [source],
- publishVideo: async () => ({
-      outcome: "succeeded",
-      evidence: { stage: "created", classification: "succeeded", pinId: "12345", pinUrl: "https://www.pinterest.com/pin/12345/" },
- }),
- rpc: async (name) => {
-      rpcNames.push(name);
-      const values: Record<string, unknown> = {
-        publish_intent_confirm_prepare: { prepared: true },
-        publish_asset_lease_materialization: { leaseToken: "lease-1", deliveryId: "delivery-1" },
-        publish_asset_settle_item: { deliveryReady: true },
-        publish_asset_claim_ready: { claimToken: "claim-1" },
-        publish_provider_attempt_start: { attemptId: "attempt-1", status: "started", replayed: false },
-        publish_provider_attempt_settle: { settled: true },
-      };
-      return values[name];
- },
- });
- assert.equal((await dispatchV76PinterestVideo(input(), deps)).outcome, "published");
- assert.deepEqual(rpcNames, [
- "publish_intent_confirm_prepare",
- "publish_asset_lease_materialization",
- "publish_asset_settle_item",
- "publish_asset_claim_ready",
- "publish_provider_attempt_start",
- "publish_provider_attempt_settle",
- ]);
  +});
-

+await test("private materialization freezes the owner source revision and rejects owner/path tampering before copy", async () => {

- const copied: string[] = [];
- const boundary: PrivateVideoMaterializationBoundary = {
- loadDraft: async () => ({
-      updatedAt: receipt.sourceUpdatedAt,
-      payload: { media: receipt.media },
- }),
- findProvenance: async (_uid, _bucket, objectPath) => ({
-      ownerUserId: "owner-1",
-      bucketId: "generated-private",
-      objectPath,
-      mediaKind: "video",
-      contentType: "video/mp4",
-      byteSize: 10,
-      checksumSha256: "3e66ede228ae2f3f6cf3c95cb1fba47226b630fa25b4da48f3438fcb7c9d6376",
-      width: null,
-      height: null,
-      durationMs: 8_000,
-      lifecycleState: "draft",
- }),
- download: async () => new Blob(["video-data"], { type: "video/mp4" }),
- storePublishCopy: async args => { copied.push(args.targetPath); },
- };
- const exact = await materializePrivateVideoSources(input(), { leaseToken: "lease-1", deliveryId: "delivery-1" }, boundary);
- assert.equal(exact.length, 1);
- assert.equal(exact[0].objectPath.startsWith("owner-1/publish/"), true);
- assert.equal(copied.length, 1);
-
- copied.length = 0;
- boundary.loadDraft = async () => ({
- updatedAt: "2026-09-16T12:00:03.000Z",
- payload: { media: receipt.media },
- });
- await assert.rejects(
- materializePrivateVideoSources(input(), { leaseToken: "lease-1", deliveryId: "delivery-1" }, boundary),
- /publish_source_revision_conflict/,
- );
- assert.equal(copied.length, 0);
-
- const tampered = input({
- receipt: {
-      ...receipt,
-      media: [{ ...receipt.media[0], url: "/api/storage-media?path=owner-2%2Fuploads%2Fvideo.mp4" }],
- },
- });
- boundary.loadDraft = async () => ({ updatedAt: receipt.sourceUpdatedAt, payload: { media: tampered.receipt.media } });
- await assert.rejects(
- materializePrivateVideoSources(tampered, { leaseToken: "lease-1", deliveryId: "delivery-1" }, boundary),
- /video_source_owner_mismatch/,
- );
- assert.equal(copied.length, 0);
  +});
-

+await test("future schedules and out-of-window runs do not prepare, claim, or call Pinterest", async () => {

- for (const blocked of [
- input({ scheduleAt: "2026-09-16T12:01:00.000Z" }),
- input({ latestStartMs: Date.parse("2026-09-16T12:00:01.000Z") }),
- ]) {
- const { calls, deps } = harness();
- const result = await dispatchV76PinterestVideo(blocked, deps);
- assert.equal(result.outcome, "not_due");
- assert.deepEqual(calls, []);
- }
  +});
-

+await test("lease competition and an all-items-ready refusal stop before provider dispatch", async () => {

- const leased = harness();
- leased.deps.leaseMaterialization = async () => { leased.calls.push("lease"); throw new Error("materialization_already_leased"); };
- assert.equal((await dispatchV76PinterestVideo(input(), leased.deps)).outcome, "in_progress");
- assert.equal(leased.calls.includes("provider"), false);
-
- const unready = harness();
- unready.deps.settleItem = async () => { unready.calls.push("settle-item"); return { deliveryReady: false }; };
- assert.equal((await dispatchV76PinterestVideo(input(), unready.deps)).outcome, "in_progress");
- assert.equal(unready.calls.includes("claim"), false);
- assert.equal(unready.calls.includes("provider"), false);
  +});
-

+await test("a process-loss started attempt becomes unknown and is never dispatched again", async () => {

- const { calls, deps } = harness({ kind: "attempt_started", attemptId: "attempt-old", claimToken: "claim-old" });
- const result = await dispatchV76PinterestVideo(input(), deps);
- assert.equal(result.outcome, "delivery_unknown");
- assert.deepEqual(calls, ["inspect", "attempt-settle:unknown"]);
  +});
-

+await test("published replays return success and unknown replays are anti-retry", async () => {

- const published = harness({
- kind: "published",
- remoteId: "12345",
- remoteUrl: "https://www.pinterest.com/pin/12345/",
- evidence: { provider: "pinterest" },
- });
- const replay = await dispatchV76PinterestVideo(input(), published.deps);
- assert.equal(replay.outcome, "published");
- assert.equal(replay.replayed, true);
- assert.deepEqual(published.calls, ["inspect"]);
-
- const unknown = harness({ kind: "delivery_unknown", evidence: { reason: "unknown_outcome" } });
- assert.equal((await dispatchV76PinterestVideo(input(), unknown.deps)).outcome, "delivery_unknown");
- assert.deepEqual(unknown.calls, ["inspect"]);
-
- const failedReplay = harness({ kind: "failed", evidence: { reason: "provider_rejected" } });
- const failedResult = await dispatchV76PinterestVideo(input(), failedReplay.deps);
- assert.equal(failedResult.outcome, "failed");
- assert.equal(failedResult.replayed, true);
- assert.deepEqual(failedReplay.calls, ["inspect"]);
  +});
-

+await test("adapter failure and unknown settle the durable attempt without becoming success", async () => {

- for (const providerOutcome of ["failed", "unknown"] as const) {
- const { calls, deps } = harness();
- deps.publishVideo = async () => {
-      calls.push("provider");
-      return {
-        outcome: providerOutcome,
-        evidence: {
-          stage: "registered",
-          classification: providerOutcome === "failed" ? "definite_rejection" : "unknown",
-        },
-      };
- };
- const result = await dispatchV76PinterestVideo(input(), deps);
- assert.equal(result.outcome, providerOutcome === "failed" ? "failed" : "delivery_unknown");
- assert.equal(calls.at(-1), `attempt-settle:${providerOutcome}`);
- }
  +});
-

+await test("an exception after durable attempt start settles unknown and cannot escape into a retry path", async () => {

- const { calls, deps } = harness();
- deps.publishVideo = async () => {
- calls.push("provider");
- throw new Error("connection lookup or provider boundary lost");
- };
- const result = await dispatchV76PinterestVideo(input(), deps);
- assert.equal(result.outcome, "delivery_unknown");
- assert.equal(result.retryAllowed, false);
- assert.equal(result.reconcileRequired, true);
- assert.equal(calls.at(-1), "attempt-settle:unknown");
  +});
-

+await test("a 201 with a Pin id but no response URL persists and returns the canonical Pinterest URL", async () => {

- const { deps } = harness();
- deps.publishVideo = async () => ({
- outcome: "succeeded",
- evidence: { stage: "created", classification: "succeeded", pinId: "12345" },
- });
- const result = await dispatchV76PinterestVideo(input(), deps);
- assert.equal(result.outcome, "published");
- assert.equal(result.remoteUrl, "https://www.pinterest.com/pin/12345/");
  +});
-

+await test("a 201-equivalent success followed by settlement loss requires reconciliation and never reports retryable failure", async () => {

- const { calls, deps } = harness();
- deps.settleAttempt = async (_input, status) => {
- calls.push(`attempt-settle:${status}`);
- throw new Error("database unavailable after create");
- };
- const result = await dispatchV76PinterestVideo(input(), deps);
- assert.equal(result.outcome, "delivery_unknown");
- assert.equal(result.reconcileRequired, true);
- assert.equal(result.retryAllowed, false);
- assert.equal(calls.filter(call => call === "provider").length, 1);
  +});
-

+await test("one destination failure never mutates or suppresses a sibling success", async () => {

- const success = harness();
- const failed = harness();
- failed.deps.publishVideo = async () => ({
- outcome: "failed",
- evidence: { stage: "registered", classification: "definite_rejection" },
- });
- const [left, right] = await Promise.all([
- dispatchV76PinterestVideo(input(), success.deps),
- dispatchV76PinterestVideo(input({
-      destination: { ...receipt.publishableDestinations[0], id: "pinterest:connection-2", socialConnectionId: "connection-2" },
- }), failed.deps),
- ]);
- assert.equal(left.outcome, "published");
- assert.equal(right.outcome, "failed");
- assert.equal(success.calls.includes("attempt-settle:succeeded"), true);
  +});
-

+console.log(`\n${passed} passed, ${failed} failed`);
+if (failed) process.exit(1);
+} +
+void main();
diff --git a/web/src/app/api/cron/publish-due/publishDueLogic.ts b/web/src/app/api/cron/publish-due/publishDueLogic.ts
index a1d66efe..80bb4f15 100644
--- a/web/src/app/api/cron/publish-due/publishDueLogic.ts
+++ b/web/src/app/api/cron/publish-due/publishDueLogic.ts
@@ -285,25 +285,26 @@ function outcomeRows(
// rejected a post that was never sent, and inviting them to "retry" a publish
// the next run is going to make anyway. It also must not reach
// `supersededDestinationResults`, which would archive the live post this
// destination still has and drop it from the card.
.filter(o => o.status !== "skipped" && o.status !== "pending")
.map(o => {
const connectionId = typeof o.socialConnectionId === "string" && o.socialConnectionId.trim()
? o.socialConnectionId.trim()
: null;
const published = o.status === "published";

-      const deliveryUnknown = o.status === "delivery_unknown";
       const row: Record<string, unknown> = {
         destinationId: `${o.provider}:${connectionId ?? "legacy"}`,
         provider: o.provider,
         socialConnectionId: connectionId,

*        status: published ? "published" : "failed",

-        status: published ? "published" : deliveryUnknown ? "delivery_unknown" : "failed",
         submittedAt: nowIso,
       };
       if (o.accountName) row.accountLabel = o.accountName;
       if (published) {
         row.publishedAt = nowIso;
         if (o.externalPostId) row.remoteId = o.externalPostId;
         if (o.externalPostUrl) row.postUrl = o.externalPostUrl;
       } else {
         row.errorMessage = o.error || "Publishing failed.";
       }

@@ -733,21 +734,22 @@ export function payloadAfterOutcomes(
if (clearSchedule) clearScheduleFields(next);
delete next.publishError;
delete next.failureType;
delete next.errorCategory;
delete next.publishErrorCode;
return next;
}

// Nothing was delivered. The first failure is what the Content-level banner reports;
// every destination keeps its own reason in its own row.

- const firstFailure = attempted.find(o => o.status === "failed");

* const firstFailure = attempted.find(o => o.status === "failed")
* ?? attempted.find(o => o.status === "delivery_unknown");
  const message = firstFailure?.error || "Publish failed";
  const previousScheduled = previousScheduledIso(payload);
  next.publishError = message;
  next.failureType = "publish";
  next.errorCategory = mapPublishErrorToCategory(failureCode, message);
  if (failureCode) next.publishErrorCode = failureCode;
  if (clearSchedule && previousScheduled) next.previousScheduledTime = previousScheduled;
  if (clearSchedule) clearScheduleFields(next);
  return next;
  }
  @@ -774,20 +776,21 @@ function previousScheduledIso(payload: Record<string, unknown>): string | undefi

- single legacy board; with N Pinterest entries the board is a property of the ENTRY,
- so a second account with no board of its own is refused on its own rather than
- publishing into the first account's board.
  _/
  export function destinationPublishInput(
  base: DuePublishInput,
  destination: { socialConnectionId?: string | null; boardId?: string | null },
  /_* Retained for call-site compatibility; legacy target fields are never fallbacks. */
  _legacyTargetConnectionId: string,
  ): PinterestPublishInput | null {

* void _legacyTargetConnectionId;
  const own = typeof destination.boardId === "string" ? destination.boardId.trim() : "";
  const id = typeof destination.socialConnectionId === "string" ? destination.socialConnectionId.trim() : "";
  if (!own || !id) return null;
  return { ...base, boardId: own, connectionId: id };
  }

/** Extract { message, code } from a thrown error for categorization. Connection/API

- errors from publishPin.ts carry a `.code` (needs_reconnect / not_connected / …). _/
  export function describeThrown(err: unknown): PublishFailureInfo {
  const e = err as { message?: unknown; code?: unknown } | null;
  diff --git a/web/src/app/api/cron/publish-due/route.ts b/web/src/app/api/cron/publish-due/route.ts
  index 9d1b9b60..66f97d5f 100644
  --- a/web/src/app/api/cron/publish-due/route.ts
  +++ b/web/src/app/api/cron/publish-due/route.ts
  @@ -36,20 +36,22 @@ import {
  } from "@/lib/server/usage/meterScheduledPost";
  import {
  aggregateDelivery,
  classifyDelivery,
  isRefundable,
  readProviderSignal,
  type DeliveryOutcome,
  } from "@/lib/server/usage/deliveryOutcome";
  import { publishPinForUser } from "@/lib/server/pinterest/publishPin";
  import { requiresPublishAsset } from "@/lib/server/publishMedia";
  +import { dispatchSupabaseV76PinterestVideo } from "@/lib/server/publish/v76PinterestVideoServer";
  +import { buildDueVideoReceipt } from "@/lib/server/publish/v76PinterestVideoBindings";
  import {
  NeedsReconnectError,
  NotConnectedError,
  PinterestTrialAccessError,
  } from "@/lib/server/pinterest/service";
  import {
  createPublishJob,
  deferredOutcome,
  fanOutDestinations,
  hasTimeForDestination,
  @@ -95,22 +97,35 @@ const DUE_LIMIT = 20; // ≤ 20 per run so one invocation stays comfortably unde
  /_* Pause before the single persist retry — long enough for a transient blip, short
- enough that it cannot itself push the run past maxDuration. */
  const PERSIST_RETRY_DELAY_MS = 500;

type DueRow = {
vibepin_user_id: string;
draft_id: string;
payload: Record<string, unknown>;
/** The due instant — the stable half of the 5B metering idempotency key. */
scheduled_at: string | null;

- /** Exact database revision frozen into the due-time v76 confirmation. */
- updated_at: string;
  };

+function payloadMedia(payload: Record<string, unknown>): Array<Record<string, unknown>> {

- return Array.isArray(payload.media)
- ? payload.media.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
- : [];
  +}
-

+function isSingleVideoPayload(payload: Record<string, unknown>): boolean {

- const media = payloadMedia(payload);
- return media.length === 1 && media[0].kind === "video";
  +}
-

function json(body: unknown, status = 200): Response {
return Response.json(body, { status });
}

/**

- The two database operations every persist is built from.
-
- Deliberately narrow. persistRow.ts owns the merge rules — re-read, apply onto the
- LATEST payload, stamp at write time — and does not know Supabase exists, which is
- what makes those rules testable against a fake row store.
  @@ -218,41 +233,43 @@ export async function GET(req: Request): Promise<Response> {
  // polls, and being killed part-way through means the accounts that already
  // published are published again ten minutes later.
  const deadlineMs = startedMs + RUN_DEADLINE_MS;

// ── 1) SCAN due, live rows ───────────────────────────────────────────────────
const { data: dueRows, error: scanError } = await db
.from(TABLE)
// scheduled_at is selected because it is the STABLE half of the metering
// idempotency key (Phase 5B). Claim time is not usable: it is regenerated on
// every run, so a stale re-claim would mint a new key and double-count.

- .select("vibepin_user_id, draft_id, payload, scheduled_at")

* .select("vibepin_user_id, draft_id, payload, scheduled_at, updated_at")
  .lte("scheduled_at", nowIso)
  .not("scheduled_at", "is", null)
  .is("deleted_at", null)
  .is("archived_at", null)
  .order("scheduled_at", { ascending: true })
  .limit(DUE_LIMIT);

if (scanError) {
if (isMissingSchemaError(scanError)) return json({ claimed: 0, published: 0, failed: 0, skipped: 0, deferred: 0 });
console.error("[cron/publish-due] scan error:", scanError.message);
return json({ error: "scan_failed", code: "database_unavailable" }, 503);
}

let candidates = (dueRows ?? []) as DueRow[];
if (candidates.length === 0) return json({ claimed: 0, published: 0, failed: 0, skipped: 0, deferred: 0 });

- // Scheduled execution has no user session/owner confirmation to resolve private
- // media. Defer before claim, metering, job creation, or any provider work.

* // Private video is resolved by the owner-scoped v76 materializer after claim.
* // Protected legacy images and mixed/multi-video shapes still defer before claim.
  const requestOrigin = new URL(req.url).origin;
  const safeCandidates = candidates.filter(row => {
* const mediaRows = payloadMedia(row.payload);
* if (mediaRows.some(item => item.kind === "video")) return isSingleVideoPayload(row.payload);
  const media = publishMediaUrls(row.payload);
  return !media.some(url => requiresPublishAsset(url, requestOrigin));
  });
  const deferredMedia = candidates.length - safeCandidates.length;
  candidates = safeCandidates;
  if (candidates.length === 0) return json({ claimed: 0, published: 0, failed: 0, skipped: 0, deferred: deferredMedia });

// ── 2+3) CLAIM then PUBLISH, one row at a time ───────────────────────────────
//
// CLAIM is a single atomic conditional UPDATE … RETURNING: the lock is set only when
@@ -282,21 +299,21 @@ export async function GET(req: Request): Promise<Response> {
// Stamped NOW, not at the top of the run: with claiming interleaved, a row can be
// claimed minutes in, and a start-of-run stamp would shorten its 10-minute lock by
// exactly that much — another worker could steal a row still being published.
const claimIso = new Date().toISOString();
const { data: won, error: claimError } = await db
.from(TABLE)
.update({ publish_claimed_at: claimIso })
.eq("vibepin_user_id", candidate.vibepin_user_id)
.eq("draft_id", candidate.draft_id)
.or(`publish_claimed_at.is.null,publish_claimed_at.lt.${pgQuote(staleCutoff)}`)

-      .select("vibepin_user_id, draft_id, payload, scheduled_at");

*      .select("vibepin_user_id, draft_id, payload, scheduled_at, updated_at");

  if (claimError) {
  // A schema hiccup mid-run: treat as un-claimable, don't crash the batch.
  console.error("[cron/publish-due] claim error:", claimError.message);
  skipped++;
  continue;
  }
  if (!won || won.length === 0) {
  skipped++; // lost the race to another worker / already-claimed
  continue;
  @@ -407,20 +424,28 @@ export async function GET(req: Request): Promise<Response> {
  // NO metering here — the contract charges only actions that really attempt
  // delivery, and this row never reaches Pinterest.
  await persistFailure(io, row, { message: "Missing image or board — cannot publish", code: "bad_request" });
  void recordFailedPublishEvent(db, eventBase, Date.now() - rowStartedMs, {
  code: "bad_request",
  message: "Missing image or board — cannot publish",
  });
  failed++;
  continue;
  }

*      const videoReceipt = isSingleVideoPayload(row.payload) && row.scheduled_at
*        ? buildDueVideoReceipt({
*          draftId: row.draft_id,
*          updatedAt: row.updated_at,
*          scheduledAt: row.scheduled_at,
*          payload: row.payload,
*        })
*        : null;

       // ── Phase 5B: meter the scheduled post ────────────────────────────────────
       // Keyed on (draft_id, scheduled_at), NOT on claim time and NOT on the success
       // event. This route is at-least-once by construction (see the header): a death
       // between the Pinterest create and persistSuccess leaves a stale claim that is
       // re-claimed and re-published. Because scheduled_at is only cleared by
       // persistSuccess, a re-claim of that same row derives the IDENTICAL key, and
       // usage_consume_scheduled_post collapses the replay to one charge. Metering
       // before the provider call also means a crash mid-publish still recorded the
       // attempt the user really made. Fail-open in shadow: consumeScheduledPost never

@@ -503,21 +528,21 @@ export async function GET(req: Request): Promise<Response> { * Between a provider's acknowledgement and the final persist sat every remaining * destination — minutes, in which a process kill lost the record of a post that * really exists and the next run sent it again. Written immediately, that run * reads a `published` row and owes nothing for it. * * Best-effort by design: a failed bookkeeping write is logged and the publish * continues. The final persist (which retries) is still the authoritative record.
*/
const persistOne = async (outcome: DestinationOutcome): Promise<void> => {
// `pending`/`skipped` describe nothing that happened — see outcomeRows.

-        if (outcome.status !== "published" && outcome.status !== "failed") return;

*        if (outcome.status !== "published" && outcome.status !== "failed" && outcome.status !== "delivery_unknown") return;
         const { error: incErr } = await mergeOutcomesIntoRow(io, row, [outcome]);
         if (incErr) console.error("[cron/publish-due] incremental persist:", incErr);
       };
       /** Collect an outcome AND store it. */
       const record = async (outcome: DestinationOutcome): Promise<void> => {
         outcomes.push(outcome);
         await persistOne(outcome);
       };
       let adoptedConnectionId: string | null = null;
       let firstFailure: { code?: string; message: string } | null = null;

@@ -541,20 +566,71 @@ export async function GET(req: Request): Promise<Response> {
deliveries.push(classifyDelivery({ preNetwork: true }));
await record({
provider: "pinterest", status: "failed",
socialConnectionId: destination.socialConnectionId ?? null,
error: "Choose a Pinterest board before publishing.",
});
if (!firstFailure) firstFailure = { code: "bad_request", message: "Choose a Pinterest board before publishing." };
continue;
}
try {

-          if (videoReceipt) {
-            const frozenDestination = videoReceipt.destinations.find(item =>
-              item.provider === destination.provider
-              && item.socialConnectionId === (destination.socialConnectionId ?? null));
-            if (!frozenDestination) {
-              deliveries.push(classifyDelivery({ preNetwork: true }));
-              await record({
-                provider: "pinterest", status: "failed",
-                socialConnectionId: destination.socialConnectionId ?? null,
-                error: "The scheduled Pinterest destination no longer matches the frozen intent.",
-                preNetwork: true,
-              });
-              if (!firstFailure) firstFailure = { code: "invalid_confirmation", message: "The scheduled Pinterest destination no longer matches the frozen intent." };
-              continue;
-            }
-            const durable = await dispatchSupabaseV76PinterestVideo(db, {
-              uid: row.vibepin_user_id,
-              receipt: videoReceipt,
-              destination: frozenDestination,
-              scheduleAt: row.scheduled_at ?? undefined,
-              latestStartMs: deadlineMs,
-            });
-            if (durable.outcome === "published") {
-              deliveries.push(classifyDelivery({ ok: true }));
-              await record({
-                provider: "pinterest", status: "published",
-                socialConnectionId: destination.socialConnectionId ?? null,
-                externalPostId: durable.remoteId ?? null,
-                externalPostUrl: durable.remoteUrl ?? null,
-              });
-            } else if (durable.outcome === "delivery_unknown") {
-              deliveries.push(classifyDelivery({}));
-              await record({
-                provider: "pinterest", status: "delivery_unknown",
-                socialConnectionId: destination.socialConnectionId ?? null,
-                error: "Delivery is unknown. Reconcile the original intent before retrying.",
-              });
-              if (!firstFailure) firstFailure = { code: "delivery_unknown", message: "Delivery is unknown. Reconcile the original intent before retrying." };
-            } else if (durable.outcome === "in_progress" || durable.outcome === "not_due") {
-              await record(deferredOutcome(destination));
-            } else {
-              deliveries.push(classifyDelivery({ providerStatus: 400 }));
-              await record({
-                provider: "pinterest", status: "failed",
-                socialConnectionId: destination.socialConnectionId ?? null,
-                error: "Pinterest rejected the video publish.",
-              });
-              if (!firstFailure) firstFailure = { code: "pinterest_video_publish_failed", message: "Pinterest rejected the video publish." };
-            }
-            continue;
-          }
           const result = await publishPinForUser(perDestination);
           // A typed failure is decided before (or instead of) a create; a success is
           // a real Pin id. Either way this destination's state is known here.
           deliveries.push(classifyDelivery(result.ok ? { ok: true } : { preNetwork: true }));
           if (result.ok) {
             // Adopt-once (PRD §14) applies only to a Content that named no account.
             if (!destination.socialConnectionId && result.connectionId) adoptedConnectionId = result.connectionId;
             await record(pinterestOutcomeRow(destination, {
               ok: true, connectionId: result.connectionId,
               pinId: result.pin.id, pinUrl: result.pin.url,

diff --git a/web/src/app/api/pinterest/pins/route.ts b/web/src/app/api/pinterest/pins/route.ts
index f71ca6ab..3df8b507 100644
--- a/web/src/app/api/pinterest/pins/route.ts
+++ b/web/src/app/api/pinterest/pins/route.ts
@@ -59,20 +59,22 @@ import {
} from "@/lib/server/publish/confirmationReceipt";
import {
PublishIntentLedgerError,
claimPublishIntentDestination,
claimPublishRetryDestinations,
settlePublishIntentDestination,
} from "@/lib/server/publish/publishIntentLedger";
import { findConnection } from "@/lib/social/server/socialConnectionStore";
import { resolveDestinationCapability } from "@/lib/social/destinationCapability";
import { requiresPublishAsset } from "@/lib/server/publishMedia";
+import { confirmedMediaKind } from "@/lib/server/publish/v76PinterestVideoBindings";
+import { publishImmediateV76PinterestVideo } from "@/lib/server/publish/v76PinterestVideoImmediate";

export const dynamic = "force-dynamic";

// Best-effort duplicate-publish guard, keyed by `${userId}:${sourcePinId}`.
// Per-process, in-memory only — NOT durable idempotency: it does not survive
// server restarts and does not coordinate across multiple instances. It only
// catches an accidental duplicate request racing in on the SAME process (e.g. a
// double-click that slipped past the client-side guards). sourcePinId is optional;
// requests that omit it are never locked (unchanged behavior).
const _inFlightPublishes = new Set<string>();
@@ -114,21 +116,28 @@ export async function POST(req: Request) {
}, destinationId ? [destinationId] : []);
if (!confirmation.ok) {
return Response.json({ error: confirmation.error, code: confirmation.code }, { status: confirmation.code === "confirmation_required" ? 400 : 409 });
}
const confirmedDestination = confirmation.destinations.find(destination => destination.id === destinationId);
if (!confirmedDestination || confirmedDestination.provider !== "pinterest"
|| confirmedDestination.boardId !== boardId
|| confirmedDestination.socialConnectionId !== (typeof body.connectionId === "string" ? body.connectionId.trim() : "")) {
return Response.json({ error: "The Pinterest account or Board no longer matches the confirmation.", code: "invalid_confirmation" }, { status: 409 });
}

- if (imageUrls.some(url => requiresPublishAsset(url, new URL(req.url).origin))) {

* const confirmedKind = confirmedMediaKind(confirmation.receipt);
* if (confirmedKind === "unsupported") {
* return Response.json({
*      error: "Video publishing requires exactly one frozen video asset.",
*      code: "materialization_required",
* }, { status: 409 });
* }
* if (confirmedKind === "image" && imageUrls.some(url => requiresPublishAsset(url, new URL(req.url).origin))) {
  return Response.json({
  error: "Publish media asset is not materialized for provider delivery.",
  code: "publish_asset_required",
  }, { status: 409 });
  }

  let durableDb: ReturnType<typeof createServerClient>;
  try {
  durableDb = createServerClient();
  const stored = await validateStoredImmediatePublishReceipt(durableDb, uid, confirmation.receipt);
  @@ -151,20 +160,33 @@ export async function POST(req: Request) {
  error: "This Pinterest destination is no longer available.",
  code: "destination_validation_failed",
  reasonCode: capability.unavailableReason,
  }, { status: 422 });
  }
  } catch (error) {
  console.error("[publish] durable preflight unavailable:", (error as Error)?.message ?? String(error));
  return Response.json({ error: "Could not verify the publishing destination.", code: "publish_intent_unavailable" }, { status: 503 });
  }

* // Video has one production path: v76 prepare/materialize/claim/attempt/settle.
* // The legacy image claim below must never see video bytes or a private locator.
* if (confirmedKind === "video") {
* return publishImmediateV76PinterestVideo({
*      db: durableDb,
*      uid,
*      receipt: confirmation.receipt,
*      destination: confirmedDestination,
*      draftId,
*      sourcePinId,
* });
* }
* let durableClaim: Awaited<ReturnType<typeof claimPublishIntentDestination>>;
  try {
  if (confirmation.receipt.priorIntentId) {
  const retryClaims = await claimPublishRetryDestinations(
  durableDb,
  uid,
  confirmation.receipt,
  [confirmedDestination],
  );
  const retryClaim = retryClaims[0];
  diff --git a/web/src/lib/server/pinterest/service.ts b/web/src/lib/server/pinterest/service.ts
  index 9a7a1fe7..1b395028 100644
  --- a/web/src/lib/server/pinterest/service.ts
  +++ b/web/src/lib/server/pinterest/service.ts
  @@ -17,20 +17,26 @@ import {
  PINTEREST_TOKEN_URL,
  basicAuthHeader,
  getPinterestApiBase,
  getPinterestEnv,
  getPinterestSandboxAccessToken,
  canAttemptSandboxPublish,
  missingPinterestScopes,
  type PinterestEnv,
  } from "./config";
  import { buildPinMediaSource } from "./pinMediaSource";
  +import {
* publishPinterestVideo,
* type PinterestVideoAdapterDependencies,
* type PinterestVideoPublishInput,
* type PinterestVideoPublishResult,
  +} from "./videoPinAdapter";
  import {
  getActiveConnection,
  getConnectionById,
  reloadConnectionRow,
  decryptTokens,
  updateTokens,
  markNeedsReconnect,
  type PinterestConnectionRow,
  } from "./connectionStore";

@@ -759,20 +765,43 @@ export class PinterestClient {
// Prefer Pinterest's own canonical URL when the response includes one. NOT
// `data.link` — that's the Pin's destination link (where the Pin points to),
// not the Pin's own Pinterest URL. Fall back to the constructed URL otherwise.
const canonicalUrl = typeof data.url === "string" && data.url ? data.url : undefined;
return {
id,
boardId: typeof data.board_id === "string" ? data.board_id : input.boardId,
url: canonicalUrl ?? `https://www.pinterest.com/pin/${id}/`,
};
} +

- /**
- - Publish one video through the verified register/upload/poll/create adapter.
- - The same refreshed account token is frozen for every stage of this attempt.
- */
- async createVideoPin(
- input: Omit<PinterestVideoPublishInput, "accessToken" | "accountId">,
- dependencies: Partial<PinterestVideoAdapterDependencies> = {},
- ): Promise<PinterestVideoPublishResult> {
- if (this.isExpiringSoon()) await this.doRefresh();
- return publishPinterestVideo({
-      ...input,
-      accessToken: this.accessToken,
-      accountId: this.connectionId,
- }, {
-      fetch: dependencies.fetch ?? this.hooks.fetchImpl,
-      sleep: dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))),
-      now: dependencies.now ?? (() => Date.now()),
-      apiBase: dependencies.apiBase ?? getPinterestApiBase(),
-      ...(dependencies.pollIntervalMs !== undefined ? { pollIntervalMs: dependencies.pollIntervalMs } : {}),
-      ...(dependencies.pollDeadlineMs !== undefined ? { pollDeadlineMs: dependencies.pollDeadlineMs } : {}),
- });
- }
  }

function safeJsonParse(text: string): unknown {
try {
return JSON.parse(text);
} catch {
return {};
}
}

diff --git a/web/src/lib/server/publish/confirmationReceipt.ts b/web/src/lib/server/publish/confirmationReceipt.ts
index aaeb84d0..9488cd0e 100644
--- a/web/src/lib/server/publish/confirmationReceipt.ts
+++ b/web/src/lib/server/publish/confirmationReceipt.ts
@@ -54,20 +54,38 @@ export function isConfirmedSocialDestinationSelection(
function object(value: unknown): Record<string, unknown> | null {
return value && typeof value === "object" && !Array.isArray(value)
? value as Record<string, unknown>
: null;
}

function text(value: unknown): string {
return typeof value === "string" ? value : "";
}

+function confirmedMediaUrl(value: unknown, kind: "image" | "video"): string | null {

- const url = text(value).trim();
- if (/^https?:\/\//i.test(url)) return url;
- if (kind !== "video") return null;
- try {
- const parsed = new URL(url, "https://vibepin.invalid");
- if (parsed.origin !== "https://vibepin.invalid"
-        || parsed.pathname !== "/api/storage-media"
-        || parsed.hash
-        || parsed.searchParams.getAll("path").length !== 1
-        || [...parsed.searchParams.keys()].some(key => key !== "path")
-        || !parsed.searchParams.get("path")) return null;
- return `${parsed.pathname}?path=${encodeURIComponent(parsed.searchParams.get("path") as string)}`;
- } catch {
- return null;
- }
  +}
-

function destination(value: unknown): PublishDestination | null {
const row = object(value);
if (!row) return null;
const provider = text(row.provider).trim().toLowerCase();
const connectionId = text(row.socialConnectionId).trim();
if (provider !== "pinterest" && provider !== "instagram" && provider !== "facebook") return null;
if (!connectionId) return null;
const expectedId = `${provider}:${connectionId}`;
if (text(row.id).trim() !== expectedId) return null;
const boardId = text(row.boardId).trim();
@@ -155,33 +173,44 @@ export function validateImmediatePublishReceipt(
if ((!onlyPending || priorIntentId === null)
&& stablePublishString([...dispatchDestinationIds].sort()) !== stablePublishString([...publishableIds].sort())) {
return invalid("The confirmation does not authorize the complete destination set.");
}
const requested = [...requestedDestinationIds];
if (!requested.length || new Set(requested).size !== requested.length) return invalid("Select at least one exact destination.");
if (requested.some(id => !dispatchDestinationIds.includes(id))) return invalid("The request includes a destination this confirmation did not authorize.");

const normalizedMedia: ConfirmedPublishReceipt["media"] = media.flatMap(item => {
const row = object(item);

- if (!row || !text(row.id) || !/^https?:\/\//i.test(text(row.url))) return [];

* if (!row || !text(row.id)) return [];
* const kind = row.kind === "video" ? "video" : row.kind === "image" ? "image" : null;
* if (!kind) return [];
* const url = confirmedMediaUrl(row.url, kind);
* if (!url) return [];
  const rawSource = text(row.source);
  const source = rawSource === "upload" || rawSource === "ai" || rawSource === "product" || rawSource === "legacy"
  ? rawSource
  : "legacy";
* if (kind === "video" && source !== "upload") return [];
* const durationMs = typeof row.durationMs === "number" && Number.isFinite(row.durationMs) && row.durationMs > 0
*      ? row.durationMs
*      : undefined;
* const posterUrl = text(row.posterUrl).trim();
  return [{
  id: text(row.id),

-      kind: "image" as const,
-      url: text(row.url),

*      kind,
*      url,
       ...(typeof row.width === "number" ? { width: row.width } : {}),
       ...(typeof row.height === "number" ? { height: row.height } : {}),
       ...(text(row.altText) ? { altText: text(row.altText) } : {}),
       source,
*      ...(kind === "video" && durationMs ? { durationMs } : {}),
*      ...(kind === "video" && posterUrl ? { posterUrl } : {}),

  }];
  });
  if (!normalizedMedia.length || normalizedMedia.length !== media.length) return invalid("The confirmed media is invalid.");

  const normalized = {
  ...receipt,
  intentId,
  priorIntentId,
  draftId: text(value.draftId).trim(),
  contentId: text(value.contentId).trim(),
  diff --git a/web/src/lib/server/publish/v76PinterestVideoBindings.ts b/web/src/lib/server/publish/v76PinterestVideoBindings.ts
  new file mode 100644
  index 00000000..cddaee76
  --- /dev/null
  +++ b/web/src/lib/server/publish/v76PinterestVideoBindings.ts
  @@ -0,0 +1,113 @@
  +import type { PinDraft } from "@/lib/pinDraftStore";
  +import {

* buildPublishConfirmation,
* confirmPublishSnapshot,
* sha256Hex,
* stablePublishString,
* type ConfirmedPublishReceipt,
  +} from "@/lib/studio/publishConfirmation";
  +import type { DurableVideoPublishResult } from "./v76PinterestVideoPublish";
*

+export type DueVideoReceiptInput = {

- draftId: string;
- updatedAt: string;
- scheduledAt: string;
- payload: Record<string, unknown>;
  +};
-

+/**

- - Rebuild the confirmed snapshot a scheduled row authorized. The action id is a
- - stable identity for this exact schedule; a stale-claim replay therefore reaches
- - the same v76 intent instead of minting a second provider attempt.
- */
  +export function buildDueVideoReceipt(input: DueVideoReceiptInput): ConfirmedPublishReceipt {
- const revisionMs = Date.parse(input.updatedAt);
- if (!Number.isFinite(revisionMs)) throw new Error("publish_source_revision_invalid");
- const actionId = sha256Hex(stablePublishString({
- draftId: input.draftId,
- scheduledAt: input.scheduledAt,
- })).slice(0, 32);
- const draft = {
- ...input.payload,
- id: input.draftId,
- // v76 stores canonical UTC milliseconds. PostgREST may return six fractional
- // digits; normalize without changing the represented database instant.
- updatedAt: new Date(revisionMs).toISOString(),
- } as PinDraft;
- return confirmPublishSnapshot(buildPublishConfirmation(draft, {
- mode: { kind: "now" },
- onlyPending: false,
- actionId,
- }), input.scheduledAt);
  +}
-

+export function confirmedMediaKind(

- receipt: Pick<ConfirmedPublishReceipt, "media">,
  +): "image" | "video" | "unsupported" {
- if (receipt.media.length === 1 && receipt.media[0]?.kind === "video") return "video";
- if (receipt.media.length > 0 && receipt.media.every(item => item.kind === "image")) return "image";
- return "unsupported";
  +}
-

+export function videoPublishHttpResult(result: DurableVideoPublishResult): {

- status: number;
- body: Record<string, unknown>;
  +} {
- if (result.outcome === "published") {
- return {
-      status: result.replayed ? 200 : 201,
-      body: {
-        ok: true,
-        replayed: result.replayed === true,
-        pin: { id: result.remoteId, url: result.remoteUrl },
-        retryAllowed: false,
-        remoteEvidence: result.evidence ?? {},
-      },
- };
- }
- if (result.outcome === "delivery_unknown") {
- return {
-      status: 409,
-      body: {
-        ok: false,
-        error: "Delivery status is unknown. Reconcile the original intent before retrying.",
-        code: "delivery_unknown",
-        retryAllowed: false,
-        reconcileRequired: result.reconcileRequired === true,
-        remoteEvidence: result.evidence ?? {},
-      },
- };
- }
- if (result.outcome === "in_progress") {
- return {
-      status: 409,
-      body: {
-        ok: false,
-        error: "This publish intent is already in progress.",
-        code: "publish_in_progress",
-        retryAllowed: false,
-      },
- };
- }
- if (result.outcome === "not_due") {
- return {
-      status: 409,
-      body: {
-        ok: false,
-        error: "This scheduled publish is not due.",
-        code: "publish_not_due",
-        retryAllowed: false,
-      },
- };
- }
- return {
- status: 422,
- body: {
-      ok: false,
-      error: "Pinterest rejected the video publish.",
-      code: "pinterest_video_publish_failed",
-      retryAllowed: result.retryAllowed,
-      remoteEvidence: result.evidence ?? {},
- },
- };
  +}
  diff --git a/web/src/lib/server/publish/v76PinterestVideoImmediate.ts b/web/src/lib/server/publish/v76PinterestVideoImmediate.ts
  new file mode 100644
  index 00000000..166432b2
  --- /dev/null
  +++ b/web/src/lib/server/publish/v76PinterestVideoImmediate.ts
  @@ -0,0 +1,122 @@
  +import type { SupabaseClient } from "@supabase/supabase-js";
  +import type { PublishDestination } from "@/lib/contentDraftModel";
  +import type { ConfirmedPublishReceipt } from "@/lib/studio/publishConfirmation";
  +import {
- consumeScheduledPost,
- deriveScheduledPostKey,
- immediateBucketForNow,
- releaseScheduledPost,
- scheduledPostLimitResponseBody,
- signImmediateBucket,
- usageEnforceFor,
  +} from "@/lib/server/usage/meterScheduledPost";
  +import {
- newPublishAttemptId,
- PUBLISH_EVENT_ATTEMPTED,
- PUBLISH_EVENT_SUCCEEDED,
- recordFailedPublishEvent,
- recordPublishEvent,
- type PublishEventBase,
  +} from "@/lib/server/publishEvents";
  +import { videoPublishHttpResult } from "./v76PinterestVideoBindings";
  +import { dispatchSupabaseV76PinterestVideo } from "./v76PinterestVideoServer";
-

+export async function publishImmediateV76PinterestVideo(input: {

- db: SupabaseClient;
- uid: string;
- receipt: ConfirmedPublishReceipt;
- destination: PublishDestination;
- draftId: string | null;
- sourcePinId: string;
  +}): Promise<Response> {
- const boardId = input.destination.boardId?.trim() ?? "";
- const startedAt = Date.now();
- const eventBase: PublishEventBase = {
- publishAttemptId: newPublishAttemptId(),
- userId: input.uid,
- draftId: input.draftId,
- boardId,
- source: "immediate",
- };
- void recordPublishEvent(input.db, PUBLISH_EVENT_ATTEMPTED, eventBase);
- const mintedAt = Date.now();
- const meteringBucket = immediateBucketForNow(mintedAt);
- const meteringBucketSig = input.draftId
- ? signImmediateBucket(input.uid, input.draftId, meteringBucket, mintedAt)
- : undefined;
- const meterIdentity = input.draftId ?? (input.sourcePinId || null);
- let meterKey: string | null = null;
- let meterFresh = false;
- if (meterIdentity) {
- meterKey = deriveScheduledPostKey(input.uid, meterIdentity, undefined, meteringBucket);
- const consumed = await consumeScheduledPost({
-      userId: input.uid,
-      key: meterKey,
-      referenceId: meterIdentity,
-      metadata: { source: "immediate" },
- });
- meterFresh = consumed.kind === "consumed" && consumed.fresh === true;
- if (consumed.kind === "insufficient" && usageEnforceFor("scheduled_post")) {
-      void recordFailedPublishEvent(input.db, eventBase, Date.now() - startedAt, {
-        code: "scheduled_post_limit_reached", message: "Scheduled post limit reached",
-      });
-      return Response.json(scheduledPostLimitResponseBody(), { status: 402 });
- }
- }
- const refundNotSent = async () => {
- if (!meterFresh || !meterKey || !meterIdentity) return;
- await releaseScheduledPost({
-      userId: input.uid,
-      key: meterKey,
-      reason: "not_sent",
-      referenceId: meterIdentity,
-      metadata: { source: "immediate", route: "pinterest_pins_video" },
- });
- };
-
- try {
- const result = await dispatchSupabaseV76PinterestVideo(input.db, {
-      uid: input.uid,
-      receipt: input.receipt,
-      destination: input.destination,
- });
- if (result.outcome === "failed") await refundNotSent();
- if (result.outcome === "published") {
-      void recordPublishEvent(input.db, PUBLISH_EVENT_SUCCEEDED, {
-        ...eventBase,
-        durationMs: Date.now() - startedAt,
-        remotePinId: result.remoteId,
-        remotePinUrl: result.remoteUrl,
-      });
- } else if (result.outcome !== "in_progress") {
-      void recordFailedPublishEvent(input.db, eventBase, Date.now() - startedAt, {
-        code: result.outcome,
-        message: result.outcome === "delivery_unknown"
-          ? "Video delivery is unknown and requires reconciliation."
-          : "Video publish failed.",
-      });
- }
- const mapped = videoPublishHttpResult(result);
- return Response.json({
-      ...mapped.body,
-      board: { id: boardId, name: input.destination.boardName ?? "" },
-      connectionId: input.destination.socialConnectionId,
-      intentId: input.receipt.intentId,
-      meteringBucket,
-      ...(meteringBucketSig ? { meteringBucketSig, meteringBucketMintedAt: mintedAt } : {}),
- }, { status: mapped.status });
- } catch (error) {
- // Post-attempt ambiguity is converted inside the v76 orchestrator. An escaping
- // exception happened before provider dispatch and is safe to classify not-sent.
- await refundNotSent();
- void recordFailedPublishEvent(input.db, eventBase, Date.now() - startedAt, error);
- const message = error instanceof Error ? error.message : "materialization_required";
- const materialization = /source|media|materializ|owner|provenance|destination/.test(message);
- return Response.json({
-      error: materialization
-        ? "The frozen private video could not be materialized for this owner and revision."
-        : "Could not establish durable video publishing.",
-      code: materialization ? "materialization_required" : "publish_intent_unavailable",
- }, { status: materialization ? 409 : 503 });
- }
  +}
  diff --git a/web/src/lib/server/publish/v76PinterestVideoPublish.ts b/web/src/lib/server/publish/v76PinterestVideoPublish.ts
  new file mode 100644
  index 00000000..39a25fc1
  --- /dev/null
  +++ b/web/src/lib/server/publish/v76PinterestVideoPublish.ts
  @@ -0,0 +1,359 @@
  +import type { PublishDestination } from "@/lib/contentDraftModel";
  +import type { ConfirmedPublishReceipt } from "@/lib/studio/publishConfirmation";
  +import type {
- PinterestVideoPublishResult,
  +} from "@/lib/server/pinterest/videoPinAdapter";
-

+export type DurableVideoPublishState =

- | { kind: "missing" }
- | { kind: "prepared" }
- | { kind: "attempt_started"; attemptId: string; claimToken: string }
- | { kind: "published"; remoteId: string; remoteUrl?: string; evidence: Record<string, unknown> }
- | { kind: "failed"; evidence: Record<string, unknown> }
- | { kind: "delivery_unknown"; evidence: Record<string, unknown> };
-

+export type MaterializedVideoSource = {

- mediaId: string;
- ordinal: number;
- bucketId: "generated-private";
- objectPath: string;
- contentType: "video/mp4" | "video/x-m4v" | "video/quicktime";
- byteSize: number;
- checksumSha256: string;
- fileName: string;
- file: Blob;
  +};
-

+export type DurableVideoPublishInput = {

- uid: string;
- receipt: ConfirmedPublishReceipt;
- destination: PublishDestination;
- /** Present for due execution. A future value is rejected before any durable write. */
- scheduleAt?: string;
- /** Cron deadline: no destination starts after this instant. */
- latestStartMs?: number;
- nowMs?: number;
  +};
-

+export type DurableVideoPublishResult = {

- outcome: "published" | "failed" | "delivery_unknown" | "in_progress" | "not_due";
- replayed?: boolean;
- retryAllowed: boolean;
- reconcileRequired?: boolean;
- remoteId?: string;
- remoteUrl?: string;
- evidence?: Record<string, unknown>;
  +};
-

+export type DurableAttemptSettlement = "succeeded" | "failed" | "unknown"; +
+export type DurableVideoPublishDependencies = {

- inspect(input: DurableVideoPublishInput): Promise<DurableVideoPublishState>;
- confirmPrepare(input: DurableVideoPublishInput): Promise<void>;
- leaseMaterialization(input: DurableVideoPublishInput): Promise<{ leaseToken: string; deliveryId: string }>;
- materializeSources(
- input: DurableVideoPublishInput,
- lease: { leaseToken: string; deliveryId: string },
- ): Promise<MaterializedVideoSource[]>;
- settleItem(
- input: DurableVideoPublishInput,
- lease: { leaseToken: string; deliveryId: string },
- source: MaterializedVideoSource,
- ): Promise<{ deliveryReady: boolean }>;
- claimReady(
- input: DurableVideoPublishInput,
- lease: { leaseToken: string; deliveryId: string },
- ): Promise<{ claimToken: string }>;
- startAttempt(
- input: DurableVideoPublishInput,
- claim: { claimToken: string },
- ): Promise<{ attemptId: string; status: DurableAttemptSettlement | "started"; replayed: boolean }>;
- publishVideo(
- input: DurableVideoPublishInput,
- source: MaterializedVideoSource,
- ): Promise<PinterestVideoPublishResult>;
- settleAttempt(
- input: DurableVideoPublishInput,
- status: DurableAttemptSettlement,
- attempt: { attemptId: string; claimToken: string },
- provider?: PinterestVideoPublishResult,
- ): Promise<void>;
  +};
-

+type V76Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>; +
+export type V76RpcVideoPublishBoundary = {

- rpc: V76Rpc;
- inspect: DurableVideoPublishDependencies["inspect"];
- materializeSources: DurableVideoPublishDependencies["materializeSources"];
- publishVideo: DurableVideoPublishDependencies["publishVideo"];
  +};
-

+function record(value: unknown): Record<string, unknown> {

- if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("v76_rpc_invalid_result");
- return value as Record<string, unknown>;
  +}
-

+function requiredText(value: unknown, code: string): string {

- const text = typeof value === "string" ? value.trim() : "";
- if (!text) throw new Error(code);
- return text;
  +}
-

+function canonicalPinterestUrl(pinId: string | undefined, pinUrl?: string): string | undefined {

- if (pinUrl) return pinUrl;
- return pinId && /^[0-9]+$/.test(pinId)
- ? `https://www.pinterest.com/pin/${pinId}/`
- : undefined;
  +}
-

+/** Bind the orchestrator to the existing v76 service-role RPC surface. */
+export function createV76RpcVideoPublishDependencies(

- boundary: V76RpcVideoPublishBoundary,
  +): DurableVideoPublishDependencies {
- return {
- inspect: boundary.inspect,
- async confirmPrepare(input) {
-      await boundary.rpc("publish_intent_confirm_prepare", {
-        p_user_id: input.uid,
-        p_receipt: input.receipt,
-      });
- },
- async leaseMaterialization(input) {
-      const value = record(await boundary.rpc("publish_asset_lease_materialization", {
-        p_user_id: input.uid,
-        p_intent_id: input.receipt.intentId,
-        p_destination_id: input.destination.id,
-        p_lease_token: globalThis.crypto.randomUUID(),
-        p_lease_seconds: 300,
-      }));
-      return {
-        leaseToken: requiredText(value.leaseToken, "materialization_lease_missing"),
-        deliveryId: requiredText(value.deliveryId, "materialization_delivery_missing"),
-      };
- },
- materializeSources: boundary.materializeSources,
- async settleItem(input, lease, source) {
-      const value = record(await boundary.rpc("publish_asset_settle_item", {
-        p_user_id: input.uid,
-        p_intent_id: input.receipt.intentId,
-        p_destination_id: input.destination.id,
-        p_lease_token: lease.leaseToken,
-        p_source_media_key: source.mediaId,
-        p_media_ordinal: source.ordinal,
-        p_bucket_id: source.bucketId,
-        p_object_path: source.objectPath,
-        p_content_type: source.contentType,
-        p_byte_size: source.byteSize,
-        p_checksum_sha256: source.checksumSha256,
-      }));
-      return { deliveryReady: value.deliveryReady === true };
- },
- async claimReady(input) {
-      const claimToken = globalThis.crypto.randomUUID();
-      const value = record(await boundary.rpc("publish_asset_claim_ready", {
-        p_user_id: input.uid,
-        p_intent_id: input.receipt.intentId,
-        p_destination_id: input.destination.id,
-        p_claim_token: claimToken,
-      }));
-      return { claimToken: requiredText(value.claimToken, "publish_claim_missing") };
- },
- async startAttempt(input, claim) {
-      const value = record(await boundary.rpc("publish_provider_attempt_start", {
-        p_user_id: input.uid,
-        p_intent_id: input.receipt.intentId,
-        p_destination_id: input.destination.id,
-        p_claim_token: claim.claimToken,
-        p_attempt: 1,
-      }));
-      const status = requiredText(value.status, "provider_attempt_status_missing");
-      if (status !== "started" && status !== "succeeded" && status !== "failed" && status !== "unknown") {
-        throw new Error("provider_attempt_status_invalid");
-      }
-      return {
-        attemptId: requiredText(value.attemptId, "provider_attempt_id_missing"),
-        status,
-        replayed: value.replayed === true,
-      };
- },
- publishVideo: boundary.publishVideo,
- async settleAttempt(input, status, attempt, provider) {
-      const succeeded = status === "succeeded" ? provider?.evidence : undefined;
-      const remoteUrl = canonicalPinterestUrl(succeeded?.pinId, succeeded?.pinUrl);
-      await boundary.rpc("publish_provider_attempt_settle", {
-        p_user_id: input.uid,
-        p_attempt_id: attempt.attemptId,
-        p_claim_token: attempt.claimToken,
-        p_status: status,
-        p_provider_status: status === "succeeded" ? 201 : null,
-        p_remote_id: succeeded?.pinId ?? null,
-        p_remote_url: remoteUrl ?? null,
-        p_evidence: {
-          provider: "pinterest",
-          reason: status === "succeeded"
-            ? "non_retryable"
-            : status === "failed"
-              ? "provider_rejected"
-              : "unknown_outcome",
-        },
-      });
- },
- };
  +}
-

+function unknownResult(

- evidence: Record<string, unknown> = {},
- reconcileRequired = false,
  +): DurableVideoPublishResult {
- return {
- outcome: "delivery_unknown",
- retryAllowed: false,
- reconcileRequired,
- evidence,
- };
  +}
-

+function isLeaseCompetition(error: unknown): boolean {

- const message = error instanceof Error ? error.message : String(error);
- return message.includes("already_leased")
- || message.includes("already_claimed")
- || message.includes("not_ready_or_already_claimed")
- || message.includes("claim_lost");
  +}
-

+/**

- - The single ordering boundary for immediate and due Pinterest video delivery.
- - Provider dispatch is reachable only after a ready claim and a durable attempt.
- */
  +export async function dispatchV76PinterestVideo(
- input: DurableVideoPublishInput,
- deps: DurableVideoPublishDependencies,
  +): Promise<DurableVideoPublishResult> {
- const nowMs = input.nowMs ?? Date.now();
- const scheduleMs = input.scheduleAt ? Date.parse(input.scheduleAt) : Number.NaN;
- if ((Number.isFinite(scheduleMs) && scheduleMs > nowMs)
-      || (typeof input.latestStartMs === "number" && nowMs > input.latestStartMs)) {
- return { outcome: "not_due", retryAllowed: false };
- }
-
- const prior = await deps.inspect(input);
- if (prior.kind === "published") {
- return {
-      outcome: "published",
-      replayed: true,
-      retryAllowed: false,
-      remoteId: prior.remoteId,
-      remoteUrl: prior.remoteUrl,
-      evidence: prior.evidence,
- };
- }
- if (prior.kind === "delivery_unknown") return unknownResult(prior.evidence);
- if (prior.kind === "failed") {
- return {
-      outcome: "failed",
-      replayed: true,
-      retryAllowed: true,
-      evidence: prior.evidence,
- };
- }
- if (prior.kind === "attempt_started") {
- try {
-      await deps.settleAttempt(
-        input,
-        "unknown",
-        { attemptId: prior.attemptId, claimToken: prior.claimToken },
-      );
- } catch {
-      // The durable row is still started. Either state forbids another dispatch.
- }
- return unknownResult({ reason: "process_loss_after_provider_attempt" }, true);
- }
-
- await deps.confirmPrepare(input);
-
- let lease: Awaited<ReturnType<DurableVideoPublishDependencies["leaseMaterialization"]>>;
- try {
- lease = await deps.leaseMaterialization(input);
- } catch (error) {
- if (isLeaseCompetition(error)) return { outcome: "in_progress", retryAllowed: false };
- throw error;
- }
-
- const sources = await deps.materializeSources(input, lease);
- if (!sources.length || sources.length !== input.receipt.media.length) {
- return { outcome: "failed", retryAllowed: true, evidence: { reason: "materialization_incomplete" } };
- }
- let deliveryReady = false;
- for (const source of [...sources].sort((left, right) => left.ordinal - right.ordinal)) {
- const settled = await deps.settleItem(input, lease, source);
- deliveryReady = settled.deliveryReady;
- }
- if (!deliveryReady) return { outcome: "in_progress", retryAllowed: false };
-
- let claim: { claimToken: string };
- try {
- claim = await deps.claimReady(input, lease);
- } catch (error) {
- if (isLeaseCompetition(error)) return { outcome: "in_progress", retryAllowed: false };
- throw error;
- }
- const started = await deps.startAttempt(input, claim);
- if (started.status !== "started") {
- return started.status === "succeeded"
-      ? { outcome: "published", replayed: true, retryAllowed: false }
-      : started.status === "failed"
-        ? { outcome: "failed", replayed: true, retryAllowed: true }
-        : unknownResult({ reason: "provider_attempt_replayed_unknown" });
- }
-
- let provider: PinterestVideoPublishResult;
- try {
- provider = await deps.publishVideo(input, sources[0]);
- } catch {
- // The durable attempt is already started. Even a local exception at the provider
- // boundary is indistinguishable from a request that left the process before its
- // response was observed, so it is never allowed to escape into a retryable path.
- try {
-      await deps.settleAttempt(
-        input,
-        "unknown",
-        { attemptId: started.attemptId, claimToken: claim.claimToken },
-      );
- } catch {
-      // A still-started attempt is equally non-retryable and is reconciled on replay.
- }
- return unknownResult({ reason: "provider_boundary_exception" }, true);
- }
- const settlement: DurableAttemptSettlement = provider.outcome === "succeeded"
- ? "succeeded"
- : provider.outcome === "failed"
-      ? "failed"
-      : "unknown";
- try {
- await deps.settleAttempt(
-      input,
-      settlement,
-      { attemptId: started.attemptId, claimToken: claim.claimToken },
-      provider,
- );
- } catch {
- // Once the adapter could have created a Pin, a persistence outage is ambiguous.
- // Never turn it into an ordinary retryable failure.
- return unknownResult({ ...provider.evidence, reason: "provider_settlement_unavailable" }, true);
- }
-
- if (provider.outcome === "succeeded") {
- return {
-      outcome: "published",
-      retryAllowed: false,
-      remoteId: provider.evidence.pinId,
-      remoteUrl: canonicalPinterestUrl(provider.evidence.pinId, provider.evidence.pinUrl),
-      evidence: provider.evidence,
- };
- }
- if (provider.outcome === "failed") {
- return { outcome: "failed", retryAllowed: true, evidence: provider.evidence };
- }
- return unknownResult(provider.evidence);
  +}
  diff --git a/web/src/lib/server/publish/v76PinterestVideoRuntime.ts b/web/src/lib/server/publish/v76PinterestVideoRuntime.ts
  new file mode 100644
  index 00000000..66e51e38
  --- /dev/null
  +++ b/web/src/lib/server/publish/v76PinterestVideoRuntime.ts
  @@ -0,0 +1,363 @@
  +import { stablePublishString } from "@/lib/studio/publishConfirmation";
  +import type {
- DurableVideoPublishDependencies,
- DurableVideoPublishInput,
- DurableVideoPublishState,
- MaterializedVideoSource,
  +} from "./v76PinterestVideoPublish";
  +import { createV76RpcVideoPublishDependencies } from "./v76PinterestVideoPublish";
  +import type { SupabaseClient } from "@supabase/supabase-js";
  +import type { PinterestVideoPublishResult } from "@/lib/server/pinterest/videoPinAdapter";
-

+const PRIVATE_BUCKET = "generated-private" as const;
+const VIDEO_TYPES = new Set(["video/mp4", "video/x-m4v", "video/quicktime"]); +
+export type PrivateVideoProvenance = {

- ownerUserId: string;
- bucketId: string;
- objectPath: string;
- mediaKind: string;
- contentType: string;
- byteSize: number;
- checksumSha256: string;
- width: number | null;
- height: number | null;
- durationMs: number | null;
- lifecycleState: string;
  +};
-

+export type PrivateVideoMaterializationBoundary = {

- loadDraft(uid: string, draftId: string): Promise<{
- updatedAt: string;
- payload: Record<string, unknown>;
- } | null>;
- findProvenance(uid: string, bucket: string, objectPath: string): Promise<PrivateVideoProvenance | null>;
- download(bucket: string, objectPath: string): Promise<Blob>;
- storePublishCopy(input: {
- uid: string;
- intentId: string;
- sourcePath: string;
- targetPath: string;
- contentType: MaterializedVideoSource["contentType"];
- byteSize: number;
- checksumSha256: string;
- width: number | null;
- height: number | null;
- durationMs: number | null;
- file: Blob;
- }): Promise<void>;
  +};
-

+function videoPath(value: string): string | null {

- try {
- const parsed = new URL(value, "https://vibepin.invalid");
- if (parsed.origin !== "https://vibepin.invalid"
-        || parsed.pathname !== "/api/storage-media"
-        || parsed.hash
-        || parsed.searchParams.getAll("path").length !== 1
-        || [...parsed.searchParams.keys()].some(key => key !== "path")) return null;
- const path = parsed.searchParams.get("path")?.trim() ?? "";
- if (!path || path.startsWith("/") || path.includes("..") || path.includes("//") || path.includes("\\")) return null;
- return path;
- } catch {
- return null;
- }
  +}
-

+async function sha256(value: ArrayBuffer | string): Promise<string> {

- const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
- const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
- return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  +}
-

+function exactMediaIdentity(media: unknown): string {

- if (!Array.isArray(media)) return "[]";
- return stablePublishString(media.map(value => {
- const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
- return {
-      id: typeof row.id === "string" ? row.id : "",
-      kind: row.kind === "video" ? "video" : row.kind === "image" ? "image" : "",
-      url: typeof row.url === "string" ? row.url : "",
-      durationMs: typeof row.durationMs === "number" ? row.durationMs : null,
-      width: typeof row.width === "number" ? row.width : null,
-      height: typeof row.height === "number" ? row.height : null,
-      source: typeof row.source === "string" ? row.source : null,
-      posterUrl: typeof row.posterUrl === "string" ? row.posterUrl : null,
-      altText: typeof row.altText === "string" ? row.altText : null,
- };
- }));
  +}
-

+function extension(contentType: string): string {

- return contentType === "video/quicktime" ? "mov" : contentType === "video/x-m4v" ? "m4v" : "mp4";
  +}
-

+/**

- - Resolve owner-authorized source bytes and create one intent-scoped private copy.
- - No signed URL or public locator is produced or stored.
- */
  +export async function materializePrivateVideoSources(
- input: DurableVideoPublishInput,
- _lease: { leaseToken: string; deliveryId: string },
- boundary: PrivateVideoMaterializationBoundary,
  +): Promise<MaterializedVideoSource[]> {
- const draft = await boundary.loadDraft(input.uid, input.receipt.draftId);
- if (!draft) throw new Error("video_source_not_found");
- if (Date.parse(draft.updatedAt) !== Date.parse(input.receipt.sourceUpdatedAt)) {
- throw new Error("publish_source_revision_conflict");
- }
- if (exactMediaIdentity(draft.payload.media) !== exactMediaIdentity(input.receipt.media)) {
- throw new Error("publish_source_media_conflict");
- }
-
- const output: MaterializedVideoSource[] = [];
- for (const [ordinal, media] of input.receipt.media.entries()) {
- if (media.kind !== "video") throw new Error("materialization_required");
- const sourcePath = videoPath(media.url);
- if (!sourcePath) throw new Error("video_source_locator_invalid");
- if (sourcePath.split("/", 1)[0] !== input.uid) throw new Error("video_source_owner_mismatch");
-
- const provenance = await boundary.findProvenance(input.uid, PRIVATE_BUCKET, sourcePath);
- if (!provenance
-        || provenance.ownerUserId !== input.uid
-        || provenance.bucketId !== PRIVATE_BUCKET
-        || provenance.objectPath !== sourcePath
-        || provenance.mediaKind !== "video"
-        || !VIDEO_TYPES.has(provenance.contentType)
-        || !Number.isSafeInteger(provenance.byteSize)
-        || provenance.byteSize <= 0
-        || !/^[0-9a-f]{64}$/.test(provenance.checksumSha256)
-        || (media.width !== undefined && provenance.width !== media.width)
-        || (media.height !== undefined && provenance.height !== media.height)
-        || (media.durationMs !== undefined && provenance.durationMs !== media.durationMs)
-        || !["draft", "publish_pending", "published", "retained"].includes(provenance.lifecycleState)) {
-      throw new Error("video_source_provenance_invalid");
- }
-
- const file = await boundary.download(PRIVATE_BUCKET, sourcePath);
- if (file.size !== provenance.byteSize
-        || (file.type && file.type !== provenance.contentType)
-        || await sha256(await file.arrayBuffer()) !== provenance.checksumSha256) {
-      throw new Error("video_source_bytes_conflict");
- }
- const key = (await sha256(`${input.receipt.intentId}:${media.id}:${ordinal}`)).slice(0, 32);
- const targetPath = `${input.uid}/publish/${input.receipt.fingerprint}/${ordinal}-${key}.${extension(provenance.contentType)}`;
- await boundary.storePublishCopy({
-      uid: input.uid,
-      intentId: input.receipt.intentId,
-      sourcePath,
-      targetPath,
-      contentType: provenance.contentType as MaterializedVideoSource["contentType"],
-      byteSize: provenance.byteSize,
-      checksumSha256: provenance.checksumSha256,
-      width: provenance.width,
-      height: provenance.height,
-      durationMs: provenance.durationMs,
-      file,
- });
- output.push({
-      mediaId: media.id,
-      ordinal,
-      bucketId: PRIVATE_BUCKET,
-      objectPath: targetPath,
-      contentType: provenance.contentType as MaterializedVideoSource["contentType"],
-      byteSize: provenance.byteSize,
-      checksumSha256: provenance.checksumSha256,
-      fileName: targetPath.slice(targetPath.lastIndexOf("/") + 1),
-      file,
- });
- }
- return output;
  +}
-

+function dbError(error: { code?: string; message?: string } | null, fallback: string): Error {

- return new Error(error?.message || error?.code || fallback);
  +}
-

+export async function inspectV76VideoPublishState(

- db: SupabaseClient,
- input: DurableVideoPublishInput,
  +): Promise<DurableVideoPublishState> {
- const intentResult = await db
- .from("publish_intents")
- .select("id,source_revision")
- .eq("user_id", input.uid)
- .eq("intent_id", input.receipt.intentId)
- .maybeSingle();
- if (intentResult.error) throw dbError(intentResult.error, "publish_intent_inspection_failed");
- if (!intentResult.data) return { kind: "missing" };
- const storedRevision = (intentResult.data as { source_revision?: string | null }).source_revision ?? "";
- if (!Number.isFinite(Date.parse(storedRevision))
-      || Date.parse(storedRevision) !== Date.parse(input.receipt.sourceUpdatedAt)) {
- throw new Error("publish_source_revision_conflict");
- }
- const intentDbId = String((intentResult.data as { id: unknown }).id);
- const destinationResult = await db
- .from("publish_intent_destinations")
- .select("status,remote_id,remote_url,evidence")
- .eq("publish_intent_id", intentDbId)
- .eq("destination_id", input.destination.id)
- .maybeSingle();
- if (destinationResult.error) throw dbError(destinationResult.error, "publish_destination_inspection_failed");
- const destination = destinationResult.data as Record<string, unknown> | null;
- if (destination?.status === "published") {
- const remoteId = typeof destination.remote_id === "string" ? destination.remote_id : "";
- const storedUrl = typeof destination.remote_url === "string" ? destination.remote_url : "";
- const remoteUrl = storedUrl || (/^[0-9]+$/.test(remoteId) ? `https://www.pinterest.com/pin/${remoteId}/` : "");
- if (!remoteId) throw new Error("provider_success_evidence_missing");
- return {
-      kind: "published",
-      remoteId,
-      ...(remoteUrl ? { remoteUrl } : {}),
-      evidence: destination.evidence && typeof destination.evidence === "object"
-        ? destination.evidence as Record<string, unknown>
-        : {},
- };
- }
- if (destination?.status === "delivery_unknown") {
- return {
-      kind: "delivery_unknown",
-      evidence: destination.evidence && typeof destination.evidence === "object"
-        ? destination.evidence as Record<string, unknown>
-        : {},
- };
- }
- const attemptResult = await db
- .from("provider_publish_attempts")
- .select("id,status,claim_token_identity,evidence")
- .eq("publish_intent_id", intentDbId)
- .eq("destination_id", input.destination.id)
- .order("attempt", { ascending: false })
- .limit(1)
- .maybeSingle();
- if (attemptResult.error) throw dbError(attemptResult.error, "provider_attempt_inspection_failed");
- const attempt = attemptResult.data as Record<string, unknown> | null;
- if (attempt?.status === "started") {
- return {
-      kind: "attempt_started",
-      attemptId: String(attempt.id),
-      claimToken: String(attempt.claim_token_identity),
- };
- }
- if (attempt?.status === "unknown") {
- return {
-      kind: "delivery_unknown",
-      evidence: attempt.evidence && typeof attempt.evidence === "object"
-        ? attempt.evidence as Record<string, unknown>
-        : {},
- };
- }
- return destination?.status === "failed"
- ? {
-      kind: "failed",
-      evidence: destination.evidence && typeof destination.evidence === "object"
-        ? destination.evidence as Record<string, unknown>
-        : {},
- }
- : { kind: "prepared" };
  +}
-

+export function createSupabasePrivateVideoMaterializationBoundary(

- db: SupabaseClient,
  +): PrivateVideoMaterializationBoundary {
- return {
- async loadDraft(uid, draftId) {
-      const { data, error } = await db
-        .from("pin_drafts")
-        .select("updated_at,payload,deleted_at")
-        .eq("vibepin_user_id", uid)
-        .eq("draft_id", draftId)
-        .maybeSingle();
-      if (error) throw dbError(error, "video_source_draft_unavailable");
-      if (!data || (data as { deleted_at?: unknown }).deleted_at) return null;
-      const row = data as { updated_at: string; payload: Record<string, unknown> };
-      return { updatedAt: row.updated_at, payload: row.payload };
- },
- async findProvenance(uid, bucket, objectPath) {
-      const { data, error } = await db
-        .from("media_asset_provenance")
-        .select("owner_user_id,bucket_id,object_path,media_kind,content_type,byte_size,checksum_sha256,width,height,duration_ms,lifecycle_state")
-        .eq("owner_user_id", uid)
-        .eq("bucket_id", bucket)
-        .eq("object_path", objectPath)
-        .maybeSingle();
-      if (error) throw dbError(error, "video_source_provenance_unavailable");
-      if (!data) return null;
-      const row = data as Record<string, unknown>;
-      return {
-        ownerUserId: String(row.owner_user_id),
-        bucketId: String(row.bucket_id),
-        objectPath: String(row.object_path),
-        mediaKind: String(row.media_kind),
-        contentType: String(row.content_type),
-        byteSize: Number(row.byte_size),
-        checksumSha256: String(row.checksum_sha256),
-        width: typeof row.width === "number" ? row.width : null,
-        height: typeof row.height === "number" ? row.height : null,
-        durationMs: typeof row.duration_ms === "number" ? row.duration_ms : null,
-        lifecycleState: String(row.lifecycle_state),
-      };
- },
- async download(bucket, objectPath) {
-      const { data, error } = await db.storage.from(bucket).download(objectPath);
-      if (error || !data) throw dbError(error, "video_source_download_failed");
-      return data;
- },
- async storePublishCopy(copy) {
-      const bucket = db.storage.from(PRIVATE_BUCKET);
-      const uploaded = await bucket.upload(copy.targetPath, copy.file, {
-        contentType: copy.contentType,
-        upsert: false,
-      });
-      if (uploaded.error) {
-        // A lost upload response or replay may find the deterministic private copy
-        // already present. Accept it only when the exact bytes match.
-        const existing = await bucket.download(copy.targetPath);
-        if (existing.error || !existing.data
-            || existing.data.size !== copy.byteSize
-            || await sha256(await existing.data.arrayBuffer()) !== copy.checksumSha256) {
-          throw dbError(uploaded.error, "video_publish_copy_failed");
-        }
-      }
-      const { error } = await db.from("media_asset_provenance").upsert({
-        owner_user_id: copy.uid,
-        bucket_id: PRIVATE_BUCKET,
-        object_path: copy.targetPath,
-        source_type: "publish_copy",
-        intent_id: copy.intentId,
-        lifecycle_state: "publish_pending",
-        media_kind: "video",
-        content_type: copy.contentType,
-        byte_size: copy.byteSize,
-        checksum_sha256: copy.checksumSha256,
-        width: copy.width,
-        height: copy.height,
-        duration_ms: copy.durationMs,
-        updated_at: new Date().toISOString(),
-      }, { onConflict: "bucket_id,object_path" });
-      if (error) throw dbError(error, "video_publish_copy_provenance_failed");
- },
- };
  +}
-

+export function createSupabaseV76VideoPublishDependencies(input: {

- db: SupabaseClient;
- publishVideo: DurableVideoPublishDependencies["publishVideo"];
  +}): DurableVideoPublishDependencies {
- const materialization = createSupabasePrivateVideoMaterializationBoundary(input.db);
- return createV76RpcVideoPublishDependencies({
- inspect: current => inspectV76VideoPublishState(input.db, current),
- materializeSources: (current, lease) => materializePrivateVideoSources(current, lease, materialization),
- publishVideo: input.publishVideo,
- async rpc(name, args) {
-      const { data, error } = await input.db.rpc(name, args);
-      if (error) throw dbError(error, `${name}_failed`);
-      return data;
- },
- });
  +}
-

+export type PinterestVideoPublisher = (

- input: DurableVideoPublishInput,
- source: MaterializedVideoSource,
  +) => Promise<PinterestVideoPublishResult>;
  diff --git a/web/src/lib/server/publish/v76PinterestVideoServer.ts b/web/src/lib/server/publish/v76PinterestVideoServer.ts
  new file mode 100644
  index 00000000..1d9b3276
  --- /dev/null
  +++ b/web/src/lib/server/publish/v76PinterestVideoServer.ts
  @@ -0,0 +1,35 @@
  +import type { SupabaseClient } from "@supabase/supabase-js";
  +import { PinterestClient } from "@/lib/server/pinterest/service";
  +import {
- dispatchV76PinterestVideo,
- type DurableVideoPublishInput,
- type DurableVideoPublishResult,
  +} from "./v76PinterestVideoPublish";
  +import { createSupabaseV76VideoPublishDependencies } from "./v76PinterestVideoRuntime";
-

+/** Production binding shared by the immediate route and the due worker. */
+export async function dispatchSupabaseV76PinterestVideo(

- db: SupabaseClient,
- input: DurableVideoPublishInput,
  +): Promise<DurableVideoPublishResult> {
- const connectionId = input.destination.socialConnectionId?.trim() ?? "";
- const boardId = input.destination.boardId?.trim() ?? "";
- if (!connectionId || !boardId) throw new Error("video_destination_invalid");
- return dispatchV76PinterestVideo(input, createSupabaseV76VideoPublishDependencies({
- db,
- publishVideo: async (current, source) => {
-      // Provider client construction/refresh is inside this callback, hence
-      // unreachable until v76 grants a ready claim and starts a durable attempt.
-      const client = await PinterestClient.forConnection(current.uid, connectionId);
-      return client.createVideoPin({
-        boardId,
-        title: current.receipt.title,
-        description: current.receipt.description,
-        link: current.receipt.destinationUrl,
-        altText: current.receipt.altText,
-        file: source.file,
-        fileName: source.fileName,
-      });
- },
- }));
  +}
  diff --git a/web/src/lib/studio/publishConfirmation.ts b/web/src/lib/studio/publishConfirmation.ts
  index bdb9a57f..29d54411 100644
  --- a/web/src/lib/studio/publishConfirmation.ts
  +++ b/web/src/lib/studio/publishConfirmation.ts
  @@ -142,21 +142,29 @@ export function sha256Hex(value: string): string {

export type PublishConfirmationFingerprintInput = {
priorIntentId: string | null;
draftId: string;
contentId: string;
sourceUpdatedAt: string;
title: string;
description: string;
altText: string;
destinationUrl: string;

- media: Array<{ id: string; url: string; width?: number | null; height?: number | null }>;

* media: Array<{
* id: string;
* url: string;
* kind?: "image" | "video";
* width?: number | null;
* height?: number | null;
* durationMs?: number | null;
* posterUrl?: string | null;
* }>;
  mode: PublishConfirmationMode;
  destinations: Array<{
  id: string;
  provider: PublishProvider;
  socialConnectionId?: string | null;
  accountLabel?: string | null;
  boardId?: string | null;
  boardName?: string | null;
  }>;
  dispatchDestinationIds: string[];
  @@ -176,22 +184,27 @@ export function publishConfirmationFingerprint(input: PublishConfirmationFingerp
  priorIntentId: input.priorIntentId,
  sourceUpdatedAt: input.sourceUpdatedAt,
  mode: input.mode,
  title: input.title,
  description: input.description,
  altText: input.altText,
  destinationUrl: input.destinationUrl,
  media: input.media.map(item => ({
  id: item.id,
  url: item.url,
*      // `null` preserves every pre-video image fingerprint while making a video
*      // impossible to relabel as an image without invalidating confirmation.
*      kind: item.kind === "video" ? "video" : null,
       width: item.width ?? null,
       height: item.height ?? null,
*      durationMs: item.kind === "video" ? item.durationMs ?? null : null,
*      posterUrl: item.kind === "video" ? item.posterUrl ?? null : null,
  })),
  destinations: input.destinations.map(item => ({
  id: item.id,
  provider: item.provider,
  socialConnectionId: item.socialConnectionId,
  accountLabel: item.accountLabel ?? null,
  boardId: item.boardId ?? null,
  boardName: item.boardName ?? null,
  })),
  dispatchDestinationIds: [...input.dispatchDestinationIds].sort(),
  @@ -269,21 +282,31 @@ export function buildPublishConfirmation(
  const identity = {
  priorIntentId,
  contentId: draft.contentId?.trim() || draft.id,
  draftId: draft.id,
  sourceUpdatedAt: draft.updatedAt,
  mode,
  title: draft.title?.trim() || "Untitled content",
  description: draft.description ?? "",
  altText: draft.altText ?? "",
  destinationUrl: draft.destinationUrl ?? "",

- media: media.map(item => ({ id: item.id, url: item.url, width: item.width ?? null, height: item.height ?? null })),

* media: media.map(item => ({
*      id: item.id,
*      url: item.url,
*      kind: item.kind,
*      width: item.width ?? null,
*      height: item.height ?? null,
*      ...(item.kind === "video" ? {
*        durationMs: item.durationMs ?? null,
*        posterUrl: item.posterUrl ?? null,
*      } : {}),
* })),
  destinations: destinations.map(item => ({
  id: item.id,
  provider: item.provider,
  socialConnectionId: item.socialConnectionId,
  accountLabel: item.accountLabel ?? null,
  boardId: item.boardId ?? null,
  boardName: item.boardName ?? null,
  })),
  dispatchDestinationIds,
  blockers: blockers.map(item => ({ code: item.code, destinationId: item.destinationId ?? null })),
