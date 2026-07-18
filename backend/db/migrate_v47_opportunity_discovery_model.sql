-- ═══════════════════════════════════════════════════════════════════════════
-- migrate_v47_opportunity_discovery_model
--   VibePin is a Pinterest OPPORTUNITY DISCOVERY tool, not a product scraper.
--   This migration re-shapes pin_products so the schema encodes that product
--   positioning instead of fighting it.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Supersedes (and fully subsumes) the earlier, unapplied
--   backend/db/migrate_v47_lifecycle_aware_product_uniqueness.sql
-- Do not apply both. This file is the single v47.
--
-- Apply via (the ONLY working DDL channel in this project):
--   python backend/scripts/run_migration.py --apply \
--       --sql db/migrate_v47_opportunity_discovery_model.sql
--
-- ── THE MODEL ────────────────────────────────────────────────────────────────
-- Pin → discover External Product URL → verify Pinterest user interest →
-- Opportunity → user clicks through to the merchant.
--
-- The asset is the EVIDENCE (which Pin, how many saves, which keyword/category,
-- which external URL). Product DETAILS are a nice-to-have enrichment. Therefore:
--
--   A. REQUIRED (Opportunity Evidence) — a row without these is not an
--      opportunity and must never exist:
--        parent_pin_id, source_pin_url, source_url (= external_product_url),
--        source_pin_save_count, source_category, seed_keyword,
--        discovery_method, lifecycle_status(implicit: NULL = active)
--
--   B. OPTIONAL (Product Details) — best-effort enrichment; NULL is a valid,
--      honest answer and must NEVER cause a legitimate opportunity to be dropped:
--        product_name, image_url, price, currency, merchant, availability
--
-- ── WHAT THIS MIGRATION CHANGES ──────────────────────────────────────────────
-- 1. product_name  NOT NULL → NULLABLE.
--      THE hard blocker for the new positioning. Etsy (and every other WAF-403
--      merchant) is a perfectly legitimate opportunity: the Pin is real, the
--      saves are real, the /listing/<id> URL is real — only the product DETAILS
--      are unreachable. Today the DB refuses the row, which forces the harvester
--      into exactly the behaviour that produced the 798 dirty T10 rows: invent a
--      product_name from the Pin title. Making the column nullable is what makes
--      "抓不到就 NULL，绝不猜测" expressible at all.
--
-- 2. NEW detail_fetch_status text CHECK (success | blocked | unavailable)
--      Honest, machine-readable record of WHY the enrichment fields are NULL.
--
--      >>> SUPERSEDED — DO NOT USE THIS VOCABULARY. <<<
--      This file was APPLIED with the 3-value set below, and then the decision-maker
--      finalised a different 4-value one. The correction lives in
--          migrate_v48_detail_fetch_status_four_state.sql
--      which swaps the CHECK to:  available | blocked | not_found | not_attempted
--      (mapping: success→available, unavailable→not_found, + new not_attempted).
--      v47 is left unedited as the honest historical record of what was applied.
--      The LIVE constraint is v48's. Read v48 for the authoritative semantics.
--
--      (as-applied by this file:)
--        success     — merchant page fetched + parsed; details present
--        blocked     — WAF / 403 / bot-wall (Etsy, Depop, eBay). URL is fine.
--        unavailable — 404 / delisted / page has no structured product data.
--      NULL = enrichment never attempted (e.g. legacy rows).
--
-- 3. NEW availability text
--      schema.org Offer.availability (InStock / OutOfStock / …) when the merchant
--      page truthfully provides it. Enrichment field → nullable, never inferred.
--
-- 4. Uniqueness becomes LIFECYCLE-AWARE (partial unique indexes).
--      Empirically established 2026-07-14 by the T2 pilot: a real 16-row insert
--      failed with
--        23505 duplicate key value violates unique constraint
--        "pin_products_parent_pin_id_source_url_key"
--        Key (parent_pin_id, source_url)=(5277724560265272,
--          https://www.amazon.com/dp/B0CQ4MGY5M/) already exists.
--      i.e. a RETIRED T10 row permanently blacklisted its own URL. "Soft" retirement
--      must mean the row survives as evidence while its URL stays re-collectable.
--      Both total unique constraints are therefore replaced with partial ones
--      predicated on  lifecycle_status IS DISTINCT FROM 'retired'  (NULL-safe:
--      NULL = never touched by a lifecycle action = ACTIVE).
--
--      NOTE on the hash index: all 798 retired rows currently carry
--      normalized_product_url_hash = NULL, and NULLs never collide in a Postgres
--      unique index — so that TOTAL index does not block coexistence TODAY. That
--      is an accident of the v27-era writer, not a guarantee, and it would fail
--      SILENTLY (writers use ON CONFLICT DO NOTHING). Made lifecycle-aware here so
--      the invariant holds by construction.
--
-- 5. Required-field integrity: a VALIDATED CHECK scoped to discovery_method =
--    'outbound_link' (the new T2 chain).
--
--    WHY THE DB LAYER AND NOT ONLY THE APP LAYER — and why scoped:
--      * DB layer is right for the A-fields because the whole point of the new
--        positioning is that evidence is the product. An evidence-less row is not
--        "a slightly worse row", it is a category error — and app-layer-only
--        guarantees have already failed once here (T10's 798 rows were written by
--        an app that "meant" to be honest). A constraint cannot be forgotten by
--        the next writer.
--      * SCOPED to outbound_link because the legacy corpora legitimately violate
--        it and must NOT be rewritten by a schema migration:
--            stl (2676 rows): 2186 have source_category NULL, 303 seed_keyword NULL
--            outbound_link_bootstrap (798, all retired): all 798 source_category NULL
--        A table-wide CHECK would either fail to build or force us to backfill/
--        mutate historical evidence. Both are unacceptable.
--      * Verified before authoring: all 100 existing discovery_method='outbound_link'
--        rows already satisfy every clause (0 NULL source_url / source_pin_url /
--        source_pin_save_count / source_category / seed_keyword), so the constraint
--        can be added VALIDATED with no data change.
--    The B-fields (product_name, image_url, price, currency, merchant, availability)
--    are deliberately left OUT of every constraint — that is the point of B.
--    The application layer (backend/tools/t2_harvest.py) additionally asserts the
--    A-fields before the INSERT, so the failure surfaces as a readable message
--    rather than a raw 23514. Belt AND braces: the app gives good errors, the DB
--    gives the guarantee.
--
-- ── SAFETY ───────────────────────────────────────────────────────────────────
-- * One transaction; fully idempotent (IF EXISTS / IF NOT EXISTS everywhere).
-- * Touches ZERO product rows: no UPDATE, no DELETE, no backfill.
-- * Additive-then-swap on the unique indexes: the partial index is built and
--   valid BEFORE the total constraint is dropped — there is never a window in
--   which duplicate ACTIVE rows could slip in.
-- * Pre-flight assertions abort the whole transaction if the data would violate
--   any new constraint, giving an actionable error instead of a raw 23505/23514.
-- * Relaxing NOT NULL cannot invalidate any existing row.
-- * Rollback section at the bottom.

BEGIN;

-- ═══ 0) PRE-FLIGHT ASSERTIONS ═══════════════════════════════════════════════
-- If any of these raise, NOTHING is applied (single transaction).

