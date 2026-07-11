-- ============================================================
-- Migration v11 — Rebuild trend_opportunities_view
--
-- Problem: v9 view joined via  ps.source_keyword = tk.keyword
-- which only matched ~9% of keywords because source_keywords were
-- broader search terms, not the exact trend keyword text.
--
-- Fix: route the join through keyword_product_map, which was
-- already correctly populated by calculate_product_scores.py
-- using a flexible keyword-text lookup.
--
-- New join path:
--   trend_keywords
--   → keyword_product_map  (kpm.keyword_id = tk.id)
--   → product_scores       (psc.product_id = kpm.product_id)
--
-- New fields vs v9:
--   linked_products_count  replaces total_products
--   linked_pins_count      replaces total_pins  (from kpm.total_pins sum)
--   total_source_saves     replaces total_saves (from kpm.total_saves sum)
--   avg_velocity_score     replaces avg_save_velocity
--   avg_trend_score        new
--   avg_freshness_score    new
--   score_tier             new  ('high' | 'medium' | 'low')
--   data_confidence        new  (evidence-based, NOT derived from score)
--   confidence_reason      new  (human-readable explanation)
--   top_product_ids        new  (text[], top 3 product UUIDs)
--   last_scored_at         new
--
-- Safe to re-run (CREATE OR REPLACE VIEW).
-- Requires: migrate_v9.sql (keyword_product_map, product_scores).
-- ============================================================

-- DROP required because CREATE OR REPLACE cannot rename existing columns.
-- No data is stored in a view — this is safe to run at any time.
DROP VIEW IF EXISTS trend_opportunities_view;

CREATE VIEW trend_opportunities_view AS
WITH kw_stats AS (
    SELECT
        tk.id                                                       AS keyword_id,
        tk.keyword,
        tk.category,
        tk.yearly_change                                            AS pct_growth_yoy,
        tk.search_volume_level,
        tk.priority_score,

        -- Evidence counts (from keyword_product_map, not text join)
        COUNT(DISTINCT kpm.product_id)                              AS linked_products_count,
        COALESCE(SUM(kpm.total_pins),  0)                           AS linked_pins_count,
        COALESCE(SUM(kpm.total_saves), 0)                           AS total_source_saves,

        -- Score aggregates across all products for this keyword
        ROUND(AVG(psc.opportunity_score)::numeric,   1)             AS opportunity_score,
        ROUND(AVG(psc.save_velocity_score)::numeric, 1)             AS avg_velocity_score,
        ROUND(AVG(psc.trend_score)::numeric,         1)             AS avg_trend_score,
        ROUND(AVG(psc.freshness_score)::numeric,     1)             AS avg_freshness_score,
        MAX(psc.scored_at)                                          AS last_scored_at

    FROM trend_keywords tk
    LEFT JOIN keyword_product_map kpm ON kpm.keyword_id = tk.id
    LEFT JOIN product_scores psc      ON psc.product_id = kpm.product_id
    WHERE tk.status = 'active'
    GROUP BY
        tk.id, tk.keyword, tk.category, tk.yearly_change,
        tk.search_volume_level, tk.priority_score
)
SELECT
    ks.keyword_id,
    ks.keyword,
    ks.category,
    ks.pct_growth_yoy,
    ks.search_volume_level,
    ks.priority_score,
    ks.linked_products_count,
    ks.linked_pins_count,
    ks.total_source_saves,
    ks.opportunity_score,
    ks.avg_velocity_score,
    ks.avg_trend_score,
    ks.avg_freshness_score,
    ks.last_scored_at,

    -- score_tier: opportunity signal strength (based on composite score)
    CASE
        WHEN ks.linked_products_count = 0 OR ks.opportunity_score IS NULL THEN 'low'
        WHEN ks.opportunity_score >= 70                                    THEN 'high'
        WHEN ks.opportunity_score >= 40                                    THEN 'medium'
        ELSE                                                                    'low'
    END::text AS score_tier,

    -- data_confidence: evidence depth (independent of opportunity_score)
    -- High:   5+ products, 10+ pin linkages, 50k+ saves
    -- Medium: 2+ products, 3+ pin linkages, 10k+ saves
    -- Low:    anything below medium
    CASE
        WHEN ks.linked_products_count >= 5
         AND ks.linked_pins_count     >= 10
         AND ks.total_source_saves    >= 50000 THEN 'high'
        WHEN ks.linked_products_count >= 2
         AND ks.linked_pins_count     >= 3
         AND ks.total_source_saves    >= 10000 THEN 'medium'
        ELSE                                        'low'
    END::text AS data_confidence,

    -- confidence_reason: one-line human-readable evidence summary
    CASE
        WHEN ks.linked_products_count = 0
            THEN 'no products linked — run pipeline --step stl'
        WHEN ks.linked_products_count >= 5
         AND ks.linked_pins_count     >= 10
         AND ks.total_source_saves    >= 50000
            THEN ks.linked_products_count::text || ' products · '
              || ks.linked_pins_count::text       || ' pins · '
              || to_char(ks.total_source_saves, 'FM999,999,999') || ' saves'
        WHEN ks.linked_products_count >= 2
         AND ks.linked_pins_count     >= 3
         AND ks.total_source_saves    >= 10000
            THEN ks.linked_products_count::text || ' products · '
              || ks.linked_pins_count::text       || ' pins — expand data for high confidence'
        WHEN ks.linked_pins_count < 3
            THEN 'only ' || ks.linked_pins_count::text
              || ' source pin linkage(s) — crawl more keywords'
        WHEN ks.total_source_saves < 10000
            THEN to_char(ks.total_source_saves, 'FM999,999,999')
              || ' saves — below 10k threshold'
        ELSE 'insufficient data'
    END::text AS confidence_reason,

    -- top_product_ids: top 3 product UUIDs by opportunity_score for this keyword
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
ORDER BY COALESCE(ks.opportunity_score, 0) DESC;
