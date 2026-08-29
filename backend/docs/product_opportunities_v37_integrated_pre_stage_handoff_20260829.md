# Product Opportunities v3.7 — Central integrated pre-stage handoff

Authority: `docs/prd/0825数据功能修改-VibePin_Product_Opportunities_PRD_v3.7_—_产品与技术执行版.md`.

This handoff does not authorize or claim a push, migration, deploy, promotion,
VPS/timer change or production database write. It defines the only currently
reviewed order if those external stages are separately initiated.

## Exact identity

- Branch: `codex/product-v37-central-integrate-0829`
- Production anchor: `5bcc1a6a0068347c6397b463c713aba82e45a6d9`
- Runtime and rollback candidate: `60a540f1f3ead08e112d378f3df778000c189abb`
- Runtime tree: `94b5994fdcd46077b0b52092238863c0896e37ea`
- Four-line merge: `385b9e07456007593572466f537f0e44bb8c0264`
- Selected admin: `27c70f90ec69bed64511efb98eb6827b5a427b5f`
- Selected reference: `68eebbd242889baf3205f2bc3c14396f560a0620`
- Selected multichannel: `4320a4daf0956b026d5707907841104939aec337`
- Selected v3.7: `cd21adfe357b572b10eddcecac51d59952203993`
- Integrated manifest:
  `backend/docs/product_opportunities_v37_integrated_release_manifest_60a540f1.json`
- Local verdict: `READY_FOR_PREVIEW_NOT_PRODUCTION`

The schema auditor must bind receipts to the immutable runtime candidate
`60a540f1...`, not the old standalone functional SHA `d2c13dd6...` and not a
docs/test-only branch tip. Immediately before handoff, freeze the final branch
tip, run the integrated manifest test from a clean checkout and recompute the
manifest file SHA-256 for the deployment receipt.

From the repository root, the mandatory zero-network/zero-write handoff preflight
is:

```powershell
$head = (git rev-parse HEAD).Trim()
$manifest = "backend/docs/product_opportunities_v37_integrated_release_manifest_60a540f1.json"
$manifestSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifest).Hash.ToLower()
py backend/scripts/preflight_product_opportunity_integrated_release.py `
  --repo-root . `
  --expected-head $head `
  --expected-branch codex/product-v37-central-integrate-0829 `
  --expected-manifest-sha256 $manifestSha
```

Require exit 0 and `PASS_READY_FOR_PREVIEW_HANDOFF`. The receipt must also say
`mutation=false`, `networkAccess=false`, `readyForProduction=false`, and contain
zero errors. This preflight does not make Preview or production ready by itself.

## Migration order and rollback identity

Forward order is exact:

1. `backend/db/migrate_v63_product_opportunities_v1.sql`
   SHA-256 `6de95674b286b71ce299eb298e28312a2a632e4e1d312cd3752e005ee6d8d3d1`
2. `backend/db/migrate_v66_creem_subscription_units.sql`
   SHA-256 `41cb068ab89f55cc887a68daef8921f6ef32f4f9e697efcb30a5da3c007d0de0`
3. `backend/db/migrate_v67_remove_connection_if_unscheduled.sql`
   SHA-256 `df0208cfc2087056ed78b16fa816ae423cafa6b4435d85fcc69bc9648a9752e3`

Rollback order is exact and reverse:

1. `backend/db/rollback_v67_remove_connection_if_unscheduled.sql`
   SHA-256 `2197fa7860f4642f6fb19aba0012090d2c201ce7fa913940c8e5ac635a1ae0f7`
2. `backend/db/rollback_v66_creem_subscription_units.sql`
   SHA-256 `6c93bf07f546d5ed476d354cddc625872fe75d8e40d80ac6c73b67bfd98fe0ba`
3. `backend/db/rollback_v63_product_opportunities_v1.sql`
   SHA-256 `bba932a49e65b7f7f9cf2c38ebaa89a751eab7719c9e17a923abd853acdb9e3c`

The v66 rollback is deliberately fail-closed. If any production row has
`units <> 1`, it raises P0001 before dropping the column and preserves all data.
Never edit quantities or force-drop the column to make rollback green. The v63
schema rollback is permitted only while every new v63 table remains empty. Once
an admitted Product exists, rollback retires exact returned IDs and preserves
Evidence/history; it does not drop the schema.

