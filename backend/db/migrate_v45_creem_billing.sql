-- v45: Creem Billing fulfillment mirror tables (server-side provisioning).
-- Run in the Supabase SQL editor. Additive and idempotent (IF NOT EXISTS).
--
-- Business context: Creem is the NEW merchant of record after Paddle was rejected.
-- The Paddle tables (billing_customers / billing_subscriptions, v44) are KEPT as
-- history and are NOT touched. Creem checkout passes { userId } in metadata; a
-- webhook (POST /api/webhooks/creem) receives checkout/subscription/refund/dispute
-- events and mirrors them here. These tables are the SOURCE OF TRUTH for billing
-- state; `user_metadata.plan` (read by resolvePlan/useUserTier) is a derived cache
-- the webhook refreshes.
--
-- Conventions (template migrate_v44): additive + idempotent, RLS enabled with NO
-- permissive policies (service-role only, via createServerClient), run manually in
-- the Supabase SQL Editor / Management API runner.
--
-- INTENTIONAL: there is NO foreign key between creem_subscriptions.creem_customer_id
-- and creem_customers.creem_customer_id. Creem delivers webhooks AT-LEAST-ONCE and
-- OUT OF ORDER: a subscription.active (or checkout.completed) can arrive BEFORE the
-- row that would supply the customer. An FK would reject those early events. Instead
-- each table self-heals as later events land, and the linkage is resolved at read
-- time (or via metadata.userId on the event itself).
--
-- Out-of-order guard: creem_customers and creem_subscriptions each carry
-- `last_event_at`. An upsert only applies when the incoming event's occurred_at >=
-- the stored last_event_at, so a delayed older event cannot overwrite newer state
-- (read-compare-write in creemStore).
--
-- Idempotency: beyond the PK upserts, creem_webhook_events records every processed
-- event_id. The webhook try-inserts the event_id right after signature verification;
-- a unique-violation means the event was already processed and is acknowledged with
-- 200 without reprocessing (satisfies "the same event must not create duplicates").

create table if not exists creem_customers (
  creem_customer_id text        primary key,          -- Creem cust_… id
  email             text,                             -- nullable ON PURPOSE: a
                                                      -- refund/dispute placeholder row
                                                      -- can be created before an event
                                                      -- carrying the email arrives.
  user_id           uuid,                             -- linked VibePin user (from checkout metadata.userId)
  last_event_at     timestamptz,                      -- out-of-order guard: latest applied occurred_at
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists creem_customers_user_id
  on creem_customers (user_id);

create table if not exists creem_subscriptions (
  creem_subscription_id text        primary key,       -- Creem sub_… id
  provider              text        not null default 'creem',
  creem_customer_id     text        not null,          -- Creem cust_… id (NO FK — see header)
  user_id               uuid,                          -- linked VibePin user when known
  status                text        not null,          -- active | trialing | canceled | past_due | expired | paused | unpaid | scheduled_cancel
  creem_product_id      text        not null,          -- Creem prod_… id from the event
  plan                  text,                          -- resolved VibePin plan (starter|pro|business) or null
  billing_interval      text,                          -- month | year (from the product map) or null
  current_period_end    timestamptz,                   -- current_period_end_date
  scheduled_cancel      boolean     not null default false,  -- true after subscription.scheduled_cancel (still entitled until period end)
  last_event_at         timestamptz,                   -- out-of-order guard: latest applied occurred_at
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists creem_subscriptions_customer_id
  on creem_subscriptions (creem_customer_id);
create index if not exists creem_subscriptions_user_id
  on creem_subscriptions (user_id);

-- Event-level idempotency ledger: one row per processed webhook event_id.
create table if not exists creem_webhook_events (
  event_id    text        primary key,   -- Creem event envelope id
  event_type  text,                      -- eventType for debugging/audit
  received_at timestamptz not null default now()
);

alter table creem_customers      enable row level security;
alter table creem_subscriptions  enable row level security;
alter table creem_webhook_events enable row level security;
-- (No permissive policies on any: service-role only.)
