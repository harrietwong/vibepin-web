# Task 3 Round 8 Focused Final Review

**APPROVED — 0 Critical, 0 Important, 0 Minor.**

Reviewed frozen implementation HEAD: `360df0a1e29b44ac77086ab052c9150ca694a5d4`. This is Task 3 review acceptance, not deployment authorization or a claim that the overall project Goal is complete. The review adds only this report and `web/scripts/probe-task3-review-round8.ts`; no production code or external system was changed.

## G1 Closed

The v80 postflight now reads the default into `v_default`, checks a missing row explicitly, and uses `IS DISTINCT FROM` for a NULL-safe comparison. CHECK and primary-key validation are also NULL-safe. The Round 7 `DROP DEFAULT` reproducer now reports **`reapplyRejected=true`** and exits 0; after restoring the proper default, the same real poster operation succeeds.

The old probe deliberately continues to call association against its injected invalid schema after rejection, so its printed NOT NULL error is an expected negative control, not a failure of the fixed migration. The relevant safety change is rejection before accepting that installed state.

Additional independent real-PGlite mutations all pass:

1. Missing path CHECK catalog row is rejected with `v80_schema_collision`.
2. Missing state CHECK catalog row is rejected.
3. Missing primary-key catalog row is rejected.
4. Missing state-default catalog row is rejected.
5. Explicit NULL state default is rejected.

Each fixture restores its original constraint/default and performs a successful clean reapply before the next fixture. The final default is verified as `'associated'::text`. This prevents a prior failed transaction from falsely satisfying another negative test.

## Fresh Verification On This HEAD

- Backend `node verify-v80-video-poster-operations.mjs`: **completed, exit 0, 25 assertions passed**. This includes clean apply/reapply/rollback, real association/retain/reference/ACL behavior, all prior catalog mutations and the new default-removal mutation. The process was awaited to completion, not inferred from early output.
- `npx --no-install tsx scripts/probe-task3-review-round7.ts`: **exit 0**, original G1 reproducer now rejects the drift correctly.
- `npx --no-install tsx scripts/probe-task3-review-round8.ts`: **5 passed / 0 failed**, with restored clean reapply between every mutation.
- `npm run typecheck`: **exit 0**.
- `npm run check:test-registry`: **248 tracked / 240 runnable / 8 excluded with explicit reasons**.
- `test-video-batch-safety.ts`: **19/19**, including real persistence retry, owner boundaries, reload recovery and the owner-check mutation.
- `test-video-batch-upload.ts`: **16/16**, including concurrency, idempotence, partial failure, cancellation and terminal retry with fresh poster.
- Scoped ESLint on the Task 3 production upload/recovery files, five formal batch/runtime/safety/UI scripts, and the new Round 8 probe: **exit 0**, no diagnostics.
- `git diff --check 73d48e2d..360df0a1`: **clean**. Evidence-only staged diff is checked before commit.

## Prior Matrix And Scope

As authorized for this focused review, the unchanged broader matrix is referenced from evidence commit `4d53cd4f` and `task-3-review-round7.md`: Round 5 probe **20/20**, Round 6 probe **9/9**, v77 **140 assertions**, runtime **6/6**, Round 3 safety **7/7**, UI **4/4**, private-video **31/31**, privacy **16/16**. No browser application code changed between that fully tested implementation and this focused migration fix.

That prior evidence establishes actual same-page quota retry persistence, one upload and one durable draft after cold reload, retain-before-attach/recovery, exact poster identity, cleanup success/failure ordering, owner isolation, mixed-file behavior, cancellation, required decode, encoded references and the five earlier catalog mutations. The present v80 verifier reruns those catalog mutations against the final SQL. No C/D/E/F finding remains open in the reviewed acceptance scope.

The unchanged old Round 4 probe contains one obsolete setup assumption requiring a finalized receipt after retain fails; later safety-semantic probes verify the correct durable-pending behavior. It is historical review evidence, not a product regression.

## Handoff

Task 3 may proceed through the coordinator's remaining integration, final-advisor and deployment-coordination gates. This review performs no merge, push, deploy, live Storage test, authenticated real-browser E2E or build. The browser checks use production callbacks with hermetic transport/DOM mocks and the real board store; SQL checks use real migrations/RPCs in isolated local PGlite. The implementation SHA remained frozen throughout this review.
