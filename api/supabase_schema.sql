-- Social Flow — Supabase Schema
-- Run this in the Supabase SQL editor

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ─── Tasks ───────────────────────────────────────────────────────────────────
create table if not exists tasks (
  id              uuid primary key default uuid_generate_v4(),
  user_id         text not null,
  product_url     text not null,
  style_preset    text not null default 'scandinavian',
  platforms       text not null default 'both',
  status          text not null default 'pending',
  metadata        jsonb,
  assets          jsonb,
  error_message   text,
  retry_count     int not null default 0,
  pin_id          text,
  pin_url         text,
  ig_media_id     text,
  ig_permalink    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  published_at    timestamptz
);

create index on tasks(user_id, created_at desc);
create index on tasks(status);

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger tasks_updated_at before update on tasks
  for each row execute procedure update_updated_at();

-- ─── User Settings ────────────────────────────────────────────────────────────
create table if not exists user_settings (
  id                          uuid primary key default uuid_generate_v4(),
  user_id                     text unique not null,
  auto_publish                boolean not null default false,
  review_image                boolean not null default true,
  review_copy                 boolean not null default true,
  default_platforms           text not null default 'both',
  daily_limit                 int not null default 10,
  default_style               text not null default 'scandinavian',
  -- Pinterest
  pinterest_connected         boolean not null default false,
  pinterest_username          text,
  pinterest_access_token      text,  -- encrypted in production
  pinterest_refresh_token     text,
  pinterest_default_board_id  text,
  pinterest_boards            jsonb,
  -- Instagram
  instagram_connected         boolean not null default false,
  instagram_access_token      text,  -- encrypted in production
  instagram_ig_user_id        text,
  -- Audit
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create trigger user_settings_updated_at before update on user_settings
  for each row execute procedure update_updated_at();

-- ─── Audit Log ───────────────────────────────────────────────────────────────
create table if not exists audit_log (
  id          uuid primary key default uuid_generate_v4(),
  user_id     text not null,
  action      text not null,
  platform    text,
  content_id  text,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);

create index on audit_log(user_id, created_at desc);

-- ─── Row Level Security (enable in production) ───────────────────────────────
-- alter table tasks enable row level security;
-- alter table user_settings enable row level security;
-- create policy "Users own their tasks" on tasks
--   for all using (auth.uid()::text = user_id);
