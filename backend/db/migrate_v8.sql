-- ============================================================
-- Migration v8 — Automated Intelligence Pipeline Tables
-- Safe to re-run (all use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
-- Run in Supabase SQL editor AFTER migrate_v7.sql
-- ============================================================

-- ── 1. trend_interests ────────────────────────────────────────────────────────
-- Stores all Pinterest Trends interest categories discovered at runtime.
-- Seeded from Pinterest's official 24-slug enum (L1InterestList in OpenAPI spec),
-- then kept current via interest_discovery.py on every pipeline run.
-- Code reads from this table at runtime — no hardcoded category dicts in scripts.

CREATE TABLE IF NOT EXISTS trend_interests (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    interest_slug   text        NOT NULL,
    interest_name   text,
    country         text        NOT NULL DEFAULT 'US',
    is_active       boolean     NOT NULL DEFAULT true,
    keyword_count   int         DEFAULT 0,       -- how many keywords were found last run
    last_seen_at    timestamptz,                  -- last time Pinterest returned data for this
    last_fetched_at timestamptz,                  -- last time we attempted a fetch
    created_at      timestamptz DEFAULT now(),
    UNIQUE (interest_slug, country)
);

-- ── 2. crawl_queue ────────────────────────────────────────────────────────────
-- Single work queue for all keyword crawl jobs, driven by trend discovery.
-- Decouples trend fetching from pin scraping — any source writes here,
-- the crawler reads here. No manual keyword lists feed this table.

CREATE TABLE IF NOT EXISTS crawl_queue (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    keyword         text        NOT NULL,
    source_interest text,                         -- which interest slug produced this keyword
    category        text,                         -- internal category label (home/fashion/beauty…)
    priority_score  numeric     DEFAULT 0,
    status          text        NOT NULL DEFAULT 'pending',
    attempts        int         NOT NULL DEFAULT 0,
    last_error      text,
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now(),
    UNIQUE (keyword)
);

-- ── 3. keyword_expansions ────────────────────────────────────────────────────
-- Typeahead-derived variants of each crawl_queue keyword.
-- Stored to avoid re-expanding the same seed on repeat runs.

CREATE TABLE IF NOT EXISTS keyword_expansions (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    seed_keyword     text        NOT NULL,
    expanded_keyword text        NOT NULL,
    source_interest  text,
    created_at       timestamptz DEFAULT now(),
    UNIQUE (seed_keyword, expanded_keyword)
);

-- ── 4. pin_samples additions ─────────────────────────────────────────────────
-- age_days and trend_stage computed at scrape time.
-- save_velocity already added in migrate_v4.sql.

ALTER TABLE pin_samples ADD COLUMN IF NOT EXISTS age_days    int;
ALTER TABLE pin_samples ADD COLUMN IF NOT EXISTS trend_stage text;

-- source_interest links a pin back to the Pinterest interest that generated it.
ALTER TABLE pin_samples ADD COLUMN IF NOT EXISTS source_interest text;

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Active interests sorted by staleness (drives pipeline scheduling)
CREATE INDEX IF NOT EXISTS idx_trend_interests_active
    ON trend_interests (last_fetched_at NULLS FIRST, interest_slug)
    WHERE is_active = true;

-- Pending queue items sorted by priority (crawler picks highest first)
CREATE INDEX IF NOT EXISTS idx_crawl_queue_pending
    ON crawl_queue (priority_score DESC, created_at ASC)
    WHERE status = 'pending';

-- Status lookup (pipeline queries by status + age)
CREATE INDEX IF NOT EXISTS idx_crawl_queue_status
    ON crawl_queue (status, updated_at DESC);

-- Trend stage lookup (frontend "emerging" / "growing" feeds)
CREATE INDEX IF NOT EXISTS idx_pin_samples_trend_stage
    ON pin_samples (trend_stage, save_velocity DESC NULLS LAST)
    WHERE trend_stage IS NOT NULL;

-- Source interest → pin join (keyword intelligence queries)
CREATE INDEX IF NOT EXISTS idx_pin_samples_source_interest
    ON pin_samples (source_interest)
    WHERE source_interest IS NOT NULL;

-- Expansion lookup (avoid re-expanding same seed)
CREATE INDEX IF NOT EXISTS idx_keyword_expansions_seed
    ON keyword_expansions (seed_keyword);
