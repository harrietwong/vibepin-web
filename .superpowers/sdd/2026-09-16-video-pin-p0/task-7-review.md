# Task 7 Independent Review

Verdict: **CHANGES REQUIRED — NOT APPROVED**

- Base: `d7635c02b2bb010380c39d5c7777fbdadbcab8da`
- Reviewed HEAD: `c449e73210872eb09362662b6c9b664c199aa66b`
- Critical: 0. Important: 8. Minor: 0.
- Review date: 2026-09-16.
- Product code, HEAD, index, branches and external systems were not changed. Only this review and two local review-probe artifacts were added. No real database, Storage, Pinterest, token refresh, deploy, push or merge was used.

## Strengths

Immediate and due routes really do call the same production server wrapper. That wrapper constructs the Pinterest client inside the post-attempt callback, so registration is behind ready claim and durable attempt creation. Private materialization checks owner, exact protected locator, provenance, byte size, content type and checksum; it never creates a public URL or signed download URL. The approved Task 6 adapter is called directly. A normal SQL-backed publish/replay and a 201 followed by settlement loss both obey no-duplicate dispatch in the independent probes.

The implementation is therefore more than a test-only path, but its lifecycle/recovery assumptions do not match the existing database and draft writers.

## Important Findings

### I1 — P1: Video retry bypasses durable parent lineage, allowing unknown delivery to be resent

Location: [video early return](D:/vp-tmp/wt-video-pin-p0-task7/web/src/app/api/pinterest/pins/route.ts:173), [v76 prepare binding](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/v76PinterestVideoPublish.ts:116).

The video branch returns before the existing `claimPublishRetryDestinations` call at line 186. The replacement inspects only the new receipt's `intentId`, then calls v76 confirm/prepare. That RPC neither checks nor persists `priorIntentId`; its canonical receipt at SQL line 891 drops it. Consequently a fresh child receipt with `onlyPending:true` and `priorIntentId` pointing to a durable `delivery_unknown` parent gets a fresh ready claim and provider attempt. The stored draft/fingerprint validator is not a durable retry-entitlement check and cannot substitute for this.

Independent probe R6 used real v76/v77 SQL: parent settled `unknown`; child named that parent; child outcome was `published`; provider call count increased by one, without reconciliation. The same bypass also loses the one-child-per-parent-destination retry entitlement. Additionally, the existing v76 receipt RPC demands equal `publishableDestinations`/`dispatchDestinationIds` sets, so legitimate narrowed partial retries are not integrated with its contract either.

Required correction: provide an atomic v76-compatible retry-lineage authorization before creating or claiming the child, preserving rejection for parent started/published/unknown and one-time entitlement for eligible failed destinations. Test a stale/client-edited draft against the actual route and durable parent ledger, plus legitimate narrowed retries. Do not route video through the old image claim as a workaround.

### I2 — P1: Draft operational timestamps invalidate frozen source identity and break siblings/recovery

Location: [source revision comparison](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/v76PinterestVideoRuntime.ts:106), [inspection revision comparison](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/v76PinterestVideoRuntime.ts:189), [due receipt construction](D:/vp-tmp/wt-video-pin-p0-task7/web/src/app/api/cron/publish-due/route.ts:434).

The cron route creates one receipt from `row.updated_at`, but `record()` calls `mergeOutcomesIntoRow` after each destination. That existing writer changes both payload.updatedAt and row.updated_at ([writer](D:/vp-tmp/wt-video-pin-p0-task7/web/src/app/api/cron/publish-due/persistRow.ts:163)). The second destination then reloads the same draft and throws `publish_source_revision_conflict` even when source bytes/media/content never changed. Probe R1 reproduces first sibling published, second sibling rejected with no provider call, using the production materializer and actual v76/v77 SQL.

