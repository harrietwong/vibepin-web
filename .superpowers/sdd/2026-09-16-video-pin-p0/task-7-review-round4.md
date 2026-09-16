# Task 7 Independent Review — Round 4

Verdict: **APPROVED**

- Reviewed range: `7fd7588c973a60365c2a76375f258b8dcdcbf2d2..b36edaeb668ebdf6f0c2da7b42401df4b63a275d`.
- Critical: **0**. Important: **0**. Minor: **0** in the bounded review scope.
- Round 3's one Important and one Minor are closed with independent test evidence.
- This is Task 7 integration acceptance, not production deployment authorization or a replacement for the parent task's final integrated tests/Fable gate.
- No product file, index, HEAD or branch was modified. Only this report and the independent Round 4 probe were added, both **uncommitted**. No external database/Storage/Pinterest calls, token refresh, deployment, push or merge occurred.

## Round 3 Closure

### R3-I1 — Manifest, effective permissions and rollback boundary: CLOSED

Migration and rollback now validate a complete owned function set, exact signatures, markers, body hashes, language, SECURITY DEFINER/search-path/return configuration, direct ACLs and effective anon/authenticated/service permissions before changing objects. Partial sets and same-name overloads are rejected. The postflight validates newly created functions so unexpected ambient default grants cause the transaction to roll back.

The retained source-identity column is checked as nullable `text`, without a default or direct column ACL, with the expected marker and effective service/client privileges. Rollback mirrors the owned-schema/permission checks and verifies the known RPC names are absent after their bounded removal.

Fresh independent evidence covers:

- Fresh service-only RPC permissions; apply twice; rollback twice; historical identity retained; reapply.
- Same-marker body drift and extra overload rejected by apply and rollback.
- Inherited client EXECUTE and ambient default EXECUTE drift rejected. The drift fixture deliberately remains unsafe after rejection: the correct behavior is to stop without silently changing unowned grants, not to claim that rejection repairs those grants.
- Column type, nullability, default and client SELECT grant drift rejected.
- Additional reviewer controls: PUBLIC EXECUTE, direct authenticated EXECUTE, service EXECUTE WITH GRANT OPTION, revoked service EXECUTE, and an unknown direct role are all rejected by apply and rollback. The exact function definitions/ACLs remain unchanged after each refusal.
- Partial function sets are rejected atomically. A client UPDATE column grant is rejected while both function manifests and historical source identity remain unchanged.

### R3-M1 — NULL source fingerprint: CLOSED

The RPC explicitly rejects NULL before the regex check. NULL, blank and 63-character hashes independently return `invalid_source_identity_fingerprint`, with no intent graph created.

## Earlier Recovery Regressions

The five grouped Round 2 adversarial cases remain green at this HEAD:

1. Two concurrent claimed-recovery callers share one durable attempt and make **one provider invocation**. The replay returns `in_progress`.
2. The next due pass continues an untouched sibling after operational `updated_at` changes.
3. A real two-destination parent can retry only its one failed destination.
4. Nonempty/trimmed alt and poster metadata agree between the real builder and validator.
5. Ready recovery uses the frozen private copy; original-upload absence succeeds, while missing/corrupt/wrong-owner frozen assets reject.

The 18 earlier production-wrapper/PGlite regressions also pass, including unknown-parent rejection, once-only retry entitlement, stale-attempt anti-redispatch, substantive source mutation, sibling outcomes, and the pinned legacy image hash.

## Versioned Upgrade Integrity

`backend/db/migrate_v76_publish_asset_materializer.sql` at HEAD and official base `04b0ebe0` both have Git blob **`577f75625ff494a60caaec29491b792e07a26543`**. The old migration remains byte-identical.

The independently executed upgrade suite loads official v76, then applies v77 and additive v78 without rolling the installed baseline back first. It passes repeated v78 apply, subsequent v77 rollback/reapply, v78 rollback/reapply and body-drift rejection. v78 is the new versioned repair surface; no production installation of an earlier unreleased v78 is assumed.

## Mutation Test

The reviewer created an **in-memory-only copy** of the current v78 migration with its direct/effective function ACL checks removed; owned function bodies and repository files were unchanged. An unknown-role EXECUTE grant was then introduced in ephemeral PGlite.

- The expected-safe assertion against that weakened migration failed: expected refusal `true`, observed `false`.
- The real production migration rejected the identical drift and left function definitions/ACLs unchanged.
- After removing the test grant, the production migration reapplied successfully.

This demonstrates that the ACL tests detect removal of the security boundary, rather than merely passing on the current implementation. The mutation was killed; the overall control script exits zero only when the mutant turns red and the real migration passes.

## Fresh Independent Verification

Cached runner: `D:/vp-tmp/npm-cache-video-pin-p0/_npx/fd45a72a545557e9/node_modules/tsx/dist/cli.mjs`. Commands ran from the reviewed worktree's web directory unless stated.

| Command | Observed result |
|---|---|
| `node <runner> scripts/test-v78-pinterest-video-manifest.ts` | 10 manifest/ACL/input groups passed; 0 failed. |
| `node <runner> scripts/test-v78-pinterest-video-recovery.ts` | Five Round 2 groups passed; provider count 1. |
| `node <runner> scripts/test-v78-pinterest-video-upgrade.ts` | Official-v76 additive upgrade, reapply and drift controls passed. |
| `node <runner> scripts/test-v76-pinterest-video-recovery.ts` | All 18 production-wrapper/PGlite probes passed. |
| `node <runner> ../.superpowers/sdd/2026-09-16-video-pin-p0/task-7-review-round4-probes.ts` | Eight independent control groups passed; ACL mutant produced the required failing assertion. |
| `npm run typecheck` | exit 0. |
| `npm run check:test-registry` | exit 0: 245 tracked, 237 run, 8 excluded with reasons. |
| `git diff --check 7fd7588c b36edaeb` | exit 0. |
| `git diff --quiet` and `git diff --cached --quiet` | exit 0; tracked worktree and index unchanged. |

The v76/v77 files and application wrapper were not changed in this last repair. Their full standalone verifiers were independently run in Round 3; this final bounded pass reran the SQL-backed manifest, upgrade and recovery suites instead of repeating the unchanged broader suites. No full integrated build/browser/production verification is claimed here.

## Artifacts And Acceptance

- [Independent Round 4 controls and mutation](D:/vp-tmp/wt-video-pin-p0-task7/.superpowers/sdd/2026-09-16-video-pin-p0/task-7-review-round4-probes.ts).
- [Registered manifest probe](D:/vp-tmp/wt-video-pin-p0-task7/.superpowers/sdd/2026-09-16-video-pin-p0/task-7-review-round3-probes.ts).

**Task 7 ready for integration: Yes, at `b36edaeb668ebdf6f0c2da7b42401df4b63a275d`.** The parent task should still verify the combined worktree, migration order and final rollout gates before any deployment.
