-- ============================================================
-- Migration v16 — Trend lifecycle classification
--
-- Adds two columns to trend_keywords:
--   trend_history   JSONB         52-week normalized (0-100) time series
--                                 from Pinterest Trends API; populated by
--                                 trend_fetcher.py --db when Layer 1 data
--                                 is available.
--   trend_lifecycle VARCHAR(20)   Computed lifecycle label, written by
--                                 classify_trends.py after trend_history
--                                 is populated.
--                                 Values: 'rising' | 'evergreen' | 'seasonal'
--                                         | 'unclear' (= use computed fallback)
--
-- Updates trend_opportunities_view to expose trend_lifecycle so the
-- frontend can use backend-computed labels instead of heuristic fallbacks.
--
-- Safe to re-run (ADD COLUMN IF NOT EXISTS + DROP/CREATE view).
-- ============================================================

ALTER TABLE trend_keywords
  ADD COLUMN IF NOT EXISTS trend_history   JSONB        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS trend_lifecycle VARCHAR(20)  DEFAULT NULL;

-- ── Recreate view (same logic as v15, adds trend_lifecycle passthrough) ──────

DROP VIEW IF EXISTS trend_opportunities_view;

CREATE VIEW trend_opportunities_view AS

WITH pin_direct AS (
    SELECT
        trend_keyword_id                        AS keyword_id,
        COUNT(*)                                AS pin_count,
        COALESCE(SUM(save_count), 0)            AS total_saves
    FROM   pin_samples
    WHERE  trend_keyword_id IS NOT NULL
    GROUP BY trend_keyword_id
),

kw_stats AS (
    SELECT
        tk.id                                                       AS keyword_id,
        tk.keyword,
        tk.category,
        tk.yearly_change                                            AS pct_growth_yoy,
        tk.weekly_change,
        tk.search_volume_level,
        tk.priority_score,
        tk.trend_lifecycle,

        COUNT(DISTINCT kpm.product_id)                              AS linked_products_count,

        GREATEST(
            COALESCE(SUM(kpm.total_pins), 0),
            COALESCE(MAX(pd.pin_count),   0)
        )                                                           AS linked_pins_count,

        CASE
            WHEN COALESCE(SUM(kpm.total_saves), 0) > 0
                THEN SUM(kpm.total_saves)
            ELSE COALESCE(MAX(pd.total_saves), 0)
        END                                                         AS total_source_saves,

        COALESCE(MAX(pd.pin_count), 0)                              AS direct_pin_count,

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
        tk.search_volume_level, tk.priority_score,
        tk.trend_lifecycle
),

kw_tiers AS (
    SELECT
        ks.*,

        CASE
            WHEN ks.pct_growth_yoy    >= 200
             AND (   ks.total_source_saves >= 5000
                  OR ks.search_volume_level = 'very_high')
             AND ks.linked_pins_count  <= 30                        THEN 'high'

            WHEN ks.pct_growth_yoy    >= 100
             AND (   ks.total_source_saves >= 500
                  OR ks.search_volume_level IN ('very_high', 'high', 'medium'))
             AND ks.linked_pins_count  <= 100                       THEN 'medium'

            WHEN ks.search_volume_level IN ('very_high', 'high')
             AND COALESCE(ks.weekly_change, 0) >= 0                 THEN 'medium'

            ELSE                                                         'low'
        END::text AS opportunity_tier,

        CASE
            WHEN ks.linked_products_count >= 5 THEN 'high'
            WHEN ks.linked_products_count >= 1 THEN 'medium'
            ELSE                                    'low'
        END::text AS monetization_confidence

    FROM kw_stats ks
)

SELECT
    kt.keyword_id,
    kt.keyword,
    kt.category,
    kt.pct_growth_yoy,
    kt.weekly_change,
    kt.search_volume_level,
    kt.priority_score,
    kt.trend_lifecycle,
    kt.linked_products_count,
    kt.linked_pins_count,
    kt.total_source_saves,
    kt.direct_pin_count,
    kt.opportunity_score,
    kt.avg_velocity_score,
    kt.avg_trend_score,
    kt.avg_freshness_score,
    kt.last_scored_at,

    kt.opportunity_tier,
    kt.monetization_confidence,
    kt.opportunity_tier                     AS score_tier,

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
ORDER BY
  -- Keywords with a pipeline-computed opportunity_score rank by that score.
  -- Keywords without pipeline data (score IS NULL) get a lifecycle-aware
  -- fallback so Rising/Seasonal/Evergreen surface above 'unclear' keywords.
  COALESCE(
    kt.opportunity_score,
    CASE kt.trend_lifecycle
      WHEN 'rising'    THEN LEAST(kt.total_source_saves / 100.0, 30) + 20
      WHEN 'seasonal'  THEN LEAST(kt.total_source_saves / 100.0, 25) + 15
      WHEN 'evergreen' THEN LEAST(kt.total_source_saves / 100.0, 20) + 10
      ELSE                  LEAST(kt.total_source_saves / 100.0, 15)
    END,
    0
  ) DESC;
