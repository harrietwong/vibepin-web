# Product Opportunities v3.7 — Pre-stage deployment handoff

Generated at `2026-08-29T07:58:22Z`. This is a read-only readiness handoff. It
does not authorize or claim a migration, deploy, promotion, timer change, or
production write.

## Exact release identity

- Branch: `codex/product-v37-manifest-b229`
- Functional commit: `d2c13dd6a4d1e79d0d247fa6cd09d68c04a15b5d`
- Documentation/manifest HEAD: `81b2ac1761a4ed0f38bf16b8ffb8046a62ce16db`
- Production integration base: `b22930ebe73847cf35bc44be789414902ae6b599`
- Release manifest:
  `backend/docs/product_opportunities_v37_release_manifest_d2c13dd.json`
- Manifest SHA-256:
  `8095ec7066e01ae57439a903809c05c47b26b28006680b3f1f52ec4f5db76c3c`
- Manifest boundary: 81 unique artifacts

Independent deployment-session verdict: `APPROVE` at the code layer and ready
for staged deployment. This is not a production-live verdict.

## Current production facts

Fresh Management API read-only baseline:

- Receipt:
  `backend/docs/product_opportunities_v37_stage1_legacy_baseline_20260829T075020Z.json`
- Receipt SHA-256:
  `d5163d467b1496115c2c74c3ee68f77deb6a2c2a713024889845f47ed96de169`
- Candidate binding: `d2c13dd6a4d1e79d0d247fa6cd09d68c04a15b5d`
- HTTP status: 201
- Verdict: PASS
- Mutation: false
- v63 matching objects: 0
- Legacy products: 4,115
- Legacy snapshots: 36,672
- Legacy products MD5: `4225202c49f1e726530425ee620e5ff6`
- Legacy snapshots MD5: `956471caff1d511418e500e0aaace122`

This receipt is pre-stage evidence only and is not cutover-eligible. It must be
replaced by a new receipt no older than 900 seconds immediately before an
authorized v63 migration. The snapshot count has already changed from the older
34,073-row evidence, proving that a stale receipt cannot be reused.

Fresh VPS read-only status at `2026-08-29T15:51:35+08:00`:

- Existing legacy `vibepin-product-supply.timer`: enabled and active
- Next legacy trigger: `2026-08-29 23:08:49 Asia/Shanghai`
- Supply service: inactive; prior result success; exit status 0
- Supply lock: free
- `pin_products` writer lock: free
- Matching Product-Supply processes: none
- systemd: 255
- v3.7 Admission and Tracking units remain absent/not deployed according to the
  latest byte-parity receipt; no current production fact proves otherwise.

The enabled legacy Supply timer discovers into the legacy pool. It is not proof
that v3.7 Admission, all-active Product Tracking, daily snapshots, G30/G7, Saved
Products, or the v3.7 Web catalog are live.

## Evidence still required

1. A fresh completed-backup inventory immediately before migration. The last
   known inventory proves a completed physical backup is locatable and WAL-G is
   enabled, but PITR is disabled and no restore was tested.
2. An immutable Web Preview for the exact release candidate. Chrome navigation
   and the in-app browser both failed to return authoritative page state during
   this audit. Preview/browser QA remains `NEEDS EVIDENCE`; no setting or page
   was treated as passed from a URL/title alone.
3. VPS staging of the exact runtime files, followed by byte hashes,
   `systemd-analyze verify`, ShellCheck, environment-target binding, and
   preflight-only service execution. Staging must not enable a new timer.

## Central deployment sequence

Only the central production deployment session should execute this sequence.
Stop immediately at the first failed gate.

1. Record the current state of the legacy Supply timer and service. Choose a
   window that cannot overlap its next trigger. If the deployment authority
   temporarily stops that timer, record its prior enabled/active state so the
   exact state can be restored.
