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

-- ─── Row Level Security ───────────────────────────────────────────────────────
-- The deployable/idempotent hardening lives in backend/db/migrate_v74_*.sql.
-- Keep fresh legacy installs safe by default as well.
alter table tasks enable row level security;
alter table tasks force row level security;
alter table user_settings enable row level security;
alter table user_settings force row level security;
alter table audit_log enable row level security;
alter table audit_log force row level security;

create policy vibepin_v74_tasks_owner_access on tasks
  as permissive for all to authenticated
  using (auth.uid()::text = user_id::text)
  with check (auth.uid()::text = user_id::text);
comment on policy vibepin_v74_tasks_owner_access on tasks
  is 'vibepin:v74:owner-access';
create policy vibepin_v74_tasks_owner_boundary on tasks
  as restrictive for all to authenticated
  using (auth.uid()::text = user_id::text)
  with check (auth.uid()::text = user_id::text);
comment on policy vibepin_v74_tasks_owner_boundary on tasks
  is 'vibepin:v74:owner-boundary';

create policy vibepin_v74_user_settings_owner_access on user_settings
  as permissive for all to authenticated
  using (auth.uid()::text = user_id::text)
  with check (auth.uid()::text = user_id::text);
comment on policy vibepin_v74_user_settings_owner_access on user_settings
  is 'vibepin:v74:owner-access';
create policy vibepin_v74_user_settings_owner_boundary on user_settings
  as restrictive for all to authenticated
  using (auth.uid()::text = user_id::text)
  with check (auth.uid()::text = user_id::text);
comment on policy vibepin_v74_user_settings_owner_boundary on user_settings
  is 'vibepin:v74:owner-boundary';

create policy vibepin_v74_audit_owner_select on audit_log
  as permissive for select to authenticated
  using (auth.uid()::text = user_id::text);
comment on policy vibepin_v74_audit_owner_select on audit_log
  is 'vibepin:v74:audit-owner-select';
create policy vibepin_v74_audit_owner_select_boundary on audit_log
  as restrictive for select to authenticated
  using (auth.uid()::text = user_id::text);
comment on policy vibepin_v74_audit_owner_select_boundary on audit_log
  is 'vibepin:v74:audit-owner-select-boundary';

create policy vibepin_v74_audit_owner_insert on audit_log
  as permissive for insert to authenticated
  with check (auth.uid()::text = user_id::text);
comment on policy vibepin_v74_audit_owner_insert on audit_log
  is 'vibepin:v74:audit-owner-insert';
create policy vibepin_v74_audit_owner_insert_boundary on audit_log
  as restrictive for insert to authenticated
  with check (auth.uid()::text = user_id::text);
comment on policy vibepin_v74_audit_owner_insert_boundary on audit_log
  is 'vibepin:v74:audit-owner-insert-boundary';

create policy vibepin_v74_audit_deny_update on audit_log
  as restrictive for update to authenticated using (false) with check (false);
comment on policy vibepin_v74_audit_deny_update on audit_log
  is 'vibepin:v74:audit-deny-update';
create policy vibepin_v74_audit_deny_delete on audit_log
  as restrictive for delete to authenticated using (false);
comment on policy vibepin_v74_audit_deny_delete on audit_log
  is 'vibepin:v74:audit-deny-delete';
