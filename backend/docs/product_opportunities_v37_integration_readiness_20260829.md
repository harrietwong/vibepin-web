# Product Opportunities v3.7 Integration Readiness — 2026-08-29

This is a local, read-only topology and merge-surface audit. It did not fetch,
merge, create a worktree, update a ref, push, deploy, apply a migration or touch
production. Local refs are point-in-time evidence and must be re-resolved by the
central deployment session immediately before building an integrated candidate.

## Exact audited refs

| Role | Ref | Audited local SHA |
|---|---|---|
| v3.7 functional boundary | direct commit | `d2c13dd6a4d1e79d0d247fa6cd09d68c04a15b5d` |
| v3.7 docs/test branch | `codex/product-v37-manifest-b229` | `6ac660fbe37a2dd61c0c5ff8387ace490240fed0` |
| production lineage anchor | `deploy/fanout-visibility-0810` | `5bcc1a6a0068347c6397b463c713aba82e45a6d9` |
| multichannel candidate | `integrate/multichannel-0827` | `a31dfb136623bbc376771cd9a7c98f11547c87f4` |
| admin cockpit candidate | `codex/admin-cockpit-on-live` | `27c70f90ec69bed64511efb98eb6827b5a427b5f` |
| reference recommendations | `feat/reference-recs-p0-0827` | `68eebbd242889baf3205f2bc3c14396f560a0620` |

The remote-tracking multichannel ref was still older than the audited local ref.
This document therefore does not claim that any candidate above is the final
remote deployment input.

## Historical integrated branch is not the current candidate

`codex/product-opportunities-v37-integrated@74be67da08c1861b0b735101bf32d5964ae198cf`
contains the production lineage anchor `5bcc1a6`, but it contains none of:

- final v3.7 functional `d2c13dd6`;
- current v3.7 docs/test head `6ac660fb`;
- multichannel `a31dfb13`;
- admin cockpit `27c70f90`;
- reference recommendations `68eebbd2`.

It is historical evidence only. Deploying it would regress the final v3.7 safety
work and omit later product lines.

## Pairwise merge surface

All four comparisons have merge base
`b22930ebe73847cf35bc44be789414902ae6b599`. The v3.7 functional boundary
changes 172 paths from that base.

| Other line | Other changed paths | Simple path overlap | Both-changed merge-tree sections | Textual conflicts |
|---|---:|---:|---:|---:|
| production `5bcc1a6` | 1,761 | 17 | 14 | 9 |
| multichannel `a31dfb13` | 1,851 | 18 | 15 | 9 |
| admin `27c70f90` | 1,789 | 18 | 15 | 10 |
| reference `68eebbd2` | 1,825 | 18 | 15 | 9 |

These are pairwise diagnostics, not proof that a sequential four-line merge will
have the same count. The central deployment session must recompute after freezing
the exact integration order.

### Conflicts common to every audited line

- `backend/deploy/systemd/vibepin-product-supply.service`
- `backend/product_harvest.py`
- `backend/shop_the_look_expand.py`
- `backend/tests/test_run_worker.py`
- `backend/tests/test_shop_the_look_expand.py`
- `backend/tests/test_stl_authenticated_session.py` (added independently on both sides)
- `web/package.json`
- `web/src/app/api/generate/route.ts`
- `web/src/lib/server/shopify/connectPrep.ts` (added independently on both sides)

### Line-specific conflicts

- admin: `web/scripts/test-generation-moderation-gate.ts`.

`backend/run_worker.py`, `web/package-lock.json`, `web/scripts/test-registry.ts`,
`web/vercel.json` and several Shopify/Studio files are either changed on both
sides but merge cleanly pairwise, or changed only by v3.7. Their combined
semantics still require review even though the pairwise merge has no text marker.

## Resolution rules

No conflicted production file may be resolved by taking all of one side.

1. Product Supply/harvest files must retain v3.7's 100-Pin scan, 50-row run cap,
   20-row atomic cap, merchant-only image/name provenance, shared red-line core,
   exact inserted-ID receipt and explicit `launch-v37` audit profile while also
   preserving later retailer, timeout and worker fixes from the selected base.
2. `generate/route.ts` must retain the current generation/moderation/usage path
   and v3.7 Create Pin handoff. Product Save must not be introduced into that
   route.
3. `vercel.json`, package files and test registries must be regenerated or
   reconciled from the integrated tree, never copied wholesale from the v3.7
   branch. `vercel.json` is not a pairwise text conflict in this audit, but its
   install-command change still affects the integrated build.
4. Product count/access tests must continue proving a fixed Free set of ten and
   paid full-catalog access without changing Product facts by plan.
5. Create Pins prefill tests must preserve the independent handoff and must not
   make Save an implicit precondition or side effect.

## Runtime conflict resolution blueprint

The following is a semantic blueprint, not an authorization to merge. It is based
on direct blob-to-blob comparison of multichannel `a31dfb13` and final v3.7
functional `d2c13dd6`.

### `vibepin-product-supply.service`

Retain the existing preflight default, lock directory, wrapper-only `ExecStart`,
`KillMode=control-group`, `Restart=no` and resource priority. Replace the old
50-Pin runtime values with the PRD v3.7 contract:

