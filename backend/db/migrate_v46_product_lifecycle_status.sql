-- migrate_v46: Product row lifecycle / soft-retirement columns on pin_products
--              (数据侧任务书 v1.1 T10 阶段 2 — 历史 outbound 脏数据整批软退役)
--
-- Applied via: python backend/scripts/run_migration.py --apply --sql db/migrate_v46_product_lifecycle_status.sql
-- (Management API over HTTPS — raw :5432 / pooler are proxy-blocked in this
--  environment. This is the ONLY working DDL channel for the project.)
--
-- Conventions follow v45/v41/v40: additive + idempotent (IF NOT EXISTS), safe to
-- re-run, code degrades gracefully while unapplied. This DDL segment makes NO
-- writes to product rows — it only adds columns / an index / comments.
--
-- WHY THIS EXISTS
-- ---------------
-- pin_products holds 798 rows with discovery_method='outbound_link_bootstrap'
-- (the v27-era batch, created_at 2026-06-01 → 2026-07-09). T10 stage-1
-- (docs/审查报告/T10-脏数据评估-20260713.md) established, on the FULL 798 rows
-- (not a sample):
--   * image_url is i.pinimg.com on 798/798 — a Pinterest Pin screenshot, i.e. a
--     FAKE product image; 0 rows carry a real merchant-CDN product photo;
--   * save_count == source_pin_save_count on 798/798 — the SOURCE Pin's saves were
--     copied verbatim into the product-level save field;
--   * product_pin_id is NULL on 798/798 — so per §3 the product-side save_count
--     should have been NULL to begin with.
-- Salvage rate is only ~17.8% (Etsy is 70.4% of the batch and 403s every compliant
-- GET), far below the 50% repair threshold. Decision-maker approved retiring the
-- whole batch instead of repairing it.
--
-- WHAT "SOFT RETIREMENT" MEANS HERE (deliberate constraints)
-- ---------------------------------------------------------
--   * NO hard delete. The rows stay, fully intact, and stay queryable.
--   * discovery_method is NOT overwritten. The batch keeps its historical identity
--     ('outbound_link_bootstrap') so provenance, reporting and the T10 rollback key
--     all keep working. Retirement is expressed in a SEPARATE dimension.
--   * The evidence fields stay byte-for-byte untouched:
--       discovery_method / parent_pin_id / source_url / source_pin_save_count / created_at
--   * Production reads filter on `lifecycle_status IS DISTINCT FROM 'retired'`
--     (NULL-safe: legacy rows have NULL and remain visible).
--
-- No lifecycle/status/is_active/metadata column existed on pin_products before this
-- migration (live schema probed read-only 2026-07-13: 47 columns, none of them a
-- lifecycle carrier), so there was nothing to reuse — hence the four new columns.

-- ── 1) Lifecycle columns ─────────────────────────────────────────────────────
-- NULL semantics (chosen deliberately over a DEFAULT 'active'):
--   lifecycle_status IS NULL  → the row was never touched by a lifecycle action.
--                               It is ACTIVE. This is the state of all 3,376
--                               pre-existing non-T10 rows and of every row future
--                               writers insert without setting the column, so no
--                               backfill and no writer change is needed.
--   lifecycle_status='retired' → soft-retired. MUST NOT surface in any product
--                               surface (list / detail / picker / saved / counts).
-- Readers therefore use `lifecycle_status IS DISTINCT FROM 'retired'`, which is
-- NULL-safe and treats NULL as active. A plain `<> 'retired'` would WRONGLY drop
-- every NULL row — do not use it.
ALTER TABLE pin_products
  ADD COLUMN IF NOT EXISTS lifecycle_status     text,
  ADD COLUMN IF NOT EXISTS retired_at           timestamptz,
  ADD COLUMN IF NOT EXISTS retirement_reason    text,
  ADD COLUMN IF NOT EXISTS retirement_batch_id  text;

-- Constrain the vocabulary so a typo can never silently un-retire / mis-retire a row.
ALTER TABLE pin_products
  DROP CONSTRAINT IF EXISTS pin_products_lifecycle_status_check;
