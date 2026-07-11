-- migrate_v31: visual_asset_reviews (INTERNAL Visual Review v0)
-- =====================================================================
-- APPLIED + VERIFIED 2026-07-02 against Supabase (project jaxteelkecvlozdrdoog):
-- table present, 15 columns, UNIQUE(source_type, source_id) [23505 on dup],
-- score CHECK constraints [23514 on out-of-range], 3 indexes, 0 rows, no FKs.
-- New standalone table only.
--
-- Backs the internal, admin-only Visual Review tool at
-- /app/admin/visual-review. Reviewers score existing image candidates
-- (pin_products / pin_samples) for authenticity, AI-likeness, product
-- visibility, Pinterest-nativeness, and commercial clarity.
--
-- SAFETY / SCOPE
-- --------------
--   * This is a brand-new table. It does NOT alter, drop, or reference
--     pin_products, pin_samples, or any existing table (no FK on purpose:
--     source rows may be re-crawled / deduped independently).
--   * These scores are INTERNAL. They must never feed ranking,
--     recommendation, Product Ideas, or Create Pins.
--   * visual_asset_score and decision_label are computed in application
--     code (web/src/lib/visualReview.ts) and stored here for reporting;
--     they are not recomputed by a DB trigger.
--
-- source_type + source_id together identify the reviewed image. The unique
-- constraint makes the review API an idempotent upsert (one review per image).

CREATE TABLE IF NOT EXISTS visual_asset_reviews (
    id                             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- What was reviewed
    source_type                    text        NOT NULL
        CHECK (source_type IN ('pin_sample', 'pin_product')),
    source_id                      text        NOT NULL,   -- pin_samples.id / pin_products.id
    image_url                      text,

    -- Human-entered scores
    human_shot_authenticity_score  integer     NOT NULL
        CHECK (human_shot_authenticity_score BETWEEN 1 AND 5),
    ai_likeness_score              integer     NOT NULL
        CHECK (ai_likeness_score BETWEEN 0 AND 5),
    product_visibility_score       integer     NOT NULL
        CHECK (product_visibility_score BETWEEN 1 AND 5),
    pinterest_native_score         integer     NOT NULL
        CHECK (pinterest_native_score BETWEEN 1 AND 5),
    commercial_clarity_score       integer     NOT NULL
        CHECK (commercial_clarity_score BETWEEN 1 AND 5),

    -- Computed in app code, persisted for reporting
    visual_asset_score             integer     NOT NULL
        CHECK (visual_asset_score BETWEEN 0 AND 100),
    decision_label                 text        NOT NULL
        CHECK (decision_label IN ('PASS', 'REVIEW', 'REJECT')),

    -- Optional internal metadata
    tags                           jsonb       NOT NULL DEFAULT '[]'::jsonb,
    reviewer_note                  text,

    created_at                     timestamptz NOT NULL DEFAULT now(),
    updated_at                     timestamptz NOT NULL DEFAULT now(),

    -- One review per image; drives idempotent upsert from the review API.
    UNIQUE (source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_visual_asset_reviews_decision
    ON visual_asset_reviews (decision_label);

CREATE INDEX IF NOT EXISTS idx_visual_asset_reviews_updated_at
    ON visual_asset_reviews (updated_at DESC);
