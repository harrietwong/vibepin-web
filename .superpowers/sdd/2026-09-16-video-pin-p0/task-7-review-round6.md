# Task 7 Round 6 — Focused Independent Final Review

**Verdict: APPROVED — 0 Critical / 0 Important / 0 Minor.**

Reviewed HEAD: `7514c65002bc95451212fe8f551b6ab6e4c5d149`, compared with `253cfc18`, in `D:/vp-tmp/wt-video-pin-p0-integration-fix`, on 2026-09-16. This verdict closes Round5 I1 and covers the focused integration fix; it is not permission to deploy or a claim of live Pinterest acceptance.

## Round5 I1 Closure

The additive [v79 migration](D:/vp-tmp/wt-video-pin-p0-integration-fix/backend/db/migrate_v79_video_publish_provenance.sql:34) now validates both raw and effective v76 settlement EXECUTE permissions before installation. The direct ACL allows only its owner and service_role, disallows service grant-option expansion, and requires effective service execution while denying anon/authenticated including inherited execution. The equivalent guard is repeated in postflight at line 293.

The provenance dependency now requires its exact baseline `relrowsecurity=true / relforcerowsecurity=false`, exactly one policy, and the expected policy name, SELECT command, authenticated role, permissive flag, owner-and-lifecycle USING expression, null WITH CHECK and ownership marker. This rejects replacing the predicate with `USING(true)` and adding an OR-composed permissive bypass policy. The corresponding postflight repeats these checks.

Independent reproduction of both Round5 failures now stops with the intended dependency-tamper error. Rejection preserves the drifted policy/ACL for diagnosis; the migration does not silently rewrite dependencies. After explicitly restoring the correct baseline, a different authenticated user again reads zero OWNER provenance rows.

## Independent Adversarial Evidence

The new [Round6 executable probe](D:/vp-tmp/wt-video-pin-p0-integration-fix/.superpowers/sdd/2026-09-16-video-pin-p0/task-7-review-round6-probes.ts) re-executes all [Round5 probe](D:/vp-tmp/wt-video-pin-p0-integration-fix/.superpowers/sdd/2026-09-16-video-pin-p0/task-7-review-round5-probes.ts) controls in memory, changing only the two historical bug expectations to required safe rejections. The historical source and production files remain unchanged.

It adds 12 independently enumerated drift cases, each tested on both first apply and reapply: `USING(true)`, an additional permissive read policy, RLS disabled, force-RLS changed, direct anon/authenticated/PUBLIC EXECUTE, an unknown direct executor role, service grant option, missing service execution, and authenticated/anon inheriting service_role. These last two cases leave the raw function ACL unchanged and prove that the effective privilege check is meaningful. All **24 reject-and-preserve checks passed**. Before/after snapshots verify function definitions and ACLs, provenance policies, row-security flags and every historical provenance row remain identical after a rejected migration.

The probe also reran exact v79 RPC ACL/default-ACL rejection, v76 dependency body-hash tamper rejection, invalid source lifecycle/type, lost-lease atomic rollback, target metadata conflict preservation, source digest-history preservation, and the actual private Storage wrapper with exact replay / same-length wrong bytes / wrong size. All passed. Restored-schema apply twice, rollback twice and reapply preserve historical provenance rows and owner isolation.

Mutation sensitivity was independently demonstrated twice:

- The retained in-memory RPC ACL-check mutant makes the unknown-role safe-rejection assertion turn red; the unmodified migration rejects the same drift.
- A new policy-only mutant removes only the provenance policy/RLS guard sections. It retains all function-privilege checks (asserted by equal check counts), yet the `USING(true)` safe-rejection assertion turns red. The unmodified migration rejects the identical drift, then reapplies after restoration.

These expected-red mutation controls are deliberate test successes, not remaining production failures. The unmodified production migration has no expected-safe failures in this review.

Run the self-contained review evidence from the worktree's `web` directory:

```powershell
node D:/vp-tmp/npm-cache-video-pin-p0/_npx/fd45a72a545557e9/node_modules/tsx/dist/cli.mjs ../.superpowers/sdd/2026-09-16-video-pin-p0/task-7-review-round6-probes.ts
```

## Fresh Formal Verification

The formal v79 suite currently contains **11 groups**, not the 10 stated in the review request. All 11 were run and passed. It includes policy role/command/WITH CHECK/permissiveness/marker drift beyond the independent probe's 24-case subset.

| Command / suite | Fresh result |
| --- | --- |
| `scripts/test-v79-video-provenance-materialization.ts` | 11 groups passed; 0 expected-safe failures |
| `backend/tests/pglite_v37/verify-v76-publish-assets.mjs` | 280/280 assertions; 2 rounds |
| `backend/tests/pglite_v37/verify-v77-video-media.mjs` | 140 assertions; 0 failures |
| `scripts/test-video-upload-private.ts` | 31 passed; 0 failed |
| `scripts/test-v76-pinterest-video-publish.ts` | 19 passed; 0 failed |
| `scripts/test-v78-pinterest-video-recovery.ts` | 5 groups passed; concurrent provider count = 1 |
| `scripts/test-v78-pinterest-video-upgrade.ts` | Official v76 additive upgrade/idempotency passed |
| Round6 independent probe | Exit 0; original gaps closed, 24 new rejection checks passed, both mutations killed |
| `npm run typecheck` | Exit 0 |
| `npm run check:test-registry` | 251 tracked / 243 run / 8 reasoned exclusions |
| Scoped ESLint: runtime, publish adapter, v79/v76 suites and registry | Exit 0; no warnings/errors |
| `git diff --check 253cfc18 7514c650` and `2ff6748d 7514c650` | Exit 0 |

TS suites used the pre-existing local tsx runner shown above, not a newly installed package. Database checks used local PGlite. Production-wrapper recovery again verifies one concurrent provider call, untouched sibling next-pass continuation, a real narrowed 2-to-1 retry, nonempty media alt text and frozen-copy recovery after original upload loss.

## Immutable Migration Check

Git blobs at `7514c650` and the previously reviewed integration commit `2ff6748d` are identical:

- v76: `577f75625ff494a60caaec29491b792e07a26543`
- v77: `82a3b1affca1a60a3dc0dc5dc9404eccdd906642`
- v78: `3e608406fe1fe8d2eeb04e9dcdb791b722441e2b`

The production fix changes only the additive v79 migration preflight/postflight and its formal test suite. Its owned RPC body hash, rollback implementation, server-byte digest calculation and atomic materialization settlement remain as reviewed in Round5.

## Handoff Limits

No remaining Critical, Important or Minor finding within this focused scope. The exact provenance policy manifest intentionally fails closed on additional policies, including a potentially legitimate future policy; such schema changes require an explicit reviewed migration rather than silent acceptance.

This review commits only evidence: this report, the historical Round5 probe needed for reproduction, and the new Round6 probe. No production code was changed by the reviewer. No merge, push, deploy, external database/Storage access, real provider call, token refresh or external model call occurred. Full Web build/tests, browser E2E and live migration execution were not rerun in this focused review and are not claimed.
