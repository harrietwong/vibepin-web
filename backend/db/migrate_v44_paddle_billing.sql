-- v44: Paddle Billing fulfillment mirror tables (server-side provisioning).
-- Run in the Supabase SQL editor. Additive and idempotent (IF NOT EXISTS).
--
-- Business context: Paddle is the merchant of record. The paddle-js checkout on
-- /pricing sends `customData: { userId }`; a webhook (POST /api/paddle/webhook)
-- receives subscription/customer/transaction events and mirrors them here. These
-- two tables are the SOURCE OF TRUTH for billing state; `user_metadata.plan`
-- (read by resolvePlan/useUserTier) is a derived cache the webhook refreshes.
--
-- Conventions (裁决 i, template migrate_v39): additive + idempotent, RLS enabled
-- with NO permissive policies (service-role only, via createServerClient), run
-- manually in the Supabase SQL Editor.
--
-- INTENTIONAL: there is NO foreign key between billing_subscriptions.customer_id
-- and billing_customers.customer_id. Paddle delivers notifications AT-LEAST-ONCE
-- and OUT OF ORDER: a subscription.created (or transaction.completed) can arrive
-- BEFORE the customer.created that would supply the customer row. An FK would
-- reject those early events. Instead each table self-heals as later events land,
-- and the linkage is resolved at read time (or via custom_data.userId on the
-- event itself).
--
-- Out-of-order guard: each table carries `last_event_at`. An upsert only applies
-- when the incoming event's occurred_at >= the stored last_event_at, so a delayed
-- older event cannot overwrite newer state (read-compare-write in billingStore).

create table if not exists billing_customers (
  customer_id   text        primary key,          -- Paddle ctm_… id
  email         text,                             -- nullable ON PURPOSE: a
                                                  -- transaction.completed can create a
                                                  -- placeholder row before customer.created
                                                  -- arrives with the email.
  user_id       uuid,                             -- linked VibePin user (from checkout custom_data.userId)
  last_event_at timestamptz,                      -- out-of-order guard: latest applied occurred_at
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists billing_customers_user_id
  on billing_customers (user_id);

create table if not exists billing_subscriptions (
  subscription_id         text        primary key,   -- Paddle sub_… id
  customer_id             text        not null,       -- Paddle ctm_… id (NO FK — see header)
  user_id                 uuid,                        -- linked VibePin user when known
  status                  text        not null,        -- active | trialing | paused | canceled | past_due
  price_id                text        not null,        -- first item's Paddle pri_… id
  product_id              text        not null,        -- first item's Paddle pro_… id
  plan_key                text,                        -- resolved VibePin plan (starter|pro|business) or null
  scheduled_change_action text,                        -- cancel | pause | resume (pending), or null
  scheduled_change_at     timestamptz,                 -- when the scheduled change takes effect
  current_period_end      timestamptz,                 -- current_billing_period.ends_at
  last_event_at           timestamptz,                 -- out-of-order guard: latest applied occurred_at
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index if not exists billing_subscriptions_customer_id
  on billing_subscriptions (customer_id);
create index if not exists billing_subscriptions_user_id
  on billing_subscriptions (user_id);

alter table billing_customers     enable row level security;
alter table billing_subscriptions enable row level security;
-- (No permissive policies on either: service-role only.)
