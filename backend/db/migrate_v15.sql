-- ============================================================
-- Migration v15 — Decouple opportunity_tier from monetization_confidence
--
-- Problem (v12/v11):
--   score_tier = 'low' whenever linked_products_count = 0, even for
--   high-growth / high-saves keywords that simply have not passed through
--   the Shop-the-Look step yet. This mislabels genuine BLUE OCEAN keywords
--   as HOT RED SEA purely because the product pipeline has not run.
--
-- Root cause:
--   The old guard "WHEN linked_products_count = 0 THEN 'low'" conflates two
--   independent questions:
--     (a) Is this keyword a good opportunity?     → trend + pin evidence
--     (b) Can we monetise it with product links?  → keyword_product_map
--
-- Fix — two new columns, one renamed alias:
--
--   opportunity_tier     — primary tier badge (BLUE OCEAN / EARLY TREND / HOT RED SEA)
--                          Uses only: pct_growth_yoy, weekly_change,
--                                     search_volume_level, total_source_saves,
--                                     linked_pins_count (saturation proxy)
--                          Zero dependency on keyword_product_map.
--
--   monetization_confidence — separate product-coverage signal
--                          high   : linked_products_count >= 5
--                          medium : linked_products_count 1–4
--                          low    : linked_products_count = 0
--
--   score_tier           — backward-compatible alias for opportunity_tier
--                          (frontend still reads this field; no API changes needed)
--
-- opportunity_tier thresholds:
--   'high'   BLUE OCEAN   pct_growth_yoy≥200
--                          AND (total_source_saves≥5 000 OR vol=very_high)
--                          AND linked_pins_count≤30   (not yet saturated)
--   'medium' EARLY TREND  pct_growth_yoy≥100
--                          AND (total_source_saves≥500 OR vol IN (very_high,high,medium))
--                          AND linked_pins_count≤100
--                       OR search_volume_level IN (very_high, high)
--                          AND weekly_change≥0         (still rising)
--   'low'    HOT RED SEA  everything else
--
-- All other columns, ORDER BY, and data_confidence are unchanged from v12.
-- Safe to re-run (DROP + CREATE OR REPLACE).
-- ============================================================

DROP VIEW IF EXISTS trend_opportunities_view;

CREATE VIEW trend_opportunities_view AS

-- ── Direct pin linkage via pin_samples.trend_keyword_id (v12, unchanged) ──
WITH pin_direct AS (
    SELECT
        trend_keyword_id                        AS keyword_id,
        COUNT(*)                                AS pin_count,
        COALESCE(SUM(save_count), 0)            AS total_saves
    FROM   pin_samples
    WHERE  trend_keyword_id IS NOT NULL
    GROUP BY trend_keyword_id
),

-- ── Per-keyword aggregates (unchanged from v12) ───────────────────────────
kw_stats AS (
    SELECT
        tk.id                                                       AS keyword_id,
        tk.keyword,
        tk.category,
        tk.yearly_change                                            AS pct_growth_yoy,
        tk.weekly_change,
        tk.search_volume_level,
        tk.priority_score,

        -- Product evidence (requires keyword_product_map / pipeline)
        COUNT(DISTINCT kpm.product_id)                              AS linked_products_count,

        -- Pin count: larger of kpm aggregate or direct FK count
        GREATEST(
            COALESCE(SUM(kpm.total_pins), 0),
            COALESCE(MAX(pd.pin_count),   0)
        )                                                           AS linked_pins_count,

        -- Saves: kpm preferred; falls back to direct pin saves
        CASE
            WHEN COALESCE(SUM(kpm.total_saves), 0) > 0
                THEN SUM(kpm.total_saves)
            ELSE COALESCE(MAX(pd.total_saves), 0)
        END                                                         AS total_source_saves,

        -- Diagnostic: raw pin_samples count linked to this keyword
        COALESCE(MAX(pd.pin_count), 0)                              AS direct_pin_count,

        -- Score aggregates (from product pipeline — may be NULL before pipeline runs)
        ROUND(AVG(psc.opportunity_score)::numeric,   1)             AS opportunity_score,
        ROUND(AVG(psc.save_velocity_score)::numeric, 1)             AS avg_velocity_score,
        ROUND(AVG(psc.trend_score)::numeric,         1)             AS avg_trend_score,
        ROUND(AVG(psc.freshness_score)::numeric,     1)             AS avg_freshness_score,
        MAX(psc.scored_at)                                          AS last_scored_at

    FROM trend_keywords tk
    LEFT JOIN keyword_product_map kpm ON kpm.keyword_id = tk.id
    LEFT JOIN product_scores psc      ON psc.product_id = kpm.product_id
    LEFT JOIN pin_direct pd           ON pd.keyword_id  = tk.id
    WHERE tk.status = 'active'
    GROUP BY
        tk.id, tk.keyword, tk.category,
        tk.yearly_change, tk.weekly_change,
        tk.search_volume_level, tk.priority_score
),

