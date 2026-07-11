-- migrate_v22.sql
-- Data architecture convergence
-- Goals:
--   1. Introduce Opportunity as a first-class entity (not a view alias)
--   2. Add three relation tables: opportunity_keywords, opportunity_pins, opportunity_products
--   3. Add composer_drafts for persistent Studio prefill (replaces sessionStorage-only pattern)
--   4. Add user_products to separate user-owned assets from platform signals
--   5. Extend pin_samples with reference classification fields
--   6. Extend pin_products with product type / platform classification fields
--   7. Extend generated_assets with opportunity + session links
--   8. Extend pin_generations with opportunity + draft links
--   9. Add is_seed guard to prevent mock data from surfacing in production queries

-- ════════════════════════════════════════════════════════════════════════
-- SECTION 1 — opportunities
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS opportunities (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title                 text NOT NULL,
    canonical_keyword     text NOT NULL,
    normalized_keyword    text,
    category              text,
    subcategory           text,
    -- User-visible labels (replaces blue_ocean / hot_red_sea / etc.)
    primary_label         text,   -- 'Best Bet' | 'Steady' | 'Competitive'
    trend_state           text,   -- 'Rising' | 'Evergreen' | 'Seasonal'
    evidence_sentence     text,
    -- Scores
    score                 numeric,
    confidence_score      numeric,
    -- Qualitative bands (shown in Keyword Trends / Workspace cards)
    search_interest_band  text,   -- 'Very High' | 'High' | 'Medium' | 'Low'
    competition_band      text,   -- 'Low' | 'Medium' | 'High'
    shop_signal_band      text,   -- 'Strong' | 'Moderate' | 'Weak' | 'None'
    reference_signal_band text,   -- 'Strong' | 'Moderate' | 'Weak' | 'None'
    -- Narrative
    why_this_opportunity  text,
    -- Provenance
    created_from          text,   -- 'trend_keywords' | 'manual'
    -- Internal signals demoted from primary badges
    internal_reason_codes jsonb,  -- { "blue_ocean": true, "hidden_supply": false, ... }
    last_computed_at      timestamptz,
    created_at            timestamptz DEFAULT now(),
    updated_at            timestamptz DEFAULT now()
);

