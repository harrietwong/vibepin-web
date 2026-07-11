-- ============================================================
-- Migration v21 — Add setup_snapshot + prompt_full to pin_generations
--
-- setup_snapshot: JSONB column that stores the canonical session
--   setup at creation time — products, references (with visual
--   format metadata), prompt, mode, opportunity, etc.
--   This is the source of truth for the Generated Pins modal
--   left panel and is WRITE-ONCE (never overwritten by progress
--   updates).
--
-- prompt_full: TEXT column for the full generation prompt.
--   Previously only prompt_excerpt (first 120 chars) was stored.
--
-- groups_json rows now also include per-group visualFormat and
-- humanPresence fields written by the frontend — no schema change
-- needed for that (JSONB handles it gracefully).
--
-- Safe to re-run (IF NOT EXISTS / DO NOTHING patterns).
-- ============================================================

ALTER TABLE pin_generations
  ADD COLUMN IF NOT EXISTS prompt_full    TEXT,
  ADD COLUMN IF NOT EXISTS setup_snapshot JSONB;

-- Index for fast lookup when rehydrating the modal
CREATE INDEX IF NOT EXISTS idx_pin_gen_session_setup
  ON pin_generations (session_id)
  WHERE setup_snapshot IS NOT NULL;

-- Backfill prompt_full from prompt_excerpt for rows that have an
-- excerpt but no full prompt (best-effort — excerpt is already
-- truncated, but it's better than NULL for the UI fallback).
UPDATE pin_generations
SET    prompt_full = prompt_excerpt
WHERE  prompt_full IS NULL
  AND  prompt_excerpt IS NOT NULL;