On the next due run, `buildDueVideoReceipt` keeps the same action id for draft+schedule but uses the new operational updated_at. `inspectV76VideoPublishState` throws on the revision before reading durable success/unknown. Probe R5 reproduces this against an unknown ledger. The due catch at line 669 turns the exception into an ordinary failed outcome, preventing truthful durable recovery. The immediate path has the related sync race: its existing stored-receipt validator explicitly accepts the exact persisted publishing snapshot with a newer updated_at, but the new materializer rejects it unconditionally.

Required correction: distinguish frozen source/content identity from operational publishing updates. Reuse owner-bound frozen assets for subsequent destinations/recovery, and validate substantive media/content changes independently. Add shared-draft tests with real incremental writes, lifecycle-sync-before-request, and replay after partial-result persistence. Do not weaken owner or genuine source-change rejection.

### I3 — P1: A concurrent replay poisons an active provider attempt as unknown

Location: [started-attempt handling](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/v76PinterestVideoPublish.ts:260), [inspection mapping](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/v76PinterestVideoRuntime.ts:235).

Every observed `started` attempt is treated as process loss immediately, with no lease/staleness/liveness condition. A second HTTP request arriving while the first request is uploading or polling settles the live attempt `unknown`, clears its claim and closes its parent. When the first request then receives a valid 201, SQL rejects its success settlement as `provider_settlement_conflict`. Both callers report unknown and the database lacks the valid success evidence.

Probe R2 paused the first production-wrapper call inside the provider boundary, replayed the same input against the same SQL database, then resumed the first with a 201. The replay marked unknown and the original result became `provider_settlement_unavailable` despite the successful create.

Required correction: return in-progress for a still-live attempt; permit process-loss reconciliation only after an authoritative expiry/recovery claim. Test simultaneous callers as well as genuinely stale attempts and a valid 201 arriving during recovery.

### I4 — P1: Crash after item readiness but before durable attempt permanently wedges the intent

Location: [unconditional re-prepare/re-lease](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/v76PinterestVideoPublish.ts:273), [inspection fallback](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/v76PinterestVideoRuntime.ts:250).

Inspection collapses already-materialized/ready and claimed-without-attempt states to `prepared`. All such replays then try to lease materialization again. v76 permits materialization lease only for prepared/failed/materializing deliveries, not an already-ready delivery ([SQL](D:/vp-tmp/wt-video-pin-p0-task7/backend/db/migrate_v76_publish_asset_materializer.sql:1176)). A crash or dropped claim response after `settleItem` therefore leads to permanent `materialization_not_available`; it cannot resume even though provider work never began. A crash after ready claim but before attempt start has the same missing recovery state.

Probe R3 injected process loss at claimReady after real SQL item settlement, then retried normally: retry threw `materialization_not_available` and made zero provider calls.

Required correction: inspect the durable delivery/claim state and resume from the correct stage, retaining/recovering the authoritative claim token safely. Ready assets must be loaded from their frozen owner-bound graph rather than re-leased. Test process loss at each transition and lost RPC responses before provider dispatch.

### I5 — P1: One unknown destination blocks untouched sibling destinations

Location: [per-destination prepare](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/v76PinterestVideoPublish.ts:273), [due per-destination dispatch](D:/vp-tmp/wt-video-pin-p0-task7/web/src/app/api/cron/publish-due/route.ts:591).

The shared orchestrator starts each sibling with the same parent intent. Existing v76 settlement sets the parent `lifecycle_status='delivery_unknown'` for any one unknown destination ([SQL](D:/vp-tmp/wt-video-pin-p0-task7/backend/db/migrate_v76_publish_asset_materializer.sql:1832)). The next untouched sibling's confirm/prepare rejects that lifecycle (`publish_intent_conflict`); claimReady/attempt-start also reject it. This is separate from timestamp drift and occurs even with an unchanged draft.

Probe R7 used a receipt with two connected Pinterest destinations against one SQL database. The first returned unknown; the second threw `publish_intent_conflict` before its provider call. The due catch records that never-attempted sibling as failed. Existing success rows are not overwritten, but the promised independent fan-out is still not delivered.

