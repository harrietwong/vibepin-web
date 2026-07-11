-- v38: server-authoritative Pin Draft storage (决策6前置项). Additive; run in Supabase SQL Editor.
create extension if not exists "uuid-ossp";

create table if not exists pin_drafts (
  vibepin_user_id uuid        not null,
  draft_id        text        not null,            -- client id, e.g. "pd_1720..._ab12cd" (pinDraftStore genId)
  payload         jsonb       not null,            -- full PinDraft object (authority)
  status          text,                            -- promoted copy of payload.status (query aid)
  updated_at      timestamptz not null,            -- = payload.updatedAt; LWW authority
  created_at      timestamptz not null default now(),
  archived_at     timestamptz,                     -- promoted copy of payload.archivedAt
  deleted_at      timestamptz,                     -- tombstone (deleteDraft); payload retained 30d for recovery
  primary key (vibepin_user_id, draft_id)
);

create index if not exists pin_drafts_user_updated
  on pin_drafts (vibepin_user_id, updated_at desc);
create index if not exists pin_drafts_user_live
  on pin_drafts (vibepin_user_id) where deleted_at is null;

alter table pin_drafts enable row level security;
-- (No permissive policies: service-role only.)
