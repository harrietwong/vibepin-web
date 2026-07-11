-- migrate_v29: TOTAL unique index on pin_products.normalized_product_url_hash
--              (REVIEW ONLY — DO NOT APPLY without explicit approval)
--
-- WHY THIS EXISTS
-- ---------------
-- The Shop-the-Look bootstrap apply writes via PostgREST:
--     insert_rows("pin_products", payload, on_conflict="normalized_product_url_hash")
--   → INSERT ... ON CONFLICT (normalized_product_url_hash) DO NOTHING
--
-- migrate_v28 created this index as a PARTIAL index:
--     CREATE UNIQUE INDEX ... ON pin_products (normalized_product_url_hash)
--       WHERE normalized_product_url_hash IS NOT NULL;
--
-- PostgREST emits a BARE conflict target (no WHERE predicate), so PostgreSQL
-- cannot infer a PARTIAL index and raises:
--     42P10 "there is no unique or exclusion constraint matching the
--            ON CONFLICT specification"
-- This is the confirmed root cause of the failed/zero-write apply runs.
--
-- THE FIX
-- -------
-- Replace the partial index with a TOTAL (non-partial) unique index of the SAME
-- name so the bare ON CONFLICT (normalized_product_url_hash) matches it.
--
-- Why a total unique index is safe here:
--   * In PostgreSQL, NULLs are DISTINCT in a unique index, so the existing rows
--     (all have NULL normalized_product_url_hash today) are unaffected — any
--     number of NULL rows remain allowed.
--   * Uniqueness is enforced only on real (non-NULL) hash values, which is
--     exactly the dedup guarantee the bootstrap apply needs.
--
-- A plain "CREATE UNIQUE INDEX IF NOT EXISTS" ALONE is NOT sufficient: if the
-- v28 partial index already exists under this name, IF NOT EXISTS would skip and
-- leave the incompatible partial index in place. Hence DROP-then-CREATE below.
--
-- GUARANTEES
--   * No data dropped. No columns altered. No rows backfilled or normalized.
--   * No legacy rows touched. Index objects only.
--   * Idempotent: safe whether the v28 partial index exists, the total index
--     already exists, or no index exists.
--
-- PRE-FLIGHT (run these READ-ONLY checks BEFORE applying this migration)
-- ---------------------------------------------------------------------
-- (1) Inspect existing indexes on the column:
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE schemaname = 'public'
--     AND tablename = 'pin_products'
--     AND indexdef ILIKE '%normalized_product_url_hash%';
--
-- (2) Duplicate-safety check — MUST return zero rows before creating a unique
--     index (a non-empty result would make CREATE UNIQUE INDEX fail):
--   SELECT normalized_product_url_hash, COUNT(*)
--   FROM pin_products
--   WHERE normalized_product_url_hash IS NOT NULL
--   GROUP BY normalized_product_url_hash
--   HAVING COUNT(*) > 1;

BEGIN;

-- Drop the incompatible partial index (no-op if it does not exist). This loses
-- nothing: today 0 rows have a non-NULL hash, so the index references no rows,
-- and it is unusable by the bare ON CONFLICT anyway.
DROP INDEX IF EXISTS idx_pin_products_normalized_product_url_hash;

-- Create the TOTAL (non-partial) unique index — compatible with PostgREST
-- on_conflict="normalized_product_url_hash".
CREATE UNIQUE INDEX IF NOT EXISTS idx_pin_products_normalized_product_url_hash
  ON pin_products (normalized_product_url_hash);

COMMIT;

-- POST-APPLY VERIFICATION (expect exactly one TOTAL unique index, no WHERE clause)
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE schemaname = 'public'
--     AND tablename = 'pin_products'
--     AND indexdef ILIKE '%normalized_product_url_hash%';
--   -- indexdef should read:
--   --   CREATE UNIQUE INDEX idx_pin_products_normalized_product_url_hash
--   --     ON public.pin_products USING btree (normalized_product_url_hash)
--   -- and MUST NOT contain "WHERE (normalized_product_url_hash IS NOT NULL)".

-- ROLLBACK (restores the original v28 PARTIAL index — note this re-introduces the
-- 42P10 incompatibility with the PostgREST bare ON CONFLICT; provided only to
-- restore the prior schema state, not as a working configuration):
--   BEGIN;
--   DROP INDEX IF EXISTS idx_pin_products_normalized_product_url_hash;
--   CREATE UNIQUE INDEX IF NOT EXISTS idx_pin_products_normalized_product_url_hash
--     ON pin_products (normalized_product_url_hash)
--     WHERE normalized_product_url_hash IS NOT NULL;
--   COMMIT;
