-- migrate_v13.sql — Weekly Activation MVP
-- Tables: weekly_plans, weekly_plan_items

-- 每周计划主表（每个 category 每周一条）
CREATE TABLE IF NOT EXISTS weekly_plans (
  id           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid    NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category     text    NOT NULL,
  week_start   date    NOT NULL,         -- 本周一日期，e.g. 2026-05-25
  target_count integer NOT NULL DEFAULT 7,  -- 7 | 14 | 21
  status       text    NOT NULL DEFAULT 'planning',  -- planning | ready
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now(),
  UNIQUE (user_id, category, week_start)
);

ALTER TABLE weekly_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY weekly_plans_user ON weekly_plans
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_weekly_plans_user
  ON weekly_plans (user_id, week_start DESC);

-- 每周计划条目
CREATE TABLE IF NOT EXISTS weekly_plan_items (
  id                 uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id            uuid    NOT NULL REFERENCES weekly_plans(id) ON DELETE CASCADE,
  user_id            uuid    NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  keyword_id         text    NOT NULL,
  keyword            text    NOT NULL,
  category           text    NOT NULL,
  tier               text    NOT NULL,  -- blue_ocean | early_trend | hot_red_sea
  score              numeric,
  planned_date       date,              -- NULL 时由 sort_order 推算 Mon–Sun
  sort_order         integer NOT NULL DEFAULT 0,
  status             text    NOT NULL DEFAULT 'planned',  -- planned | generated | published
  generated_asset_id uuid,              -- Studio 生成后回写
  created_at         timestamptz DEFAULT now(),
  UNIQUE (plan_id, keyword_id)
);

ALTER TABLE weekly_plan_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY weekly_plan_items_user ON weekly_plan_items
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_wpi_plan
  ON weekly_plan_items (plan_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_wpi_user
  ON weekly_plan_items (user_id, created_at DESC);
