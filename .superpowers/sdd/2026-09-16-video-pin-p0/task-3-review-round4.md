# Task 3 Round 4 Independent Review

Verdict: **CHANGES REQUIRED — 0 Critical, 6 Important, 1 Minor**.

Reviewed implementation HEAD: `f2f55963ab11bd1a9e011c0abe0d6e2225672cbb`, relative to Round 3 `0122bc6c0e0199359fe6a035f2d939a65172ff1f`. This review changes only this report and `web/scripts/probe-task3-review-round4.ts`. No production edits, deployment, push, live database/storage mutation, or external model calls.

## Important

### D1 — Finalized recovery bypasses unsuccessful poster retention

`web/src/components/studio/StudioBoard.tsx:729–732` saves a receipt containing `finalized` before awaiting `retainVideoPosterOperation`. Failure leaves that finalized receipt durable. The recovery effect at `:786–809` only runs retain inside `!record.finalized`; a finalized receipt instead proceeds directly to `createBoardDraft`.

Independent production-callback/real-store probe: make retain always fail; initial upload correctly ends failed with zero drafts and one finalized receipt. Invoke recovery. It writes one draft without another retain attempt: `retain calls=1, recovered drafts=1`. A tab closing after the finalized receipt write but before retain acknowledgement has the same state.

Minimum acceptance: preserve operation identity and distinguish media-finalized from poster-retained, or otherwise require idempotent server retain acknowledgement before **every** poster-bearing attachment/recovery path. Retain failures and unknown responses must leave recoverable receipts and no attached draft. Test failure, close/reload, retry, and owner change during retain. Do not simply drop the finalized recovery receipt on failure.

### D2 — Fresh terminal retries reuse the previous operation's poster

`web/src/lib/studio/videoBatchUpload.ts:192–202, 281–305` retains poster information for `finalize_pending`, which is necessary while replay outcome is unknown. However, after replay returns a terminal code and the runner allocates a new batch, the same old `inspection.posterUrl`/`posterPath` survives. `preparePoster` is skipped because `posterUrl` is already present. The new operation has no association for that old path, so `onFinalized` cannot retain it.

Independent integrated evidence uses actual Studio callbacks, actual board store, v77 operation rows, production `createVideoPosterOperationStore`, and real v80 RPCs in isolated PGlite. Old operation is failed and has an associated poster; replay returns `video_upload_not_finalizable`; fresh operation finalizes. Initial result is failed with `v80_poster_operation_not_retainable`. Reload then exercises D1: one draft attaches the old poster, while the real server reports `canCleanup(oldPoster) === true`. The local board write precedes asynchronous server draft sync, so server-side `pin_drafts` reference checks cannot protect this interval. This is a reachable destructive eligibility window, not just a static theoretical mismatch.

Minimum acceptance: once terminal replay causes a fresh operation, discard the old poster identity from the new attempt and generate/upload/associate a fresh poster, or explicitly complete a safe server-owned transfer protocol. Keep old cleanup responsibility separately. Add the terminal-with-poster case, not only the existing no-poster fresh-attempt test; assert no new draft ever references an old cleanup-authorized poster.

### D3 — Recovery still accepts external video origins and foreign poster identities

`web/src/lib/studio/videoBatchRecovery.ts:56–68` now parses the video query and rejects the previously reported extra-query owner spoof. It does not constrain the URL origin/relative shape: `https://foreign.invalid/api/storage-media?path=<A>%2Fx.mp4` is accepted and later used verbatim. Poster URL validation checks only its prefix; a B-owned poster URL plus an unrelated A-owned `posterPath` is also accepted.

Both inputs return `saveVideoRecovery(...) === true` in independent probes. These tests cover malformed/imported local recovery data, not a claim that A can read B's protected storage bytes; the storage endpoint's authorization remains a separate boundary.

Minimum acceptance: one canonical relative protected-media parser for video and poster; exact route, only supported parameters, exact decoded owner and object path, no external origin, and poster URL/path identity agreement. Validate these on both save and read, preserve valid siblings, and retain current capacity/no-throw behavior.

### D5 — Attached-poster detection misses valid lowercase URL encoding

`backend/db/migrate_v80_video_poster_operations.sql:160–165` searches JSON text for a raw path or a string with `/` replaced by uppercase `%2F`. PostgreSQL `LIKE` is case sensitive. A live `pin_drafts` row using `%2f` is semantically the identical storage URL but is not detected.

Real PGlite probe: failed associated operation; live owner-A draft stores a poster URL using lowercase `%2f`; `new URL(...).searchParams.get('path')` equals the exact poster object path; production cleanup authorization returns **true**. Raw and canonical uppercase-encoded references both correctly return false.

Minimum acceptance: compare normalized media identities, or robustly cover all supported canonicalization forms before authorizing deletion. Add at least raw, uppercase `%2F`, lowercase `%2f`, mixed-case encoding, nonmatching sibling, deleted draft and foreign-owner tests. No live reference may be treated as unattached merely because URL serialization differs.

### D6 — v80 reapply does not validate its existing security/schema contract

`backend/db/migrate_v80_video_poster_operations.sql:6–23` checks only the table comment; `CREATE TABLE IF NOT EXISTS` does not restore missing constraints. Functions are replaced and exact signatures revoked/granted without detecting shadow overloads. The new verifier checks only a freshly installed schema and therefore reports green without exercising drift.

Independent real-catalog probes: (1) remove `video_poster_operations_path_check`, then apply v80 again — migration succeeds with the constraint still absent; (2) create a same-name, named-argument `text,text,text` cleanup overload granted to authenticated, then reapply — migration succeeds and that overload remains executable. These are intentionally injected migration-state faults in an isolated database, not a claim that ordinary authenticated clients can create functions or alter the schema.

