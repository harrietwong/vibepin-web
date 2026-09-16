# Task 3 Round 7 Independent Review

**CHANGES REQUIRED — 0 Critical, 1 Important, 0 Minor.**

Reviewed frozen HEAD: `73d48e2d30dcd7da398930c7a93770a6add55357`. This review adds only this report and `web/scripts/probe-task3-review-round7.ts`. No production edits, deployment, live database/Storage access or external API calls.

## Important: G1 — A missing state default bypasses the migration guard through SQL NULL

The v80 postflight at `backend/db/migrate_v80_video_poster_operations.sql:194` compares a scalar query of the `state` default using `<> '''associated''::text'`. When the default is absent, that query returns no row, so its scalar value is NULL. `NULL <> expected` is NULL, not true; the enclosing `IF` does not reject the schema. `CREATE TABLE IF NOT EXISTS` also does not restore the missing default.

New real-PGlite probe, using the actual v77/v80 SQL and `video_poster_operation_associate` RPC:

1. Apply v77/v80 and prove normal poster association succeeds.
2. `ALTER TABLE ... ALTER COLUMN state DROP DEFAULT`.
3. Reapply v80: it succeeds; the default remains absent.
4. Prepare a new valid owner-bound operation and associate its poster: the real RPC fails with `null value in column "state" ... violates not-null constraint`.
5. Restore the expected default, reapply, and retry the **same** operation: association succeeds.

The probe prints `reapplyRejected=false`, `stateDefault=null`, the NOT NULL failure, and `restoredOperationSucceeds=true`; its safe-rejection assertion exits 1. This is the remaining missing-value branch of the existing F1 default-manifest requirement, not a new product feature. The fault is injected only into isolated PGlite; ordinary application users are not claimed to have DDL access.

Minimum acceptance: compare the scalar value with `IS DISTINCT FROM` or explicitly reject a missing default before comparing it; preserve rejection of the wrong non-null default. Add a separate **DROP DEFAULT** migration mutation, keeping clean apply-twice/rollback/reapply and the five existing catalog mutations green. Verify the expected manifest value cannot become unknown and silently skip the guard.

## All Previous Runtime Findings Verified Fixed

- Round 5 probe: **20/20 passed**, unchanged.
- Round 6 probe: **9/9 passed**, unchanged. All five previously reported catalog mutations now reject; the same-page quota Retry really persists, performs one video transfer, keeps the draft ID, and cold reload sees one durable draft.
- Retain failure and finalized-receipt reload do not attach a poster prematurely. Owner switching during recovery remains blocked.
- Terminal replay cleanup failure preserves old identity and prevents new prepare; success waits for cleanup, uploads/associates a new poster and produces one correct draft.
- Same-owner URL/path mismatch, foreign-owner poster and external video origin are rejected; retain replay binds the exact operation.
- Mixed-case filename raw/encoded references remain protected.
- Mixed upload locking, cancel/reentry, bad-sibling isolation, required frame decode, and private-video lifecycle behavior show no regression in the targeted suites.
- Formal test lint is clean.

## Fresh Commands And Results

- `npx --no-install tsx scripts/probe-task3-review-round4.ts`: **10 passed / 1 obsolete setup failure**. The old assertion requires `finalized` after a retain failure; safe behavior now leaves pending. This is not a product finding.
- `npx --no-install tsx scripts/probe-task3-review-round5.ts`: **20/20**.
- `npx --no-install tsx scripts/probe-task3-review-round6.ts`: **9/9**.
- New `npx --no-install tsx scripts/probe-task3-review-round7.ts`: **exit 1**, G1 reproduced with positive baseline and restored-operation controls.
- `test-video-batch-upload.ts`: **16/16**; `test-video-batch-runtime.ts`: **6/6**.
- `test-video-batch-safety.ts`: **19/19**; `test-video-batch-safety-round3.ts`: **7/7**; `test-video-batch-upload-ui.ts`: **4/4**.
- `test-video-upload-private.ts`: **31/31**; `test-media-privacy-architecture.ts`: **16/16**. The latter's intentional mocked compensation error is expected, not a live call.
- Backend `verify-v80-video-poster-operations.mjs`: **24 assertions passed**, including isolated fixtures for the five earlier catalog mutations.
- Backend `verify-v77-video-media.mjs`: **140 assertions, zero failures**.
- Registry: **248 tracked / 240 runnable / 8 explicitly excluded**.
- `npm run typecheck`: exit 0. Scoped ESLint for all Task 3 production paths plus formal batch/runtime/safety/UI scripts: exit 0, no diagnostics.
- `git diff --check ad5bf1a2..73d48e2d`: clean; staged review evidence is checked before commit.

Existing cleanup-await and SQL terminal-guard mutants are still killed. Schema mutation fixtures are independent/restored, and no source file is patched for mutation testing. A retained permissive RLS policy in the ACL-drift fixture still exposes zero authenticated rows; no separate data-exposure finding is asserted.

## Handoff

Only G1 blocks acceptance of this frozen SHA. Once the NULL-safe manifest fix and its isolated mutation pass, rerun the existing gates on the new commit; do not treat the obsolete Round 4 phase assumption as a runtime regression.

Evidence is from actual production callbacks with hermetic browser/transport mocks, the real board store, and real SQL in local ephemeral PGlite. No authenticated real-browser E2E, preview, live Storage, build or deployment result is claimed.
