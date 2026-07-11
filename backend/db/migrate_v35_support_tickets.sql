-- migrate_v35: support_tickets / support_messages / support_attachments / support_events
-- =====================================================================
-- Run in the Supabase SQL editor. Additive and idempotent. New standalone
-- tables only — does NOT alter, drop, or reference any existing table.
--
-- Backs the Customer Support MVP (Help & Support page -> Contact Support form
-- -> ticket -> admin reply -> email notification). This is a real ticket
-- system, NOT live chat: no presence/typing/read-receipt state anywhere here.
--
-- SECURITY / SCOPE
--   * RLS enabled with NO permissive policies on every table: only the
--     service-role key (used by the Next.js support API routes, which do
--     their own user/admin authorization) can read/write. Matches the
--     admin_support_notes (v33) / admin_audit_events (v34) convention.
--   * support_tickets.context is a free-form jsonb "safe status" bag (plan,
--     boardName, error codes/messages, credit counters, connection status,
--     etc.). The application layer is responsible for NEVER writing access
--     tokens, refresh tokens, OAuth secrets, session tokens, cookies,
--     passwords, API keys, full card numbers, or raw provider payloads into
--     it — see web/src/lib/support/redact.ts.
--   * support_messages.is_internal rows (internal notes) must never be
--     returned by the user-facing API — enforced in the API layer, not RLS.

create extension if not exists "pgcrypto";

-- ── support_tickets ──────────────────────────────────────────────────────
create table if not exists support_tickets (
    id             uuid        primary key default gen_random_uuid(),
    ticket_number  text        not null unique,
    user_id        uuid        not null,
    workspace_id   uuid,
    email          text        not null,
    category       text        not null check (category in (
                       'publishing_issue', 'scheduling_issue', 'pinterest_connection_issue',
                       'ai_generation_issue', 'credits_issue', 'billing_or_subscription',
                       'bug_report', 'feature_request', 'other'
                   )),
    priority       text        not null check (priority in ('Low', 'Normal', 'High', 'Urgent')),
    status         text        not null default 'Open' check (status in (
                       'Open', 'In progress', 'Waiting for user', 'Resolved', 'Closed'
                   )),
    subject        text,
    description    text        not null,
    source         text,
    context        jsonb,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    resolved_at    timestamptz,
    closed_at      timestamptz
);

create sequence if not exists support_ticket_seq start 1000;

create index if not exists idx_support_tickets_user      on support_tickets (user_id);
create index if not exists idx_support_tickets_workspace  on support_tickets (workspace_id);
create index if not exists idx_support_tickets_status     on support_tickets (status);
create index if not exists idx_support_tickets_priority   on support_tickets (priority);
create index if not exists idx_support_tickets_category   on support_tickets (category);
create index if not exists idx_support_tickets_created    on support_tickets (created_at desc);

alter table support_tickets enable row level security;
-- No policies on purpose: service-role only (API layer enforces user/admin scoping).

-- ── support_messages ─────────────────────────────────────────────────────
create table if not exists support_messages (
    id           uuid        primary key default gen_random_uuid(),
    ticket_id    uuid        not null references support_tickets(id) on delete cascade,
    sender_type  text        not null check (sender_type in ('user', 'admin', 'ai', 'system')),
    sender_id    uuid,
    body         text        not null,
    is_internal  boolean     not null default false,
    created_at   timestamptz not null default now()
);

create index if not exists idx_support_messages_ticket on support_messages (ticket_id);

alter table support_messages enable row level security;
-- No policies on purpose: service-role only. Internal notes (is_internal =
-- true) must be filtered out by the user-facing API, never relied on RLS.

-- ── support_attachments ──────────────────────────────────────────────────
create table if not exists support_attachments (
    id          uuid        primary key default gen_random_uuid(),
    ticket_id   uuid        not null references support_tickets(id) on delete cascade,
    message_id  uuid        references support_messages(id) on delete set null,
    file_url    text        not null,
    file_type   text,
    file_name   text,
    created_at  timestamptz not null default now()
);

create index if not exists idx_support_attachments_ticket on support_attachments (ticket_id);

alter table support_attachments enable row level security;
-- No policies on purpose: service-role only.

-- ── support_events ───────────────────────────────────────────────────────
-- Append-only audit trail: ticket_created, status_changed, priority_changed,
-- admin_replied, user_replied, ai_replied, internal_note_added, ticket_resolved, ticket_closed.
create table if not exists support_events (
    id          uuid        primary key default gen_random_uuid(),
    ticket_id   uuid        not null references support_tickets(id) on delete cascade,
    event_type  text        not null,
    metadata    jsonb,
    created_at  timestamptz not null default now()
);

create index if not exists idx_support_events_ticket on support_events (ticket_id);

alter table support_events enable row level security;
-- No policies on purpose: service-role only.

-- ── Ticket number generator ──────────────────────────────────────────────
-- Atomic across concurrent inserts (nextval is transaction-safe). Called from
-- the Next.js API route via supabase.rpc('support_next_ticket_number').
create or replace function support_next_ticket_number()
returns text
language sql
volatile
as $$
  select 'SUP-' || lpad(nextval('support_ticket_seq')::text, 4, '0');
$$;
