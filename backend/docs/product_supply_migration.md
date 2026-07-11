# Product Supply Migration — Legacy STL → Bootstrap v28

Status: **legacy STL retired as the production `pin_products` writer.**
Date: 2026-06-25. Target launch: ~2 weeks out. Correctness over speed.

## Summary

The legacy daily Shop-the-Look writer (`shop_the_look.py --db --limit 300`, driven
by `pipeline.py --step stl`) is **retired as a production `pin_products` writer**.
The supported writer is the **bootstrap v28 product-supply path**
(`run_worker.py --job product-supply-expand`, engine `shop-the-look`,
implemented in `shop_the_look_expand.py`).

### Why legacy STL was retired

* Re-scrapes the same saturated **global Top-N pins by `save_count` every day** →
  very low net-new yield (audit: ~20 net-new rows on a >4.5h run).
* Emits **legacy provenance**: `discovery_method='stl'`,
  `discovery_method_detail` NULL, `normalized_product_url_hash` NULL,
  `source_category` NULL.
* Uses **merge-upsert** (`resolution=merge-duplicates`) — can mutate existing rows.
* Two Pinterest navigations per pin, long sleeps, long timeouts; DB writes are not
  the bottleneck.

The bootstrap v28 path is insert-only (`ON CONFLICT DO NOTHING` on
`normalized_product_url_hash`), carries full provenance
(`discovery_method_detail='pinterest_product_card_bootstrap'`, `source_category`,
`discovery_path`, …), selects recency-scoped category-balanced source pins, and is
dry-run-by-default with a v28 schema check before apply.

## Data policy

* **Existing legacy rows are kept** as the historical Product Ideas backbone.
* **No legacy data deletion.**
* **No legacy backfill yet** (no recompute/write of `normalized_product_url_hash`,
  no change to `discovery_method_detail` on existing rows). Designed/documented for
  a later, separate task only — see "Later: legacy normalization" below.
* **No schema change** is required for this migration. v28 is already applied.

## Guards added (this migration)

* `shop_the_look.py`: `--db` **refuses by default** before any Pinterest navigation
  or writer-lock acquisition. Override (emergency/manual only) with
  `--allow-legacy-db-write` or env `VIBEPIN_ALLOW_LEGACY_STL_DB=1`. Dry-run
  (`--dry-run`) and non-`--db` runs are unaffected.
* `pipeline.py --step stl`: a real (writing) STL run is **skip-safe** (no subprocess,
  no Pinterest, no write) unless opted in with `--allow-legacy-stl` or env
  `VIBEPIN_ALLOW_LEGACY_STL=1`. When opted in, it propagates
  `--allow-legacy-db-write` to the child so both layers agree. Dry-run preflight is
  always allowed.

Both guard changes are applied in **both** trees that hold these files:
`D:\代码\Pinterest flow\backend` (source/dev + active crawl tasks) and
`C:\vibepinbackend` (legacy scheduled-task mirror).

## Current manual sequence (controlled apply)

Use the operator runner: `scripts/run_bootstrap_product_supply.py`.

1. **Wait** for any running legacy STL instance to finish naturally (do not kill).
2. **Preflight** — `py scripts/preflight_product_supply.py` (read-only). Must be
   `SAFE_FOR_DRY_RUN` / `SAFE_FOR_APPLY`; `WAIT`/`FAIL` → stop.
3. **Frozen dry-run** — `py scripts/run_bootstrap_product_supply.py`
   (dry-run is the default; requires `SAFE_FOR_DRY_RUN`). Review the report.
4. **Cooldown** — allow the documented cooldown after the last Pinterest activity.
5. **Preflight again** — must now be `SAFE_FOR_APPLY`.
6. **Controlled apply** —
   `py scripts/run_bootstrap_product_supply.py --apply --confirm APPLY_BOOTSTRAP_PRODUCTS`.
7. **Create Pins consistency report** — re-run the Product Ideas / Create Pins
   consistency check and confirm PASS.

### Runner defaults (current frozen run)

```
--source-report logs/product_supply_expand_shop_the_look_20260623_042058.json
--limit         50
--category-mix  fashion:18,womens-fashion:14,home-decor:18
--timeout-seconds 1200
```

## Rollback

* **Legacy scheduled task** (re-enable the old daily pipeline):
  `schtasks /Change /TN "VibePin Daily Pipeline" /Enable`
* **Emergency legacy DB write** (manual, deliberate):
  `py shop_the_look.py --db --allow-legacy-db-write`  (or set
  `VIBEPIN_ALLOW_LEGACY_STL_DB=1`), or via pipeline:
  `py pipeline.py --step stl --allow-legacy-stl` (or `VIBEPIN_ALLOW_LEGACY_STL=1`).

## Later: legacy normalization (separate, not done here)

A future **dry-run-first, duplicate-safe** backfill may, for existing legacy rows:

* set `discovery_method_detail='legacy_shop_the_look_daily'`,
* compute `normalized_product_url_hash`,
* infer `source_category` **only when confident**.

This must be its own task with its own dry-run + review. Not performed in this
migration. No existing rows are modified here.