- `VIBEPIN_SUPPLY_LIMIT=100`;
- category mix `29/22/29/20`;
- only Digital Products opted back into the reviewed excluded set;
- 720-hour source horizon;
- `VIBEPIN_SUPPLY_WRITE_LIMIT=50`;
- wrapper timeout `VIBEPIN_TIMEOUT_SECONDS=5400` and systemd timeout
  `TimeoutStartSec=6300`.

Keeping the old `3600/4200` pair or omitting the four launch-profile variables
would make the installed unit incompatible with the approved 100-source receipt.

### `backend/product_harvest.py`

The v3.7 blob preserves the multichannel Amazon-family domain rule byte-for-byte
and adds AliExpress/Shopee regional PDP rules plus bounded, whitelist-only,
single-hop commerce-shortlink resolution. The resolver rewrites an accepted
shortlink to the final PDP before canonical identity and never bypasses the PDP
gate. Start from the v3.7 semantics for this file; rerun both the multichannel
retailer tests and v3.7 shortlink/PDP/provenance tests.

### `backend/shop_the_look_expand.py`

The v3.7 side intentionally removes the older direct card-to-`pin_products`
writer and duplicate fallback. It delegates to the one shared `supply_core`,
drops card title/image/price before merchant revalidation, binds the expected
project before provider/database work, caps merchant candidates and writes, and
adds a complete per-Pin timeout around DOM work. Taking the old side would reopen
the fabricated-card-field and second-red-line-core defects. Begin from the v3.7
writer semantics; only reapply a later source-extraction change after proving it
does not bypass `_apply_via_core`, the 50-row cap or exact receipt accounting.

### `web/src/app/api/generate/route.ts`

Do not take the v3.7 file wholesale. Relative to multichannel, it would remove
the current usage allowance/ledger flow, AI-cost accounting and parts of worker
and inline settlement. The integrated route must start from multichannel and
then preserve the v3.7 safety behavior:

- one authenticated identity threaded through moderation and dispatch;
- bounded structural validation of every user-controlled field;
- per-field plus composite moderation, including Product metadata titles;
- fail-closed rejection before worker enqueue, inline lock or provider dispatch;
- Product Create Pin handoff fields accepted without any Product Save call.

If the shared `generationModeration.ts` extraction is retained, imports and tests
must move without deleting multichannel's `usage/meterGeneration` and AI-cost
paths. This conflict requires line-by-line integration and the combined moderation,
usage, worker, Product handoff and production-build tests.

### `web/src/lib/server/shopify/connectPrep.ts`

The two independently-added files are behaviorally equivalent in the audited
diff: v3.7 adds comments, formatting and local variables but keeps the same config,
domain, active-store, plan-limit, state-seal and error outcomes. Prefer the frozen
integration base version and avoid unrelated churn; prove both Shopify route tests
still use the shared helper.

### `web/package.json` and lockfile

Do not replace the multichannel package file. It contains additional Facebook,
plan, usage, scheduling, fan-out and database test commands plus metering runtime
dependencies. Preserve that superset and add v3.7's `verify:product-truth` command.
The two lines also differ on the exact Next/eslint/undici versions; resolve those
only by one clean `npm ci`, TypeScript run, registered tests and production build
against the integrated lockfile. Never hand-edit the lockfile or treat a v3.7-only
build as proof for the integrated dependency tree.

### Conflict tests

Merge test intent rather than snapshots of either side. The final tests must prove:

- Product Supply uses the shared core, merchant evidence, 100/50/20 bounds and
  correct timeout hierarchy;
- retailer/PDP fixes and all run-worker routes remain registered;
- the complete generation moderation and multichannel metering paths coexist;
- admin's moderation-gate test follows the final shared/private helper boundary;
- Shopify connect behavior is unchanged.

## Mandatory integrated-candidate gates

Before any Preview deploy:

1. Freeze and record the exact parent SHAs and merge/cherry-pick order.
2. Recompute merge-tree conflicts; review every resolved production hunk.
3. Run the complete backend suite. The current v3.7 docs/test head independently
   passed `1054 passed, 2 skipped, 77 subtests`.
4. Run the exact integrated Web TypeScript, registered test, i18n and production
   build gates; prior v3.7-only numbers cannot validate the integrated tree.
5. Re-run v3.7 release/manifest automation and all multichannel/admin/reference
   candidate-specific gates.
6. Run a contamination scan and prove the integrated candidate includes every
   explicitly selected line and no unselected branch.
7. Keep v63, VPS files, services and timers untouched until the integrated Web
   candidate has passed the local gates.

After local gates, the production sequence remains: fresh <=900-second baseline,
v63 apply and post-apply/rollback proof, immutable Preview, authoritative browser
QA, bounded Admission canary, VPS byte/env/systemd checks, and only then the
separately authorized timer rollout.

## Verdict

```text
V3.7 FUNCTIONAL CODE: APPROVE
HISTORICAL INTEGRATED BRANCH: REJECT AS STALE
CURRENT INTEGRATED DEPLOY CANDIDATE: NOT BUILT
DIRECT VERCEL DEPLOY OF THE V3.7 BRANCH: BLOCK
CENTRAL DEPLOYMENT INTEGRATION: READY TO BEGIN AFTER USER AUTHORIZATION
```