Required correction: reconcile the Task 7 design with v76's parent-wide terminal policy and provide a safe destination-scoped continuation mechanism. This may require an explicitly reviewed v76 contract change; simply skipping prepare or bypassing SQL checks is unsafe. Test unknown-first, failed-first and success-first orderings in the same durable intent.

### I6 — P2: Scan-to-claim reschedule race still claims and meters future video jobs

Location: [cron claim update](D:/vp-tmp/wt-video-pin-p0-task7/web/src/app/api/cron/publish-due/route.ts:305).

The candidate scan checks schedule and liveness, but the claim UPDATE checks only owner/draft and stale lock. A user moving the candidate to a future schedule between scan and claim still gets a claim and a metering attempt. The wrapper eventually returns not_due, but that is after these writes. The claim also does not bind the scanned schedule/revision or repeat deleted/archived conditions. This claim shape predates Task 7, but Task 7 newly admits private video candidates into it, so the new video contract inherits a real violation rather than a proven zero-claim guarantee.

The independent route probe invokes the actual `GET` export with local module/DB boundaries. Its DB returns a due candidate, then changes the stored row to one hour in the future before UPDATE. Observed result: `claimed:1`, `deferred:1`, `meters:1`, `provider:0`, `durableReads:0`. The existing future-input unit test still passes because it starts after the row-claim layer.

Required correction: make the claim conditional on still-due schedule, live row, and the appropriate scanned revision/schedule identity; recheck the claimed payload's admissibility. Add full-route reschedule/cancel/delete/media-change races and assert zero claim/meter/provider when the row no longer qualifies.

### I7 — P2: Legacy image confirmation fingerprints are changed despite claimed compatibility

Location: [fingerprint media serialization](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/studio/publishConfirmation.ts:193).

The new serializer always adds `kind:null`, `durationMs:null`, and `posterUrl:null` for images. The old serializer omitted those keys. Stable JSON plus SHA-256 distinguishes omitted keys from explicit null, so the comment that null preserves every pre-video image fingerprint is false. Previously issued/stored image receipts fail the new immediate validation and stored snapshot recomputation after rollout.

Probe R4 computes the exact base algorithm and HEAD algorithm for one identical image receipt. Base: `ffc2819b87d6225015c56d27af70f4b8c2883cf8c10f9fdd5757efee6da7e54d`; HEAD: `5dbf193746009a1124e1d7f9e9b176ecf286e91438d389a3fbcf1c98144192bd`.

Required correction: append video-only fingerprint fields conditionally, leaving the complete image canonical object byte-compatible, or introduce an explicit validated version/migration path. Add a pinned base-version image receipt/hash fixture; comparing two newly generated receipts cannot test backward compatibility.

### I8 — P2: Valid empty optional video fields become false media conflicts after normalization

Location: [receipt altText normalization](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/confirmationReceipt.ts:203), [exact media identity](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/v76PinterestVideoRuntime.ts:86).

The immediate validator drops an empty media `altText`, whereas the materializer distinguishes `altText:''` in the stored draft from a missing field (`null`) in the normalized receipt. A valid video with empty per-media alt text passes receipt/fingerprint validation and then fails `publish_source_media_conflict` without any actual edit. Empty posterUrl has the same canonicalization disagreement. Due receipt construction does not apply the same immediate normalization, making this an immediate/due behavioral mismatch.

Probe R8 builds a legitimate video receipt with `media[0].altText=''`, successfully validates it, and then runs the actual materializer against the unchanged media: it rejects with `publish_source_media_conflict`.

Required correction: use one canonical optional-field/media identity representation on both sides of confirmation and materialization. Preserve meaningful tamper detection while treating permitted absent/empty equivalents consistently. Cover empty and omitted altText/posterUrl, plus nonempty mutations.

## Verification And Test Quality

Fresh executions at reviewed HEAD:

| Check | Result |
|---|---|
| Task 7 focused suite | 16 passed, 0 failed |
| Due claim suite | 106 passed, 0 failed |
| Confirmation suite | 16 passed, 0 failed |
| Durable intent suite | 23 passed, 0 failed |
| Task 6 video adapter suite | 16 passed, 0 failed |
| Existing v76 PGlite verifier | 280/280, two rounds, exit 0 |
| Existing v77 PGlite verifier | 94 assertions, exit 0 |
| Independent production-wrapper + actual SQL probes | All 12 probes completed; eight labelled reproductions R1–R8 include revision-recovery subcase R5 |
| Actual cron GET mutation probe | Future race reproduced, exit 0 |
| Reviewed commit diff whitespace check | exit 0 |

The original focused test's `rpc` fake returns predefined success objects without validating arguments or executing SQL ([test](D:/vp-tmp/wt-video-pin-p0-task7/web/scripts/test-v76-pinterest-video-publish.ts:250)). Its sibling test creates two isolated harnesses instead of one shared intent/draft ([test](D:/vp-tmp/wt-video-pin-p0-task7/web/scripts/test-v76-pinterest-video-publish.ts:447)). None of the 16 focused cases calls the production Supabase inspection implementation or actual route. The due suite checks some route source text/record counts; that proves branch presence, not the scan/claim/write interactions. The 16/16 figure therefore does not support the report's full route, lineage, sibling or crash-recovery claims. Actual SQL and actual GET probes above expose defects while all claimed focused suites remain green.

Existing v76/v77 schema suites passing is useful regression evidence but is not a Task 7 wrapper integration test. No product implementation was mutated to run probes. A full web test/build/typecheck rerun was not necessary to establish the blocking findings and is not claimed here.

## Remaining Contract Notes

- Owner/path tamper and source-byte checks were inspected and the existing focused tamper tests rerun. These fail before copying/provider dispatch.
- Same-intent published replay and crash-after-create-before-settle anti-retry work against real SQL. This positive result does not cover I1's new-child retry bypass or I3's active-attempt race.
- Schedule-only code was not changed to call the provider; both provider registration and token/client construction remain in the post-attempt callback. Future/expired wrapper inputs do zero durable/provider I/O, but I6 demonstrates the preceding cron claim issue.
- No Python Pinterest creation entry point was located in the inspected backend. The report's further claim that `publishPinForUser` is an explicit guarded video boundary is not substantiated: it still accepts URL-only image input and contains no video/materialization_required guard. Add real legacy-route negative tests; the new 16-case suite contains no such invocation. This is recorded as a verification gap rather than an additional independently proven production bypass.
- Production Task 2 upload/finalize integration remains outside this base and was not simulated as complete.

## Reproduction Artifacts

- [Production wrapper / PGlite probes](D:/vp-tmp/wt-video-pin-p0-task7/.superpowers/sdd/2026-09-16-video-pin-p0/task-7-review-probes.ts)
- [Actual cron GET mutation probe](D:/vp-tmp/wt-video-pin-p0-task7/.superpowers/sdd/2026-09-16-video-pin-p0/task-7-review-route-probe.ts)

Run from the worktree's web directory using the already-installed cached runner (no install/network required):

```powershell
node 'D:\vp-tmp\npm-cache-video-pin-p0\_npx\fd45a72a545557e9\node_modules\tsx\dist\cli.mjs' '../.superpowers/sdd/2026-09-16-video-pin-p0/task-7-review-probes.ts'
node 'D:\vp-tmp\npm-cache-video-pin-p0\_npx\fd45a72a545557e9\node_modules\tsx\dist\cli.mjs' '../.superpowers/sdd/2026-09-16-video-pin-p0/task-7-review-route-probe.ts'
```

The reproduction probes deliberately assert the observed broken outcomes so they exit zero only when those defects are reproduced. They are evidence scripts, not proposed acceptance tests. Convert them into expected-safe-behavior regression tests during repair.

Ready to integrate: **No**. Resolve all Important findings and rerun route + SQL integration evidence before Task 7 can be marked approved.
