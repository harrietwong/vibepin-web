# Task 3 Round 6 Independent Review

**CHANGES REQUIRED — 0 Critical, 2 Important, 0 Minor.**

Reviewed HEAD: `ad5bf1a2105f5d37152c9fa31c155e9f40ece701`. The review covers the fixes in `6d4e8396` and the v80 constraint-manifest changes in `ad5bf1a2`. Only this report and `web/scripts/probe-task3-review-round6.ts` are review changes. No production code, live service, deployment or external API was changed/called by the reviewer.

## Important

### F1 — The v80 manifest still adopts materially different schema contracts

`backend/db/migrate_v80_video_poster_operations.sql:182–189` now rejects the old tautological CHECK, but it checks the UNIQUE only by its name, type and validation flag, not its column set. It does not validate the actual PK/FK definitions or lifecycle default. The CHECK comparison also strips whitespace inside SQL string literals, which changes regex semantics.

New independent real-PGlite mutations all reapply successfully when they should be rejected:

| Injected drift | Observed result |
| --- | --- |
| Same-name `UNIQUE(video_item_id)` instead of `(bucket_id, object_path)` | Accepted; duplicate associations for the same object become possible. |
| `video_item_id` FK references `video_upload_batches(id)` instead of `video_upload_items(id)` | Accepted. |
| Same-name PK changes to `(bucket_id, object_path)` | Accepted; one row per video item is no longer a table invariant. |
| `state` default changes from `associated` to `retained` | Accepted. |
| Filename regex character class changes from `[A-Za-z0-9_.-]` to `[A-Za-z0-9_. -]` | Accepted because global whitespace removal erases the meaningful literal space. |

The UNIQUE case has an operational proof, not only a catalog mismatch. After v80 accepts that drift, the probe uses the production poster-store adapter and real v80 RPCs to associate the same object with two operations: one failed/associated, the other finalized/retained. `canCleanup` returns **true** for that retained object. Output records both actual association states. The whole fixture exists only in an ephemeral local database; ordinary clients are not being claimed to have DDL permission.

Minimum acceptance: implement the complete owned catalog contract using the established v77 approach: exact key columns/targets/actions, column types/nullability/defaults, and exact CHECK definitions without deleting characters inside literals. Do not patch only the newest counterexample. Include expected indexes/policies/ACL handling and function identity/ownership rules as appropriate. Reject drift atomically before it is treated as supported installed state. The new mutation suite must reject every unsafe fixture, then prove that fixture restoration and clean reapply still work.

### F2 — Same-page quota Retry preserves operation identity but still never retries persistence

The missing-attempt problem is fixed. However, the actual board store deliberately retains failed writes in memory. `web/src/lib/pinDraftStore.ts:800–802` returns the existing draft immediately on the same idempotency key without persisting it again. Studio's `createDraft` callback at `web/src/components/studio/StudioBoard.tsx:753` then observes the unchanged `hasPersistFailure()` flag and returns another failed acknowledgement. The video Retry button calls the same path repeatedly without invoking the store's existing persistence-retry mechanism.

The unchanged Round 5 probe now fails with **`draft_persist_failed`**, rather than the previous `video_recovery_persist_failed`. The new root-cause probe uses actual Studio callbacks and the real store: first write fails due to mocked quota; quota is removed; same-page Retry still fails; explicit invocation of the existing `store.retryPersist()` succeeds; the next identical Retry completes. Only **one** video transfer occurred, the draft ID stayed unchanged, and cold reload finds exactly **one durable draft**. Thus the remaining failure is not unavailable storage, missing server identity, or duplicate creation—it is the absent persistence retry at the integration boundary.

Minimum acceptance: when the video workflow is retrying an already-created memory-only draft, actually retry/verify the owner-scoped store write before acknowledging completion. Reuse the existing store contract rather than clearing the error flag or creating another draft. Keep the recovery receipt until durable acknowledgement. Test transient and persistent quota failures, same-page Retry with and without poster, exact draft ID/no reupload, and cold reload. Preserve owner/retain checks around the operation.

## Verified Fixes And Regression Coverage