2. Prove both Product writer locks are free and the Supply service is inactive.
3. Refresh the completed-backup inventory. Require a locatable completed backup;
   do not claim restore readiness because PITR is off and no restore was tested.
4. Generate a fresh Stage 1 baseline bound to functional commit
   `d2c13dd6a4d1e79d0d247fa6cd09d68c04a15b5d`. Require age <=900 seconds,
   `v63_matching_object_count=0`, exact legacy counts and exact legacy MD5 values.
5. Apply only
   `backend/db/migrate_v63_product_opportunities_v1.sql`, canonical LF SHA-256
   `6de95674b286b71ce299eb298e28312a2a632e4e1d312cd3752e005ee6d8d3d1`,
   through the reviewed migration runner with exact project-ref and confirmation
   binding. No other migration is part of this release.
6. Immediately execute the read-only post-apply verifier against the exact fresh
   baseline. Require every relation, constraint, partial unique index, trigger,
   policy, grant, RPC signature, sequence privilege, empty new-table count, and
   legacy count/MD5 invariant to pass.
7. If migration verification fails, do not admit a Product, deploy Web, or stage
   timers. Execute only the reviewed v63 rollback, re-run the baseline query, and
   require zero v63 objects plus unchanged legacy counts and MD5 values.
8. Create an immutable Preview from the exact candidate; do not promote. Verify
   Free sees exactly the fixed 10 complete Opportunities, paid access sees the
   full catalog, null names/images remain truthful, no retired technical words or
   old score/competition UI appears, Save is independent from Create Pin, and
   Create Pin does not create a Save. Any test write must use an authorized test
   account with exact-ID cleanup evidence.
9. Stage the VPS backend files without activation. Configure the exact expected
   Supabase project refs plus MODE/CONFIRM values only at their reviewed stage.
   Run byte-parity checks, ShellCheck and `systemd-analyze verify`. New Admission
   and Tracking timers must remain disabled; services begin in preflight mode.
10. Run zero-write Supply dry-run for the exact 100-Pin
    29/22/29/20 Fashion/Women's Fashion/Home/Digital mix. Then run only the
    reviewed exact-ID canary and verify its rollback/readback receipt before
    allowing regular admission.
11. Audit the first permanent v3.7 Supply run with
    `--require-scheduled-run --scheduled-profile launch-v37`. The default
    `physical-legacy` profile must not be used for the v3.7 launch receipt.
12. Enable stages separately: Admission first, then all-active Tracking only
    after a successful automatic Admission run. Verify the first timer-triggered
    execution of each; a manual start is not automatic-run evidence.
13. Promote the immutable Web deployment only after schema, backend canaries,
    truthful browser QA, and rollback references are all attached to the same
    release identity.

## Rollback boundaries

- Before v63 apply: no database rollback is needed; restore any intentionally
  paused legacy timer to its recorded prior state.
- After v63 apply but before any v3.7 Product admission: use the reviewed schema
  rollback and prove zero v63 objects plus unchanged legacy checksums.
- After a Product admission canary: roll back only the exact returned Product
  Opportunity IDs through the reviewed rollback RPC and verify retired history is
  preserved as designed.
- After VPS staging but before activation: discard the stage directory; do not
  touch live paths.
- After VPS activation: restore only files from the stage-specific backup
  manifest, run `daemon-reload`, verify hashes, and keep new timers disabled.
- After Web promotion: promote the previously recorded immutable truth-safe Web
  deployment; do not rebuild an unpinned branch as rollback.

## Hard stops

- No migration with a baseline older than 900 seconds.
- No migration while the legacy Supply service or either Product writer lock is
  active.
- No Preview promotion without authoritative browser QA.
- No Product apply without exact expected-project binding.
- No timer enable from a manual or transient receipt.
- No v3.7 Supply launch receipt without explicit `launch-v37` profile.
- No silent truncation of metric snapshot history. The present 36,672 snapshots
  remain a non-blocking capacity warning; windowing requires a design that still
  distinguishes stale history from no history.
