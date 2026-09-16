# Task 7 Independent Review — Round 3

Verdict: **CHANGES REQUIRED — NOT APPROVED**

- Reviewed range: `aead8d05ff3dfb35df6f7ec6fec4876c2778e9a1..7fd7588c973a60365c2a76375f258b8dcdcbf2d2`.
- Critical: **0**. Important: **1**. Minor: **1**.
- The six Round 2 findings pass independent retesting. The remaining Important issue is the new v78 migration/rollback integrity boundary.
- Product files, index, HEAD and branch were not changed by this review. Only this uncommitted report and its uncommitted probe were added. No external DB/Storage/Pinterest request, token refresh, deployment, push or merge occurred.

## Verified Closure Of Round 2

| Round 2 finding | Independent Round 3 result |
|---|---|
| Concurrent claimed recovery duplicates provider calls | **Fixed.** Real SQL returned one new attempt and one replay of that attempt; only the new attempt invoked the provider. Observed provider count **1**, with published/in-progress outcomes. The `replayed` gate is at [wrapper:359](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/v76PinterestVideoPublish.ts:359). |
| Next cron pass rejects untouched sibling after timestamp bookkeeping | **Fixed in the tested continuation.** Stable source identity is separate from operational revision. A real rebuilt due receipt with the same schedule and changed `updated_at` successfully publishes the untouched destination. Substantive content/media mutation tests still reject. |
| Actual 2-to-1 partial retry fails v76 set equality | **Fixed.** The new v78 transaction validates the parent's failed-only entitlement and narrows the graph passed to v76. The two-destination parent/one-failed-child test passes; unknown-parent and duplicate child tests remain closed. |
| Nonempty media altText causes builder/validator fingerprint mismatch | **Fixed.** Real builder plus validator agree on nonempty, whitespace-trimmed alt/poster fields; empty/missing cases and the pinned legacy image hash also pass. |
| Ready recovery rereads original upload | **Fixed.** The production loader reads the frozen owner/intent/destination asset graph. Original-upload absence succeeds; missing/corrupt/wrong-owner frozen assets reject. See [loader:200](D:/vp-tmp/wt-video-pin-p0-task7/web/src/lib/server/publish/v76PinterestVideoRuntime.ts:200). |
| Installed v76 cannot upgrade via an edited migration | **Fixed.** v76 at HEAD has blob `577f75625ff494a60caaec29491b792e07a26543`, exactly the official `04b0ebe0` blob; `git diff 04b0ebe0 HEAD -- backend/db/migrate_v76_publish_asset_materializer.sql` is empty. The additive v78 upgrade succeeds over official v76 and current v77 without rolling either back first. |

The existing registered upgrade test subsequently exercises v77 rollback/reapply and v78 rollback/reapply. The new independent probe additionally verifies apply twice, rollback twice, retained historical source identity, and reapply. Both migration and rollback reject same-marker function-body drift. Fresh installation denies all four v78 RPCs to anon/authenticated and grants service_role execution.

## Important

### R3-I1 — P1: v78 does not validate its full privilege/schema manifest, and rollback can leave an unexpected exposed overload

Locations: [migration preflight](D:/vp-tmp/wt-video-pin-p0-task7/backend/db/migrate_v78_video_publish_recovery.sql:6), [column marker-only check](D:/vp-tmp/wt-video-pin-p0-task7/backend/db/migrate_v78_video_publish_recovery.sql:63), [limited revokes](D:/vp-tmp/wt-video-pin-p0-task7/backend/db/migrate_v78_video_publish_recovery.sql:329), [rollback preflight](D:/vp-tmp/wt-video-pin-p0-task7/backend/db/rollback_v78_video_publish_recovery.sql:4), [rollback drops](D:/vp-tmp/wt-video-pin-p0-task7/backend/db/rollback_v78_video_publish_recovery.sql:34).

The new migration pins function bodies and rejects additional overloads during apply, but it does not check effective EXECUTE privileges, inherited role privileges, grant options or the complete shape of its new column. The rollback does not perform the apply-side overload inventory at all. These omissions let an invalid installation be accepted as a valid active/rolled-back state.

Independent local PGlite mutations reproduced three facets:

1. Grant the ready-sources RPC to a separate role inherited by `authenticated`, then rerun v78. Reapply **succeeds** and `has_function_privilege('authenticated', ..., 'EXECUTE')` remains **true**. The migration's direct revokes cannot remove the inherited grant. Setting the role to authenticated and JWT subject to user B, then passing user A's id to this intentionally service-only SECURITY DEFINER RPC, returned **one of A's frozen asset metadata records**. No real user data was involved; this demonstrates why the unexpected ACL must not be silently blessed.
2. Add `publish_asset_ready_sources_v78(text)` with default PUBLIC execution. Apply correctly rejects it. Rollback **succeeds**, removes the four recognized functions and leaves that overload **callable by authenticated**. A rollback must reject the unexpected signature before removing recognized objects, rather than declare success while an exposed name remains.
3. Change `source_identity_fingerprint` to `varchar(64)` while preserving the marker. Reapply **succeeds** and leaves the changed type intact because only the comment is checked. The same omission applies to nullability/default/column privileges. The probe uses a non-destructive compatible type to prove the manifest check is absent; it does not claim that varchar(64) itself corrupts valid hashes.

