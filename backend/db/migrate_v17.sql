-- ============================================================
-- Migration v17 — Pin Generations history table
--
-- Adds pin_generations table so the Studio "Generation History"
-- drawer persists across sessions, browsers, and devices.
--
-- Each row = one complete generation session (one or more images
-- produced by a single Generate button press).
--
-- Frontend inserts a row after handleGenerate() succeeds.
-- Row-Level Security: users can only see and insert their own rows.
--
-- Safe to re-run (CREATE TABLE IF NOT EXISTS).
-- ============================================================

CREATE TABLE IF NOT EXISTS pin_generations (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    keyword       text        NOT NULL DEFAULT '',
    category      text        NOT NULL DEFAULT '',
    source        text        NOT NULL DEFAULT 'workspace',  -- plan | workspace | batch | storage
    ref_urls      text[]      NOT NULL DEFAULT '{}',         -- reference image URLs used
    pin_urls      text[]      NOT NULL DEFAULT '{}',         -- flat list of all generated image URLs
    groups_json   jsonb       NOT NULL DEFAULT '[]',         -- [{refUrl,images:[]}] grouped by reference
    ref_count     integer     NOT NULL DEFAULT 1,
    product_count integer     NOT NULL DEFAULT 0,
    total_pins    integer     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pin_generations_user_created
    ON pin_generations (user_id, created_at DESC);

ALTER TABLE pin_generations ENABLE ROW LEVEL SECURITY;

-- Users may only read their own rows
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'pin_generations' AND policyname = 'pin_generations_select_own'
  ) THEN
    CREATE POLICY pin_generations_select_own
      ON pin_generations FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- Users may only insert their own rows
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'pin_generations' AND policyname = 'pin_generations_insert_own'
  ) THEN
    CREATE POLICY pin_generations_insert_own
      ON pin_generations FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;
