-- v57: Usage metering core (three independent per-plan quotas).
-- Additive + idempotent (IF NOT EXISTS). RLS enabled with NO permissive policies
-- (service-role only, via createServerClient) — mirrors migrate_v45_creem_billing.sql.
--
-- Business context (PRD "定价方案 credit 方案 0723", §3 + §8): VibePin meters THREE
-- independent monthly quotas — AI images, AI text generations, and scheduled posts.
-- This is NOT a credit/wallet system: there is no shared balance, no top-ups, no
-- auto-refill. Each usage_type is summed on its own over the current UTC calendar
-- month and compared against the plan's limit in web/src/lib/planEntitlements.ts.
--
-- usage_events is an append-only ledger. A "consume" adds usage; a "release" /
-- "reverse" backs it out (e.g. a scheduled post that was unscheduled). The current
-- period balance for a usage_type is sum(consume) - sum(release + reverse). Rows are
-- never updated or deleted in normal operation. Idempotency is enforced by a UNIQUE
-- index on idempotency_key: recordUsage inserts ON CONFLICT DO NOTHING, so a retried
-- request (same key) never double-counts.
--
-- ai_cost_events is a SEPARATE provider-cost audit ledger (raw token / image counts
-- and estimated $ per AI call). This migration only CREATES the table — no code writes
-- to it yet; a later task wires the generator/ai-copy cost accounting into it. It is
-- deliberately independent of usage_events (business quota vs. internal cost analytics).

create table if not exists usage_events (
  id               uuid        primary key default gen_random_uuid(),
  -- owner_type is future-proofing for workspace-scoped metering; today every row is
  -- 'user' and owner_id is the VibePin user id.
  owner_type       text        not null default 'user'
                     check (owner_type in ('user', 'workspace')),
  owner_id         uuid        not null,
  usage_type       text        not null
                     check (usage_type in ('ai_image', 'ai_text_generation', 'scheduled_post')),
  operation        text        not null
                     check (operation in ('consume', 'release', 'reverse', 'reset', 'manual_adjustment')),
  quantity         integer     not null check (quantity > 0),
  -- What the event refers to (e.g. reference_type='generation', reference_id=<requestId>;
  -- or reference_type='pin_draft', reference_id=<draftId>).
  reference_type   text        not null,
  reference_id     text        not null,
  -- Exactly-once guard: a retried request carries the SAME key so it is not counted twice.
  idempotency_key  text        not null,
  metadata         jsonb,
  created_at       timestamptz not null default now()
);

create unique index if not exists usage_events_idempotency_key
  on usage_events (idempotency_key);
create index if not exists usage_events_owner_type_period
  on usage_events (owner_id, usage_type, created_at);

-- Provider-cost audit ledger (created only; wired by a later task).
create table if not exists ai_cost_events (
  id                      uuid        primary key default gen_random_uuid(),
  user_id                 uuid,
  provider                text,
  model                   text,
  operation_type          text,
  input_tokens            integer,
  output_tokens           integer,
  requested_image_count   integer,
  successful_image_count  integer,
  resolution              text,
  estimated_cost          numeric,
  currency                text        default 'USD',
  request_status          text,
  plan                    text,
  reference_id            text,
  metadata                jsonb,
  created_at              timestamptz default now()
);

create index if not exists ai_cost_events_created_at
  on ai_cost_events (created_at);
create index if not exists ai_cost_events_user_created_at
  on ai_cost_events (user_id, created_at);

alter table usage_events   enable row level security;
alter table ai_cost_events enable row level security;
-- (No permissive policies on either: service-role only.)
