-- ============================================================
-- Migration v5 — pin_products table
-- One-to-many: a single viral Pin can contain multiple
-- "Shop the Look" product cards.
--
-- Safe to re-run (uses IF NOT EXISTS throughout).
-- Run in Supabase SQL editor AFTER migrate_v4.sql.
-- ============================================================

CREATE TABLE IF NOT EXISTS pin_products (
    id                    uuid         PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Pinterest identifiers
    product_pin_id        text         UNIQUE,          -- Pinterest pin_id of the product card
    parent_pin_id         text         NOT NULL,         -- Pinterest pin_id of the source "Shop the Look" pin

    -- Product data
    product_name          text         NOT NULL,
    price                 numeric(10, 2),               -- NULL when not available / free
    currency              text         DEFAULT 'USD',
    source_url            text,                         -- outbound merchant landing page URL
    domain                text,                         -- e.g. 'etsy.com', 'www.target.com'
    merchant              text,                         -- display merchant name

    -- Visual
    image_url             text,

    -- Engagement signals (from Pinterest product pin)
    save_count            integer      DEFAULT 0,
    reaction_count        integer      DEFAULT 0,

    -- Source pin context
    source_pin_save_count integer      DEFAULT 0,       -- saves on the parent "Shop the Look" pin
    seed_keyword          text,                         -- keyword that led to the parent pin

    -- Timestamps
    scraped_at            timestamptz  DEFAULT now(),
    created_at            timestamptz  DEFAULT now(),

    -- Fallback dedup key for products without a Pinterest pin_id
    UNIQUE (parent_pin_id, source_url)
);

-- ── Indexes ────────────────────────────────────────────────────────────────

-- Fast lookup of all products under a given source pin
CREATE INDEX IF NOT EXISTS idx_pin_products_parent
    ON pin_products (parent_pin_id);

-- Domain analysis (which stores show up most)
CREATE INDEX IF NOT EXISTS idx_pin_products_domain
    ON pin_products (domain);

-- Leaderboard queries (most-saved products)
CREATE INDEX IF NOT EXISTS idx_pin_products_saves
    ON pin_products (save_count DESC);

-- Keyword drill-down
CREATE INDEX IF NOT EXISTS idx_pin_products_keyword
    ON pin_products (seed_keyword);

-- ── Soft FK comment (no hard constraint so STL can run before pin is indexed)
-- Join pattern: SELECT pp.* FROM pin_products pp
--               JOIN pin_samples ps ON ps.pin_id = pp.parent_pin_id
--               WHERE pp.domain = 'etsy.com'
--               ORDER BY pp.save_count DESC;
