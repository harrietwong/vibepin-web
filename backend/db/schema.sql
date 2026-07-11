-- ============================================================
-- Pinterest Vibe Library — Supabase PostgreSQL Schema
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------
-- 1. trend_keywords
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trend_keywords (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    keyword        text        NOT NULL,
    category       text        NOT NULL,
    subcategory    text,
    region         text        DEFAULT 'US',
    source         text,
    trend_intent   text,
    season         text,
    priority_score numeric     DEFAULT 0,
    created_at     timestamptz DEFAULT now(),
    UNIQUE (keyword, category)
);

-- ------------------------------------------------------------
-- 2. pin_samples
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pin_samples (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    pin_id            text        UNIQUE,
    trend_keyword_id  uuid        REFERENCES trend_keywords(id) ON DELETE SET NULL,
    source_keyword    text,
    category          text,
    title             text,
    description       text,
    source_url        text,
    image_url         text,
    storage_path      text,
    local_image_path  text,
    outbound_link     text,
    is_ecommerce      boolean     DEFAULT false,
    save_count        integer     DEFAULT 0,
    reaction_count    integer     DEFAULT 0,
    comment_count     integer     DEFAULT 0,
    image_width       integer,
    image_height      integer,
    image_ratio       numeric,
    created_at_source timestamptz,
    scraped_at        timestamptz DEFAULT now()
);

-- ------------------------------------------------------------
-- 3. pin_style_analysis
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pin_style_analysis (
    id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    pin_sample_id           uuid        REFERENCES pin_samples(id) ON DELETE CASCADE,
    pin_type                text,
    style_tags              text[],
    layout_type             text,
    composition             text,
    dominant_colors         text[],
    has_text_overlay        boolean,
    visual_hook             text,
    best_for_products       text[],
    commercial_intent_score numeric,
    make_similar_score      numeric,
    prompt_template         text,
    negative_prompt         text,
    analysis_reason         text,
    model_name              text,
    analyzed_at             timestamptz DEFAULT now(),
    UNIQUE (pin_sample_id, model_name)
);

-- ------------------------------------------------------------
-- 4. prompt_templates
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prompt_templates (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    category          text,
    pin_type          text,
    layout_type       text,
    style_tags        text[],
    template_name     text,
    template_text     text,
    negative_prompt   text,
    best_for_products text[],
    source_pin_ids    text[],
    performance_score numeric     DEFAULT 0,
    is_active         boolean     DEFAULT true,
    created_at        timestamptz DEFAULT now()
);

-- ------------------------------------------------------------
-- 5. generated_assets
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS generated_assets (
    id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  uuid,
    product_title            text,
    product_url              text,
    category                 text,
    input_image_urls         text[],
    reference_pin_sample_ids uuid[],
    prompt_template_id       uuid        REFERENCES prompt_templates(id) ON DELETE SET NULL,
    final_prompt             text,
    image_url                text,
    storage_path             text,
    platform                 text,
    status                   text        DEFAULT 'created',
    created_at               timestamptz DEFAULT now()
);

-- ------------------------------------------------------------
-- 6. publish_jobs
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS publish_jobs (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            uuid,
    generated_asset_id uuid        REFERENCES generated_assets(id) ON DELETE CASCADE,
    platform           text        NOT NULL,
    board_id           text,
    title              text,
    description        text,
    outbound_link      text,
    scheduled_at       timestamptz,
    published_at       timestamptz,
    external_post_id   text,
    status             text        DEFAULT 'scheduled',
    error_message      text,
    created_at         timestamptz DEFAULT now()
);