Minimum acceptance: match the existing v77 fail-closed migration conventions for owned columns/defaults/constraints/indexes, RLS/policies/ACLs, exact function signatures/overloads/body identity and rollback state. Reject unexpected drift before overwriting/adopting it (or narrowly prove repair safety). Extend migration tests beyond clean apply-twice/rollback/reapply to these negative fixtures, including column grants, policies and function-body drift. The current clean migration tests alone do not establish these properties.

### D7 — Formal Round 3 safety script fails scoped lint

`web/scripts/test-video-batch-safety-round3.ts:79` declares `const module`, violating `@next/next/no-assign-module-variable`. The test runs successfully but the requested scoped ESLint gate exits 1. This declaration exists in the reviewed committed source; it is not an independent-probe lint finding.

Minimum acceptance: rename that temporary transpilation container, preserve the mutation assertion, and rerun ESLint on the formal safety/runtime/batch/UI scripts as well as the production files.

## Minor

### D4 — Retain's idempotency fallback ignores the requested operation

`backend/db/migrate_v80_video_poster_operations.sql:127–129` returns retained when owner/bucket/path match any retained row, without matching `batchId` or `ordinal`. Real RPC probe retains the correct operation, then sends an unrelated batch UUID and ordinal 19: the call still succeeds.

The poster is already protected, so this alone does not prove deletion or cross-owner access; nevertheless it falsely acknowledges the exact-operation contract and masks identity bugs. Bind the replay fallback through the same video item/batch/ordinal/owner relationship as the update, and test correct replay versus wrong batch/ordinal.

## Round 3 C1–C6 Recheck

| Earlier gate | Round 4 result |
| --- | --- |
| C1 write-ahead finalize | Fixed for normal runner dispatch; formal abrupt-close assertion passes. |
| C2 recovery owner switch | Fixed after finalize/retain awaits before current-owner draft writes; tested owner change passes. |
| C3 mixed cancellation lock | Fixed for the tested image-phase cancellation and subsequent upload; synchronous lock and next-selection assertion pass. |
| C4 protected poster cleanup | Association and terminal/unknown/foreign checks improved; D1/D2/D5 still prevent acceptance. |
| C5 recovery schema/owner | Malformed scoped bucket and extra-query spoof fixed; D3 remains. |
| C6 batch fixture | Fixed; full 15-check batch suite passes. |

## Verification Evidence

Commands run locally on the exact reviewed implementation, with explicit exit-code checks between chained commands:

- `node verify-v80-video-poster-operations.mjs` from backend PGlite package: **18 assertions passed**, including fresh apply twice, forced RLS, exact signatures, clean ACLs, normal association/retain, clean rollback and reapply.
- `npx --no-install tsx scripts/test-video-batch-safety.ts`: **18/18**.
- `test-video-batch-safety-round3.ts`: **7/7**.
- `test-video-batch-runtime.ts`: **6/6**, including same-request association compensation mocks and real v77 lifecycle.
- `test-video-batch-upload.ts`: **15/15**; `test-video-batch-upload-ui.ts`: **4/4**.
- `test-video-upload-private.ts`: **31/31**; `test-pin-board-store.ts`: **17/17**; `test-content-media-model.ts`: **23/23**.
- `npm run typecheck`: exit 0 on implementation HEAD; rerun with independent probe present also verified before evidence commit.
- `npm run check:test-registry`: **248 tracked, 240 runnable, 8 explicitly excluded**.
- Scoped ESLint on every changed Task 3 production path: exit 0. Scoped ESLint on the five batch/safety/runtime/UI test scripts: **exit 1**, D7 above.
- `git diff --check 0122bc6c..f2f55963`: clean; evidence diff also checked before commit.
- Independent `npx --no-install tsx scripts/probe-task3-review-round4.ts`: **3 passed, 8 failed**, exit 1, matching the documented open findings. Positive tests use the real upload handler plus real v80 association RPC; exact-signature service-only ACLs, foreign owner rejection, prepared/unknown protection, canceled terminal eligibility, raw/uppercase live references all verified.
- New isolated SQL-body mutation: remove the cleanup terminal-state gate. A prepared operation changes from denied to authorized; the safety assertion kills the mutant; restoring the original function restores denial. Production SQL/code is never edited. The mutation uses an explicit UUID signature to isolate it from the separate hostile-overload fixture.

The initial regression command used a nonexistent `test-pin-draft-store.ts` filename; it failed visibly after private tests. The correct discovered `test-pin-board-store.ts` and content suite were then independently rerun and passed. The first mutation probe was contaminated by the intentionally introduced shadow overload; explicit-signature isolation corrected the probe and the final mutation result above is the rerun result.

After the documented 3-pass/8-failure independent probe completed, a concurrent implementer began editing four production files while HEAD remained `f2f55963`. The next exploratory run observed those uncommitted changes and is **not** claimed as verification of either f2f55963 or the new fixes. This report is frozen to the reviewed committed implementation and the earlier clean-source results. The reviewer neither reverts nor stages those concurrent production changes. A later review must target the implementer's new committed SHA and update any probe setup assertions that intentionally describe the old failure receipt.

These are hermetic callback/DOM mocks and real isolated PostgreSQL-engine tests, not a claim of authenticated real-browser E2E, real Storage upload, preview testing or production deployment. No claim is made about untested live concurrency or environment provisioning. The reviewed evidence is sufficient to demonstrate the open blockers and insufficient to mark Task 3 APPROVED.
