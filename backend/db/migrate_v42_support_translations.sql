-- migrate_v42: support ticket translation + Chinese AI summary columns
-- NOTE: numbered v42 because v41 was concurrently claimed by
--       migrate_v41_creative_intelligence.sql (a different in-flight
--       feature authored around the same time) — this file was originally
--       drafted as v41; renumbered to avoid a migration-number collision.
-- =====================================================================
-- Run in the Supabase SQL editor. Additive and idempotent. Only adds
-- columns to the existing support_messages / support_tickets tables
-- (created in migrate_v35_support_tickets.sql) — does not create, drop,
-- or alter any other table.
--
-- BUSINESS CONTEXT (Phase B)
--   VibePin's human support operators work in Chinese while customers
--   write in any language. These columns let the admin UI show a Chinese
--   summary of a ticket, an automatic Chinese translation of each user
--   message, and let an admin compose a reply in Chinese that gets
--   translated to the customer's language before sending — with the
--   original AND the translation both stored. Translation is best-effort
--   and must never block reading a ticket or sending a reply; on failure
--   the admin can always send the untranslated text (see
--   translation_status below and the /reply, /translate,
--   /preview-translation routes in web/src/app/api/admin/support/tickets).
--
-- COLUMN SEMANTICS
--   support_messages.body stays the user-facing canonical text exactly as
--   before this migration:
--     - user messages: what the user typed, verbatim.
--     - admin messages: what was actually sent to the user, already in
--       the user's own language. User-facing APIs (GET
--       /api/support/tickets/:id) keep returning ONLY `body` plus the
--       pre-existing columns — none of the six new columns below are ever
--       exposed to end users, admin-only.
--
--   support_messages.original_text / original_language — what the SENDER
--   typed, in the sender's own language:
--     - admin replies composed in Chinese: original_text = the Chinese
--       draft, original_language = 'zh'.
--     - user messages: original_text is typically null because `body` IS
--       already the original (nothing to duplicate); original_language is
--       the detected language of `body`.
--
--   support_messages.translated_text / translated_language — the
--   cross-language counterpart to `body`:
--     - user messages: the Chinese translation of `body`, shown to admins
--       only. translated_language = 'zh'.
--     - admin replies: conceptually equal to body/customer language
--       (body already holds the translated text that was actually sent),
--       but set here too for symmetry with user messages whenever a
--       translation actually happened.
--
--   support_messages.translation_status — null = translation never
--   attempted or not needed; 'success'; 'failed'. A failed or null status
--   must never block a reply from being sent or a message from being read
--   (see translation_manually_edited below and the "send original as-is"
--   fallback in the admin UI).
--
--   support_messages.translation_manually_edited — true when an admin
--   hand-edited the machine-translated preview text before sending it.
--
--   support_tickets.customer_language — best-effort detected language of
--   the customer (ISO 639-1-ish code, e.g. 'es', 'zh', 'en'), learned the
--   first time a user message or a translation preview is processed.
--   Nullable — absence just means "not detected yet."
--
--   support_tickets.ai_summary / ai_summary_at — a concise Chinese
--   AI-generated summary of the ticket for the support agent, plus the
--   timestamp it was last generated. Regenerated on demand from the admin
--   UI ("生成摘要" / "刷新摘要"), never auto-emailed or shown to the user.

alter table support_messages add column if not exists original_text text;
alter table support_messages add column if not exists original_language text;
alter table support_messages add column if not exists translated_text text;
alter table support_messages add column if not exists translated_language text;
alter table support_messages add column if not exists translation_status text
    check (translation_status in ('success', 'failed') or translation_status is null);
alter table support_messages add column if not exists translation_manually_edited boolean not null default false;

alter table support_tickets add column if not exists customer_language text;
alter table support_tickets add column if not exists ai_summary text;
alter table support_tickets add column if not exists ai_summary_at timestamptz;
