-- migrate_v45: Outbound-Link Product provenance columns on pin_products
--              (数据侧任务书 v1.1 §3 字段规范 / T2 准备段)
--
-- AUTHORED — NOT APPLIED. Run manually in the Supabase SQL Editor (raw :5432 is
-- proxy-blocked). Conventions follow v41/v40/v39: additive + idempotent
-- (IF NOT EXISTS), applied by hand, code degrades gracefully while unapplied.
-- This file makes NO writes to product rows — it only adds columns / a check
-- constraint / an index / comments, plus one OPTIONAL, gated backfill segment.
--
-- WHY THIS EXISTS
-- ---------------
-- T2 bounded apply will insert Outbound-Link product rows tagged
-- discovery_method='outbound_link'. The §3 field spec requires three fields that
-- are not yet fully provisioned for that flow:
--   1. discovery_method       — the column EXISTS (v27) but its CHECK constraint
--                               does NOT permit 'outbound_link' (only the older
--                               'outbound_link_bootstrap'). An insert with
--                               discovery_method='outbound_link' would fail the
--                               v27 constraint. This migration WIDENS the
--                               constraint to add 'outbound_link'.
--   2. source_pin_image_url   — MISSING. The image of the SOURCE Pin (lifestyle /
--                               outfit shot), kept distinct from image_url which
--                               holds the real PRODUCT image (§3 red line: source
--                               Pin image and product image never share a field).
--   3. source_pin_saves       — MISSING per §3. Saves on the SOURCE Pin.
--
-- LIVE-SCHEMA NOTES (probed read-only 2026-07-13, service role)
-- ------------------------------------------------------------
--   * pin_products currently has 3,474 rows: discovery_method 'stl'=2,676,
--     'outbound_link_bootstrap'=798, NULL=0. So the v27 backfill already ran and
--     NO rows have discovery_method IS NULL today (segment §4 below is a no-op in
--     practice — retained as documented optional per the task card).
--   * v28 columns are already applied (source_pin_id / source_pin_url /
--     source_category / seed_keyword / normalized_product_url_hash present).
--   * source_pin_save_count (v28) already exists and is semantically close to the
--     new source_pin_saves. They are NOT merged here: §3 names source_pin_saves as
--     its own field, and the legacy save_count / source_pin_save_count pair is
--     overloaded (see v30 notes). T2 will populate BOTH source_pin_save_count and
--     source_pin_saves with the same inherited source-Pin save value so existing
--     readers keep working and the §3-named field is authoritative.

-- ── 1) Widen the discovery_method CHECK to permit 'outbound_link' ─────────────
-- v27 created: CHECK (discovery_method IS NULL OR discovery_method IN
--   ('stl','outbound_link_bootstrap','manual_import','user_upload'))
-- We must add 'outbound_link'. DROP-then-ADD (IF EXISTS) so it is idempotent and
-- so re-running does not accumulate duplicate constraints. No existing row
-- violates the widened set, so the ADD validates cleanly.
ALTER TABLE pin_products
  DROP CONSTRAINT IF EXISTS pin_products_discovery_method_check;
ALTER TABLE pin_products
  ADD CONSTRAINT pin_products_discovery_method_check
  CHECK (discovery_method IS NULL OR discovery_method IN
         ('stl', 'outbound_link', 'outbound_link_bootstrap',
          'manual_import', 'user_upload'));

-- ── 2) Additive Outbound-Link source-Pin columns ─────────────────────────────
ALTER TABLE pin_products
  ADD COLUMN IF NOT EXISTS source_pin_image_url text,
  ADD COLUMN IF NOT EXISTS source_pin_saves     integer;

COMMENT ON COLUMN pin_products.discovery_method IS
  'Origin of the product row (reporting + integer-window rollback key). '
  'Allowed: stl | outbound_link | outbound_link_bootstrap | manual_import | user_upload. '
  'outbound_link = harvested from pin_samples.outbound_link into a real product '
  'detail page (T2 bounded apply); outbound_link_bootstrap = the earlier v27 batch.';