DO $$
DECLARE
  dup_pairs   int;
  dup_hashes  int;
  bad_outbound int;
BEGIN
  -- 0a) The lifecycle-aware uniqueness rule must ALREADY hold among ACTIVE rows,
  --     otherwise the partial index build would fail with an opaque 23505.
  SELECT count(*) INTO dup_pairs FROM (
    SELECT parent_pin_id, source_url
      FROM pin_products
     WHERE lifecycle_status IS DISTINCT FROM 'retired'
       AND parent_pin_id IS NOT NULL
       AND source_url IS NOT NULL
     GROUP BY 1, 2
    HAVING count(*) > 1
  ) d;

  SELECT count(*) INTO dup_hashes FROM (
    SELECT normalized_product_url_hash
      FROM pin_products
     WHERE lifecycle_status IS DISTINCT FROM 'retired'
       AND normalized_product_url_hash IS NOT NULL
     GROUP BY 1
    HAVING count(*) > 1
  ) d;

  IF dup_pairs > 0 OR dup_hashes > 0 THEN
    RAISE EXCEPTION
      'v47 preflight FAILED: % duplicate ACTIVE (parent_pin_id, source_url) pairs and % duplicate ACTIVE normalized_product_url_hash values. Reconcile the duplicates before applying.',
      dup_pairs, dup_hashes;
  END IF;

  -- 0b) The scoped required-evidence CHECK must already hold for every existing
  --     discovery_method='outbound_link' row, so it can be added VALIDATED
  --     without mutating a single row.
  SELECT count(*) INTO bad_outbound
    FROM pin_products
   WHERE discovery_method = 'outbound_link'
     AND (parent_pin_id         IS NULL
       OR source_pin_url        IS NULL
       OR source_url            IS NULL
       OR source_pin_save_count IS NULL
       OR source_category       IS NULL
       OR seed_keyword          IS NULL);

  IF bad_outbound > 0 THEN
    RAISE EXCEPTION
      'v47 preflight FAILED: % existing discovery_method=''outbound_link'' rows are missing required Opportunity Evidence fields. Inspect them before applying (this migration never rewrites historical rows).',
      bad_outbound;
  END IF;

  RAISE NOTICE 'v47 preflight OK: 0 active duplicates, 0 evidence-incomplete outbound_link rows.';