## Ordered execution gates

1. Re-resolve the final central branch tip and run the mandatory offline preflight.
   It must prove the clean checkout descends from the runtime candidate and all
   four frozen source lines. Re-run manifest/hash/ancestry,
   full backend, registered Web tests, TypeScript, i18n and production build.
2. Record the current legacy Supply timer/service state. Require the service
   inactive, both Product writer locks free and the next trigger at least 30
   minutes away. Do not manually start or enable any Product timer.
3. Refresh the completed-backup inventory and capture a GET-only legacy baseline
   no older than 900 seconds, bound to
   `--candidate-sha 60a540f1f3ead08e112d378f3df778000c189abb`.
4. Apply v63 only through the reviewed runner. Immediately run the exact
   post-apply catalog/security/legacy-integrity verifier against that same
   receipt and candidate SHA. Require every v63 table empty.
5. Apply v66, then read back the column type, NOT NULL/default contract and
   existing quantities. Stop if any value is inconsistent with the migration.
6. Apply v67, then read back the exact RPC signature/security/definition. Stop
   if the function differs from the reviewed migration.
7. Create an immutable Preview from the exact integrated candidate. Do not
   promote. Verify safe Prompt moderation and generation, Free fixed 10, paid
   full catalog, truthful null-name/image behavior, separate Pinterest/Product
   links, no internal status words, Save/Create Pin independence, refresh
   persistence, Pricing Coming soon and Checkout 503 `billing_disabled`.
8. Stage exact VPS bytes without enabling timers. Verify expected Supabase
   project refs, MODE/CONFIRM, ShellCheck, `systemd-analyze verify`, timeout
   hierarchy, locks, tree-kill and no orphan processes.
9. Run Product Supply dry-run at scan 100 / write cap 50 / atomic cap 20 with
   Physical and Digital reported separately. A dry-run is zero-write evidence,
   not a successful permanent receipt.
10. Run only the reviewed exact-ID Admission canary and rollback/readback proof.
    Then run Tracking canary across the complete Active catalog, independent of
    Saved Products. Require one canonical Pin/day snapshot and no negative metric
    fabricated from counter regression.
11. Promote Web only after authoritative browser QA. Enable Admission first;
    enable Tracking only after a successful Admission automatic receipt. Product
    Supply permanent scheduling remains scan 100 / write cap 50 / atomic cap 20.

## Stop and rollback

- Any mismatch, timeout, provider failure, HTTP 400/409, lock conflict, partial
  readback, false-success receipt or orphan process is a stop. Do not retry by
  widening budgets, skipping cooldowns or changing candidate identity.
- Before any admitted v63 row exists, reverse schema rollback is v67 -> v66 ->
  v63 and every step must be read back. Respect v66's quantity guard.
- After admission, do not drop v63. Retire only exact canary IDs and preserve
  Evidence, snapshots and lifecycle history.
- Web rollback restores the exact prior production deployment identity. It must
  not restore fabricated Product titles/images or legacy score UI.
- VPS rollback restores exact stored bytes and the recorded prior timer state.
  Never create a standalone classify timer.

## Data-quality launch gates

- Admission: real direct PDP, real non-Pinterest merchant image, auditable
  Pinterest Evidence, nullable honest name, exact Source Pin/category/seed and
  no active duplicate.
- Tracking: all Active Products, not Saved-only; one shared Pin fetch per UTC
  day; provider errors never become zero/not-found facts.
- Metrics: G30 and current/previous G7 require real anchors and valid-day/gap
  rules. Physical and Digital are calibrated independently.
- UI: Free receives exactly the stable 10 complete Products; paid receives the
  complete Active catalog; both see identical facts for the same Product.
- Demand/Trend controls and Fastest Growing remain hidden until each family has
  persisted >=70% valid G30+G7 coverage and an approved family calibration.

The full PRD P0 objective remains incomplete until the external stages above
produce authoritative receipts. `READY_FOR_PREVIEW_NOT_PRODUCTION` is the only
valid current launch claim.
