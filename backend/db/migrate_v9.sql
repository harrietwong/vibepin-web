-- ============================================================
-- Migration v9 — Product Intelligence Layer
-- Tables: keyword_product_map, product_scores
-- View:   trend_opportunities_view
--
-- Safe to re-run (CREATE IF NOT EXISTS / CREATE OR REPLACE)
-- Run in Supabase SQL editor AFTER migrate_v8.sql
-- ============================================================

-- ── 1. keyword_product_map ────────────────────────────────────────────────────
-- Maps each trend_keyword to the pin_products reachable through pin_samples.
-- Join path:  trend_keywords.keyword
--             → pin_samples.seed_keyword / source_keyword
--             → pin_products.parent_pin_id
--
-- Populated and refreshed by calculate_product_scores.py.
-- One row per (keyword, product) pair — deduped on upsert.

CREATE TABLE IF NOT EXISTS keyword_product_map (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    keyword_id      uuid        NOT NULL REFERENCES trend_keywords(id) ON DELETE CASCADE,
    product_id      uuid        NOT NULL REFERENCES pin_products(id)   ON DELETE CASCADE,
    relevance_score numeric     DEFAULT 0,   -- weighted signal: total_saves / max_saves for keyword
    total_pins      int         DEFAULT 0,   -- # of pin_samples linking this (keyword, product) pair
    total_saves     bigint      DEFAULT 0,   -- sum of save_counts across those pins
    computed_at     timestamptz DEFAULT now(),
    UNIQUE (keyword_id, product_id)
);

-- ── 2. product_scores ─────────────────────────────────────────────────────────
-- One row per product. All sub-scores are 0-100.
--
-- opportunity_score formula (normalised 0-100):
--   40% × save_velocity_score   (source pin velocity; log10 scale, cap 1000/day)
--   30% × trend_score           (source keyword yearly_change; log10 scale, cap 500% YoY)
--   20% × freshness_score       (source pin age; linear decay over 90 days)
--   10% × product_density_score (# of products validated for this keyword; cap 10)
--
-- competition_score is stored separately for reference / filtering:
--   100 − product_density_score  (fewer competing products = higher score)

CREATE TABLE IF NOT EXISTS product_scores (
    id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id            uuid        NOT NULL UNIQUE REFERENCES pin_products(id) ON DELETE CASCADE,
    opportunity_score     numeric     DEFAULT 0,
    trend_score           numeric     DEFAULT 0,
    save_velocity_score   numeric     DEFAULT 0,
    freshness_score       numeric     DEFAULT 0,
    competition_score     numeric     DEFAULT 0,   -- inverse of density; high = low competition
    scored_at             timestamptz DEFAULT now()
);

-- ── 3. trend_opportunities_view ───────────────────────────────────────────────
-- Aggregates: keyword → pins → products → opportunity_score
-- One row per active trend_keyword. Used by /api/opportunities.

CREATE OR REPLACE VIEW trend_opportunities_view AS
SELECT
    tk.id                                                   AS keyword_id,
    tk.keyword,
    tk.category,
    tk.yearly_change                                        AS pct_growth_yoy,
    tk.search_volume_level,
    tk.priority_score,
    COUNT(DISTINCT ps.pin_id)                               AS total_pins,
    COUNT(DISTINCT pp.id)                                   AS total_products,
    COALESCE(SUM(ps.save_count), 0)                         AS total_saves,
    ROUND(AVG(ps.save_velocity)::numeric, 1)                AS avg_save_velocity,
    ROUND(AVG(psc.opportunity_score)::numeric, 1)           AS opportunity_score
FROM trend_keywords tk
LEFT JOIN pin_samples ps
    ON ps.seed_keyword    = tk.keyword
    OR ps.source_keyword  = tk.keyword
LEFT JOIN pin_products pp
    ON pp.parent_pin_id   = ps.pin_id
LEFT JOIN product_scores psc
    ON psc.product_id     = pp.id
WHERE tk.status = 'active'
GROUP BY
    tk.id,
    tk.keyword,
    tk.category,
    tk.yearly_change,
    tk.search_volume_level,
    tk.priority_score
ORDER BY opportunity_score DESC NULLS LAST;

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_kpm_keyword
    ON keyword_product_map (keyword_id);

CREATE INDEX IF NOT EXISTS idx_kpm_product
    ON keyword_product_map (product_id);

CREATE INDEX IF NOT EXISTS idx_kpm_relevance
    ON keyword_product_map (relevance_score DESC);

CREATE INDEX IF NOT EXISTS idx_product_scores_opportunity
    ON product_scores (opportunity_score DESC);

CREATE INDEX IF NOT EXISTS idx_product_scores_scored_at
    ON product_scores (scored_at DESC);
