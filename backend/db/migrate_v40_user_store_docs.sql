-- v40: generic account-level store document storage (通用账号级 store 同步基础设施).
-- Additive; run in Supabase SQL Editor. Same write-through model as v38 pin_drafts,
-- but keyed by an extra store_key dimension so many independent client stores share
-- one table (one server-authoritative doc set per (user, store_key)).
create extension if not exists "uuid-ossp";

create table if not exists user_store_docs (
  vibepin_user_id uuid        not null,
  store_key       text        not null,            -- client store namespace, e.g. "shopify_connections" (/^[a-z0-9_-]{1,64}$/)
  doc_id          text        not null,            -- client id within the store
  payload         jsonb       not null,            -- full document object (authority)
  updated_at      timestamptz not null,            -- = payload's updatedAt; LWW authority
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,                     -- tombstone; payload retained for cross-device convergence
  primary key (vibepin_user_id, store_key, doc_id)
);

create index if not exists user_store_docs_user_key_updated
  on user_store_docs (vibepin_user_id, store_key, updated_at desc);

alter table user_store_docs enable row level security;
-- (No permissive policies: service-role only.)