-- One opportunity per (keyword, category) pair
CREATE UNIQUE INDEX IF NOT EXISTS idx_opp_canonical_category
    ON opportunities (canonical_keyword, category)
    WHERE category IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_opp_score         ON opportunities (score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_opp_category      ON opportunities (category);
CREATE INDEX IF NOT EXISTS idx_opp_primary_label ON opportunities (primary_label);
CREATE INDEX IF NOT EXISTS idx_opp_trend_state   ON opportunities (trend_state);
CREATE INDEX IF NOT EXISTS idx_opp_computed      ON opportunities (last_computed_at DESC NULLS LAST);

-- ════════════════════════════════════════════════════════════════════════
-- SECTION 2 — opportunity_keywords
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS opportunity_keywords (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
    keyword_id      uuid NOT NULL REFERENCES trend_keywords(id) ON DELETE CASCADE,
    relevance_score numeric,
    created_at      timestamptz DEFAULT now(),
    UNIQUE (opportunity_id, keyword_id)
);

CREATE INDEX IF NOT EXISTS idx_opp_kw_opportunity ON opportunity_keywords (opportunity_id);
CREATE INDEX IF NOT EXISTS idx_opp_kw_keyword     ON opportunity_keywords (keyword_id);

-- ════════════════════════════════════════════════════════════════════════
-- SECTION 3 — opportunity_pins
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS opportunity_pins (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
    pin_id          uuid NOT NULL REFERENCES pin_samples(id) ON DELETE CASCADE,
    role            text DEFAULT 'evidence',  -- 'evidence' | 'reference_candidate'
    relevance_score numeric,
    created_at      timestamptz DEFAULT now(),
    UNIQUE (opportunity_id, pin_id)
);

CREATE INDEX IF NOT EXISTS idx_opp_pins_opportunity ON opportunity_pins (opportunity_id);
CREATE INDEX IF NOT EXISTS idx_opp_pins_pin         ON opportunity_pins (pin_id);
CREATE INDEX IF NOT EXISTS idx_opp_pins_role        ON opportunity_pins (opportunity_id, role);

-- ════════════════════════════════════════════════════════════════════════
-- SECTION 4 — opportunity_products
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS opportunity_products (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
    product_id      uuid NOT NULL REFERENCES pin_products(id) ON DELETE CASCADE,
    role            text DEFAULT 'signal',  -- 'signal' | 'recommended'
    relevance_score numeric,
    created_at      timestamptz DEFAULT now(),
    UNIQUE (opportunity_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_opp_products_opportunity ON opportunity_products (opportunity_id);
CREATE INDEX IF NOT EXISTS idx_opp_products_product     ON opportunity_products (product_id);

-- ════════════════════════════════════════════════════════════════════════
-- SECTION 5 — composer_drafts
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS composer_drafts (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    -- Where the user came from
    source_page             text,  -- 'workspace' | 'trends' | 'discover' | 'products' | 'plan'
    source_context          jsonb, -- raw WorkspaceFeedItem / TrendOpportunity / etc.
    -- Resolved opportunity (may be null for manual/product-only flows)
    opportunity_id          uuid   REFERENCES opportunities(id) ON DELETE SET NULL,
    -- Resolved references & products at draft creation time
    selected_reference_ids  uuid[],
    selected_product_ids    uuid[],
    -- Full Studio state at time of draft creation / last save
    draft_snapshot          jsonb,
    -- Lifecycle
    status                  text DEFAULT 'active',  -- 'active' | 'consumed' | 'abandoned'
    created_at              timestamptz DEFAULT now(),
    updated_at              timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cd_user_status   ON composer_drafts (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cd_opportunity   ON composer_drafts (opportunity_id)
    WHERE opportunity_id IS NOT NULL;

ALTER TABLE composer_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own drafts" ON composer_drafts;
CREATE POLICY "Users manage own drafts"
    ON composer_drafts FOR ALL
    USING  (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- ════════════════════════════════════════════════════════════════════════
-- SECTION 6 — user_products
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS user_products (
    id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title                        text,
    image_url                    text,
    thumbnail_url                text,
    category                     text,
    tags                         text[],
    -- Where this asset came from
    source                       text,  -- 'upload' | 'url_import' | 'saved_signal'
    source_url                   text,
    import_source                text,  -- 'etsy' | 'shopify' | 'amazon' | 'manual'
    -- If saved from a Product Signal, track the origin
    saved_from_product_signal_id uuid   REFERENCES pin_products(id) ON DELETE SET NULL,
    -- Type flags
    is_uploaded                  boolean DEFAULT false,
    is_imported                  boolean DEFAULT false,
    -- Rights: pin_products are inspiration_only; user_products are assumed_own by default
    rights_status                text DEFAULT 'assumed_own',  -- 'assumed_own' | 'licensed' | 'inspiration_only'
    last_used_at                 timestamptz,
    created_at                   timestamptz DEFAULT now(),
    updated_at                   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_up_user   ON user_products (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_up_signal ON user_products (saved_from_product_signal_id)
    WHERE saved_from_product_signal_id IS NOT NULL;

ALTER TABLE user_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own products" ON user_products;
CREATE POLICY "Users manage own products"
    ON user_products FOR ALL
    USING  (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- ════════════════════════════════════════════════════════════════════════
-- SECTION 7 — pin_samples: reference classification fields
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE pin_samples
    ADD COLUMN IF NOT EXISTS is_reference_eligible  boolean  DEFAULT false,
    ADD COLUMN IF NOT EXISTS reference_quality_score numeric,
    -- Visual format classification
    ADD COLUMN IF NOT EXISTS visual_format           text,
        -- 'lifestyle' | 'flat_lay' | 'collage' | 'product_only'
        -- | 'text_heavy' | 'infographic' | 'unknown'
    ADD COLUMN IF NOT EXISTS human_presence          text,
        -- 'none' | 'hands' | 'partial' | 'full'
    ADD COLUMN IF NOT EXISTS text_overlay_level      text,
        -- 'none' | 'light' | 'moderate' | 'heavy'
    ADD COLUMN IF NOT EXISTS watermark_detected      boolean  DEFAULT false,
    ADD COLUMN IF NOT EXISTS image_quality_band      text,
        -- 'high' | 'medium' | 'low'
    ADD COLUMN IF NOT EXISTS composition_type        text,
        -- 'single_focal' | 'multi_product' | 'scene' | 'abstract'
    ADD COLUMN IF NOT EXISTS has_clear_subject       boolean;

CREATE INDEX IF NOT EXISTS idx_ps_reference_eligible
    ON pin_samples (reference_quality_score DESC NULLS LAST)
    WHERE is_reference_eligible = true;

CREATE INDEX IF NOT EXISTS idx_ps_visual_format
    ON pin_samples (visual_format)
    WHERE visual_format IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════
-- SECTION 8 — pin_products: type / platform classification fields
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE pin_products
    ADD COLUMN IF NOT EXISTS product_type              text,
        -- 'physical' | 'digital'
    ADD COLUMN IF NOT EXISTS digital_format            text,
        -- 'printable' | 'template' | 'ebook' | 'preset' | 'svg'
        -- | 'font' | 'notion' | 'canva' | 'other_digital'
    ADD COLUMN IF NOT EXISTS source_platform           text,
        -- 'etsy' | 'amazon' | 'target' | 'walmart' | 'poshmark'
        -- | 'gumroad' | 'payhip' | 'tpt' | 'creativemarket'
        -- | 'creativefabrica' | 'shopify' | 'other'
    ADD COLUMN IF NOT EXISTS product_signal_confidence numeric,  -- 0.0–1.0
    -- pin_products are ALWAYS signals/inspiration, never user-owned assets
    ADD COLUMN IF NOT EXISTS inspiration_only          boolean  DEFAULT true,
    ADD COLUMN IF NOT EXISTS is_user_ownable           boolean  DEFAULT false,
    ADD COLUMN IF NOT EXISTS is_mockup_like            boolean  DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_pp_product_type
    ON pin_products (product_type)
    WHERE product_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pp_source_platform
    ON pin_products (source_platform)
    WHERE source_platform IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pp_digital_format
    ON pin_products (digital_format)
    WHERE digital_format IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════
-- SECTION 9 — generated_assets: opportunity + session links
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE generated_assets
    -- Links back to the pin_generations.session_id for cross-reference
    ADD COLUMN IF NOT EXISTS session_id      text,
    -- Which opportunity drove this generation
    ADD COLUMN IF NOT EXISTS opportunity_id  uuid REFERENCES opportunities(id) ON DELETE SET NULL,
    -- Snapshot of which pin_samples and pin_products were selected
    ADD COLUMN IF NOT EXISTS reference_ids   uuid[],
    ADD COLUMN IF NOT EXISTS product_ids     uuid[];

CREATE INDEX IF NOT EXISTS idx_ga_session
    ON generated_assets (session_id)
    WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ga_opportunity
    ON generated_assets (opportunity_id)
    WHERE opportunity_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════
-- SECTION 10 — pin_generations: opportunity + draft links
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE pin_generations
    ADD COLUMN IF NOT EXISTS opportunity_id  uuid REFERENCES opportunities(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS draft_id        uuid REFERENCES composer_drafts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pg_opportunity
    ON pin_generations (opportunity_id)
    WHERE opportunity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pg_draft
    ON pin_generations (draft_id)
    WHERE draft_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════
-- SECTION 11 — Seed data guard
-- Prevents mock / cold-start seed data from surfacing in production queries.
-- Backend scripts must set is_seed = true when inserting static data.
-- All production APIs must filter WHERE is_seed IS NOT TRUE (or is_seed = false).
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS is_seed boolean DEFAULT false;
ALTER TABLE pin_samples    ADD COLUMN IF NOT EXISTS is_seed boolean DEFAULT false;
ALTER TABLE pin_products   ADD COLUMN IF NOT EXISTS is_seed boolean DEFAULT false;
ALTER TABLE opportunities  ADD COLUMN IF NOT EXISTS is_seed boolean DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_tk_is_seed ON trend_keywords (is_seed) WHERE is_seed = true;
CREATE INDEX IF NOT EXISTS idx_ps_is_seed ON pin_samples    (is_seed) WHERE is_seed = true;
CREATE INDEX IF NOT EXISTS idx_pp_is_seed ON pin_products   (is_seed) WHERE is_seed = true;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES  (run after applying to confirm success)
-- ════════════════════════════════════════════════════════════════════════

-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public'
--   AND table_name IN (
--     'opportunities','opportunity_keywords','opportunity_pins',
--     'opportunity_products','composer_drafts','user_products'
--   )
--   ORDER BY table_name;
-- Expected: 6 rows

-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'pin_samples'
--   AND column_name IN (
--     'is_reference_eligible','reference_quality_score','visual_format',
--     'human_presence','text_overlay_level','watermark_detected',
--     'image_quality_band','composition_type','has_clear_subject'
--   );
-- Expected: 9 rows

-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'pin_products'
--   AND column_name IN (
--     'product_type','digital_format','source_platform',
--     'product_signal_confidence','inspiration_only','is_user_ownable','is_mockup_like'
--   );
-- Expected: 7 rows

-- SELECT column_name FROM information_schema.columns
--   WHERE table_name IN ('generated_assets','pin_generations')
--   AND column_name IN ('opportunity_id','draft_id','session_id','reference_ids','product_ids')
--   ORDER BY table_name, column_name;
-- Expected: 7 rows (ga: session_id, opportunity_id, reference_ids, product_ids;
--                    pg: opportunity_id, draft_id — session_id already existed from v19)

-- SELECT column_name FROM information_schema.columns
--   WHERE table_name IN ('trend_keywords','pin_samples','pin_products','opportunities')
--   AND column_name = 'is_seed'
--   ORDER BY table_name;
-- Expected: 4 rows
