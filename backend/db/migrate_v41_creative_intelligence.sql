-- v41: Creative Intelligence layer (PRD v0.2 Phase A / A3). Additive; run in Supabase SQL Editor.
-- NOTE: numbered v41 because v40 is already taken by migrate_v40_user_store_docs.sql
--       (the PRD task referred to it as "v40" before that file existed).
-- Conventions (follow v38/v39/v40): additive + idempotent (IF NOT EXISTS), RLS enabled
-- with NO permissive policies (service-role only, via web/src/lib/supabase.ts
-- createServerClient), applied manually in the Supabase SQL Editor (raw :5432 is
-- proxy-blocked). Code degrades gracefully while this is unapplied (see route notes).
create extension if not exists "uuid-ossp";

-- ── 1) Promoted Creative-Intelligence columns on the v38 pin_drafts table ──────────
-- pin_drafts keeps the FULL PinDraft object in `payload` (authority); these three
-- jsonb columns are promoted, query-friendly copies (same pattern as the existing
-- status / archived_at / deleted_at promotions). Written from payload by the
-- /api/pin-drafts PUT handler; the client round-trips the data through `payload`.
alter table pin_drafts
  add column if not exists image_analysis      jsonb;   -- { summary, objects, colors, style, ocr, category, model, updatedAt, status }
alter table pin_drafts
  add column if not exists recommended_keywords jsonb;  -- string[] of high-search Pinterest keywords
alter table pin_drafts
  add column if not exists creative_selections  jsonb;  -- { selectedDirection, selectedReferenceIds, rejectedReferenceIds, removedKeywords }

-- ── 2) analytics_events — durable event sink (A4) ──────────────────────────────────
create table if not exists analytics_events (
  id           uuid        primary key default uuid_generate_v4(),
  workspace_id uuid,                                    -- effective workspace (= vibepin user today)
  user_id      uuid,                                    -- authenticated VibePin user (nullable: anon dropped upstream)
  draft_id     text,                                    -- optional pinDraftStore id the event is about
  event_name   text        not null,
  payload      jsonb,                                   -- truncated client props (see analyticsIngest.ts)
  created_at   timestamptz not null default now()
);

create index if not exists analytics_events_name_created
  on analytics_events (event_name, created_at desc);
create index if not exists analytics_events_user_created
  on analytics_events (user_id, created_at desc);

alter table analytics_events enable row level security;
-- (No permissive policies: service-role only.)