END $$;


-- ═══ 1) product_name → NULLABLE  (the core unblock) ═════════════════════════
ALTER TABLE pin_products
  ALTER COLUMN product_name DROP NOT NULL;

COMMENT ON COLUMN pin_products.product_name IS
  'ENRICHMENT (optional, may be NULL). The product title as read FROM THE MERCHANT '
  'PAGE (schema.org Product.name / og:title / <title>). It is NEVER the source Pin''s '
  'title — a Pin title is Pin data, not product data, and writing it here is what '
  'produced the 798 dirty T10 rows. If the merchant page cannot be fetched or parsed, '
  'this stays NULL and detail_fetch_status records why. A NULL product_name never '
  'invalidates the opportunity: the evidence (Pin + saves + external URL) is the asset.';


-- ═══ 2) NEW enrichment columns ══════════════════════════════════════════════
ALTER TABLE pin_products
  ADD COLUMN IF NOT EXISTS detail_fetch_status text,
  ADD COLUMN IF NOT EXISTS availability        text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'pin_products'::regclass
       AND conname  = 'pin_products_detail_fetch_status_check'
  ) THEN
    ALTER TABLE pin_products
      ADD CONSTRAINT pin_products_detail_fetch_status_check
      CHECK (detail_fetch_status IS NULL
             OR detail_fetch_status IN ('success', 'blocked', 'unavailable'));
  END IF;
END $$;

COMMENT ON COLUMN pin_products.detail_fetch_status IS
  'Honest outcome of the OPTIONAL product-detail enrichment fetch. '
  'success = merchant page fetched and parsed, detail fields populated from it. '
  'blocked = WAF / 403 / bot-wall (Etsy, Depop, eBay …) — the URL and the opportunity '
  'are valid, only the details are unreachable; we do NOT render/JS-bypass. '
  'unavailable = 404 / delisted / page carries no structured product data. '
  'NULL = enrichment never attempted (legacy rows). '
  'This column exists so "no product details" is a RECORDED FACT, never a reason to '
  'discard a real opportunity and never an excuse to fabricate details.';

COMMENT ON COLUMN pin_products.availability IS
  'ENRICHMENT (optional, may be NULL). schema.org Offer.availability as literally '
  'stated by the merchant page (e.g. InStock, OutOfStock, PreOrder). Never inferred, '
  'never defaulted — absent on the page means NULL here.';


-- ═══ 3) LIFECYCLE-AWARE UNIQUENESS (partial unique indexes) ═════════════════
-- Rule: uniqueness applies only among LIVE rows.
--   "at most one ACTIVE row per (parent_pin_id, source_url)"
--   "at most one ACTIVE row per normalized_product_url_hash"
-- Retired rows are EVIDENCE: exempt from uniqueness, never updated, never reused,
-- and legally coexist with a new active row carrying the same URL.

-- 3a) (parent_pin_id, source_url) — the constraint that blocked the T2 pilot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pin_products_active_parent_source_url
  ON pin_products (parent_pin_id, source_url)
  WHERE lifecycle_status IS DISTINCT FROM 'retired';

-- Drop the TOTAL constraint only AFTER its replacement exists and is valid.
-- (It is a CONSTRAINT, not a bare index — DROP INDEX on it would fail.)
ALTER TABLE pin_products
  DROP CONSTRAINT IF EXISTS pin_products_parent_pin_id_source_url_key;

COMMENT ON INDEX idx_pin_products_active_parent_source_url IS
  'Lifecycle-aware replacement for pin_products_parent_pin_id_source_url_key. Enforces '
  '"at most one ACTIVE row per (parent_pin_id, source_url)". Soft-retired rows are '
  'EXEMPT, so a retired T10 row can never blacklist its product URL against the clean '
  'T2 chain. Predicate is NULL-safe: lifecycle_status IS NULL means ACTIVE. Duplicate '
  'ACTIVE rows are still rejected exactly as before — this loosens nothing that matters.';

-- 3b) normalized_product_url_hash — same rule, so coexistence stops depending on
--     the accident that the retired rows happen to carry a NULL hash.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pin_products_active_normalized_url_hash
  ON pin_products (normalized_product_url_hash)
  WHERE lifecycle_status IS DISTINCT FROM 'retired'
    AND normalized_product_url_hash IS NOT NULL;

DROP INDEX IF EXISTS idx_pin_products_normalized_product_url_hash;

