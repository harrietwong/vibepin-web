-- ============================================================
-- Migration v19 — Add session_id to pin_generations
--
-- The frontend generates its own localStorage session ID (e.g.
-- "1700000000000_xk3m2p") that is used as the key in pinStore.
-- Without storing this on the row, DB-recovered history entries
-- get the DB's auto-generated UUID as their id, which never
-- matches pinStore keys — so all recovered entries show as
-- "Not added" even when their pins were added to the plan.
--
-- session_id is nullable so existing rows are unaffected.
-- Safe to re-run (ADD COLUMN IF NOT EXISTS).
-- ============================================================

ALTER TABLE pin_generations
    ADD COLUMN IF NOT EXISTS session_id text;

CREATE INDEX IF NOT EXISTS idx_pin_generations_session_id
    ON pin_generations (session_id)
    WHERE session_id IS NOT NULL;
