-- ═══════════════════════════════════════════════════════════════════════════
-- migrate_v48_detail_fetch_status_four_state
--   Corrective migration: pin_products.detail_fetch_status moves from the
--   3-value vocabulary shipped in v47 to the decision-maker's final 4-value one.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply via (the ONLY working DDL channel in this project):
--   python backend/scripts/run_migration.py --apply \
--       --sql db/migrate_v48_detail_fetch_status_four_state.sql
--
-- ── WHY THIS EXISTS (honest history) ─────────────────────────────────────────
-- migrate_v47_opportunity_discovery_model was authored and APPLIED with
--     CHECK (detail_fetch_status IN ('success','blocked','unavailable'))
-- The decision-maker then finalised a different, better vocabulary. Rather than
-- silently editing the already-applied v47 file (which would leave the repo lying
-- about what is actually in the database), v47 is left as the historical record and
-- this migration performs the correction.
--
-- ── THE CHANGE ───────────────────────────────────────────────────────────────
--   OLD (v47, applied):  success | blocked | unavailable
--   NEW (final):         available | blocked | not_found | not_attempted
--
--   semantic mapping:
--     success      → available       detail fetch succeeded; enrichment fields populated
--     blocked      → blocked         (unchanged) WAF / 403 / bot-wall
--     unavailable  → not_found       404 / delisted / no structured product data
--     (new)        → not_attempted   enrichment was never tried
--
-- ── DATA SAFETY: THIS IS A PURE CONSTRAINT SWAP ─────────────────────────────
-- detail_fetch_status was introduced by v47 minutes ago and NO writer has run since.
-- Verified immediately before authoring:
--     SELECT detail_fetch_status, count(*) FROM pin_products GROUP BY 1;
--     →  (NULL, 3574)          -- i.e. every row, no row carries any old value
-- So there is nothing to remap: zero rows change. The pre-flight below RE-VERIFIES
-- this at apply time and aborts the whole transaction if any legacy value has
-- appeared in the meantime (in which case a remap must be added deliberately, not
-- assumed). No product rows are touched. No UPDATE, no DELETE.
--
-- ── UI NOTE (not enforced here, recorded for the next reader) ───────────────
-- These four states are an INTERNAL diagnostic vocabulary, stored so the enrichment
-- pipeline can be optimised later. The product surface must NOT render them: every
-- non-'available' state shows the single user-facing string "Product details
-- unavailable". A missing product detail is never an error the user has to reason
-- about — the opportunity (pin + saves + trend + external link) is the asset.

BEGIN;

-- ── 0) PRE-FLIGHT: no row may carry a value outside the NEW vocabulary. ──────
-- Guards the assumption this migration is built on (all-NULL today). If a writer
-- has since written 'success'/'unavailable', we must NOT silently drop the old
-- CHECK and leave illegal values behind — abort and force a deliberate remap.
DO $$
DECLARE legacy_valued int;
BEGIN
  SELECT count(*) INTO legacy_valued
    FROM pin_products
   WHERE detail_fetch_status IS NOT NULL
     AND detail_fetch_status NOT IN ('available', 'blocked', 'not_found', 'not_attempted');

  IF legacy_valued > 0 THEN
    RAISE EXCEPTION
      'v48 preflight FAILED: % rows carry a detail_fetch_status outside the new 4-value vocabulary (expected 0 — the column was all-NULL when this migration was authored). A deliberate value remap (success→available, unavailable→not_found) must be added to this migration before it can be applied.',
      legacy_valued;
  END IF;

  RAISE NOTICE 'v48 preflight OK: 0 rows carry a legacy detail_fetch_status value.';
END $$;

-- ── 1) Swap the CHECK constraint to the final 4-value vocabulary. ────────────
ALTER TABLE pin_products
  DROP CONSTRAINT IF EXISTS pin_products_detail_fetch_status_check;

ALTER TABLE pin_products
  ADD CONSTRAINT pin_products_detail_fetch_status_check
  CHECK (detail_fetch_status IS NULL
         OR detail_fetch_status IN ('available', 'blocked', 'not_found', 'not_attempted'));

COMMENT ON COLUMN pin_products.detail_fetch_status IS
  'Honest outcome of the OPTIONAL product-detail enrichment fetch. INTERNAL diagnostic '
  'vocabulary — never rendered to users (the UI shows one string, "Product details '
  'unavailable", for every non-available state). '
  'available     = merchant page fetched and parsed; enrichment fields populated FROM IT. '
  'blocked       = WAF / 403 / bot-wall (Etsy, Depop, eBay …). The URL and the opportunity '
  '                are valid — only the details are unreachable. We do NOT render/JS-bypass. '
  'not_found     = 404 / delisted / page carries no structured product data. '
  'not_attempted = enrichment was never tried. '
  'NULL          = legacy row, predating enrichment tracking. '
  'This column exists so that "no product details" is a RECORDED FACT — never a reason to '
  'discard a real opportunity, and never an excuse to fabricate details. Etsy scoring '
  'Discovery=100% / Detail=0% is a fully ACCEPTABLE success state, not a defect: VibePin is '
  'a Pinterest Opportunity Discovery tool, not a product database.';

COMMIT;

-- ── POST-APPLY VERIFICATION (read-only) ─────────────────────────────────────
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid='pin_products'::regclass
--      AND conname='pin_products_detail_fetch_status_check';
--   -- expect: CHECK (detail_fetch_status IS NULL OR detail_fetch_status = ANY
--   --                (ARRAY['available','blocked','not_found','not_attempted']))
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
--   BEGIN;
--   ALTER TABLE pin_products DROP CONSTRAINT IF EXISTS pin_products_detail_fetch_status_check;
--   ALTER TABLE pin_products
--     ADD CONSTRAINT pin_products_detail_fetch_status_check
--     CHECK (detail_fetch_status IS NULL
--            OR detail_fetch_status IN ('success','blocked','unavailable'));
--   COMMIT;
--   -- (fails if any row already carries a new-vocabulary value — by design)
