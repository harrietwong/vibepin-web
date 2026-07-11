-- migrate_v34: admin_audit_events (INTERNAL admin audit trail)
-- =====================================================================
-- Run in the Supabase SQL editor. Additive and idempotent. New standalone
-- table only — does NOT alter, drop, or reference any existing table.
--
-- Records when an internal admin views SENSITIVE details in the admin console
-- (v0: revealing a generation's full internal prompt template in Generation
-- Logs at /admin/generation-logs). Append-only audit trail.
--
-- SECURITY / SCOPE
--   * Stores WHO (actor_email/id/role), WHAT (action), and WHICH record
--     (target_type/target_id) — never the sensitive value itself, and never
--     any token/secret.
--   * RLS enabled with NO permissive policies: only the service-role key (used
--     by the super-admin-gated admin API) can read/write.

create extension if not exists "pgcrypto";

create table if not exists admin_audit_events (
    id           uuid        primary key default gen_random_uuid(),
    actor_id     text,
    actor_email  text,
    actor_role   text,                    -- super_admin | support
    action       text        not null,    -- e.g. generation_log.reveal_prompt
    target_type  text,                    -- e.g. pin_generation
    target_id    text,
    metadata     jsonb,
    created_at   timestamptz not null default now()
);

create index if not exists idx_admin_audit_events_created
    on admin_audit_events (created_at desc);
create index if not exists idx_admin_audit_events_target
    on admin_audit_events (target_type, target_id);

alter table admin_audit_events enable row level security;
-- No policies on purpose: service-role only.