ALTER TABLE pin_products
  ADD CONSTRAINT pin_products_lifecycle_status_check
  CHECK (lifecycle_status IS NULL OR lifecycle_status IN ('active', 'retired'));

COMMENT ON COLUMN pin_products.lifecycle_status IS
  'Row lifecycle, orthogonal to discovery_method (which stays the provenance field). '
  'NULL = never touched by a lifecycle action = ACTIVE (the default for all existing '
  'and future rows). ''retired'' = soft-retired: kept in the table for evidence but '
  'MUST NOT surface in any product surface. Production reads filter with '
  '"lifecycle_status IS DISTINCT FROM ''retired''" (NULL-safe).';

COMMENT ON COLUMN pin_products.retired_at IS
  'When the row was soft-retired (now() at retirement). NULL for active rows.';

COMMENT ON COLUMN pin_products.retirement_reason IS
  'Machine-readable reason code for the retirement, e.g. '
  '''t10_low_salvage_rate_and_unrecoverable_product_fields''. NULL for active rows.';

COMMENT ON COLUMN pin_products.retirement_batch_id IS
  'Retirement batch key, so a batch can be reported on and rolled back as a unit '
  '(e.g. ''T10''). NULL for active rows.';

-- ── 2) Index for the read filter + batch reporting/rollback ──────────────────
-- Partial: only retired rows are indexed. The hot path
-- (lifecycle_status IS DISTINCT FROM 'retired') is a wide, low-selectivity scan
-- that the planner serves fine from the existing indexes; what benefits from an
-- index is finding/rolling back the retired minority.
CREATE INDEX IF NOT EXISTS idx_pin_products_lifecycle_retired
  ON pin_products (lifecycle_status)
  WHERE lifecycle_status = 'retired';

CREATE INDEX IF NOT EXISTS idx_pin_products_retirement_batch
  ON pin_products (retirement_batch_id)
  WHERE retirement_batch_id IS NOT NULL;

-- ── POST-APPLY VERIFICATION (read-only) ──────────────────────────────────────
-- 1) Columns exist:
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name='pin_products'
--      AND column_name IN ('lifecycle_status','retired_at','retirement_reason','retirement_batch_id');
-- 2) Nothing is retired yet (this DDL retires NOTHING — expect 0):
--   SELECT count(*) FROM pin_products WHERE lifecycle_status='retired';
-- 3) Every pre-existing row is still active (NULL) — expect 3,574:
--   SELECT count(*) FROM pin_products WHERE lifecycle_status IS NULL;
--
-- ── THE T10 RETIREMENT UPDATE IS NOT IN THIS FILE ────────────────────────────
-- The 798-row UPDATE is applied separately, keyed on the exact id list captured in
-- backend/tools/t10_retire_snapshot.json (NOT on a broad predicate), by
-- backend/tools/t10_retire_apply.py. Shape:
--
--   UPDATE pin_products
--      SET lifecycle_status    = 'retired',
--          retired_at          = now(),
--          retirement_reason   = 't10_low_salvage_rate_and_unrecoverable_product_fields',
--          retirement_batch_id = 'T10'
--    WHERE id IN (<the 798 snapshot ids>);
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- Un-retire the T10 batch (data-level; leaves the columns in place):
--   UPDATE pin_products
--      SET lifecycle_status=NULL, retired_at=NULL,
--          retirement_reason=NULL, retirement_batch_id=NULL
--    WHERE retirement_batch_id = 'T10';
--   -- or, id-exact, from the snapshot: ... WHERE id IN (<the 798 snapshot ids>);
--
-- Drop the schema addition entirely (only after the data rollback above):
--   BEGIN;
--   DROP INDEX IF EXISTS idx_pin_products_retirement_batch;
--   DROP INDEX IF EXISTS idx_pin_products_lifecycle_retired;
--   ALTER TABLE pin_products DROP CONSTRAINT IF EXISTS pin_products_lifecycle_status_check;
--   ALTER TABLE pin_products
--     DROP COLUMN IF EXISTS lifecycle_status,
--     DROP COLUMN IF EXISTS retired_at,
--     DROP COLUMN IF EXISTS retirement_reason,
--     DROP COLUMN IF EXISTS retirement_batch_id;
--   COMMIT;
