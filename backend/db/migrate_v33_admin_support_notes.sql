-- migrate_v33: admin_support_notes (INTERNAL Customer 360 support notes)
-- =====================================================================
-- Run in the Supabase SQL editor. Additive and idempotent. New standalone
-- table only — does NOT alter, drop, or reference any existing table.
--
-- Backs the internal, admin-only Customer 360 tool at /admin/users/[id].
-- Founder/support write short internal notes about a customer account. These
-- notes are INTERNAL: they are never shown to the customer and never feed
-- ranking, recommendations, Product Ideas, or Create Pins.
--
-- SECURITY / SCOPE
--   * No secrets, tokens, or PII beyond the note text the author types.
--   * user_id is the Supabase auth.users id of the customer the note is about.
--     Intentionally NO foreign key: notes must survive independent of whether
--     the auth user is later removed, and this table lives outside RLS.
--   * RLS is enabled with NO permissive policies, so only the service-role key
--     (used by the Next.js admin API, itself super-admin gated) can read/write.

create extension if not exists "pgcrypto";

create table if not exists admin_support_notes (
    id           uuid        primary key default gen_random_uuid(),
    user_id      uuid        not null,          -- auth.users id of the customer
    note         text        not null,
    author_email text,                          -- super-admin who wrote the note
    author_id    text,                          -- super-admin id (may be synthetic in E2E/local)
    created_at   timestamptz not null default now()
);

create index if not exists idx_admin_support_notes_user_created
    on admin_support_notes (user_id, created_at desc);

alter table admin_support_notes enable row level security;
-- No policies on purpose: service-role only.
