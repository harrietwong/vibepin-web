-- Migration: Pinterest OAuth connections (per-user, encrypted tokens)
-- Run in the Supabase SQL editor.
--
-- One ACTIVE Pinterest connection per VibePin user (v1). Tokens are encrypted
-- at rest by the Next.js server (AES-256-GCM) before they are written here —
-- this table never stores plaintext access/refresh tokens.
--
-- This is additive. It does not modify the existing user_settings, publish_jobs,
-- publishing_queue, or composer_drafts tables.

create extension if not exists "uuid-ossp";

create table if not exists pinterest_connections (
  id                        uuid primary key default uuid_generate_v4(),
  vibepin_user_id           uuid not null,
  provider                  text not null default 'pinterest',
  pinterest_user_id         text,
  pinterest_username        text,
  pinterest_account_type    text,
  -- Ciphertext only (AES-256-GCM, "v1:" prefixed base64). Never plaintext.
  access_token_encrypted    text,
  refresh_token_encrypted   text,
  access_token_expires_at   timestamptz,
  refresh_token_expires_at  timestamptz,
  scopes                    text[] not null default '{}',
  needs_reconnect           boolean not null default false,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  disconnected_at           timestamptz
);

-- One active connection per user. A disconnected row sets disconnected_at and is
-- ignored by the app; re-connecting upserts the same user row back to active.
create unique index if not exists pinterest_connections_user_unique
  on pinterest_connections (vibepin_user_id);

create index if not exists pinterest_connections_active
  on pinterest_connections (vibepin_user_id) where disconnected_at is null;

-- Reuse the shared updated_at trigger if it exists (created in supabase_schema.sql).
do $$
begin
  if exists (select 1 from pg_proc where proname = 'update_updated_at') then
    drop trigger if exists pinterest_connections_updated_at on pinterest_connections;
    create trigger pinterest_connections_updated_at
      before update on pinterest_connections
      for each row execute procedure update_updated_at();
  end if;
end$$;

-- RLS: the Next.js server uses the service-role key (bypasses RLS). Enable RLS so
-- no anon/authenticated client can ever read encrypted tokens directly.
alter table pinterest_connections enable row level security;
-- (No permissive policies: only the service role may touch this table.)