These are drift-dependent failures, **not a claim that a pristine installation grants clients access**. Fresh ACLs are correct. However, this task explicitly requires drift-resistant, server-only upgrade/rollback behavior, and the existing v77 migration already checks effective privileges and full owned-column definitions. The new v78 surface must preserve that standard before integration.

Required bounded correction:

- Define allowed fresh/active/rolled-back manifests for the four v78 RPCs and the additive source-identity column. Validate exact signatures, body/security configuration, column type/nullability/default, and relevant direct/effective privileges before changing anything.
- Reject unexpected direct or inherited client execution and grant-option drift; do not silently keep or expand it. Validate first-install default ACL effects too.
- Mirror the exact-name overload checks in rollback, and stop before dropping known functions if an extra signature or privilege/schema drift exists. Do not delete an unowned overload to hide the collision.
- Add the three mutations above to the formal upgrade suite alongside fresh/apply-twice/rollback-twice/reapply and body-drift tests. Assert that rejected apply/rollback leaves known function definitions, grants and historical identity unchanged.

## Minor

### R3-M1 — P3: NULL source identity bypasses the new RPC validation

Location: [fingerprint guard](D:/vp-tmp/wt-video-pin-p0-task7/backend/db/migrate_v78_video_publish_recovery.sql:92).

`IF p_source_identity_fingerprint !~ ...` evaluates to NULL when the argument is NULL, so the error branch is skipped. The independent probe passes NULL with an otherwise valid receipt: the RPC succeeds and creates one intent graph with a NULL source identity. Runtime inspection subsequently cannot resume that graph. The current production TypeScript caller always computes a valid hash, so this is RPC hardening rather than a demonstrated normal-UI regression.

Use an explicit NULL check or a fail-closed regex condition, and assert rejection before graph creation for NULL/blank/malformed hashes. This can be included with the manifest repair.

## Fresh Independent Test Evidence

Cached TS runner: `D:/vp-tmp/npm-cache-video-pin-p0/_npx/fd45a72a545557e9/node_modules/tsx/dist/cli.mjs`. TS commands ran from the worktree's web directory, with local PGlite and explicit provider/Storage mocks only.

| Command | Result |
|---|---|
| `node <runner> scripts/test-v78-pinterest-video-recovery.ts` | Five Round 2 adversarial groups pass; provider count 1. |
| `node <runner> scripts/test-v78-pinterest-video-upgrade.ts` | Official-v76 additive upgrade/reapply/v77 interaction/body-drift checks pass. |
| `node <runner> scripts/test-v76-pinterest-video-recovery.ts` | All 18 production-wrapper/SQL probes pass. |
| `node <runner> scripts/test-v76-pinterest-video-publish.ts` | 17 passed, 0 failed. |
| `node <runner> scripts/test-publish-due-video-races.ts` | Four actual GET races pass, zero claim/meter/provider/durable reads. |
| `node <runner> scripts/test-pinterest-video-legacy-route.ts` | Actual mixed-video POST rejects before legacy provider. |
| `node <runner> scripts/test-publish-durable-intent.ts` | 23 passed, 0 failed. |
| `node <runner> scripts/test-publish-confirmation.ts` | 16 passed, 0 failed. |
| `node <runner> scripts/test-pinterest-video-adapter.ts` | 16 passed, 0 failed. |
| `node backend/tests/pglite_v37/verify-v76-publish-assets.mjs` (repo cwd) | 280/280, two rounds, exit 0. |
| `node backend/tests/pglite_v37/verify-v77-video-media.mjs` (repo cwd) | 94 assertions, exit 0. |
| `npm run typecheck` | exit 0. |
| `npm run check:test-registry` | exit 0; 244 tracked, 236 run, 8 excluded. |
| `git diff --check aead8d05 7fd7588c` | exit 0. |
| New `task-7-review-round3-probes.ts` | **exit 1**: four expected-safe assertions fail (three manifest facets plus NULL input); positive fresh ACL, lifecycle preservation, body-drift and apply-overload controls pass. |

No build or browser QA claim is made by this bounded review.

## Review Artifact And Disposition

[Independent Round 3 probes](D:/vp-tmp/wt-video-pin-p0-task7/.superpowers/sdd/2026-09-16-video-pin-p0/task-7-review-round3-probes.ts) mutate only an ephemeral PGlite database and compile the existing test harness in memory. They do not edit or substitute production files. The newly discovered unsafe cases turn red; positive controls demonstrate that expected active/rollback states and same-marker body-drift refusals still work.

**Ready to integrate: No.** The six earlier application-level defects are closed, but the additive migration needs one bounded manifest/rollback hardening pass. No application-flow rewrite is requested by this review.
