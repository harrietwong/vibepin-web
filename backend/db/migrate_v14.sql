-- migrate_v14.sql — Publish Jobs (Mock-ready, full RLS)
-- Upgrades the existing publish_jobs table from schema.sql v6:
--   + Adds missing columns (mock_board_id, pinterest_pin_url, retry_count)
--   + Sets platform default to 'pinterest'
--   + Replaces status check constraint with the 5-state enum
--   + Enables RLS + user-scoped policy
--   + Adds supporting indexes
--
-- Safe to run on a fresh DB (uses IF NOT EXISTS / IF EXISTS guards).
-- Run in Supabase SQL Editor or via psql.

-- ── 1. Add missing columns (idempotent) ──────────────────────────────────────

DO $$
BEGIN

  -- mock_board_id: replaces the generic board_id for Pinterest mock flow
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'publish_jobs' AND column_name = 'mock_board_id'
  ) THEN
    ALTER TABLE publish_jobs ADD COLUMN mock_board_id text;
  END IF;

  -- pinterest_pin_url: written back by Mock Worker after simulated publish
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'publish_jobs' AND column_name = 'pinterest_pin_url'
  ) THEN
    ALTER TABLE publish_jobs ADD COLUMN pinterest_pin_url text;
  END IF;

  -- retry_count: incremented by worker on transient failures
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'publish_jobs' AND column_name = 'retry_count'
  ) THEN
    ALTER TABLE publish_jobs ADD COLUMN retry_count integer NOT NULL DEFAULT 0;
  END IF;

  -- error_message: human-readable failure reason
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'publish_jobs' AND column_name = 'error_message'
  ) THEN
    ALTER TABLE publish_jobs ADD COLUMN error_message text;
  END IF;

  -- published_at: timestamp of successful mock publish
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'publish_jobs' AND column_name = 'published_at'
  ) THEN
    ALTER TABLE publish_jobs ADD COLUMN published_at timestamptz;
  END IF;

END $$;

-- ── 2. Defaults ───────────────────────────────────────────────────────────────

ALTER TABLE publish_jobs
  ALTER COLUMN platform SET DEFAULT 'pinterest';

ALTER TABLE publish_jobs
  ALTER COLUMN status SET DEFAULT 'scheduled';

-- ── 3. Status constraint — 5-state enum ──────────────────────────────────────
-- Drop any pre-existing check so we can redefine cleanly.

ALTER TABLE publish_jobs
  DROP CONSTRAINT IF EXISTS publish_jobs_status_check;

ALTER TABLE publish_jobs
  ADD CONSTRAINT publish_jobs_status_check
  CHECK (status IN ('scheduled', 'pending', 'sending', 'published', 'failed'));

-- Back-fill rows that used the old publishing_queue statuses
UPDATE publish_jobs
SET status = 'scheduled'
WHERE status NOT IN ('scheduled', 'pending', 'sending', 'published', 'failed');

-- ── 4. Row Level Security ─────────────────────────────────────────────────────

ALTER TABLE publish_jobs ENABLE ROW LEVEL SECURITY;

-- Each user can only see and modify their own jobs.
-- The API route uses the service role key to bypass RLS for writes on behalf of
-- the authenticated user, so the policy mainly guards direct client queries.
DROP POLICY IF EXISTS publish_jobs_user ON publish_jobs;
CREATE POLICY publish_jobs_user ON publish_jobs
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── 5. Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_pj_user_status
  ON publish_jobs (user_id, status, scheduled_at DESC);

CREATE INDEX IF NOT EXISTS idx_pj_asset
  ON publish_jobs (generated_asset_id);

-- ── Reference: complete target schema ────────────────────────────────────────
-- (For documentation / fresh-DB installs. Not executed by this migration.)
--
-- CREATE TABLE publish_jobs (
--   id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
--   user_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
--   asset_id           uuid        REFERENCES generated_assets(id)   ON DELETE SET NULL,
--   platform           text        NOT NULL DEFAULT 'pinterest',
--   mock_board_id      text,
--   scheduled_at       timestamptz NOT NULL DEFAULT now(),
--   status             text        NOT NULL DEFAULT 'scheduled'
--                        CHECK (status IN ('scheduled','pending','sending','published','failed')),
--   pinterest_pin_url  text,
--   error_message      text,
--   retry_count        integer     NOT NULL DEFAULT 0,
--   published_at       timestamptz,
--   created_at         timestamptz NOT NULL DEFAULT now()
-- );
