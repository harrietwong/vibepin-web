# Task 3 Round 5 Independent Review

**CHANGES REQUIRED — 0 Critical, 5 Important, 0 Minor.**

Reviewed implementation: `8f7782128b4119a1836032ac5233e41cb7674a3c`, against the Round 4 findings on `f2f55963`. Only this report and `web/scripts/probe-task3-review-round5.ts` are review changes. No production code edits, deployments, external requests, or live database/Storage writes were performed by the reviewer.

## Important

### E1 — Poster-bearing finalized items cannot complete same-page Retry after local persistence failure

At the reviewed HEAD, `web/src/lib/studio/videoBatchUpload.ts:154` clears `attempt` when processing `finalized`. If the subsequent draft write fails, the item remains retryable with `finalized` and `posterPath`, but no operation identity. On Retry, Studio calls `onFinalized` again; `web/src/lib/studio/videoBatchRecovery.ts:77` now rejects a finalized poster receipt without an attempt. Retry therefore fails with `video_recovery_persist_failed` even after local storage is available again.

Actual Studio callback and real board-store probe: force draft-storage quota failure while retaining the recovery ledger; upload a video **with a poster**; initial error is correctly `draft_persist_failed`; restore storage and run failed-only Retry; observed status is still `failed`, now `video_recovery_persist_failed`. The existing quota test uses a no-poster item and does not detect this regression.

Minimum acceptance: preserve the server poster-operation identity throughout finalized-but-not-durably-attached states, including reducer transitions and same-page retries, without weakening the new retention gate. After storage recovers, Retry must complete once with the original finalized video, no reupload, no duplicate draft, and no abandoned receipt. Keep a separate no-poster regression.

### E2 — Recovery can retain one poster but attach another poster owned by the same user

`web/src/lib/studio/videoBatchRecovery.ts:64–77` validates the owner prefix independently for `inspection.posterUrl` and `posterPath`, but never requires their decoded object paths to be identical. Studio recovery retains `posterPath` and renders/attaches `inspection.posterUrl`. Owner checks alone cannot establish that the acknowledged asset is the attached asset.

Two independent checks fail: the malformed same-owner/mismatched-path receipt is accepted; and an integrated real v80 RPC test proves the impact. Seed retained poster A and a different failed/cleanup-eligible poster B for the same owner; persist a receipt whose `posterPath` is A but `posterUrl` is B; run actual Studio recovery and real board store with production poster-store RPCs. The result is **accepted=true, unsafe poster attached=true, canCleanup(B)=true**. This concerns inconsistent recovery data and its attachment invariant, not a claim that another account's protected bytes become readable.

Minimum acceptance: canonicalize the protected poster URL to an exact owner/object identity and require it to equal `posterPath`; define and reject inconsistent missing-path/missing-operation combinations. Only the very same asset confirmed retained may be attached. Add same-owner different-file tests in addition to the now-passing foreign-owner and external-origin tests.

### E3 — Encoded live references still miss filenames containing uppercase characters

`backend/db/migrate_v80_video_poster_operations.sql:163–168` lowercases `d.payload::text`, but computes `v_encoded_path` by replacing slashes on the original mixed-case path. A canonical allowed object such as `studio/uploads/<owner>/Review_8.png` therefore cannot match its encoded form in the lowercased payload. Raw-path comparison separately lowercases its needle, so raw references work while encoded ones do not.

Real PGlite probe uses a failed associated operation and live `pin_drafts` references to that exact mixed-case filename. Results for raw, uppercase `%2F`, lowercase `%2f`, and mixed escape case are **[denied, allowed, allowed, allowed]**. Lowercase filenames pass the current formal and Round 4 tests, masking the remaining deletion-eligibility hole.

Minimum acceptance: normalize the two comparison sides consistently, preferably by decoding supported URL forms to exact storage identities. Preserve the distinction between case-sensitive object names and case-insensitive percent-escape spelling; conservative retention is safer than false nonattachment. Test mixed-case filenames with all supported encoded/raw forms and nonmatching siblings.

### E4 — Migration postflight checks words, not the owned constraint contract

`backend/db/migrate_v80_video_poster_operations.sql:182–186` checks only whether `pg_get_constraintdef` contains selected strings. It accepts a same-name tautology such as `CHECK (object_path IS NOT NULL OR object_path = 'studio/uploads png|jpg|jpeg|webp|gif')`. Since the column is NOT NULL, this constraint accepts every row. Reapply succeeds and leaves the broken constraint installed.

The independent probe installs that drift only inside isolated PGlite, reapplies the actual migration, observes no rejection, and restores the original constraint. Missing constraints and independent shadow overloads are now correctly rejected, but keyword presence is not a substitute for the requested migration contract check. This is an intentionally injected administrative/schema-state fault, not a claim that ordinary clients can ALTER TABLE.

Minimum acceptance: compare the exact owned catalog definitions or otherwise verify their complete semantics, following v77's established contract approach. Include state/path checks, PK/FK/unique relationships, column types/nullability/defaults, indexes, expected policies/ACLs and function ownership/signatures/body handling as applicable; do not merely add another token to the existing substring test. Add malformed-but-keyword-matching constraints as negative fixtures. Ensure each drift test restores its fixture so one earlier failure cannot make a later test appear successful.

