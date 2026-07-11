-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: add competition + interest-index columns to trend_keywords
-- Run once in Supabase SQL Editor.  Safe to re-run (IF NOT EXISTS / IF EXISTS).
--
-- Column naming contract
-- ──────────────────────
-- interest_index_estimate      — 0-100 normalised interest score derived from
--                                search_volume_level + trend_history.
--                                INTERNAL ONLY. Not displayed to users as search volume.
--
-- competition_sample_count     — Pin count observed in one sampled Pinterest search.
--                                This is a SAMPLE, not an official Pinterest total.
--                                INTERNAL ONLY. The UI shows only competition_level.
--
-- competition_index            — 0-100 log-scaled index computed from sample_count.
-- competition_level            — Low / Medium / High  (the only field shown in the UI).
-- competition_source           — "pinterest_search_sample" or "visual_count_estimate"
-- competition_confidence       — High / Medium / Low  (how reliable the sample was)
-- last_competition_enriched_at — Timestamp of the enrichment that wrote these fields.
-- ─────────────────────────────────────────────────────────────────────────────

-- Section A: Add new columns (correct names)
ALTER TABLE trend_keywords
  ADD COLUMN IF NOT EXISTS interest_index_estimate      numeric,
  ADD COLUMN IF NOT EXISTS competition_sample_count     integer,
  ADD COLUMN IF NOT EXISTS competition_index            numeric,
  ADD COLUMN IF NOT EXISTS competition_level            text
    CHECK (competition_level IS NULL OR competition_level IN ('Low', 'Medium', 'High')),
  ADD COLUMN IF NOT EXISTS competition_source           text,
  ADD COLUMN IF NOT EXISTS competition_confidence       text
    CHECK (competition_confidence IS NULL OR competition_confidence IN ('High', 'Medium', 'Low')),
  ADD COLUMN IF NOT EXISTS last_competition_enriched_at timestamptz;

-- Section B: If you already ran the OLD migration (which added competition_count,
--            search_volume_estimate, competition_scraped_at), rename them.
--            Skip this section if those columns do not exist.

DO $$
BEGIN
  -- rename competition_count → competition_sample_count (if old column exists)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trend_keywords' AND column_name = 'competition_count'
  ) THEN
    ALTER TABLE trend_keywords
      RENAME COLUMN competition_count TO competition_sample_count;
  END IF;

  -- rename search_volume_estimate → interest_index_estimate
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trend_keywords' AND column_name = 'search_volume_estimate'
  ) THEN
    ALTER TABLE trend_keywords
      RENAME COLUMN search_volume_estimate TO interest_index_estimate;
  END IF;

  -- rename competition_scraped_at → last_competition_enriched_at
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trend_keywords' AND column_name = 'competition_scraped_at'
  ) THEN
    ALTER TABLE trend_keywords
      RENAME COLUMN competition_scraped_at TO last_competition_enriched_at;
  END IF;
END $$;

-- Section C: Indexes
CREATE INDEX IF NOT EXISTS idx_trend_keywords_competition_level
  ON trend_keywords (competition_level)
  WHERE competition_level IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trend_keywords_enriched_at
  ON trend_keywords (last_competition_enriched_at DESC)
  WHERE last_competition_enriched_at IS NOT NULL;

-- Section D: Verification
SELECT
  COUNT(*)                                                       AS total_active,
  COUNT(competition_level)                                       AS has_competition_level,
  COUNT(*) FILTER (WHERE competition_level = 'Low')              AS comp_low,
  COUNT(*) FILTER (WHERE competition_level = 'Medium')           AS comp_medium,
  COUNT(*) FILTER (WHERE competition_level = 'High')             AS comp_high,
  COUNT(*) FILTER (WHERE competition_source = 'pinterest_search_sample') AS api_sourced,
  COUNT(*) FILTER (WHERE competition_source = 'visual_count_estimate')   AS visual_sourced
FROM trend_keywords
WHERE status = 'active';