COMMENT ON COLUMN pin_products.source_pin_image_url IS
  'Image of the SOURCE Pin (the lifestyle / outfit / scene shot the outbound link '
  'was found on). MUST stay distinct from image_url, which holds the real PRODUCT '
  'image (§3: source Pin image and product image never share a field). NULL when '
  'unknown; never backfilled with the product image.';

COMMENT ON COLUMN pin_products.source_pin_saves IS
  'Saves on the SOURCE Pin (inherited evidence, never fabricated). Distinct from '
  'save_count / target_product_pin_save_count, which are Product-Pin metrics. For '
  'Outbound-Link rows there is usually no Product Pin, so product-side save fields '
  'stay NULL and this holds the only save signal.';

-- ── 3) Index on discovery_method for the batch rollback / reporting query ─────
-- v27 already created idx_pin_products_discovery_method (partial, WHERE NOT NULL).
-- IF NOT EXISTS makes this a no-op if that index is present; included so this
-- migration is self-contained if applied on a fresh DB.
CREATE INDEX IF NOT EXISTS idx_pin_products_discovery_method
  ON pin_products (discovery_method)
  WHERE discovery_method IS NOT NULL;

-- ── 4) OPTIONAL — backfill legacy Shop-the-Look rows to discovery_method='shop_the_look'
-- ─────────────────────────────────────────────────────────────────────────────
-- NOTE / DO NOT RUN BLINDLY. The task card asked for a Shop-the-Look backfill
-- UPDATE for rows with discovery_method IS NULL. On the LIVE DB (probed
-- 2026-07-13) there are ZERO such rows — v27 already labelled every legacy STL
-- row 'stl'. This segment is therefore:
--   (a) OPTIONAL and currently a no-op (matches 0 rows), and
--   (b) written against the value 'shop_the_look', which is NOT in the CHECK set
--       widened above. Do NOT run it as-is: it would either affect nothing (no
--       NULL rows) or, if any NULL row ever appears, VIOLATE the check
--       constraint. It is retained only to document the task-card request.
-- If a future decision truly wants the STL rows re-labelled 'shop_the_look',
-- FIRST add 'shop_the_look' to the CHECK set in §1, THEN run:
--
--   -- UPDATE pin_products
--   --    SET discovery_method = 'shop_the_look'
--   --  WHERE discovery_method IS NULL;
--
-- (Left commented; the live-correct label for existing STL rows is already 'stl'.)

-- ── POST-APPLY VERIFICATION (read-only) ──────────────────────────────────────
-- 1) Constraint permits the new value:
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conname = 'pin_products_discovery_method_check';
--   -- def MUST contain 'outbound_link'.
-- 2) New columns exist:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name='pin_products'
--     AND column_name IN ('source_pin_image_url','source_pin_saves');
-- 3) Smoke (does NOT need to insert): confirm no existing row violates the new
--    constraint (expect 0):
--   SELECT count(*) FROM pin_products
--   WHERE discovery_method IS NOT NULL
--     AND discovery_method NOT IN ('stl','outbound_link','outbound_link_bootstrap',
--                                  'manual_import','user_upload');
--
-- ── ROLLBACK (restore the v27 constraint + drop the two new columns) ──────────
--   BEGIN;
--   ALTER TABLE pin_products DROP CONSTRAINT IF EXISTS pin_products_discovery_method_check;
--   ALTER TABLE pin_products
--     ADD CONSTRAINT pin_products_discovery_method_check
--     CHECK (discovery_method IS NULL OR discovery_method IN
--            ('stl','outbound_link_bootstrap','manual_import','user_upload'));
--   ALTER TABLE pin_products DROP COLUMN IF EXISTS source_pin_image_url;
--   ALTER TABLE pin_products DROP COLUMN IF EXISTS source_pin_saves;
--   COMMIT;
--   -- (Only safe if no 'outbound_link' rows exist yet; run T2's DELETE-by-window
--   --  rollback FIRST if a batch was already applied.)