### E5 — The formal safety script still fails scoped ESLint

`web/scripts/test-video-batch-safety-round3.ts:79` still declares `const module`. Scoped lint exits 1 with `@next/next/no-assign-module-variable`. This is the unchanged Round 4 D7 finding in committed formal test code, not an independent probe warning.

Minimum acceptance: rename the temporary transpilation container and preserve its mutation assertion. Rerun the complete requested production-plus-formal-test lint scope. Runtime green is not a lint pass.

## Verified Round 4 Improvements

| Gate | Round 5 result |
| --- | --- |
| D1 retain before finalized attachment | Actual failure and reload cases now retain the pending receipt and create zero drafts. Explicit finalized-receipt recovery also creates zero drafts while retain fails. |
| D2 terminal replay old-poster sequencing | Cleanup is awaited before clear/prepare; failure preserves old poster and prevents a fresh operation. Success creates and associates a fresh poster and produces one correct draft. |
| D3 exact URL/owner validation | External video origin and foreign poster owner are rejected. Same-owner asset identity remains E2. |
| D4 retain operation replay | Wrong batch/ordinal is rejected; correct operation replay remains idempotent. |
| D5 raw and encoded references | Raw and both escape cases work for lowercase filenames. Mixed-case filenames remain E3. |
| D6 migration drift | Clean apply/reapply/rollback succeeds; missing path constraint and independently introduced shadow overload are rejected. Tautological constraint remains E4. |
| D7 formal test lint | Unchanged failure, E5. |

The ACL drift fixture adds an authenticated column grant and permissive RLS policy, then reapplies v80. The migration does not reject it, but the test observes **zero exposed authenticated rows** afterward. No data-exposure finding is asserted for that fixture. Fresh service-only RPC ACLs, forced RLS, owner checks and terminal-state protection also pass.

## Commands And Fresh Evidence

- Required unchanged committed `npx --no-install tsx scripts/probe-task3-review-round4.ts`: **10 passed, 1 failed**. The failure is its obsolete setup assertion requiring a finalized receipt after retain fails; the implementation now safely leaves pending. This failure is **not** counted as an implementation defect.
- New `npx --no-install tsx scripts/probe-task3-review-round5.ts`: **15 passed, 5 failed**, exit 1. The failures are E1, both E2 checks, E3, and E4. The old D1 setup assertion is adapted to require a durable receipt without insisting on the old unsafe phase.
- `test-video-batch-upload.ts`: **16/16**; `test-video-batch-runtime.ts`: **6/6**.
- `test-video-batch-safety.ts`: **18/18**; `test-video-batch-safety-round3.ts`: **7/7**; `test-video-batch-upload-ui.ts`: **4/4**.
- `test-video-upload-private.ts`: **31/31**; `test-media-privacy-architecture.ts`: **16/16**. The latter intentionally logs its mocked compensation-removal failure; the assertion passes, and no real Storage call is made.
- Backend `node verify-v80-video-poster-operations.mjs`: **18 assertions**; `node verify-v77-video-media.mjs`: **140 assertions, zero failures**.
- `npm run check:test-registry`: **248 tracked / 240 runnable / 8 explicitly excluded**.
- `npm run typecheck`: exit 0 on the reviewed clean implementation during the initial regression run.
- Scoped ESLint over all Task 3 production upload/recovery files plus the five formal batch/safety/runtime/UI scripts: **exit 1**, exactly the formal-script error E5 above.
- `git diff --check f2f55963..8f778212`: clean. The evidence-only staged diff is also checked before commit.

New mutation: in-memory transpilation removes the `await` from terminal old-poster cleanup. The genuine runner issues zero fresh prepares while cleanup acknowledgement is blocked; the mutant issues one. The assertion kills the mutant, and no production file is patched. The earlier isolated SQL terminal-guard mutation is also rerun successfully.

Unlike the unchanged Round 4 probe, the Round 5 drift probes restore a dropped constraint before testing a shadow overload and remove the overload afterward. Thus missing-constraint rejection cannot falsely satisfy the later shadow-overload test. All database probes use the local repository-relative PGlite test dependency and isolated ephemeral databases.

## Scope And Handoff

The reviewed worktree was clean except prior review artifacts at the start. After the final independent probe had loaded the reviewed modules/migration, a concurrent implementer began changing three production files. Those uncommitted fixes are not part of this verdict and were neither reverted nor staged by the reviewer. A later typecheck/lint pass on that evolving worktree is not presented as fresh acceptance of either version. This report remains scoped to `8f778212` and the evidence above.

There is no real-browser authenticated E2E, live Storage/preview test, build or deployment claim. Callback/DOM mocks use actual production callbacks and the real board store; v77/v80 checks execute real migration/RPC SQL in isolated PGlite. Only after E1–E5 are resolved and independently verified should Task 3 receive APPROVED.
