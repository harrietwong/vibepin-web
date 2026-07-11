-- ============================================================
-- Migration v20 — Backfill groups_json from pin_urls
--
-- Old rows in pin_generations were inserted before the frontend
-- reliably wrote groups_json. Those rows have groups_json = '[]'
-- (the column default) but do have pin_urls populated with the
-- flat list of generated image URLs.
--
-- This migration reconstructs a single-group groups_json entry
-- from pin_urls so the Studio History drawer can display thumbnails
-- for all past sessions, not just recent ones.
--
-- Rows that already have a non-empty groups_json are untouched.
-- Rows with groups_json = '[]' AND empty pin_urls are also skipped
-- (nothing to backfill).
--
-- Safe to re-run (WHERE clause is idempotent).
-- ============================================================

UPDATE pin_generations
SET groups_json = jsonb_build_array(
    jsonb_build_object(
        'refUrl',  null,
        'images',  to_jsonb(pin_urls)
    )
)
WHERE groups_json = '[]'::jsonb
  AND cardinality(pin_urls) > 0;