COMMENT ON INDEX idx_pin_products_active_normalized_url_hash IS
  'Lifecycle-aware replacement for the TOTAL unique index on normalized_product_url_hash. '
  'Retired rows exempt. WRITER WARNING: Postgres cannot infer a PARTIAL unique index from '
  'a bare column list, so ON CONFLICT (normalized_product_url_hash) DO NOTHING no longer '
  'matches this index. Writers must use a PLAIN INSERT and let a genuine collision surface '
  'as a loud 23505 — silently swallowing rows via ON CONFLICT DO NOTHING is precisely the '
  'failure mode we are engineering out.';


-- ═══ 4) REQUIRED OPPORTUNITY EVIDENCE (scoped, validated CHECK) ═════════════
-- Scoped to the new T2 chain (discovery_method='outbound_link'). Historical stl /
-- outbound_link_bootstrap corpora legitimately predate this rule and are NOT rewritten.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'pin_products'::regclass
       AND conname  = 'pin_products_outbound_evidence_check'
  ) THEN
    ALTER TABLE pin_products
      ADD CONSTRAINT pin_products_outbound_evidence_check
      CHECK (
        discovery_method IS DISTINCT FROM 'outbound_link'
        OR (
             parent_pin_id         IS NOT NULL
         AND source_pin_url        IS NOT NULL
         AND source_url            IS NOT NULL
         AND source_pin_save_count IS NOT NULL
         AND source_category       IS NOT NULL
         AND seed_keyword          IS NOT NULL
        )
      );
  END IF;
END $$;

COMMENT ON CONSTRAINT pin_products_outbound_evidence_check ON pin_products IS
  'Opportunity Evidence floor for the T2 discovery chain (discovery_method=''outbound_link''). '
  'An opportunity IS its evidence: which Pin (parent_pin_id, source_pin_url), how much real '
  'Pinterest demand (source_pin_save_count), which external product URL (source_url), and the '
  'keyword/category context that makes it actionable (seed_keyword, source_category). A row '
  'missing any of these is not a weak opportunity, it is not an opportunity — reject it. '
  'Deliberately says NOTHING about product_name / image_url / price / currency / merchant / '
  'availability: those are ENRICHMENT and are allowed to be NULL forever.';

COMMIT;


-- ═══ POST-APPLY VERIFICATION (read-only) ════════════════════════════════════
--   -- product_name must be nullable:
--   SELECT column_name, is_nullable FROM information_schema.columns
--    WHERE table_name='pin_products'
--      AND column_name IN ('product_name','detail_fetch_status','availability');
--   -- expect: product_name YES, detail_fetch_status YES, availability YES
--
--   SELECT indexname FROM pg_indexes
--    WHERE tablename='pin_products' AND indexdef ILIKE '%UNIQUE%';
--   -- expect present: pin_products_pkey, pin_products_product_pin_id_key,
--   --                 idx_pin_products_active_parent_source_url,
--   --                 idx_pin_products_active_normalized_url_hash
--   -- expect GONE:    pin_products_parent_pin_id_source_url_key,
--   --                 idx_pin_products_normalized_product_url_hash
--
--   SELECT conname FROM pg_constraint WHERE conrelid='pin_products'::regclass;
--   -- expect NEW: pin_products_detail_fetch_status_check,
--   --             pin_products_outbound_evidence_check
--
-- ═══ ROLLBACK ═══════════════════════════════════════════════════════════════
-- The uniqueness half is only safely reversible while NO "retired + active same-URL"
-- pair exists yet. Once the T2 re-collection batch is written, restoring the TOTAL
-- constraint WILL fail — by design: those pairs are the intended new state.
-- Restoring product_name NOT NULL likewise fails once any NULL-name (e.g. Etsy)
-- opportunity row exists — also by design.
--
--   BEGIN;
--   ALTER TABLE pin_products DROP CONSTRAINT IF EXISTS pin_products_outbound_evidence_check;
--   ALTER TABLE pin_products DROP CONSTRAINT IF EXISTS pin_products_detail_fetch_status_check;
--   ALTER TABLE pin_products DROP COLUMN IF EXISTS availability;
--   ALTER TABLE pin_products DROP COLUMN IF EXISTS detail_fetch_status;
--   DROP INDEX IF EXISTS idx_pin_products_active_parent_source_url;
--   DROP INDEX IF EXISTS idx_pin_products_active_normalized_url_hash;
--   ALTER TABLE pin_products
--     ADD CONSTRAINT pin_products_parent_pin_id_source_url_key
--     UNIQUE (parent_pin_id, source_url);
--   CREATE UNIQUE INDEX idx_pin_products_normalized_product_url_hash
--     ON pin_products (normalized_product_url_hash);
--   -- only if no NULL product_name rows exist:
--   ALTER TABLE pin_products ALTER COLUMN product_name SET NOT NULL;
--   COMMIT;
