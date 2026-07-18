-- migrate_v43: support chat resolution/escalation state + support_emails audit log
-- =====================================================================
-- Run in the Supabase SQL editor. Additive and idempotent. Only adds
-- columns to the existing support_tickets table (migrate_v35) and creates
-- one new standalone table (support_emails) — does not alter or drop any
-- other table.
--
-- BUSINESS CONTEXT
--   Per docs/prd/客服系统简化版v1.1.txt: VibePin does not build a classic
--   ticket-status product experience. The user-facing surface is a
--   multi-turn AI chat on the Help page; when the AI can't solve the issue
--   or the topic is high-risk, the conversation escalates to "we'll reply
--   by email" — no ticket numbers/statuses are ever shown to the user.
--
--   We deliberately REUSE the existing support_tickets/support_messages
--   tables (created for the earlier ticket-system MVP, migrate_v35) as the
--   underlying conversation record rather than building a parallel
--   SupportConversation model — one row in support_tickets IS one chat
--   conversation. This migration adds the columns needed to drive that
--   chat + email-escalation state machine on top of the existing schema,
--   plus a new support_emails table that is an EMAIL-SEND AUDIT LOG, not a
--   ticket system: it records every attempted admin reply email (Resend
--   provider ID, translation provenance, failure reason, retry count) so
--   sends are idempotent and safely retryable, per PRD §8.4/§8.5.
--
-- COLUMN SEMANTICS (support_tickets)
--   resolution_mode — lifecycle summary of how the conversation ended (or
--   is still going): 'ai_active' (default state while the AI is still
--   engaged, no explicit value needed — column is nullable), 'resolved_by_ai'
--   (user confirmed "This solved my issue" — see ai-feedback route),
--   'email_escalated' (handed off to a human over email). Nullable — null
--   means "not yet resolved and not escalated."
--
--   escalation_state — where an escalated conversation sits in the async
--   email pipeline: 'none' (default, not escalated), 'processing'
--   (reserved for a future async worker; not currently set by the app),
--   'needs_email_reply' (in the admin "Support Inbox" queue),
--   'email_sent' (admin's reply email delivered), 'email_failed' (send
--   attempt failed — conversation STAYS in the pending queue, see PRD
--   §8.5), 'closed' (reserved for admin-initiated close).
--
--   escalation_reason — short machine-readable reason the conversation was
--   escalated (e.g. "refund_request", "user_requested_human",
--   "cannot_answer") — see web/src/lib/support/chatResponder.ts.
--
--   escalated_at — when escalation_state first moved off 'none'.
--
-- support_emails
--   Append-only send-attempt log, one row per send/retry attempt (retry
--   re-attempts the SAME row per PRD §8.4's idempotency-key rule — a retry
--   does not mint a new idempotency key). idempotency_key is UNIQUE so a
--   duplicate POST /send-email with the same key can never send twice.
--   admin_source_text_zh / translated_text mirror the Chinese-in,
--   customer-language-out translation flow from migrate_v42.

alter table support_tickets add column if not exists resolution_mode text
    check (resolution_mode in ('ai_active', 'resolved_by_ai', 'email_escalated') or resolution_mode is null);
alter table support_tickets add column if not exists escalation_state text not null default 'none'
    check (escalation_state in ('none', 'processing', 'needs_email_reply', 'email_sent', 'email_failed', 'closed'));
alter table support_tickets add column if not exists escalation_reason text;
alter table support_tickets add column if not exists escalated_at timestamptz;

-- ── support_emails ───────────────────────────────────────────────────────
-- This is an email-send audit log, not a ticket system: it does not carry
-- its own status workflow beyond a single send attempt's lifecycle
-- (sending -> sent | failed). The conversation's own escalation_state on
-- support_tickets remains the source of truth for "where is this in the
-- pipeline."
create table if not exists support_emails (
    id                    uuid        primary key default gen_random_uuid(),
    ticket_id             uuid        not null references support_tickets(id) on delete cascade,
    to_email              text        not null,
    from_email            text        not null,
    reply_to_email        text,
    subject               text        not null,
    admin_source_text_zh  text,
    translated_text       text        not null,
    target_language       text,
    translation_engine    text,
    translation_edited    boolean     not null default false,
    status                text        not null check (status in ('sending', 'sent', 'failed')),
    provider_message_id   text,
    failure_code          text,
    failure_message       text,
    idempotency_key       text        not null unique,
    retry_count           int         not null default 0,
    sent_at               timestamptz,
    created_at            timestamptz not null default now()
);

create index if not exists idx_support_emails_ticket on support_emails (ticket_id);

alter table support_emails enable row level security;
-- No policies on purpose: service-role only (matches every other support_*
-- table's convention — the Next.js admin API routes do their own admin
-- authorization).
