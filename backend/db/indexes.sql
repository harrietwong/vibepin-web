-- ============================================================
-- Pinterest Vibe Library — Indexes
-- ============================================================

-- trend_keywords
CREATE INDEX IF NOT EXISTS idx_tk_keyword          ON trend_keywords (keyword);
CREATE INDEX IF NOT EXISTS idx_tk_category         ON trend_keywords (category);
CREATE INDEX IF NOT EXISTS idx_tk_priority         ON trend_keywords (priority_score DESC);

-- pin_samples
CREATE INDEX IF NOT EXISTS idx_ps_pin_id           ON pin_samples (pin_id);
CREATE INDEX IF NOT EXISTS idx_ps_trend_keyword    ON pin_samples (trend_keyword_id);
CREATE INDEX IF NOT EXISTS idx_ps_source_keyword   ON pin_samples (source_keyword);
CREATE INDEX IF NOT EXISTS idx_ps_save_count       ON pin_samples (save_count DESC);
CREATE INDEX IF NOT EXISTS idx_ps_scraped_at       ON pin_samples (scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_ps_is_ecommerce     ON pin_samples (is_ecommerce);
CREATE INDEX IF NOT EXISTS idx_ps_category         ON pin_samples (category);

-- pin_style_analysis
CREATE INDEX IF NOT EXISTS idx_psa_pin_sample      ON pin_style_analysis (pin_sample_id);
CREATE INDEX IF NOT EXISTS idx_psa_pin_type        ON pin_style_analysis (pin_type);
CREATE INDEX IF NOT EXISTS idx_psa_make_similar    ON pin_style_analysis (make_similar_score DESC);
CREATE INDEX IF NOT EXISTS idx_psa_commercial      ON pin_style_analysis (commercial_intent_score DESC);

-- prompt_templates
CREATE INDEX IF NOT EXISTS idx_pt_category         ON prompt_templates (category);
CREATE INDEX IF NOT EXISTS idx_pt_pin_type         ON prompt_templates (pin_type);
CREATE INDEX IF NOT EXISTS idx_pt_is_active        ON prompt_templates (is_active);
CREATE INDEX IF NOT EXISTS idx_pt_performance      ON prompt_templates (performance_score DESC);

-- generated_assets
CREATE INDEX IF NOT EXISTS idx_ga_user_id          ON generated_assets (user_id);
CREATE INDEX IF NOT EXISTS idx_ga_status           ON generated_assets (status);
CREATE INDEX IF NOT EXISTS idx_ga_created_at       ON generated_assets (created_at DESC);

-- publish_jobs
CREATE INDEX IF NOT EXISTS idx_pj_user_id          ON publish_jobs (user_id);
CREATE INDEX IF NOT EXISTS idx_pj_status           ON publish_jobs (status);
CREATE INDEX IF NOT EXISTS idx_pj_scheduled_at     ON publish_jobs (scheduled_at);
CREATE INDEX IF NOT EXISTS idx_pj_platform         ON publish_jobs (platform);
