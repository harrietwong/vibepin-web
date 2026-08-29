-- ============================================================
-- Migration v52 — pin_generations extended-context columns
--
-- WHAT: Adds the 13 "extended context" columns the Studio client
--   writer (web/src/lib/studioPersistence.ts → insertGenerationToDb /
--   createRunningSessionInDb) has been inserting since v41-era, PLUS
--   a new generation_request_id column that links a generation row to
--   the draft it produced (draft payload.sourceGenerationId).
--
-- WHY: Production pin_generations only ever had the v17 base columns
--   (id, user_id, created_at, keyword, category, source, ref_urls,
--   pin_urls, groups_json, ref_count, product_count, total_pins) plus
--   session_id (v19). The client insert payload carries 13 MORE columns.
--   PostgREST rejects an INSERT that references an unknown column
--   (PGRST204 "could not find the column"), so the ENTIRE insert was
--   rejected — and the writer swallows the error in a catch {}. Net
--   effect: generation-history persistence to the DB has been silently
--   DEAD in production (schema drift) since ~2026-06-14. Rows only ever
--   survived in browser localStorage. This migration realigns the table
--   with the writer so inserts start succeeding again.
--
--   generation_request_id additionally repairs the admin AI-adoption
--   EXACT linkage: /api/generate echoes the client-sent generationRequestId
--   (in the Studio page flow this equals session_id), and drafts persist it
--   as payload.sourceGenerationId. Recording it on the generation row lets
--   adminAiAdoption.ts join generation → published draft on a real key.
--
-- TYPES: derived from the TypeScript writer values (studioPersistence.ts
--   HistoryEntry + insert payload). String arrays follow the v17 ref_urls/
--   pin_urls convention (text[]); structured objects follow groups_json (jsonb).
--     status           text     (GenerationStatus union string)
--     expected_total   integer  (number)
--     mode             text     (string)
--     opportunity      text     (string)
--     images_per_ref   integer  (number)
--     product_names    text[]   (string[])
--     product_ids      text[]   (string[])
--     prompt_excerpt   text     (string)
--     prompt_full      text     (string)
--     setup_snapshot   jsonb    (SetupSnapshot object)
--     category_audit   jsonb    (CategoryAudit object)
--     error_type       text     (GenerationErrorType union string)
--     error_message    text     (string)
--     generation_request_id text (string; mirrors session_id in the page flow)
--
-- Safe to re-run (ADD COLUMN IF NOT EXISTS on every column).
--
-- RUN: apply via the standard runner from the main worktree —
--   backend/scripts/run_migration.py --apply
--   (Do NOT hand-run in the SQL editor; the runner is the source of truth.)
-- ============================================================

ALTER TABLE pin_generations
    ADD COLUMN IF NOT EXISTS status                text,
    ADD COLUMN IF NOT EXISTS expected_total        integer,
    ADD COLUMN IF NOT EXISTS mode                  text,
    ADD COLUMN IF NOT EXISTS opportunity           text,
    ADD COLUMN IF NOT EXISTS images_per_ref        integer,
    ADD COLUMN IF NOT EXISTS product_names         text[],
    ADD COLUMN IF NOT EXISTS product_ids           text[],
    ADD COLUMN IF NOT EXISTS prompt_excerpt        text,
    ADD COLUMN IF NOT EXISTS prompt_full           text,
    ADD COLUMN IF NOT EXISTS setup_snapshot        jsonb,
    ADD COLUMN IF NOT EXISTS category_audit        jsonb,
    ADD COLUMN IF NOT EXISTS error_type            text,
    ADD COLUMN IF NOT EXISTS error_message         text,
    ADD COLUMN IF NOT EXISTS generation_request_id text;

-- Adoption join reads generation_request_id per row within the scan window;
-- a partial index keeps that lookup cheap without bloating the table.
CREATE INDEX IF NOT EXISTS idx_pin_generations_request_id
    ON pin_generations (generation_request_id)
    WHERE generation_request_id IS NOT NULL;
