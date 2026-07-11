-- Migration v32: Multi-platform social connections + publish jobs
-- Run in the Supabase SQL editor. Additive and idempotent.
--
-- Adds three tables that let VibePin connect and publish approved content to
-- multiple social platforms (Pinterest, Instagram, Facebook Pages, TikTok)
-- through a vendor-neutral provider abstraction (Zernio / OneUp / Publer /
-- Ayrshare / official APIs). No auto-publishing: a publish job is only ever
-- created after the merchant reviews the content and explicitly clicks Publish.
--
-- SECURITY
--   * Never stores raw passwords.
--   * Access/refresh tokens are stored ONLY as ciphertext (AES-256-GCM, "v1:"
--     prefixed) written by the Next.js server. For MVP these stay NULL because
--     real OAuth is not wired yet.
--   * RLS is enabled with no permissive policies — only the service-role key
--     (used by the Next.js API routes) can read/write these tables.
--
-- This does NOT modify the existing publish_jobs, publishing_queue,
-- pinterest_connections, or composer_drafts tables. Pinterest keeps its own
-- dedicated OAuth table (pinterest_connections); the unified API surfaces it
-- alongside the rows below.

create extension if not exists "uuid-ossp";

-- ── social_connections ───────────────────────────────────────────────────────
-- One row per (user, provider, connected account). A merchant may connect
-- several accounts of the same provider (e.g. two Facebook Pages).
create table if not exists social_connections (
  id                          uuid primary key default uuid_generate_v4(),
  user_id                     uuid not null,
  workspace_id               uuid,
  provider                    text not null,          -- pinterest | instagram | facebook | tiktok
  provider_account_id         text,
  provider_account_name       text,
  provider_account_username   text,
  provider_account_avatar_url text,
  connection_status           text not null default 'not_connected',
                              -- connected | not_connected | expired | revoked | error
  auth_provider               text,                   -- zernio | oneup | publer | ayrshare | official | mock
  external_connection_id      text,                   -- third-party (Zernio/OneUp/…) connection/account id
  scopes                      text[],
  -- Ciphertext only (AES-256-GCM, "v1:" prefixed). Never plaintext. NULL until OAuth is wired.
  access_token_encrypted      text,
  refresh_token_encrypted     text,
  token_expires_at            timestamptz,
  metadata                    jsonb,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint social_connections_provider_check
    check (provider in ('pinterest', 'instagram', 'facebook', 'tiktok')),
  constraint social_connections_status_check
    check (connection_status in ('connected', 'not_connected', 'expired', 'revoked', 'error'))
);

-- Fast lookup of a user's accounts, and one connected account per external id.
create index if not exists social_connections_user_provider
  on social_connections (user_id, provider);
create unique index if not exists social_connections_external_unique
  on social_connections (provider, external_connection_id)
  where external_connection_id is not null;

-- ── social_publish_jobs ──────────────────────────────────────────────────────
-- A merchant-approved post fanned out to one or more destinations. Named with a
-- `social_` prefix so it never collides with the existing single-platform
-- publish_jobs table (which the current Pinterest flow still uses).
create table if not exists social_publish_jobs (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid not null,
  workspace_id uuid,
  product_id   uuid,
  post_id      uuid,
  status       text not null default 'draft',
               -- draft | pending_review | approved | publishing | published
               --       | partially_published | failed
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint social_publish_jobs_status_check
    check (status in ('draft', 'pending_review', 'approved', 'publishing',
                      'published', 'partially_published', 'failed'))
);

create index if not exists social_publish_jobs_user
  on social_publish_jobs (user_id, created_at desc);

-- ── social_publish_job_destinations ──────────────────────────────────────────
-- One row per target platform within a publish job.
create table if not exists social_publish_job_destinations (
  id                   uuid primary key default uuid_generate_v4(),
  publish_job_id       uuid not null
                       references social_publish_jobs (id) on delete cascade,
  provider             text not null,
  social_connection_id uuid references social_connections (id) on delete set null,
  status               text not null default 'pending',
                       -- pending | skipped | publishing | published | failed
  external_post_id     text,
  external_post_url    text,
  error_message        text,
  payload              jsonb,
  published_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint social_publish_job_destinations_provider_check
    check (provider in ('pinterest', 'instagram', 'facebook', 'tiktok')),
  constraint social_publish_job_destinations_status_check
    check (status in ('pending', 'skipped', 'publishing', 'published', 'failed'))
);

create index if not exists social_publish_job_destinations_job
  on social_publish_job_destinations (publish_job_id);

-- ── updated_at triggers (reuse shared function if present) ────────────────────
do $$
begin
  if exists (select 1 from pg_proc where proname = 'update_updated_at') then
    drop trigger if exists social_connections_updated_at on social_connections;
    create trigger social_connections_updated_at
      before update on social_connections
      for each row execute procedure update_updated_at();

    drop trigger if exists social_publish_jobs_updated_at on social_publish_jobs;
    create trigger social_publish_jobs_updated_at
      before update on social_publish_jobs
      for each row execute procedure update_updated_at();

    drop trigger if exists social_publish_job_destinations_updated_at on social_publish_job_destinations;
    create trigger social_publish_job_destinations_updated_at
      before update on social_publish_job_destinations
      for each row execute procedure update_updated_at();
  end if;
end$$;

-- ── RLS: service-role only (no permissive policies) ───────────────────────────
alter table social_connections               enable row level security;
alter table social_publish_jobs              enable row level security;
alter table social_publish_job_destinations  enable row level security;