- Retain failure before finalized receipt creation leaves a durable pending receipt and no draft. Reloading an explicit finalized receipt still does not attach while retain fails.
- Terminal replay awaits old-poster cleanup before clearing identity or preparing fresh bytes. Cleanup failure preserves the old operation and prevents a fresh prepare; success associates a fresh poster and creates exactly one correct draft.
- Same-owner mismatched poster URL/path is now rejected. The real-RPC retain-A/attach-cleanable-B probe is blocked. External video origin and foreign poster owner also remain rejected.
- Mixed-case filenames are protected for raw, uppercase/lowercase percent escapes and mixed escape casing.
- Wrong batch/ordinal retain replay is rejected.
- The previously demonstrated path tautology and independent shadow overload are rejected. Their fixtures are restored between assertions, so one earlier rejection cannot mask another case.
- Column-ACL plus permissive-RLS-policy drift exposes zero authenticated association rows after reapply. One policy remains, but no exposure is asserted for that fixture. Clean service-only RPC/table access and forced RLS checks pass.
- The formal Round 3 safety-script `module` lint violation is fixed.

## Fresh Verification Evidence

All commands below ran locally against the reviewed HEAD, with explicit exit handling for sequential formal tests.

- Unchanged `npx --no-install tsx scripts/probe-task3-review-round4.ts`: **10 passed / 1 failed**. The failure is its obsolete setup assumption that a retain failure leaves `finalized`, rather than the now-safe pending receipt. It is not counted as an implementation defect.
- Unchanged `npx --no-install tsx scripts/probe-task3-review-round5.ts`: **19 passed / 1 failed**. The remaining functional failure is F2.
- New `npx --no-install tsx scripts/probe-task3-review-round6.ts`: **3 passed / 6 failed**, exit 1. Five failures exercise the single incomplete-manifest finding F1; one demonstrates F2 and its real-store cause.
- `test-video-batch-upload.ts`: **16/16**; `test-video-batch-runtime.ts`: **6/6**.
- `test-video-batch-safety.ts`: **18/18**; `test-video-batch-safety-round3.ts`: **7/7**; `test-video-batch-upload-ui.ts`: **4/4**.
- `test-video-upload-private.ts`: **31/31**; `test-media-privacy-architecture.ts`: **16/16**. Its intentional mocked compensation-failure log is expected and involves no external service.
- Backend `verify-v80-video-poster-operations.mjs`: **19 assertions passed**; `verify-v77-video-media.mjs`: **140 assertions, zero failures**.
- `npm run check:test-registry`: **248 tracked / 240 runnable / 8 excluded with explicit reasons**.
- `npm run typecheck`: exit 0.
- Scoped ESLint over all Task 3 production upload/recovery paths plus the five formal batch/safety/runtime/UI scripts: exit 0, no diagnostics.
- `git diff --check 8f778212..ad5bf1a2`: clean. Evidence-only staged diff checked before commit.

Mutation evidence includes the new UNIQUE/FK/PK/default/regex-literal schema mutations, plus reruns of the earlier cleanup-await and SQL terminal-guard mutants. The former expose manifest acceptance gaps; the latter safety assertions still kill their mutants. Every new database fixture is restored explicitly, and the final clean reapply succeeds. No production file is mutated for these probes.

## Handoff

This is close to functional acceptance, but **not APPROVED**: an advertised Retry path still does not recover transient persistence failure, and the migration's claimed exact installed-state contract remains incomplete. These are two existing acceptance areas, not added product scope.

Use one complete catalog manifest rather than continuing case-by-case substring patches. After F1/F2 are fixed, rerun the unchanged Round 5 probe, the new Round 6 probe and the formal gates on a new frozen SHA. The old Round 4 setup assertion can be separately modernized without counting it as a product defect.

No real-browser authenticated E2E, live Storage/preview, build or deployment result is claimed. Browser behavior here is exercised through actual production callbacks with hermetic DOM/transport mocks and the real board store; database behavior uses real SQL in isolated local PGlite. The reviewed HEAD was unchanged throughout the completed probes and formal gates.
