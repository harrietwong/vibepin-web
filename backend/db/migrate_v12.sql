-- ============================================================
-- Migration v12 — Enrich trend_opportunities_view with
--                 direct pin_samples linkage
--
-- Problem (v11): linked_pins_count and total_source_saves
-- both came exclusively from keyword_product_map, which is
-- only populated after calculate_product_scores.py runs.
-- Until that script runs, ALL evidence fields are 0, causing
-- every keyword to score as "unknown competition / low demand".
--
-- Fix: introduce a pin_direct CTE that aggregates pin_samples
-- rows via the already-populated trend_keyword_id FK.  This
-- gives us real save counts and pin counts even before the
-- product pipeline runs.
--
-- Precedence rule:
--   total_source_saves → kpm first (product-linked, higher quality),
--                        then pin_samples direct (always available)
--   linked_pins_count  → MAX of both sources
--
-- New column added:
--   direct_pin_count   — pins linked via trend_keyword_id (diagnostic)
--   weekly_change      — exposed from trend_keywords for scoring
--   search_volume_level already existed; now exposed explicitly
--
-- Safe to re-run (DROP + CREATE OR REPLACE).
-- ============================================================

DROP VIEW IF EXISTS trend_opportunities_view;

CREATE VIEW trend_opportunities_view AS

-- ── Direct pin linkage via pin_samples.trend_keyword_id ──────────────────
WITH pin_direct AS (
    SELECT
        trend_keyword_id                        AS keyword_id,
        COUNT(*)                                AS pin_count,
        COALESCE(SUM(save_count), 0)            AS total_saves
    FROM   pin_samples
    WHERE  trend_keyword_id IS NOT NULL
    GROUP BY trend_keyword_id
),

-- ── Per-keyword aggregates ────────────────────────────────────────────────
kw_stats AS (
    SELECT
        tk.id                                                       AS keyword_id,
        tk.keyword,
        tk.category,
        tk.yearly_change                                            AS pct_growth_yoy,
        tk.weekly_change,
        tk.search_volume_level,
        tk.priority_score,

        -- Product evidence (from keyword_product_map → requires pipeline)
        COUNT(DISTINCT kpm.product_id)                              AS linked_products_count,

        -- Pin count: take the larger of the two sources
        GREATEST(
            COALESCE(SUM(kpm.total_pins), 0),
            COALESCE(MAX(pd.pin_count),   0)
        )                                                           AS linked_pins_count,

        -- Saves: product-linked saves preferred; fall back to direct pin saves
        CASE
            WHEN COALESCE(SUM(kpm.total_saves), 0) > 0
                THEN SUM(kpm.total_saves)
            ELSE COALESCE(MAX(pd.total_saves), 0)
        END                                                         AS total_source_saves,

        -- Diagnostic: raw pin_samples count linked to this keyword
        COALESCE(MAX(pd.pin_count), 0)                              AS direct_pin_count,

        -- Score aggregates (from product pipeline)
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
        tk.id, tk.keyword, tk.category, tk.yearly_change, tk.weekly_change,
        tk.search_volume_level, tk.priority_score
)

SELECT
    ks.keyword_id,
    ks.keyword,
    ks.category,
    ks.pct_growth_yoy,
    ks.weekly_change,
    ks.search_volume_level,
    ks.priority_score,
    ks.linked_products_count,
    ks.linked_pins_count,
    ks.total_source_saves,
    ks.direct_pin_count,
    ks.opportunity_score,
    ks.avg_velocity_score,
    ks.avg_trend_score,
    ks.avg_freshness_score,
    ks.last_scored_at,

    -- score_tier (unchanged from v11)
    CASE
        WHEN ks.linked_products_count = 0 OR ks.opportunity_score IS NULL THEN 'low'
        WHEN ks.opportunity_score >= 70                                    THEN 'high'
        WHEN ks.opportunity_score >= 40                                    THEN 'medium'
        ELSE                                                                    'low'
    END::text AS score_tier,

    -- data_confidence — now respects direct pin linkage too
    CASE
        WHEN ks.linked_products_count >= 5
         AND ks.linked_pins_count     >= 10
         AND ks.total_source_saves    >= 50000 THEN 'high'
        WHEN ks.linked_products_count >= 2
         AND ks.linked_pins_count     >= 3
         AND ks.total_source_saves    >= 10000 THEN 'medium'
        WHEN ks.direct_pin_count      >= 3
         AND ks.total_source_saves    >= 5000  THEN 'medium'
        ELSE                                        'low'
    END::text AS data_confidence,

    -- confidence_reason
    CASE
        WHEN ks.linked_products_count = 0 AND ks.direct_pin_count = 0
            THEN 'no products or pins linked — run pipeline'
        WHEN ks.linked_products_count = 0 AND ks.direct_pin_count > 0
            THEN ks.direct_pin_count::text || ' direct pins · '
              || to_char(ks.total_source_saves, 'FM999,999,999')
              || ' saves — run pipeline to add products'
        WHEN ks.linked_products_count >= 5
         AND ks.linked_pins_count     >= 10
         AND ks.total_source_saves    >= 50000
            THEN ks.linked_products_count::text || ' products · '
              || ks.linked_pins_count::text       || ' pins · '
              || to_char(ks.total_source_saves, 'FM999,999,999') || ' saves'
        WHEN ks.linked_products_count >= 2
            THEN ks.linked_products_count::text || ' products · '
              || ks.linked_pins_count::text       || ' pins — expand for high confidence'
        WHEN ks.linked_pins_count < 3
            THEN 'only ' || ks.linked_pins_count::text
              || ' pin linkage(s) — crawl more keywords'
        WHEN ks.total_source_saves < 10000
            THEN to_char(ks.total_source_saves, 'FM999,999,999')
              || ' saves — below 10k threshold'
        ELSE 'insufficient data'
    END::text AS confidence_reason,

    -- top_product_ids (unchanged)
    (
        SELECT ARRAY_AGG(sub.pid::text)
        FROM (
            SELECT kpm2.product_id AS pid
            FROM   keyword_product_map kpm2
            LEFT JOIN product_scores psc2 ON psc2.product_id = kpm2.product_id
            WHERE  kpm2.keyword_id = ks.keyword_id
            ORDER BY COALESCE(psc2.opportunity_score, 0) DESC
            LIMIT 3
        ) sub
    ) AS top_product_ids

FROM kw_stats ks
ORDER BY COALESCE(ks.opportunity_score, ks.total_source_saves / 1000.0, 0) DESC;
