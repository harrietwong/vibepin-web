-- ── migrate_v36: Suggestion Rank for Pinterest search-dropdown expansions ─────
-- PRD v2.0 final (Phase 3): keyword_expansions rows are the REAL Pinterest
-- autocomplete suggestions for a seed keyword; `rank` stores the 1-based
-- position in the dropdown at crawl time (lower = nearer the top = stronger
-- search intent). Written by scraper_v2.upsert_keyword_expansions from now on;
-- historical rows keep rank = NULL and the UI simply omits the rank for them.
--
-- Apply via Supabase SQL Editor (raw :5432 is proxy-blocked from this machine).

ALTER TABLE keyword_expansions
    ADD COLUMN IF NOT EXISTS rank integer;

COMMENT ON COLUMN keyword_expansions.rank IS
    '1-based position of this suggestion in the Pinterest search dropdown at crawl time';

CREATE INDEX IF NOT EXISTS idx_keyword_expansions_seed_rank
    ON keyword_expansions (seed_keyword, rank);