-- ── Tier computation (separated to avoid repeating CASE expressions) ──────
kw_tiers AS (
    SELECT
        ks.*,

        -- ── opportunity_tier ─────────────────────────────────────────────
        -- Derived purely from trend data + pin evidence.
        -- linked_products_count plays NO role here.
        CASE
            -- BLUE OCEAN: strong YoY + real demand signal + not yet saturated
            WHEN ks.pct_growth_yoy    >= 200
             AND (   ks.total_source_saves >= 5000
                  OR ks.search_volume_level = 'very_high')
             AND ks.linked_pins_count  <= 30                        THEN 'high'

            -- EARLY TREND: positive trend + some demand + room to grow
            WHEN ks.pct_growth_yoy    >= 100
             AND (   ks.total_source_saves >= 500
                  OR ks.search_volume_level IN ('very_high', 'high', 'medium'))
             AND ks.linked_pins_count  <= 100                       THEN 'medium'

            -- Volume-led EARLY TREND: high search vol + not falling weekly
            -- (handles keywords where YoY data is incomplete / NULL)
            WHEN ks.search_volume_level IN ('very_high', 'high')
             AND COALESCE(ks.weekly_change, 0) >= 0                 THEN 'medium'

            ELSE                                                         'low'
        END::text AS opportunity_tier,

        -- ── monetization_confidence ──────────────────────────────────────
        -- Tracks product-pipeline coverage independently.
        -- Frontend can show this as a secondary badge (e.g. "No products yet").
        CASE
            WHEN ks.linked_products_count >= 5 THEN 'high'
            WHEN ks.linked_products_count >= 1 THEN 'medium'
            ELSE                                    'low'
        END::text AS monetization_confidence

    FROM kw_stats ks
)

-- ── Final projection ──────────────────────────────────────────────────────
SELECT
    kt.keyword_id,
    kt.keyword,
    kt.category,
    kt.pct_growth_yoy,
    kt.weekly_change,
    kt.search_volume_level,
    kt.priority_score,
    kt.linked_products_count,
    kt.linked_pins_count,
    kt.total_source_saves,
    kt.direct_pin_count,
    kt.opportunity_score,
    kt.avg_velocity_score,
    kt.avg_trend_score,
    kt.avg_freshness_score,
    kt.last_scored_at,

    -- New: explicit tier columns
    kt.opportunity_tier,
    kt.monetization_confidence,
    -- Backward-compatible alias — frontend reads score_tier, no API change needed
    kt.opportunity_tier                     AS score_tier,

    -- data_confidence (unchanged from v12)
    CASE
        WHEN kt.linked_products_count >= 5
         AND kt.linked_pins_count     >= 10
         AND kt.total_source_saves    >= 50000 THEN 'high'
        WHEN kt.linked_products_count >= 2
         AND kt.linked_pins_count     >= 3
         AND kt.total_source_saves    >= 10000 THEN 'medium'
        WHEN kt.direct_pin_count      >= 3
         AND kt.total_source_saves    >= 5000  THEN 'medium'
        ELSE                                        'low'
    END::text AS data_confidence,

    -- confidence_reason (unchanged from v12)
    CASE
        WHEN kt.linked_products_count = 0 AND kt.direct_pin_count = 0
            THEN 'no products or pins linked — run pipeline'
        WHEN kt.linked_products_count = 0 AND kt.direct_pin_count > 0
            THEN kt.direct_pin_count::text || ' direct pins · '
              || to_char(kt.total_source_saves, 'FM999,999,999')
              || ' saves — run pipeline to add products'
        WHEN kt.linked_products_count >= 5
         AND kt.linked_pins_count     >= 10
         AND kt.total_source_saves    >= 50000
            THEN kt.linked_products_count::text || ' products · '
              || kt.linked_pins_count::text       || ' pins · '
              || to_char(kt.total_source_saves,   'FM999,999,999') || ' saves'
        WHEN kt.linked_products_count >= 2
            THEN kt.linked_products_count::text || ' products · '
              || kt.linked_pins_count::text       || ' pins — expand for high confidence'
        WHEN kt.linked_pins_count < 3
            THEN 'only ' || kt.linked_pins_count::text
              || ' pin linkage(s) — crawl more keywords'
        WHEN kt.total_source_saves < 10000
            THEN to_char(kt.total_source_saves, 'FM999,999,999')
              || ' saves — below 10k threshold'
        ELSE 'insufficient data'
    END::text AS confidence_reason,

    -- top_product_ids (unchanged from v12)
    (
        SELECT ARRAY_AGG(sub.pid::text)
        FROM (
            SELECT kpm2.product_id AS pid
            FROM   keyword_product_map kpm2
            LEFT JOIN product_scores psc2 ON psc2.product_id = kpm2.product_id
            WHERE  kpm2.keyword_id = kt.keyword_id
            ORDER BY COALESCE(psc2.opportunity_score, 0) DESC
            LIMIT 3
        ) sub
    ) AS top_product_ids

FROM kw_tiers kt
ORDER BY COALESCE(kt.opportunity_score, kt.total_source_saves / 1000.0, 0) DESC;
