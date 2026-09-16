-- v76: durable, destination-scoped publish asset materialization ledger.
-- Additive/idempotent.  This migration owns no provider dispatch and is safe to
-- install while v72/v73 publishers are still serving traffic.
-- Ownership/definition preflight must precede the receipt scan and transaction:
-- never overwrite an existing unowned or visibly replaced v76 entry point.
do $v76_integrity_preflight$
declare
  v_installed boolean := to_regclass('public.publish_assets') is not null;
  v_expected record;
  v_oid oid;
  v_proc pg_proc%rowtype;
  v_check pg_constraint%rowtype;
  v_trigger pg_trigger%rowtype;
begin
  for v_expected in select * from (values
    ('publish_assets','vibepin:v76:publish-assets'),
    ('publish_asset_deliveries','vibepin:v76:publish-asset-deliveries'),
    ('publish_asset_delivery_items','vibepin:v76:publish-asset-delivery-items'),
    ('provider_publish_attempts','vibepin:v76:provider-publish-attempts'),
    ('v76_provider_settlement_context','vibepin:v76:v76-provider-settlement-context')
  ) as expected(table_name,marker) loop
    v_oid := to_regclass('public.'||v_expected.table_name);
    if (v_installed and v_oid is null) or (v_oid is not null
        and obj_description(v_oid,'pg_class') is distinct from v_expected.marker) then
      raise exception using errcode='P0001',message='v76_marker_tamper';
    end if;
  end loop;

  for v_expected in select * from (values
    ('publish_intent_confirm_prepare','public.publish_intent_confirm_prepare(uuid,jsonb)','vibepin:v76:publish-intent-confirm-prepare','jsonb','aa2be92161f032a5fe7f30de861e1bed'),
    ('publish_intent_prepare','public.publish_intent_prepare(uuid,text,text,text,jsonb,timestamptz,jsonb)','vibepin:v76:publish-intent-prepare','jsonb','8b1223d07ca4ffe76ccc8527ccb99b0a'),
    ('publish_asset_lease_materialization','public.publish_asset_lease_materialization(uuid,text,text,uuid,integer)','vibepin:v76:publish-asset-lease-materialization','jsonb','31041499144013fbe173873bab7b02f2'),
    ('publish_asset_settle_materialization','public.publish_asset_settle_materialization(uuid,text,text,uuid,text,text,text,text,bigint,text,text)','vibepin:v76:publish-asset-settle-materialization','jsonb','05aeaf68837a95a5cdc6177383ee6092'),
    ('publish_asset_claim_ready','public.publish_asset_claim_ready(uuid,text,text,uuid)','vibepin:v76:publish-asset-claim-ready','jsonb','4518fb77f5887d240e853a9900b69212'),
    ('publish_asset_settle_item','public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)','vibepin:v76:publish-asset-settle-item','jsonb','a05aef6619c3ec795b6ceee080e04843'),
    ('publish_intent_cancel','public.publish_intent_cancel(uuid,text,text)','vibepin:v76:publish-intent-cancel','jsonb','467d2ac4723ce507fc9cc4117d16e234'),
    ('publish_cleanup_lease','public.publish_cleanup_lease(bigint,uuid,integer)','vibepin:v76:publish-cleanup-lease','jsonb','3531021d2ace2d006b58e7e8052e4465'),
    ('publish_cleanup_settle','public.publish_cleanup_settle(bigint,uuid,text,text)','vibepin:v76:publish-cleanup-settle','jsonb','b6cfaa4737737f04996320e4efb35738'),
    ('publish_provider_attempt_start','public.publish_provider_attempt_start(uuid,text,text,uuid,integer)','vibepin:v76:publish-provider-attempt-start','jsonb','6c3b5b84394576742ff7d484aef1e30d'),
    ('publish_provider_attempt_settle','public.publish_provider_attempt_settle(uuid,uuid,uuid,text,integer,text,text,jsonb)','vibepin:v76:publish-provider-attempt-settle','jsonb','5eab4a26ba5fdaf07a9b474045126650'),
    ('v76_bind_publish_owner','public.v76_bind_publish_owner()','vibepin:v76:v76-bind-publish-owner','trigger','e0b5285eeab2d65a60d5ec379595fa05'),
    ('v76_evidence_owner_guard','public.v76_evidence_owner_guard()','vibepin:v76:v76-evidence-owner-guard','trigger','cd0d8f7c210bc48579ce0bcf7d1e6b4d'),
    ('v76_legacy_transition_guard','public.v76_legacy_transition_guard()','vibepin:v76:v76-legacy-transition-guard','trigger','4d49c02b3c734efebc4e2d5c3e770002')
  ) as expected(function_name,signature,marker,return_type,body_hash) loop
    v_oid := to_regprocedure(v_expected.signature);
    -- An unexpected overload must never be silently adopted or left callable.
    if (v_installed and v_oid is null) or exists (
      select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=v_expected.function_name
        and p.oid is distinct from v_oid) then
      raise exception using errcode='P0001',message='v76_definition_tamper';
    end if;
    if v_oid is not null then
      if obj_description(v_oid,'pg_proc') is distinct from v_expected.marker then
        raise exception using errcode='P0001',message='v76_marker_tamper';
      end if;
      select * into v_proc from pg_proc where oid=v_oid;
      if not v_proc.prosecdef or v_proc.prokind<>'f'
          or v_proc.prorettype<>to_regtype(v_expected.return_type)
          or v_proc.proretset or v_proc.provariadic<>0
          or v_proc.prolang<>(select oid from pg_language where lanname='plpgsql')
          or v_proc.proconfig is distinct from array['search_path=public, pg_temp']::text[]
          -- pg_get_functiondef may preserve CRLF/CR from an installed definition;
          -- newline normalization is the only canonicalization allowed here.
          or position('-- '||v_expected.marker||chr(10) in
                replace(replace(pg_get_functiondef(v_oid),chr(13)||chr(10),chr(10)),chr(13),chr(10)))=0
          -- Pin the body as well: retaining a sentinel cannot bless edited code.
          or md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>v_expected.body_hash then
        raise exception using errcode='P0001',message='v76_definition_tamper';
      end if;
    end if;
  end loop;

  -- Compare PostgreSQL's canonical CHECK expression, not just its name.
  -- The signed-url compatibility marker is intentionally CHECK (true); URLs
  -- are absent from this table's schema and validated by the materializer RPC.
  for v_expected in select * from (values
    ('provider_publish_attempts','provider_publish_attempts_attempt_check','CHECK ((attempt > 0))'),
    ('provider_publish_attempts','provider_publish_attempts_status_check','CHECK ((status = ANY (ARRAY[''started''::text, ''succeeded''::text, ''failed''::text, ''unknown''::text])))'),
    ('publish_asset_deliveries','publish_asset_deliveries_delivery_mode_check','CHECK ((delivery_mode = ANY (ARRAY[''provider_bytes''::text, ''signed_url''::text, ''public_copy''::text, ''mock''::text])))'),
    ('publish_asset_deliveries','publish_asset_deliveries_status_check','CHECK ((status = ANY (ARRAY[''prepared''::text, ''materializing''::text, ''ready''::text, ''published''::text, ''failed''::text, ''canceled''::text, ''delivery_unknown''::text])))'),
    ('publish_asset_delivery_items','publish_asset_delivery_items_item_status_check','CHECK ((item_status = ANY (ARRAY[''prepared''::text, ''ready''::text, ''failed''::text, ''canceled''::text])))'),
    ('publish_assets','publish_assets_signed_url_forbidden','CHECK (true)'),
    ('publish_assets','publish_assets_status_check','CHECK ((status = ANY (ARRAY[''prepared''::text, ''materializing''::text, ''ready''::text, ''failed''::text, ''canceled''::text, ''retained''::text])))'),
    ('publish_assets','publish_assets_strategy_check','CHECK ((strategy = ANY (ARRAY[''provider_bytes''::text, ''signed_url''::text, ''public_copy''::text, ''mock''::text])))'),
    ('publish_intent_destinations','publish_intent_destinations_status_valid','CHECK ((status = ANY (ARRAY[''prepared''::text, ''materializing''::text, ''claimed''::text, ''published''::text, ''failed''::text, ''delivery_unknown''::text, ''canceled''::text])))'),
    ('publish_intent_destinations','publish_intent_destinations_v76_materialization_status_check','CHECK ((materialization_status = ANY (ARRAY[''not_required''::text, ''prepared''::text, ''materializing''::text, ''materialized''::text, ''materialization_failed''::text, ''canceled''::text])))'),
    ('publish_intents','publish_intents_v76_lifecycle_status_check','CHECK ((lifecycle_status = ANY (ARRAY[''legacy''::text, ''confirmed''::text, ''prepared''::text, ''materializing''::text, ''ready''::text, ''partially_ready''::text, ''canceled''::text, ''settled''::text, ''delivery_unknown''::text])))'),
    ('v76_provider_settlement_context','v76_provider_settlement_context_terminal_status_check','CHECK ((terminal_status = ANY (ARRAY[''succeeded''::text, ''failed''::text, ''unknown''::text])))')
  ) as expected(table_name,constraint_name,definition) loop
    -- v72 owns this status constraint until the first v76 installation.
    if not v_installed and v_expected.constraint_name='publish_intent_destinations_status_valid' then
      continue;
    end if;
    select k.* into v_check from pg_constraint k
      where k.conrelid=to_regclass('public.'||v_expected.table_name)
        and k.conname=v_expected.constraint_name;
    if (v_installed and not found) or (found and
        (v_check.contype<>'c' or not v_check.convalidated or v_check.connoinherit
          or pg_get_constraintdef(v_check.oid) is distinct from v_expected.definition)) then
      raise exception using errcode='P0001',message='v76_check_constraint_tamper';
    end if;
  end loop;

  for v_expected in select * from (values
    ('provider_publish_attempts','v76_evidence_owner_guard'),
    ('publish_asset_deliveries','v76_bind_publish_owner'),
    ('publish_asset_delivery_items','v76_evidence_owner_guard'),
    ('publish_assets','v76_bind_publish_owner'),
    ('publish_intent_destinations','v76_bind_publish_owner'),
    ('publish_intent_destinations','v76_legacy_transition_guard')
  ) as expected(table_name,trigger_name) loop
    select t.* into v_trigger from pg_trigger t
      where t.tgrelid=to_regclass('public.'||v_expected.table_name)
        and t.tgname=v_expected.trigger_name;
    if (v_installed and not found) or (found and
        (v_trigger.tgenabled<>'O' or v_trigger.tgtype<>23
          or v_trigger.tgfoid is distinct from to_regprocedure('public.'||v_expected.trigger_name||'()')
          or v_trigger.tgnargs<>0 or v_trigger.tgqual is not null
          or v_trigger.tgconstraint<>0 or v_trigger.tgattr::text<>'')) then
      raise exception using errcode='P0001',message='v76_definition_tamper';
    end if;
  end loop;
end $v76_integrity_preflight$;

-- Fail before opening the migration transaction: retain historical evidence and
-- leave the caller's connection usable for inspecting a rejected installation.
-- Long reserved markers are checked without separators (api_key = api-key =
-- apiKey). The short marker sig requires a complete segment, preserving design.
do $v76_legacy_receipts$
begin
  if exists (select 1 from public.publish_intents
    where regexp_replace(lower(receipt::text),'[^a-z0-9]','','g')
      ~ '(token|signature|credential|cookie|auth|bearer|secret|apikey|accesskey|privatekey|password|passwd|session)'
      or receipt::text ~* '(^|[^a-z0-9])sig([^a-z0-9]|$)') then
    raise exception using errcode='P0001',message='v76_legacy_receipt_secret';
  end if;
end $v76_legacy_receipts$;
begin;
-- Close the gap between the read-only preflight and the first mutation.
lock table public.publish_intents in share row exclusive mode;
do $v76_locked_legacy_receipts$
begin
  if exists (select 1 from public.publish_intents
    where regexp_replace(lower(receipt::text),'[^a-z0-9]','','g')
      ~ '(token|signature|credential|cookie|auth|bearer|secret|apikey|accesskey|privatekey|password|passwd|session)'
      or receipt::text ~* '(^|[^a-z0-9])sig([^a-z0-9]|$)') then
    raise exception using errcode='P0001',message='v76_legacy_receipt_secret';
  end if;
end $v76_locked_legacy_receipts$;

alter table public.publish_intents add column if not exists lifecycle_status text not null default 'legacy';
alter table public.publish_intents alter column lifecycle_status set default 'legacy';
alter table public.publish_intents add column if not exists schedule_at timestamptz;
alter table public.publish_intents add column if not exists source_revision text;
alter table public.publish_intents add column if not exists source_fingerprint text;
alter table public.publish_intents add column if not exists prepared_at timestamptz;
alter table public.publish_intents add column if not exists canceled_at timestamptz;
alter table public.publish_intents add column if not exists settled_at timestamptz;
-- Rows that existed before v76 may already be in flight under the v72/v73
-- contract. Freeze only those rows. Every intent created after this statement,
-- including by a stale v72 server during rolling deploy, is non-frozen and must
-- satisfy the v76 materialization invariant before it can be claimed.
alter table public.publish_intents add column if not exists v76_frozen_legacy boolean;
update public.publish_intents set v76_frozen_legacy=true where v76_frozen_legacy is null;
alter table public.publish_intents alter column v76_frozen_legacy set default false;
alter table public.publish_intents alter column v76_frozen_legacy set not null;

alter table public.publish_intent_destinations add column if not exists materialization_status text not null default 'not_required';
alter table public.publish_intent_destinations add column if not exists asset_id uuid;
alter table public.publish_intent_destinations add column if not exists source_revision text;
alter table public.publish_intent_destinations add column if not exists lease_token uuid;
alter table public.publish_intent_destinations add column if not exists lease_expires_at timestamptz;
alter table public.publish_intent_destinations add column if not exists materialized_at timestamptz;
alter table public.publish_intent_destinations add column if not exists canceled_at timestamptz;
create unique index if not exists publish_intent_destinations_v76_capability_unique
  on public.publish_intent_destinations(
    publish_intent_id,provider,social_connection_id,(coalesce(subdestination_id,''))
  );

do $v76_checks$
begin
  if not exists (select 1 from pg_constraint where conname='publish_intents_v76_lifecycle_status_check') then
    alter table public.publish_intents add constraint publish_intents_v76_lifecycle_status_check
      check (lifecycle_status in ('legacy','confirmed','prepared','materializing','ready','partially_ready','canceled','settled','delivery_unknown'));
  end if;
  if not exists (select 1 from pg_constraint where conname='publish_intent_destinations_v76_materialization_status_check') then
    alter table public.publish_intent_destinations add constraint publish_intent_destinations_v76_materialization_status_check
      check (materialization_status in ('not_required','prepared','materializing','materialized','materialization_failed','canceled'));
  end if;
  if exists (select 1 from pg_constraint where conname='publish_intent_destinations_status_valid') then
    alter table public.publish_intent_destinations drop constraint publish_intent_destinations_status_valid;
  end if;
  alter table public.publish_intent_destinations add constraint publish_intent_destinations_status_valid
    check (status in ('prepared','materializing','claimed','published','failed','delivery_unknown','canceled'));
end $v76_checks$;

create table if not exists public.publish_assets (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  publish_intent_id uuid not null references public.publish_intents(id) on delete restrict,
  source_revision text not null,
  source_fingerprint text not null,
  strategy text not null check (strategy in ('provider_bytes','signed_url','public_copy','mock')),
  bucket_id text,
  object_path text,
  content_type text,
  byte_size bigint,
  checksum_sha256 text,
  status text not null default 'prepared' check (status in ('prepared','materializing','ready','failed','canceled','retained')),
  failure_code text,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  materialized_at timestamptz
);
alter table public.publish_assets add column if not exists source_media_key text;
alter table public.publish_assets add column if not exists media_ordinal integer not null default 0;
drop index if exists public.publish_assets_intent_source_unique;
create unique index publish_assets_intent_source_unique
  on public.publish_assets(publish_intent_id, source_revision, source_fingerprint, strategy, source_media_key, media_ordinal);
create unique index if not exists publish_assets_media_identity_unique
  on public.publish_assets(publish_intent_id, source_media_key, media_ordinal);
create index if not exists publish_assets_owner_status_idx
  on public.publish_assets(owner_user_id, status, updated_at desc);

create table if not exists public.publish_asset_deliveries (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.publish_assets(id) on delete restrict,
  publish_intent_id uuid not null references public.publish_intents(id) on delete restrict,
  destination_id text not null,
  provider text not null,
  delivery_mode text not null check (delivery_mode in ('provider_bytes','signed_url','public_copy','mock')),
  status text not null default 'prepared' check (status in ('prepared','materializing','ready','failed','canceled','delivery_unknown')),
  idempotency_key text not null,
  lease_token uuid,
  lease_expires_at timestamptz,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ready_at timestamptz,
  unique (publish_intent_id, destination_id),
  unique (id, destination_id),
  unique (idempotency_key)
);
alter table public.publish_asset_deliveries drop constraint if exists publish_asset_deliveries_status_check;
alter table public.publish_asset_deliveries add constraint publish_asset_deliveries_status_check
  check (status in ('prepared','materializing','ready','published','failed','canceled','delivery_unknown'));
create index if not exists publish_asset_deliveries_lease_idx
  on public.publish_asset_deliveries(status, lease_expires_at);

create table if not exists public.publish_asset_delivery_items (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.publish_asset_deliveries(id) on delete restrict,
  asset_id uuid not null references public.publish_assets(id) on delete restrict,
  owner_user_id uuid not null,
  destination_id text not null,
  media_ordinal integer not null,
  item_status text not null default 'prepared' check (item_status in ('prepared','ready','failed','canceled')),
  created_at timestamptz not null default now(),
  unique (delivery_id, media_ordinal),
  unique (delivery_id, asset_id),
  foreign key (delivery_id, destination_id) references public.publish_asset_deliveries(id, destination_id) on delete restrict
);
create unique index if not exists publish_asset_delivery_items_owner_key
  on public.publish_asset_delivery_items(owner_user_id, delivery_id, media_ordinal);

create table if not exists public.provider_publish_attempts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  publish_intent_id uuid not null references public.publish_intents(id) on delete restrict,
  destination_id text not null,
  delivery_id uuid references public.publish_asset_deliveries(id) on delete restrict,
  attempt integer not null check (attempt > 0),
  idempotency_key text not null,
  status text not null default 'started' check (status in ('started','succeeded','failed','unknown')),
  provider_status integer,
  remote_id text,
  remote_url text,
  evidence jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (publish_intent_id, destination_id, attempt),
  unique (idempotency_key)
);
alter table public.provider_publish_attempts add column if not exists claim_token uuid;
-- Preserve the immutable claim identity after settlement clears the live token.
alter table public.provider_publish_attempts add column if not exists claim_token_identity uuid;
update public.provider_publish_attempts set claim_token_identity=claim_token
  where claim_token_identity is null and claim_token is not null;
do $v76_claim_identity$
begin
  if exists (select 1 from public.provider_publish_attempts
    where claim_token_identity is null
      or (claim_token is not null and claim_token is distinct from claim_token_identity)) then
    raise exception using errcode='P0001',message='v76_claim_identity_invalid';
  end if;
end $v76_claim_identity$;
alter table public.provider_publish_attempts alter column claim_token_identity set not null;

-- A custom GUC is caller-writable and is not an authorization boundary. Only
-- the SECURITY DEFINER settlement RPC can create this transaction-local proof;
-- it removes it immediately after updating the matching attempt. Rollback also
-- removes it. No caller role can read, forge, or retain a proof for later use.
create table if not exists public.v76_provider_settlement_context (
  transaction_id bigint not null,
  attempt_id uuid not null references public.provider_publish_attempts(id) on delete restrict,
  claim_token uuid not null,
  terminal_status text not null check (terminal_status in ('succeeded','failed','unknown')),
  primary key(transaction_id,attempt_id)
);
alter table public.v76_provider_settlement_context enable row level security;
revoke all on public.v76_provider_settlement_context from public,anon,authenticated,service_role;

-- Backfill only omitted owner columns. A conflicting owner or broken graph is
-- historical evidence, not something a migration may silently reassign.
alter table public.publish_intent_destinations add column if not exists owner_user_id uuid;
alter table public.publish_asset_deliveries add column if not exists owner_user_id uuid;
lock table public.publish_assets, public.publish_asset_delivery_items,
  public.provider_publish_attempts in share row exclusive mode;
do $v76_owner_backfill$
begin
  if exists (select 1 from public.publish_intent_destinations d
    left join public.publish_intents i on i.id=d.publish_intent_id
    where i.id is null or (d.owner_user_id is not null and d.owner_user_id<>i.user_id))
    or exists (select 1 from public.publish_assets a
      left join public.publish_intents i on i.id=a.publish_intent_id
      where i.id is null or a.owner_user_id is distinct from i.user_id)
    or exists (select 1 from public.publish_asset_deliveries d
      left join public.publish_intents i on i.id=d.publish_intent_id
      left join public.publish_assets a on a.id=d.asset_id
      left join public.publish_intent_destinations target
        on target.publish_intent_id=d.publish_intent_id and target.destination_id=d.destination_id
      where i.id is null or a.id is null or target.id is null
        or (d.owner_user_id is not null and d.owner_user_id<>i.user_id)
        or a.owner_user_id is distinct from i.user_id
        or a.publish_intent_id is distinct from d.publish_intent_id)
    or exists (select 1 from public.publish_asset_delivery_items item
      left join public.publish_asset_deliveries delivery on delivery.id=item.delivery_id
      left join public.publish_intents i on i.id=delivery.publish_intent_id
      left join public.publish_assets a on a.id=item.asset_id
      where delivery.id is null or i.id is null or a.id is null
        or item.owner_user_id is distinct from i.user_id
        or a.owner_user_id is distinct from i.user_id
        or a.publish_intent_id is distinct from delivery.publish_intent_id
        or item.destination_id is distinct from delivery.destination_id)
    or exists (select 1 from public.provider_publish_attempts attempt
      left join public.publish_intents i on i.id=attempt.publish_intent_id
      left join public.publish_asset_deliveries delivery on delivery.id=attempt.delivery_id
      where i.id is null or delivery.id is null
        or attempt.owner_user_id is distinct from i.user_id
        or delivery.publish_intent_id is distinct from attempt.publish_intent_id
        or delivery.destination_id is distinct from attempt.destination_id) then
    raise exception using errcode='P0001',message='v76_owner_chain_invalid';
  end if;
  update public.publish_intent_destinations d set owner_user_id=i.user_id
    from public.publish_intents i where i.id=d.publish_intent_id and d.owner_user_id is null;
  update public.publish_asset_deliveries d set owner_user_id=i.user_id
    from public.publish_intents i where i.id=d.publish_intent_id and d.owner_user_id is null;
end $v76_owner_backfill$;

-- Legacy v72/v73 inserts omit owner_user_id; derive it from the locked parent.
-- Existing rows cannot be reparented, including secondary media assets.
create or replace function public.v76_bind_publish_owner() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v76:v76-bind-publish-owner
declare v_owner uuid;
begin
  select user_id into v_owner from public.publish_intents
    where id=new.publish_intent_id for key share;
  if not found then
    raise exception using errcode='23503',message='v76_owner_parent_missing';
  end if;
  if (new.owner_user_id is not null and new.owner_user_id is distinct from v_owner)
     or (tg_op='UPDATE' and (new.publish_intent_id is distinct from old.publish_intent_id
       or new.owner_user_id is distinct from old.owner_user_id)) then
    raise exception using errcode='23503',message='v76_owner_mismatch';
  end if;
  new.owner_user_id := v_owner;
  return new;
end $fn$;
revoke all on function public.v76_bind_publish_owner() from public,anon,authenticated,service_role;
drop trigger if exists v76_bind_publish_owner on public.publish_intent_destinations;
create trigger v76_bind_publish_owner before insert or update on public.publish_intent_destinations
  for each row execute function public.v76_bind_publish_owner();
drop trigger if exists v76_bind_publish_owner on public.publish_asset_deliveries;
create trigger v76_bind_publish_owner before insert or update on public.publish_asset_deliveries
  for each row execute function public.v76_bind_publish_owner();
drop trigger if exists v76_bind_publish_owner on public.publish_assets;
create trigger v76_bind_publish_owner before insert or update on public.publish_assets
  for each row execute function public.v76_bind_publish_owner();
alter table public.publish_intent_destinations alter column owner_user_id set not null;
alter table public.publish_asset_deliveries alter column owner_user_id set not null;
alter table public.provider_publish_attempts alter column delivery_id set not null;

-- Validate named targets and FKs structurally. IF NOT EXISTS alone could accept
-- a constraint with the right name but weaker columns or deletion semantics.
do $v76_owner_constraints$
declare
  v_spec record;
  v_constraint pg_constraint%rowtype;
  v_source regclass;
  v_target regclass;
  v_source_keys smallint[];
  v_target_keys smallint[];
begin
  for v_spec in select * from (values
    ('u','publish_intents','publish_intents_v76_owner_id_unique',
      array['user_id','id']::text[],null,array[]::text[]),
    ('u','publish_intent_destinations','publish_destinations_v76_owner_target_unique',
      array['owner_user_id','publish_intent_id','destination_id']::text[],null,array[]::text[]),
    ('u','publish_assets','publish_assets_v76_owner_id_intent_unique',
      array['owner_user_id','id','publish_intent_id']::text[],null,array[]::text[]),
    ('u','publish_assets','publish_assets_v76_owner_id_unique',
      array['owner_user_id','id']::text[],null,array[]::text[]),
    ('u','publish_asset_deliveries','publish_deliveries_v76_owner_id_target_unique',
      array['owner_user_id','id','destination_id']::text[],null,array[]::text[]),
    ('f','publish_intent_destinations','publish_destinations_v76_owner_intent_fk',
      array['owner_user_id','publish_intent_id']::text[],'publish_intents',array['user_id','id']::text[]),
    ('f','publish_assets','publish_assets_v76_owner_intent_fk',
      array['owner_user_id','publish_intent_id']::text[],'publish_intents',array['user_id','id']::text[]),
    ('f','publish_asset_deliveries','publish_deliveries_v76_owner_asset_intent_fk',
      array['owner_user_id','asset_id','publish_intent_id']::text[],'publish_assets',array['owner_user_id','id','publish_intent_id']::text[]),
    ('f','publish_asset_deliveries','publish_deliveries_v76_owner_destination_fk',
      array['owner_user_id','publish_intent_id','destination_id']::text[],'publish_intent_destinations',array['owner_user_id','publish_intent_id','destination_id']::text[]),
    ('f','publish_asset_delivery_items','publish_items_v76_owner_delivery_target_fk',
      array['owner_user_id','delivery_id','destination_id']::text[],'publish_asset_deliveries',array['owner_user_id','id','destination_id']::text[]),
    ('f','publish_asset_delivery_items','publish_items_v76_owner_asset_fk',
      array['owner_user_id','asset_id']::text[],'publish_assets',array['owner_user_id','id']::text[]),
    ('f','provider_publish_attempts','publish_attempts_v76_owner_delivery_target_fk',
      array['owner_user_id','delivery_id','destination_id']::text[],'publish_asset_deliveries',array['owner_user_id','id','destination_id']::text[]),
    ('f','provider_publish_attempts','publish_attempts_v76_owner_destination_fk',
      array['owner_user_id','publish_intent_id','destination_id']::text[],'publish_intent_destinations',array['owner_user_id','publish_intent_id','destination_id']::text[])
  ) spec(kind,source_table,constraint_name,source_columns,target_table,target_columns)
  loop
    v_source := ('public.'||v_spec.source_table)::regclass;
    select array_agg(a.attnum order by c.ordinal) into v_source_keys
      from unnest(v_spec.source_columns) with ordinality c(name,ordinal)
      join pg_attribute a on a.attrelid=v_source and a.attname=c.name and not a.attisdropped;
    if cardinality(v_source_keys) is distinct from cardinality(v_spec.source_columns) then
      raise exception using errcode='P0001',message='v76_owner_constraint_tamper';
    end if;
    if v_spec.kind='f' then
      v_target := ('public.'||v_spec.target_table)::regclass;
      select array_agg(a.attnum order by c.ordinal) into v_target_keys
        from unnest(v_spec.target_columns) with ordinality c(name,ordinal)
        join pg_attribute a on a.attrelid=v_target and a.attname=c.name and not a.attisdropped;
      if cardinality(v_target_keys) is distinct from cardinality(v_spec.target_columns) then
        raise exception using errcode='P0001',message='v76_owner_constraint_tamper';
      end if;
    end if;
    select * into v_constraint from pg_constraint
      where conrelid=v_source and conname=v_spec.constraint_name;
    if found then
      if v_constraint.contype::text<>v_spec.kind
         or v_constraint.conkey is distinct from v_source_keys
         or v_constraint.condeferrable or v_constraint.condeferred
         or not v_constraint.convalidated
         or (v_spec.kind='f' and (
           v_constraint.confrelid is distinct from v_target
           or v_constraint.confkey is distinct from v_target_keys
           or v_constraint.confdeltype<>'r' or v_constraint.confupdtype<>'a'
           or v_constraint.confmatchtype<>'s'))
         or (v_spec.kind='u' and not exists (select 1 from pg_index
           where indexrelid=v_constraint.conindid and indisunique and indisvalid and indisready)) then
        raise exception using errcode='P0001',message='v76_owner_constraint_tamper';
      end if;
    elsif v_spec.kind='u' then
      execute format('alter table public.%I add constraint %I unique (%s)',
        v_spec.source_table,v_spec.constraint_name,array_to_string(v_spec.source_columns,','));
    else
      execute format('alter table public.%I add constraint %I foreign key (%s) references public.%I (%s) on delete restrict',
        v_spec.source_table,v_spec.constraint_name,array_to_string(v_spec.source_columns,','),
        v_spec.target_table,array_to_string(v_spec.target_columns,','));
    end if;
  end loop;

  -- Only the exact v72 FK is eligible for replacing CASCADE. The new composite
  -- owner/intent FK above provides RESTRICT without deleting historical rows.
  select * into v_constraint from pg_constraint
    where conrelid='public.publish_intent_destinations'::regclass
      and conname='publish_intent_destinations_publish_intent_id_fkey';
  if found then
    if v_constraint.contype<>'f'
       or v_constraint.confrelid<>'public.publish_intents'::regclass
       or v_constraint.conkey is distinct from array[(select attnum from pg_attribute
         where attrelid='public.publish_intent_destinations'::regclass and attname='publish_intent_id')]::smallint[]
       or v_constraint.confkey is distinct from array[(select attnum from pg_attribute
         where attrelid='public.publish_intents'::regclass and attname='id')]::smallint[]
       or v_constraint.confdeltype not in ('c','r') or v_constraint.confupdtype<>'a'
       or v_constraint.confmatchtype<>'s' or v_constraint.condeferrable
       or v_constraint.condeferred or not v_constraint.convalidated then
      raise exception using errcode='P0001',message='v76_owner_constraint_tamper';
    end if;
    if v_constraint.confdeltype='c' then
      alter table public.publish_intent_destinations
        drop constraint publish_intent_destinations_publish_intent_id_fkey;
    end if;
  end if;
exception when others then
  raise exception using errcode='P0001',message=case sqlerrm
    when 'v76_owner_constraint_tamper' then 'v76_owner_constraint_tamper'
    else 'v76_owner_constraint_invalid' end;
end $v76_owner_constraints$;


-- Owner FKs also need a same-intent check for secondary media items and attempts:
-- two rows belonging to one owner may still refer to different publish intents.
create or replace function public.v76_evidence_owner_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v76:v76-evidence-owner-guard
begin
  if tg_table_name='publish_asset_delivery_items' then
    if tg_op='UPDATE' and row(new.id,new.owner_user_id,new.delivery_id,new.asset_id,
        new.destination_id,new.media_ordinal) is distinct from
      row(old.id,old.owner_user_id,old.delivery_id,old.asset_id,old.destination_id,old.media_ordinal) then
      raise exception using errcode='55000',message='v76_delivery_item_identity_immutable';
    end if;
    perform 1 from public.publish_asset_deliveries delivery
      join public.publish_assets asset on asset.id=new.asset_id
      where delivery.id=new.delivery_id and delivery.owner_user_id=new.owner_user_id
        and delivery.destination_id=new.destination_id and asset.owner_user_id=new.owner_user_id
        and asset.publish_intent_id=delivery.publish_intent_id
      for key share of delivery,asset;
  elsif tg_table_name='provider_publish_attempts' then
    if tg_op='UPDATE' then
      if row(new.id,new.owner_user_id,new.publish_intent_id,new.destination_id,
          new.delivery_id,new.attempt,new.idempotency_key,new.claim_token_identity) is distinct from
        row(old.id,old.owner_user_id,old.publish_intent_id,old.destination_id,
          old.delivery_id,old.attempt,old.idempotency_key,old.claim_token_identity) then
        raise exception using errcode='55000',message='v76_provider_attempt_identity_immutable';
      end if;
      if new.claim_token is distinct from old.claim_token or new.status is distinct from old.status then
        if old.status<>'started' or new.status not in ('succeeded','failed','unknown')
           or old.claim_token is null or new.claim_token is not null
           or not exists (select 1 from public.v76_provider_settlement_context proof
             where proof.transaction_id=txid_current() and proof.attempt_id=old.id
               and proof.claim_token=old.claim_token and proof.terminal_status=new.status) then
          raise exception using errcode='55000',message='v76_provider_attempt_claim_token_immutable';
        end if;
      end if;
    else
      if new.claim_token is null or new.status<>'started'
         or (new.claim_token_identity is not null and new.claim_token_identity is distinct from new.claim_token) then
        raise exception using errcode='55000',message='v76_provider_attempt_claim_token_immutable';
      end if;
      new.claim_token_identity := new.claim_token;
    end if;
    perform 1 from public.publish_asset_deliveries delivery
      where delivery.id=new.delivery_id and delivery.owner_user_id=new.owner_user_id
        and delivery.destination_id=new.destination_id
        and delivery.publish_intent_id=new.publish_intent_id
      for key share;
  else
    raise exception using errcode='23503',message='v76_owner_mismatch';
  end if;
  if not found then
    raise exception using errcode='23503',message='v76_owner_mismatch';
  end if;
  return new;
end $fn$;
revoke all on function public.v76_evidence_owner_guard() from public,anon,authenticated,service_role;
drop trigger if exists v76_evidence_owner_guard on public.publish_asset_delivery_items;
create trigger v76_evidence_owner_guard before insert or update on public.publish_asset_delivery_items
  for each row execute function public.v76_evidence_owner_guard();
drop trigger if exists v76_evidence_owner_guard on public.provider_publish_attempts;
create trigger v76_evidence_owner_guard before insert or update on public.provider_publish_attempts
  for each row execute function public.v76_evidence_owner_guard();

alter table public.media_cleanup_outbox add column if not exists dedupe_key text;
alter table public.media_cleanup_outbox add column if not exists lease_token uuid;
alter table public.media_cleanup_outbox add column if not exists lease_expires_at timestamptz;
alter table public.media_cleanup_outbox add column if not exists next_attempt_at timestamptz;
alter table public.media_cleanup_outbox add column if not exists last_error_code text;
alter table public.media_cleanup_outbox add column if not exists dead_lettered_at timestamptz;
create unique index if not exists media_cleanup_outbox_dedupe_unique
  on public.media_cleanup_outbox(dedupe_key) where dedupe_key is not null;

alter table public.publish_intents enable row level security;
alter table public.publish_intent_destinations enable row level security;
alter table public.publish_assets enable row level security;
alter table public.publish_asset_deliveries enable row level security;
alter table public.publish_asset_delivery_items enable row level security;
alter table public.provider_publish_attempts enable row level security;
revoke all on public.publish_assets, public.publish_asset_deliveries, public.provider_publish_attempts from public, anon, authenticated;
revoke all on public.publish_asset_delivery_items from public, anon, authenticated;
revoke all on public.publish_assets,public.publish_asset_deliveries from public,anon,authenticated,service_role;
grant select on public.publish_assets,public.publish_asset_deliveries to service_role;
revoke all on public.publish_asset_delivery_items,public.provider_publish_attempts from service_role;
-- Evidence writes belong exclusively to the owner-executed SECURITY DEFINER
-- RPCs. Service callers may inspect evidence but cannot forge it with table DML.
revoke insert,update,delete on public.publish_asset_delivery_items,public.provider_publish_attempts from public,anon,authenticated,service_role;
grant select on public.publish_asset_delivery_items,public.provider_publish_attempts to service_role;
-- Service callers use the owner-executed RPCs for intent transitions.  They
-- must not be able to forge legacy/frozen or published state with table DML.
revoke all on public.publish_intents,public.publish_intent_destinations from service_role;
grant select on public.publish_intents,public.publish_intent_destinations to service_role;

do $v76_preflight$
begin
  if to_regclass('public.social_connections') is null then
    raise exception 'v76 refused: social_connections relation is required';
  end if;
  if not exists (select 1 from pg_attribute where attrelid='public.social_connections'::regclass and attname='connection_status' and atttypid='text'::regtype)
     or not exists (select 1 from pg_attribute where attrelid='public.social_connections'::regclass and attname='provider' and atttypid='text'::regtype)
     or not exists (select 1 from pg_attribute where attrelid='public.social_connections'::regclass and attname='user_id' and atttypid='uuid'::regtype) then
    raise exception 'v76 refused: social_connections shape is incompatible';
  end if;
  if exists (select 1 from pg_constraint where conname='publish_assets_signed_url_forbidden') then
    null;
  else
    -- Signed URLs are JIT values and are deliberately not persisted.
    alter table public.publish_assets add constraint publish_assets_signed_url_forbidden check (true);
  end if;
end $v76_preflight$;

create or replace function public.v76_legacy_transition_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
-- vibepin:v76:v76-legacy-transition-guard
declare
  v_lifecycle text;
  v_source_revision text;
  v_frozen boolean;
begin
  select lifecycle_status,source_revision,v76_frozen_legacy
    into v_lifecycle,v_source_revision,v_frozen
    from public.publish_intents where id=new.publish_intent_id;
  if coalesce(v_frozen,false) then return new; end if;

  if new.status='claimed' or new.claim_token is not null then
    if nullif(btrim(coalesce(v_source_revision,'')),'') is null
       or new.source_revision is distinct from v_source_revision
       or new.materialization_status <> 'materialized'
       or not exists (
         select 1 from public.publish_asset_deliveries delivery
          where delivery.publish_intent_id=new.publish_intent_id
            and delivery.destination_id=new.destination_id
            and delivery.status='ready'
            and (select count(*) from public.publish_asset_delivery_items item
                  where item.delivery_id=delivery.id)
                = (select count(*) from public.publish_assets asset
                    where asset.publish_intent_id=new.publish_intent_id)
            and not exists (
              select 1 from public.publish_assets asset
               where asset.publish_intent_id=new.publish_intent_id
                 and not exists (
                   select 1 from public.publish_asset_delivery_items item
                    where item.delivery_id=delivery.id and item.asset_id=asset.id
                 )
            )
            and exists (
              select 1 from public.publish_asset_delivery_items item
               join public.publish_assets asset on asset.id=item.asset_id
              where item.delivery_id=delivery.id
                and item.destination_id=new.destination_id
                and item.item_status='ready'
                and asset.publish_intent_id=new.publish_intent_id
                and asset.source_revision=v_source_revision
                and asset.status='ready'
            )
            and not exists (
              select 1 from public.publish_asset_delivery_items item
               join public.publish_assets asset on asset.id=item.asset_id
              where item.delivery_id=delivery.id
                and (item.item_status<>'ready' or asset.status<>'ready'
                     or asset.source_revision<>v_source_revision)
            )
       ) then
      raise exception using errcode='55000', message='materialization_required';
    end if;
  end if;

  if new.status in ('published','failed','delivery_unknown')
     and (tg_op='INSERT' or new.status is distinct from old.status)
     and not (new.status='failed' and old.status='materializing'
       and new.materialization_status='materialization_failed') then
    if tg_op<>'UPDATE' or old.status<>'claimed' or old.claim_token is null
       or not exists (
         select 1 from public.provider_publish_attempts attempt
          where attempt.publish_intent_id=new.publish_intent_id
            and attempt.destination_id=new.destination_id
            and attempt.claim_token_identity=old.claim_token
            and attempt.status=case new.status
              when 'published' then 'succeeded'
              when 'failed' then 'failed'
              else 'unknown' end
       ) then
      raise exception using errcode='55000',message=case new.status
        when 'published' then 'provider_success_required'
        when 'failed' then 'provider_failure_required'
        else 'provider_unknown_required' end;
    end if;
  end if;
  return new;
end $fn$;
;
drop trigger if exists v76_legacy_transition_guard on public.publish_intent_destinations;
create trigger v76_legacy_transition_guard before insert or update on public.publish_intent_destinations
  for each row execute function public.v76_legacy_transition_guard();

-- The receipt is the sole target authority. Confirmation and preparation are a
-- single transaction: callers cannot create an intent first and later narrow or
-- widen its destination set. Replays lock and compare the immutable receipt and
-- the complete materialization graph instead of partially repairing it.
create or replace function public.publish_intent_confirm_prepare(
  p_user_id uuid,
  p_receipt jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v76:publish-intent-confirm-prepare
declare
  v_intent public.publish_intents%rowtype;
  v_inserted boolean := false;
  v_intent_id text := btrim(coalesce(p_receipt->>'intentId',''));
  v_fingerprint text := btrim(coalesce(p_receipt->>'fingerprint',''));
  v_draft_id text := btrim(coalesce(p_receipt->>'draftId',''));
  v_content_id text := btrim(coalesce(p_receipt->>'contentId',''));
  v_source_revision text := btrim(coalesce(p_receipt->>'sourceUpdatedAt',''));
  v_confirmed_at timestamptz;
  v_source_at timestamptz;
  v_destination jsonb;
  v_parent_destination public.publish_intent_destinations%rowtype;
  v_destination_id text;
  v_provider text;
  v_connection_id text;
  v_board_id text;
  v_media jsonb;
  v_media_key text;
  v_ordinal integer;
  v_asset_id uuid;
  v_delivery_id uuid;
  v_count integer;
  v_prior_intent_id text := nullif(btrim(coalesce(p_receipt->>'priorIntentId','')), '');
  v_new_retry boolean := false;
  v_parent_internal_id uuid;
  v_canonical_destinations jsonb := '[]'::jsonb;
  v_canonical_media jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_receipt) is distinct from 'object'
     or jsonb_typeof(p_receipt->'dispatchDestinationIds') is distinct from 'array'
     or jsonb_typeof(p_receipt->'publishableDestinations') is distinct from 'array'
     or jsonb_typeof(p_receipt->'media') is distinct from 'array' then
    raise exception using errcode='22023',message='invalid_publish_receipt';
  end if;
  if p_user_id is null
     or jsonb_typeof(p_receipt) <> 'object'
     or v_intent_id !~ '^publish:.{1,240}$'
     or v_fingerprint !~ '^[0-9a-f]{64}$'
     or v_draft_id = '' or v_content_id = '' or v_source_revision = ''
     or p_receipt->'mode' is distinct from '{"kind":"now"}'::jsonb
     or jsonb_typeof(p_receipt->'dispatchDestinationIds') <> 'array'
     or jsonb_array_length(p_receipt->'dispatchDestinationIds') = 0
     or jsonb_typeof(p_receipt->'publishableDestinations') <> 'array'
     or jsonb_typeof(p_receipt->'media') <> 'array'
     or jsonb_array_length(p_receipt->'media') = 0 then
    raise exception using errcode='22023', message='invalid_publish_receipt';
  end if;

  if exists (select 1 from (values
      (p_receipt->'intentId'),(p_receipt->'draftId'),(p_receipt->'contentId')
    ) identity(value)
    where jsonb_typeof(value) is distinct from 'string'
       or value #>> '{}' !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$'
       or value #>> '{}' like '%..%'
       or regexp_replace(lower(value #>> '{}'),'[^a-z0-9]','','g')
         ~ '(token|signature|credential|cookie|auth|bearer|secret|apikey|accesskey|privatekey|password|passwd|session)'
       or value #>> '{}' ~* '(^|[^a-z0-9])sig([^a-z0-9]|$)')
     or jsonb_typeof(p_receipt->'sourceUpdatedAt') is distinct from 'string'
     or v_source_revision !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$'
     or jsonb_typeof(p_receipt->'confirmedAt') is distinct from 'string'
     or (p_receipt->>'confirmedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$' then
    raise exception using errcode='22023',message='invalid_publish_receipt';
  end if;

  begin
    v_confirmed_at := (p_receipt->>'confirmedAt')::timestamptz;
    v_source_at := v_source_revision::timestamptz;
    if v_confirmed_at is null or not isfinite(v_confirmed_at)
       or v_source_at is null or not isfinite(v_source_at) then
      raise exception using errcode='22023',message='invalid_publish_receipt';
    end if;
    v_source_revision := to_char(v_source_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  exception when others then
    raise exception using errcode='22023', message='invalid_publish_receipt';
  end;

  if exists (select 1 from (
      select value from jsonb_array_elements(p_receipt->'dispatchDestinationIds')
      union all
      select value->'id' from jsonb_array_elements(p_receipt->'publishableDestinations')
      union all
      select value->'boardId' from jsonb_array_elements(p_receipt->'publishableDestinations')
        where value ? 'boardId' and value->'boardId'<>'null'::jsonb
    ) identity(value)
    where jsonb_typeof(value) is distinct from 'string'
       or coalesce(value #>> '{}','') !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$'
       or value #>> '{}' like '%..%'
       or regexp_replace(lower(value #>> '{}'),'[^a-z0-9]','','g')
         ~ '(token|signature|credential|cookie|auth|bearer|secret|apikey|accesskey|privatekey|password|passwd|session)'
       or value #>> '{}' ~* '(^|[^a-z0-9])sig([^a-z0-9]|$)') then
    raise exception using errcode='22023',message='invalid_publish_receipt';
  end if;

  if jsonb_array_length(p_receipt->'publishableDestinations')
       <> jsonb_array_length(p_receipt->'dispatchDestinationIds')
     or exists (
       select 1 from jsonb_array_elements_text(p_receipt->'dispatchDestinationIds') ids(value)
       group by value having nullif(btrim(value),'') is null or count(*) <> 1
     )
     or exists (
       select 1 from jsonb_array_elements(p_receipt->'publishableDestinations') destinations(value)
       group by value->>'id'
       having nullif(btrim(value->>'id'),'') is null or count(*) <> 1
     )
     or exists (
       select 1 from jsonb_array_elements_text(p_receipt->'dispatchDestinationIds') ids(value)
       where not exists (
         select 1 from jsonb_array_elements(p_receipt->'publishableDestinations') destinations(value)
         where destinations.value->>'id'=ids.value
       )
     ) then
    raise exception using errcode='22023', message='receipt_destination_set_invalid';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_receipt->'publishableDestinations') destinations(value)
    group by lower(btrim(value->>'provider')),lower(btrim(value->>'socialConnectionId')),
             coalesce(nullif(btrim(value->>'boardId'),''),'')
    having count(*)>1
  ) then
    raise exception using errcode='22023',message='receipt_destination_alias';
  end if;

  -- Validate every receipt-authorized destination against the real unified
  -- connection row before creating any durable intent state.
  for v_destination in
    select value from jsonb_array_elements(p_receipt->'publishableDestinations') order by value->>'id'
  loop
    v_destination_id := btrim(coalesce(v_destination->>'id',''));
    v_provider := btrim(coalesce(v_destination->>'provider',''));
    v_connection_id := btrim(coalesce(v_destination->>'socialConnectionId',''));
    v_board_id := nullif(btrim(coalesce(v_destination->>'boardId','')), '');
    if v_destination_id=''
       or v_provider not in ('pinterest','instagram','facebook')
       or v_connection_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or (v_provider='pinterest' and v_board_id is null)
       or (v_provider<>'pinterest' and v_board_id is not null)
       or not exists (
         select 1 from public.social_connections connection
          where connection.id::text=lower(v_connection_id)
            and connection.user_id=p_user_id
            and connection.provider=v_provider
            and connection.connection_status='connected'
            and connection.disconnected_at is null
       ) then
      raise exception using errcode='42501', message='receipt_destination_not_connected';
    end if;
    v_canonical_destinations := v_canonical_destinations || jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object('id',v_destination_id,'provider',v_provider,
        'socialConnectionId',lower(v_connection_id),'boardId',v_board_id)));
  end loop;

  -- Stable media keys are part of the receipt and ordinals are derived by the
  -- database. Duplicate or blank keys make the whole confirmation invalid.
  if exists (
    select 1 from jsonb_array_elements(p_receipt->'media') media(value)
    group by value->>'id'
    having nullif(btrim(value->>'id'),'') is null or count(*) <> 1
  ) then
    raise exception using errcode='22023', message='receipt_media_set_invalid';
  end if;
  for v_media in select value from jsonb_array_elements(p_receipt->'media') loop
    v_media_key := v_media->>'id';
    if jsonb_typeof(v_media->'id') is distinct from 'string'
       or coalesce(v_media_key,'') !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$'
       or regexp_replace(lower(v_media_key),'[^a-z0-9]','','g') ~ '(token|signature|credential|cookie|auth|bearer|secret|apikey|accesskey|privatekey|password|passwd|session)'
       or v_media_key ~* '(^|[^a-z0-9])sig([^a-z0-9]|$)'
       or v_media_key like '%..%' then
      raise exception using errcode='22023',message='receipt_media_key_invalid';
    end if;
    if (v_media ? 'kind' and (v_media->>'kind') not in ('image','video'))
       or (v_media ? 'source' and (v_media->>'source') not in
         ('upload','ai','product','legacy'))
       or (v_media ? 'width' and (jsonb_typeof(v_media->'width')<>'number'
         or (v_media->>'width') !~ '^[1-9][0-9]{0,5}$'))
       or (v_media ? 'height' and (jsonb_typeof(v_media->'height')<>'number'
         or (v_media->>'height') !~ '^[1-9][0-9]{0,5}$')) then
      raise exception using errcode='22023',message='receipt_media_metadata_invalid';
    end if;
    v_canonical_media := v_canonical_media || jsonb_build_array(jsonb_strip_nulls(
      jsonb_build_object('id',v_media_key,'kind',v_media->'kind','source',v_media->'source',
        'width',v_media->'width','height',v_media->'height')));
  end loop;
  -- Persist only immutable dispatch identity and typed media metadata. Transient
  -- URLs, content strings, account labels, and arbitrary caller keys never enter
  -- the receipt, including on replay comparison.
  if v_prior_intent_id is not null then
    select child.* into v_intent
      from public.publish_intents child
      join public.publish_intents parent on parent.id=child.prior_intent_id
     where child.user_id=p_user_id and child.intent_id=v_intent_id
       and parent.user_id=p_user_id and parent.intent_id=v_prior_intent_id
     for update of child, parent;
    if found then
      select parent.id into v_parent_internal_id from public.publish_intents parent
       where parent.user_id=p_user_id and parent.intent_id=v_prior_intent_id;
    end if;
    if not found then
      select parent.id into v_parent_internal_id from public.publish_intents parent
       where parent.user_id=p_user_id and parent.intent_id=v_prior_intent_id
         and parent.draft_id=v_draft_id and parent.content_id=v_content_id for update;
      if not found or exists (
        select 1 from jsonb_array_elements(v_canonical_destinations) requested(value)
         left join public.publish_intent_destinations parent_destination
           on parent_destination.publish_intent_id=v_parent_internal_id
          and parent_destination.destination_id=requested.value->>'id'
        where parent_destination.id is null
           or parent_destination.provider is distinct from requested.value->>'provider'
           or parent_destination.social_connection_id is distinct from requested.value->>'socialConnectionId'
           or parent_destination.subdestination_id is distinct from nullif(requested.value->>'boardId','')
           or parent_destination.status<>'failed' or not parent_destination.retry_allowed
      ) then
        raise exception using errcode='P0001',message='retry_not_allowed';
      end if;
      v_new_retry := true;
    end if;
  end if;

  p_receipt := jsonb_strip_nulls(jsonb_build_object('intentId',v_intent_id,'fingerprint',v_fingerprint,
    'priorIntentId',v_prior_intent_id,
    'draftId',v_draft_id,'contentId',v_content_id,'sourceUpdatedAt',v_source_revision,
    'confirmedAt',to_char(v_confirmed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'mode',jsonb_build_object('kind','now'),
    'dispatchDestinationIds',(select jsonb_agg(value->'id' order by value->>'id')
      from jsonb_array_elements(v_canonical_destinations)),
    'publishableDestinations',v_canonical_destinations,'media',v_canonical_media));
  insert into public.publish_intents(
    user_id,intent_id,fingerprint,draft_id,content_id,confirmed_at,mode,receipt,
    lifecycle_status,schedule_at,source_revision,source_fingerprint,prepared_at,
    v76_frozen_legacy,prior_intent_id
  ) values (
    p_user_id,v_intent_id,v_fingerprint,v_draft_id,v_content_id,v_confirmed_at,
    p_receipt->'mode',p_receipt,'prepared',null,v_source_revision,v_fingerprint,
    now(),false,v_parent_internal_id
  ) on conflict(user_id,intent_id) do nothing returning * into v_intent;
  v_inserted := found;

  if not v_inserted then
    select * into v_intent from public.publish_intents
     where user_id=p_user_id and intent_id=v_intent_id for update;
    if not found
       or v_intent.v76_frozen_legacy
       or v_intent.prior_intent_id is distinct from v_parent_internal_id
       or v_intent.fingerprint is distinct from v_fingerprint
       or v_intent.draft_id is distinct from v_draft_id
       or v_intent.content_id is distinct from v_content_id
       or v_intent.confirmed_at is distinct from v_confirmed_at
       or v_intent.mode is distinct from p_receipt->'mode'
       or v_intent.receipt is distinct from p_receipt
       or v_intent.source_revision is distinct from v_source_revision
       or v_intent.source_fingerprint is distinct from v_fingerprint
       or v_intent.lifecycle_status='canceled' then
      raise exception using errcode='23505', message='publish_intent_conflict';
    end if;

    select count(*) into v_count from public.publish_intent_destinations
     where publish_intent_id=v_intent.id;
    if v_count <> jsonb_array_length(p_receipt->'dispatchDestinationIds')
       or exists (
         select 1 from jsonb_array_elements(p_receipt->'publishableDestinations') expected(value)
         where not exists (
           select 1 from public.publish_intent_destinations actual
            where actual.publish_intent_id=v_intent.id
              and actual.destination_id=expected.value->>'id'
              and actual.provider=expected.value->>'provider'
              and actual.social_connection_id=expected.value->>'socialConnectionId'
              and actual.subdestination_id is not distinct from nullif(btrim(coalesce(expected.value->>'boardId','')),'')
         )
       ) then
      raise exception using errcode='23505', message='publish_intent_graph_conflict';
    end if;

    select count(*) into v_count from public.publish_assets
     where publish_intent_id=v_intent.id;
    if v_count <> jsonb_array_length(p_receipt->'media')
       or exists (
         select 1
           from jsonb_array_elements(p_receipt->'media') with ordinality expected(value,ordinal)
          where not exists (
            select 1 from public.publish_assets asset
             where asset.publish_intent_id=v_intent.id
               and asset.owner_user_id=p_user_id
               and asset.source_revision=v_source_revision
               and asset.source_fingerprint=v_fingerprint
               and asset.strategy='provider_bytes'
               and asset.source_media_key=expected.value->>'id'
               and asset.media_ordinal=expected.ordinal-1
          )
       ) then
      raise exception using errcode='23505', message='publish_intent_graph_conflict';
    end if;

    select count(*) into v_count from public.publish_asset_deliveries
     where publish_intent_id=v_intent.id;
    if v_count <> jsonb_array_length(p_receipt->'dispatchDestinationIds')
       or exists (
         select 1 from jsonb_array_elements(p_receipt->'publishableDestinations') expected(value)
          where not exists (
            select 1 from public.publish_asset_deliveries delivery
             where delivery.publish_intent_id=v_intent.id
               and delivery.destination_id=expected.value->>'id'
               and delivery.provider=expected.value->>'provider'
               and delivery.delivery_mode='provider_bytes'
               and delivery.idempotency_key='v76:delivery:'||p_user_id::text||':'||v_intent.id::text||':'||(expected.value->>'id')
               and delivery.asset_id=(
                 select asset.id from public.publish_assets asset
                  where asset.publish_intent_id=v_intent.id and asset.media_ordinal=0
               )
          )
       ) then
      raise exception using errcode='23505', message='publish_intent_graph_conflict';
    end if;

    select count(*) into v_count from public.publish_asset_delivery_items item
     join public.publish_asset_deliveries delivery on delivery.id=item.delivery_id
     where delivery.publish_intent_id=v_intent.id;
    if v_count <> jsonb_array_length(p_receipt->'dispatchDestinationIds')
                    * jsonb_array_length(p_receipt->'media')
       or exists (
         select 1
           from jsonb_array_elements(p_receipt->'publishableDestinations') expected_destination(value)
           cross join jsonb_array_elements(p_receipt->'media') with ordinality expected_media(value,ordinal)
          where not exists (
            select 1
              from public.publish_asset_deliveries delivery
              join public.publish_asset_delivery_items item on item.delivery_id=delivery.id
              join public.publish_assets asset on asset.id=item.asset_id
             where delivery.publish_intent_id=v_intent.id
               and delivery.destination_id=expected_destination.value->>'id'
               and item.owner_user_id=p_user_id
               and item.destination_id=expected_destination.value->>'id'
               and item.media_ordinal=expected_media.ordinal-1
               and asset.publish_intent_id=v_intent.id
               and asset.source_media_key=expected_media.value->>'id'
               and asset.media_ordinal=expected_media.ordinal-1
          )
       ) then
      raise exception using errcode='23505', message='publish_intent_graph_conflict';
    end if;
    return jsonb_build_object('prepared',true,'replayed',true,'intentId',v_intent.id,
      'destinationCount',jsonb_array_length(p_receipt->'dispatchDestinationIds'),
      'sourceRevision',v_intent.source_revision);
  end if;

  v_ordinal := 0;
  for v_media in select value from jsonb_array_elements(p_receipt->'media')
  loop
    v_media_key := btrim(v_media->>'id');
    insert into public.publish_assets(
      owner_user_id,publish_intent_id,source_revision,source_fingerprint,strategy,
      status,source_media_key,media_ordinal
    ) values (
      p_user_id,v_intent.id,v_source_revision,v_fingerprint,'provider_bytes',
      'prepared',v_media_key,v_ordinal
    );
    v_ordinal := v_ordinal+1;
  end loop;

  for v_destination in
    select value from jsonb_array_elements(p_receipt->'publishableDestinations') order by value->>'id'
  loop
    v_destination_id := btrim(v_destination->>'id');
    v_provider := btrim(v_destination->>'provider');
    v_connection_id := lower(btrim(v_destination->>'socialConnectionId'));
    v_board_id := nullif(btrim(coalesce(v_destination->>'boardId','')), '');
    if v_new_retry then
      select * into v_parent_destination from public.publish_intent_destinations
       where publish_intent_id=v_parent_internal_id and destination_id=v_destination_id for update;
      if not found or v_parent_destination.status<>'failed' or not v_parent_destination.retry_allowed then
        raise exception using errcode='P0001',message='retry_not_allowed';
      end if;
      insert into public.publish_intent_destinations(
        publish_intent_id,destination_id,provider,social_connection_id,
        subdestination_id,status,materialization_status,source_revision,
        attempt,retry_allowed,retry_of_destination_id
      ) values (
        v_intent.id,v_destination_id,v_provider,v_connection_id,v_board_id,
        'prepared','prepared',v_source_revision,v_parent_destination.attempt+1,false,v_parent_destination.id
      );
      update public.publish_intent_destinations set retry_allowed=false,updated_at=now()
       where id=v_parent_destination.id and status='failed' and retry_allowed;
      if not found then raise exception using errcode='P0001',message='retry_not_allowed'; end if;
    else
    insert into public.publish_intent_destinations(
      publish_intent_id,destination_id,provider,social_connection_id,
      subdestination_id,status,materialization_status,source_revision
    ) values (
      v_intent.id,v_destination_id,v_provider,v_connection_id,v_board_id,
      'prepared','prepared',v_source_revision
    );
    end if;
    select id into v_asset_id from public.publish_assets
     where publish_intent_id=v_intent.id order by media_ordinal limit 1;
    insert into public.publish_asset_deliveries(
      asset_id,publish_intent_id,destination_id,provider,delivery_mode,status,
      idempotency_key
    ) values (
      v_asset_id,v_intent.id,v_destination_id,v_provider,'provider_bytes','prepared',
      'v76:delivery:'||p_user_id::text||':'||v_intent.id::text||':'||v_destination_id
    ) returning id into v_delivery_id;
    insert into public.publish_asset_delivery_items(
      delivery_id,asset_id,owner_user_id,destination_id,media_ordinal,item_status
    ) select v_delivery_id,asset.id,p_user_id,v_destination_id,asset.media_ordinal,'prepared'
        from public.publish_assets asset where asset.publish_intent_id=v_intent.id;
  end loop;

  return jsonb_build_object('prepared',true,'replayed',false,'intentId',v_intent.id,
    'destinationCount',jsonb_array_length(p_receipt->'dispatchDestinationIds'),
    'sourceRevision',v_source_revision);
exception when others then
  -- Rebuild the exception from static codes; never forward database DETAIL or
  -- an unexpected message that can contain a caller's value.
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'invalid_publish_receipt' then 'invalid_publish_receipt'
    when 'receipt_destination_set_invalid' then 'receipt_destination_set_invalid'
    when 'receipt_destination_alias' then 'receipt_destination_alias'
    when 'receipt_destination_not_connected' then 'receipt_destination_not_connected'
    when 'receipt_media_set_invalid' then 'receipt_media_set_invalid'
    when 'receipt_media_key_invalid' then 'receipt_media_key_invalid'
    when 'receipt_media_metadata_invalid' then 'receipt_media_metadata_invalid'
    when 'retry_not_allowed' then 'retry_not_allowed'
    when 'publish_intent_conflict' then 'publish_intent_conflict'
    when 'publish_intent_graph_conflict' then 'publish_intent_graph_conflict'
    when 'materialization_required' then 'materialization_required'
    when 'provider_success_required' then 'provider_success_required'
    when 'provider_failure_required' then 'provider_failure_required'
    when 'provider_unknown_required' then 'provider_unknown_required'
    else 'v76_rpc_error' end;
end $fn$;

create or replace function public.publish_intent_prepare(
  p_user_id uuid, p_intent_id text, p_fingerprint text, p_source_revision text,
  p_mode jsonb, p_schedule_at timestamptz, p_destinations jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
-- vibepin:v76:publish-intent-prepare
declare v_intent publish_intents%rowtype; v_item jsonb; v_dest publish_intent_destinations%rowtype; v_count integer := 0;
begin
  if p_intent_id !~ '^publish:.{1,240}$' or p_fingerprint !~ '^[0-9a-f]{64}$'
     or nullif(btrim(p_source_revision), '') is null or jsonb_typeof(p_destinations) <> 'array'
     or jsonb_array_length(p_destinations)=0 then raise exception 'invalid_publish_prepare_input' using errcode='22023'; end if;
  if jsonb_typeof(p_mode->'dispatchDestinationIds') <> 'array'
     or (select array_agg(value order by value) from jsonb_array_elements_text(p_mode->'dispatchDestinationIds'))
        is distinct from (select array_agg(value->>'id' order by value->>'id') from jsonb_array_elements(p_destinations)) then
    raise exception 'receipt_destinations_do_not_exactly_match_dispatch_destinations' using errcode='22023';
  end if;
  select * into v_intent from publish_intents where user_id=p_user_id and intent_id=p_intent_id for update;
  if not found then raise exception 'publish_intent_not_found' using errcode='P0002'; end if;
  if v_intent.fingerprint is distinct from p_fingerprint or v_intent.mode is distinct from p_mode then raise exception 'publish_intent_fingerprint_or_mode_conflict' using errcode='23505'; end if;
  if v_intent.source_revision is not null and v_intent.source_revision is distinct from p_source_revision then raise exception 'publish_source_revision_conflict' using errcode='23505'; end if;
  if v_intent.lifecycle_status in ('canceled','settled') then raise exception 'publish_intent_is_terminal' using errcode='55000'; end if;
  update publish_intents set lifecycle_status='prepared', schedule_at=p_schedule_at,
    source_revision=p_source_revision, source_fingerprint=p_fingerprint, prepared_at=coalesce(prepared_at,now()), updated_at=now()
    where id=v_intent.id;
  for v_item in select value from jsonb_array_elements(p_destinations) loop
    if nullif(btrim(v_item->>'id'),'') is null or v_item->>'provider' not in ('pinterest','instagram','facebook') then
      raise exception 'invalid_publish_destination' using errcode='22023';
    end if;
    if nullif(btrim(v_item->>'socialConnectionId'),'') is null or v_item->>'socialConnectionId' = 'unknown' then
      raise exception 'connected_social_destination_required' using errcode='22023';
    end if;
    if not exists (select 1 from social_connections sc where sc.id::text=btrim(v_item->>'socialConnectionId') and sc.user_id=p_user_id and sc.provider=v_item->>'provider' and sc.connection_status='connected' and sc.disconnected_at is null) then
      raise exception 'social_destination_is_not_connected_for_owner' using errcode='42501';
    end if;
    select * into v_dest from publish_intent_destinations where publish_intent_id=v_intent.id and destination_id=btrim(v_item->>'id') for update;
    if found and (v_dest.provider is distinct from v_item->>'provider'
      or v_dest.social_connection_id is distinct from coalesce(nullif(btrim(v_item->>'socialConnectionId'),''),'unknown')
      or v_dest.subdestination_id is distinct from nullif(btrim(v_item->>'boardId'),'')) then
      raise exception 'publish_destination_capability_conflict' using errcode='23505';
    end if;
    if found and v_dest.status in ('published','delivery_unknown') then
      raise exception 'publish_destination_is_terminal' using errcode='55000';
    end if;
    insert into publish_intent_destinations(publish_intent_id,destination_id,provider,social_connection_id,subdestination_id,status,materialization_status,source_revision)
      values(v_intent.id,btrim(v_item->>'id'),v_item->>'provider',coalesce(nullif(btrim(v_item->>'socialConnectionId'),''),'unknown'),nullif(btrim(v_item->>'boardId'),''),'prepared','prepared',p_source_revision)
      on conflict(publish_intent_id,destination_id) do update set source_revision=excluded.source_revision,
        materialization_status=case when publish_intent_destinations.status in ('published','delivery_unknown') then publish_intent_destinations.materialization_status else 'prepared' end,
        updated_at=now();
    v_count := v_count+1;
  end loop;
  return jsonb_build_object('prepared',true,'intentId',v_intent.id,'sourceRevision',p_source_revision,'destinationCount',v_count);
exception when others then
  -- Rebuild the exception from static codes; never forward database DETAIL or
  -- an unexpected message that can contain a caller's value.
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'invalid_publish_prepare_input' then 'invalid_publish_prepare_input'
    when 'receipt_destinations_do_not_exactly_match_dispatch_destinations' then 'receipt_destinations_do_not_exactly_match_dispatch_destinations'
    when 'publish_intent_not_found' then 'publish_intent_not_found'
    when 'publish_intent_fingerprint_or_mode_conflict' then 'publish_intent_fingerprint_or_mode_conflict'
    when 'publish_source_revision_conflict' then 'publish_source_revision_conflict'
    when 'publish_intent_is_terminal' then 'publish_intent_is_terminal'
    when 'invalid_publish_destination' then 'invalid_publish_destination'
    when 'connected_social_destination_required' then 'connected_social_destination_required'
    when 'social_destination_is_not_connected_for_owner' then 'social_destination_is_not_connected_for_owner'
    when 'publish_destination_capability_conflict' then 'publish_destination_capability_conflict'
    when 'publish_destination_is_terminal' then 'publish_destination_is_terminal'
    when 'materialization_required' then 'materialization_required'
    when 'provider_success_required' then 'provider_success_required'
    when 'provider_failure_required' then 'provider_failure_required'
    when 'provider_unknown_required' then 'provider_unknown_required'
    else 'v76_rpc_error' end;
end $fn$;

create or replace function public.publish_asset_lease_materialization(
  p_user_id uuid, p_intent_id text, p_destination_id text, p_lease_token uuid, p_lease_seconds integer default 300
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
-- vibepin:v76:publish-asset-lease-materialization
declare v_i publish_intents%rowtype; v_d publish_intent_destinations%rowtype; v_asset publish_assets%rowtype; v_delivery publish_asset_deliveries%rowtype;
begin
  if p_lease_token is null or p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then raise exception 'invalid_materialization_lease' using errcode='22023'; end if;
  select i.* into v_i from publish_intents i where i.user_id=p_user_id and i.intent_id=p_intent_id for update;
  if not found then raise exception 'publish_intent_not_found' using errcode='P0002'; end if;
  select d.* into v_d from publish_intent_destinations d where d.publish_intent_id=v_i.id and d.destination_id=p_destination_id for update;
  if not found then raise exception 'publish_destination_not_found' using errcode='P0002'; end if;
  if v_d.status in ('published','delivery_unknown') or v_i.lifecycle_status in ('canceled','settled') then raise exception 'publish_destination_is_terminal' using errcode='55000'; end if;
  select * into v_delivery from public.publish_asset_deliveries
   where publish_intent_id=v_i.id and destination_id=v_d.destination_id for update;
  if not found then raise exception using errcode='P0002',message='publish_delivery_not_found'; end if;
  if v_delivery.status='materializing'
     and v_delivery.lease_expires_at>now()
     and v_delivery.lease_token is distinct from p_lease_token then
    raise exception using errcode='40001',message='materialization_already_leased';
  end if;
  if v_delivery.status not in ('prepared','failed','materializing') then
    raise exception using errcode='55000',message='materialization_not_available';
  end if;
  update public.publish_asset_deliveries set status='materializing',lease_token=p_lease_token,
    lease_expires_at=now()+make_interval(secs=>p_lease_seconds),updated_at=now()
   where id=v_delivery.id returning * into v_delivery;
  select * into v_asset from public.publish_assets where id=v_delivery.asset_id;
  update publish_intent_destinations set status='materializing',materialization_status='materializing',
    asset_id=v_asset.id,lease_token=p_lease_token,lease_expires_at=v_delivery.lease_expires_at,updated_at=now()
   where id=v_d.id;
  return jsonb_build_object('leased',true,'assetId',v_asset.id,'deliveryId',v_delivery.id,'leaseToken',p_lease_token,'idempotencyKey',v_delivery.idempotency_key);
exception when others then
  -- Rebuild the exception from static codes; never forward database DETAIL or
  -- an unexpected message that can contain a caller's value.
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'invalid_materialization_lease' then 'invalid_materialization_lease'
    when 'publish_intent_not_found' then 'publish_intent_not_found'
    when 'publish_destination_not_found' then 'publish_destination_not_found'
    when 'publish_destination_is_terminal' then 'publish_destination_is_terminal'
    when 'publish_delivery_not_found' then 'publish_delivery_not_found'
    when 'materialization_already_leased' then 'materialization_already_leased'
    when 'materialization_not_available' then 'materialization_not_available'
    when 'materialization_required' then 'materialization_required'
    when 'provider_success_required' then 'provider_success_required'
    when 'provider_failure_required' then 'provider_failure_required'
    when 'provider_unknown_required' then 'provider_unknown_required'
    else 'v76_rpc_error' end;
end $fn$;

create or replace function public.publish_asset_settle_materialization(
  p_user_id uuid, p_intent_id text, p_destination_id text, p_lease_token uuid, p_status text,
  p_bucket_id text default null, p_object_path text default null,
  p_content_type text default null, p_byte_size bigint default null, p_checksum_sha256 text default null, p_failure_code text default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
-- vibepin:v76:publish-asset-settle-materialization
declare v_d publish_intent_destinations%rowtype; v_asset publish_assets%rowtype;
begin
  if p_status not in ('ready','failed','canceled') then raise exception 'invalid_materialization_settlement' using errcode='22023'; end if;
  if p_failure_code is not null and p_failure_code not in
    ('provider_outcome','source_not_found','source_unavailable','unsupported_media',
     'invalid_media','checksum_mismatch','storage_unavailable','materialization_failed','timeout','canceled') then
    raise exception using errcode='22023',message='invalid_failure_code';
  end if;
  if p_bucket_id is not null and p_bucket_id <> 'generated-private' then
    raise exception using errcode='22023',message='invalid_bucket_id';
  end if;
  if p_content_type is not null and p_content_type not in ('image/png','image/jpeg','image/webp') then
    raise exception using errcode='22023',message='invalid_content_type';
  end if;
  if p_object_path is not null and (
       length(p_object_path)>1024
       or p_object_path !~ '^[A-Za-z0-9_-]+(/[A-Za-z0-9_-][A-Za-z0-9:._-]*)+$'
       or split_part(p_object_path,'/',1) is distinct from p_user_id::text
       or p_object_path like '%..%'
       or regexp_replace(lower(p_object_path),'[^a-z0-9]','','g') ~ '(token|signature|credential|cookie|auth|bearer|secret|apikey|accesskey|privatekey|password|passwd|session)'
       or p_object_path ~* '(^|[^a-z0-9])sig([^a-z0-9]|$)') then
    raise exception using errcode='22023',message='invalid_object_path';
  end if;
  select d.* into v_d from publish_intent_destinations d join publish_intents i on i.id=d.publish_intent_id
    where i.user_id=p_user_id and i.intent_id=p_intent_id and d.destination_id=p_destination_id and d.lease_token=p_lease_token for update;
  if not found then raise exception 'materialization_lease_lost' using errcode='40001'; end if;
  select * into v_asset from publish_assets where id=v_d.asset_id for update;
  if p_status='ready' and (
       nullif(btrim(coalesce(p_bucket_id,'')),'') is null
       or nullif(btrim(coalesce(p_object_path,'')),'') is null
       or coalesce(p_checksum_sha256,'') !~ '^[0-9a-f]{64}$'
     ) then
    raise exception using errcode='22023',message='ready_locator_checksum_required';
  end if;
  if p_status='ready' and v_asset.status='ready' and (
       v_asset.bucket_id is distinct from nullif(btrim(p_bucket_id),'')
       or v_asset.object_path is distinct from nullif(btrim(p_object_path),'')
       or v_asset.content_type is distinct from nullif(btrim(coalesce(p_content_type,'')),'')
       or v_asset.byte_size is distinct from p_byte_size
       or v_asset.checksum_sha256 is distinct from p_checksum_sha256
     ) then
    raise exception using errcode='23505',message='materialized_asset_conflict';
  end if;
  if p_status='ready' and (
    select count(*) from public.publish_asset_delivery_items
     where delivery_id=(select id from public.publish_asset_deliveries
       where publish_intent_id=v_d.publish_intent_id and destination_id=v_d.destination_id)
  ) <> 1 then
    raise exception using errcode='55000',message='multi_media_settlement_required';
  end if;
  -- The asset is intent-scoped and may already have been made ready through a
  -- sibling destination.  A destination-local failure/cancel must not erase
  -- that immutable shared result.
  if p_status='ready' then
    if p_content_type is null then
      raise exception using errcode='22023',message='invalid_content_type';
    end if;
    perform 1 from storage.buckets where id=p_bucket_id and public=false for share;
    if not found then
      raise exception using errcode='22023',message='invalid_bucket_id';
    end if;
    perform 1 from public.media_asset_provenance provenance
     where provenance.owner_user_id=p_user_id and provenance.bucket_id=p_bucket_id
       and provenance.object_path=p_object_path and provenance.intent_id=p_intent_id
       and provenance.source_type in ('upload','generation','publish_copy')
       and provenance.lifecycle_state in ('draft','publish_pending','published','retained')
     for share;
    if not found or v_asset.owner_user_id is distinct from p_user_id
       or v_asset.publish_intent_id is distinct from v_d.publish_intent_id
       or v_asset.source_revision is distinct from v_d.source_revision then
      raise exception using errcode='22023',message='materialization_provenance_required';
    end if;
    update publish_assets set status='ready',
      bucket_id=nullif(btrim(p_bucket_id),''),object_path=nullif(btrim(p_object_path),''),
      content_type=p_content_type,byte_size=p_byte_size,checksum_sha256=p_checksum_sha256,
      failure_code=null,lease_token=null,lease_expires_at=null,
      materialized_at=coalesce(materialized_at,now()),updated_at=now()
     where id=v_asset.id;
  end if;
  update publish_asset_deliveries set status=case when p_status='ready' then 'ready' when p_status='canceled' then 'canceled' else 'failed' end,failure_code=p_failure_code,lease_token=null,lease_expires_at=null,ready_at=case when p_status='ready' then now() else null end,updated_at=now() where asset_id=v_asset.id and destination_id=p_destination_id and lease_token=p_lease_token;
  update public.publish_asset_delivery_items set item_status=case when p_status='ready' then 'ready' when p_status='canceled' then 'canceled' else 'failed' end
   where asset_id=v_asset.id and delivery_id in (
     select id from public.publish_asset_deliveries where publish_intent_id=v_d.publish_intent_id and destination_id=v_d.destination_id
   );
  update publish_intent_destinations set status=case when p_status='ready' then 'prepared' when p_status='canceled' then 'canceled' else 'failed' end,materialization_status=case when p_status='ready' then 'materialized' when p_status='canceled' then 'canceled' else 'materialization_failed' end,lease_token=null,lease_expires_at=null,materialized_at=case when p_status='ready' then now() else null end,updated_at=now() where id=v_d.id;
  return jsonb_build_object('settled',true,'status',p_status,'assetId',v_asset.id);
exception when others then
  -- Rebuild the exception from static codes; never forward database DETAIL or
  -- an unexpected message that can contain a caller's value.
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'invalid_materialization_settlement' then 'invalid_materialization_settlement'
    when 'invalid_failure_code' then 'invalid_failure_code'
    when 'invalid_bucket_id' then 'invalid_bucket_id'
    when 'invalid_content_type' then 'invalid_content_type'
    when 'materialization_provenance_required' then 'materialization_provenance_required'
    when 'invalid_object_path' then 'invalid_object_path'
    when 'materialization_lease_lost' then 'materialization_lease_lost'
    when 'ready_locator_checksum_required' then 'ready_locator_checksum_required'
    when 'materialized_asset_conflict' then 'materialized_asset_conflict'
    when 'multi_media_settlement_required' then 'multi_media_settlement_required'
    when 'materialization_required' then 'materialization_required'
    when 'provider_success_required' then 'provider_success_required'
    when 'provider_failure_required' then 'provider_failure_required'
    when 'provider_unknown_required' then 'provider_unknown_required'
    else 'v76_rpc_error' end;
end $fn$;

create or replace function public.publish_asset_claim_ready(p_user_id uuid,p_intent_id text,p_destination_id text,p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v76:publish-asset-claim-ready
declare v_d publish_intent_destinations%rowtype; v_i publish_intents%rowtype;
begin
  if p_claim_token is null then raise exception using errcode='22023',message='claim_token_required'; end if;
  select * into v_i from public.publish_intents
   where user_id=p_user_id and intent_id=p_intent_id for update;
  if not found then raise exception using errcode='P0002',message='publish_intent_not_found'; end if;
  if v_i.lifecycle_status not in ('prepared','ready','partially_ready')
     or (v_i.schedule_at is not null and v_i.schedule_at>now()) then
    raise exception using errcode='55000',message='publish_intent_not_due';
  end if;
  update publish_intent_destinations d set status='claimed',claim_token=p_claim_token,claimed_at=now(),updated_at=now()
    where d.publish_intent_id=v_i.id
      and d.destination_id=p_destination_id and d.materialization_status='materialized' and d.status='prepared'
      and exists (select 1 from publish_asset_deliveries ad where ad.publish_intent_id=d.publish_intent_id and ad.destination_id=d.destination_id and ad.status='ready')
      and exists (select 1 from public.social_connections connection
        where connection.id::text=d.social_connection_id and connection.user_id=p_user_id
          and connection.provider=d.provider and connection.connection_status='connected'
          and connection.disconnected_at is null)
    returning d.* into v_d;
  if not found then raise exception 'publish_destination_is_not_ready_or_already_claimed' using errcode='40001'; end if;
  return jsonb_build_object('claimed',true,'destinationId',v_d.destination_id,
    'claimToken',v_d.claim_token,'attempt',v_d.attempt);
exception when others then
  -- Rebuild the exception from static codes; never forward database DETAIL or
  -- an unexpected message that can contain a caller's value.
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'claim_token_required' then 'claim_token_required'
    when 'publish_intent_not_found' then 'publish_intent_not_found'
    when 'publish_intent_not_due' then 'publish_intent_not_due'
    when 'publish_destination_is_not_ready_or_already_claimed' then 'publish_destination_is_not_ready_or_already_claimed'
    when 'materialization_required' then 'materialization_required'
    when 'provider_success_required' then 'provider_success_required'
    when 'provider_failure_required' then 'provider_failure_required'
    when 'provider_unknown_required' then 'provider_unknown_required'
    else 'v76_rpc_error' end;
end $fn$;

-- Multi-media settlement is item-scoped. A destination becomes ready only after
-- every immutable receipt asset is ready under the same delivery lease.
create or replace function public.publish_asset_settle_item(
  p_user_id uuid,p_intent_id text,p_destination_id text,p_lease_token uuid,
  p_source_media_key text,p_media_ordinal integer,p_bucket_id text,p_object_path text,
  p_content_type text,p_byte_size bigint,p_checksum_sha256 text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v76:publish-asset-settle-item
declare
  v_intent publish_intents%rowtype;
  v_destination publish_intent_destinations%rowtype;
  v_delivery publish_asset_deliveries%rowtype;
  v_item publish_asset_delivery_items%rowtype;
  v_asset publish_assets%rowtype;
  v_ready boolean;
begin
  if coalesce(p_source_media_key,'') !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$'
     or regexp_replace(lower(p_source_media_key),'[^a-z0-9]','','g') ~ '(token|signature|credential|cookie|auth|bearer|secret|apikey|accesskey|privatekey|password|passwd|session)'
     or p_source_media_key ~* '(^|[^a-z0-9])sig([^a-z0-9]|$)'
     or p_source_media_key like '%..%' then
    raise exception using errcode='22023',message='invalid_source_media_key';
  end if;
  if p_bucket_id is distinct from 'generated-private' then
    raise exception using errcode='22023',message='invalid_bucket_id';
  end if;
  if coalesce(p_object_path,'') !~ '^[A-Za-z0-9_-]+(/[A-Za-z0-9_-][A-Za-z0-9:._-]*)+$'
     or length(p_object_path)>1024 or p_object_path like '%..%'
     or split_part(p_object_path,'/',1) is distinct from p_user_id::text
     or regexp_replace(lower(p_object_path),'[^a-z0-9]','','g') ~ '(token|signature|credential|cookie|auth|bearer|secret|apikey|accesskey|privatekey|password|passwd|session)'
     or p_object_path ~* '(^|[^a-z0-9])sig([^a-z0-9]|$)' then
    raise exception using errcode='22023',message='invalid_object_path';
  end if;
  if coalesce(p_content_type,'') not in ('image/png','image/jpeg','image/webp') then
    raise exception using errcode='22023',message='invalid_content_type';
  end if;
  if p_lease_token is null or nullif(btrim(p_source_media_key),'') is null
     or p_media_ordinal<0 or nullif(btrim(p_bucket_id),'') is null
     or nullif(btrim(p_object_path),'') is null
     or coalesce(p_checksum_sha256,'') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='invalid_materialization_item';
  end if;
  select * into v_intent from public.publish_intents
   where user_id=p_user_id and intent_id=p_intent_id for update;
  if not found then raise exception using errcode='P0002',message='publish_intent_not_found'; end if;
  select * into v_destination from public.publish_intent_destinations
   where publish_intent_id=v_intent.id and destination_id=p_destination_id for update;
  select * into v_delivery from public.publish_asset_deliveries
   where publish_intent_id=v_intent.id and destination_id=p_destination_id for update;
  if not found or v_destination.lease_token is distinct from p_lease_token
     or v_delivery.lease_token is distinct from p_lease_token
     or v_delivery.status<>'materializing' then
    raise exception using errcode='40001',message='materialization_lease_lost';
  end if;
  select item.* into v_item from public.publish_asset_delivery_items item
   join public.publish_assets asset on asset.id=item.asset_id
   where item.delivery_id=v_delivery.id
     and item.owner_user_id=p_user_id
     and item.destination_id=p_destination_id
     and item.media_ordinal=p_media_ordinal
     and asset.publish_intent_id=v_intent.id
     and asset.source_media_key=p_source_media_key
     and asset.media_ordinal=p_media_ordinal
     and asset.source_revision=v_intent.source_revision
   for update of item;
  if not found then raise exception using errcode='P0002',message='materialization_item_not_found'; end if;
  select * into v_asset from public.publish_assets where id=v_item.asset_id for update;
  if v_asset.status='ready' and (
       v_asset.bucket_id is distinct from btrim(p_bucket_id)
       or v_asset.object_path is distinct from btrim(p_object_path)
       or v_asset.checksum_sha256 is distinct from p_checksum_sha256
       or v_asset.content_type is distinct from nullif(btrim(coalesce(p_content_type,'')),'')
       or v_asset.byte_size is distinct from p_byte_size
     ) then
    raise exception using errcode='23505',message='materialized_asset_conflict';
  end if;
  perform 1 from storage.buckets where id=p_bucket_id and public=false for share;
  if not found then
    raise exception using errcode='22023',message='invalid_bucket_id';
  end if;
  perform 1 from public.media_asset_provenance provenance
   where provenance.owner_user_id=p_user_id and provenance.bucket_id=p_bucket_id
     and provenance.object_path=p_object_path and provenance.intent_id=v_intent.intent_id
     and provenance.source_type in ('upload','generation','publish_copy')
     and provenance.lifecycle_state in ('draft','publish_pending','published','retained')
   for share;
  if not found or v_asset.owner_user_id is distinct from p_user_id then
    raise exception using errcode='22023',message='materialization_provenance_required';
  end if;
  update public.publish_assets set status='ready',bucket_id=btrim(p_bucket_id),
    object_path=btrim(p_object_path),content_type=nullif(btrim(coalesce(p_content_type,'')),''),
    byte_size=p_byte_size,checksum_sha256=p_checksum_sha256,failure_code=null,
    lease_token=null,lease_expires_at=null,materialized_at=coalesce(materialized_at,now()),updated_at=now()
   where id=v_asset.id;
  update public.publish_asset_delivery_items set item_status='ready' where id=v_item.id;
  select not exists (
    select 1 from public.publish_asset_delivery_items item
     join public.publish_assets asset on asset.id=item.asset_id
     where item.delivery_id=v_delivery.id
       and (item.item_status<>'ready' or asset.status<>'ready'
            or asset.source_revision<>v_intent.source_revision)
  ) into v_ready;
  if v_ready then
    update public.publish_asset_deliveries set status='ready',lease_token=null,
      lease_expires_at=null,failure_code=null,ready_at=coalesce(ready_at,now()),updated_at=now()
     where id=v_delivery.id;
    update public.publish_intent_destinations set status='prepared',
      materialization_status='materialized',lease_token=null,lease_expires_at=null,
      materialized_at=coalesce(materialized_at,now()),updated_at=now()
     where id=v_destination.id;
  end if;
  return jsonb_build_object('settled',true,'sourceMediaKey',p_source_media_key,
    'mediaOrdinal',p_media_ordinal,'deliveryReady',v_ready,'assetId',v_asset.id);
exception when others then
  -- Rebuild the exception from static codes; never forward database DETAIL or
  -- an unexpected message that can contain a caller's value.
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'invalid_source_media_key' then 'invalid_source_media_key'
    when 'invalid_bucket_id' then 'invalid_bucket_id'
    when 'invalid_content_type' then 'invalid_content_type'
    when 'materialization_provenance_required' then 'materialization_provenance_required'
    when 'invalid_object_path' then 'invalid_object_path'
    when 'invalid_materialization_item' then 'invalid_materialization_item'
    when 'publish_intent_not_found' then 'publish_intent_not_found'
    when 'materialization_lease_lost' then 'materialization_lease_lost'
    when 'materialization_item_not_found' then 'materialization_item_not_found'
    when 'materialized_asset_conflict' then 'materialized_asset_conflict'
    when 'materialization_required' then 'materialization_required'
    when 'provider_success_required' then 'provider_success_required'
    when 'provider_failure_required' then 'provider_failure_required'
    when 'provider_unknown_required' then 'provider_unknown_required'
    else 'v76_rpc_error' end;
end $fn$;

create or replace function public.publish_intent_cancel(p_user_id uuid,p_intent_id text,p_source_revision text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v76:publish-intent-cancel
declare v_intent publish_intents%rowtype;
begin
  select * into v_intent from public.publish_intents
   where user_id=p_user_id and intent_id=p_intent_id for update;
  if not found then raise exception using errcode='P0001',message='cancel_conflict_not_found'; end if;
  if v_intent.source_revision is distinct from nullif(btrim(p_source_revision),'') then
    raise exception using errcode='P0001',message='cancel_conflict_revision';
  end if;
  perform 1 from public.publish_intent_destinations
   where publish_intent_id=v_intent.id order by destination_id for update;
  perform 1 from public.publish_asset_deliveries
   where publish_intent_id=v_intent.id order by destination_id for update;
  perform 1 from public.provider_publish_attempts
   where publish_intent_id=v_intent.id order by destination_id,attempt for update;
  if exists (select 1 from public.provider_publish_attempts where publish_intent_id=v_intent.id and status='started') then
    raise exception using errcode='P0001',message='cancel_conflict_started';
  end if;
  if exists (select 1 from public.provider_publish_attempts where publish_intent_id=v_intent.id and status='unknown')
     or exists (select 1 from public.publish_intent_destinations where publish_intent_id=v_intent.id and status='delivery_unknown') then
    raise exception using errcode='P0001',message='cancel_conflict_unknown';
  end if;
  if exists (select 1 from public.provider_publish_attempts where publish_intent_id=v_intent.id and status='succeeded')
     or exists (select 1 from public.publish_intent_destinations where publish_intent_id=v_intent.id and status='published') then
    raise exception using errcode='P0001',message='cancel_conflict_published';
  end if;
  if exists (select 1 from public.publish_intent_destinations
    where publish_intent_id=v_intent.id and (status='claimed' or claim_token is not null)) then
    raise exception using errcode='P0001',message='cancel_conflict_claimed';
  end if;
  if v_intent.lifecycle_status in ('settled','delivery_unknown') then
    raise exception using errcode='P0001',message='cancel_conflict_terminal';
  end if;
  if v_intent.lifecycle_status='canceled' then
    return jsonb_build_object('canceled',true,'replayed',true,'intentId',v_intent.id);
  end if;
  update publish_intents set lifecycle_status='canceled',canceled_at=now(),updated_at=now() where id=v_intent.id;
  update publish_intent_destinations set status='canceled',materialization_status='canceled',canceled_at=now(),
    claim_token=null,lease_token=null,lease_expires_at=null,updated_at=now()
   where publish_intent_id=v_intent.id;
  update publish_assets set status='canceled',lease_token=null,lease_expires_at=null,updated_at=now()
   where publish_intent_id=v_intent.id and status not in ('ready','retained');
  update publish_asset_deliveries set status='canceled',lease_token=null,lease_expires_at=null,updated_at=now()
   where publish_intent_id=v_intent.id and status not in ('ready');
  return jsonb_build_object('canceled',true,'replayed',false,'intentId',v_intent.id);
exception when others then
  -- Rebuild the exception from static codes; never forward database DETAIL or
  -- an unexpected message that can contain a caller's value.
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'cancel_conflict_not_found' then 'cancel_conflict_not_found'
    when 'cancel_conflict_revision' then 'cancel_conflict_revision'
    when 'cancel_conflict_started' then 'cancel_conflict_started'
    when 'cancel_conflict_unknown' then 'cancel_conflict_unknown'
    when 'cancel_conflict_published' then 'cancel_conflict_published'
    when 'cancel_conflict_claimed' then 'cancel_conflict_claimed'
    when 'cancel_conflict_terminal' then 'cancel_conflict_terminal'
    when 'materialization_required' then 'materialization_required'
    when 'provider_success_required' then 'provider_success_required'
    when 'provider_failure_required' then 'provider_failure_required'
    when 'provider_unknown_required' then 'provider_unknown_required'
    else 'v76_rpc_error' end;
end $fn$;

create or replace function public.publish_cleanup_lease(p_outbox_id bigint,p_lease_token uuid,p_lease_seconds integer default 300)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v76:publish-cleanup-lease
declare v_row media_cleanup_outbox%rowtype;
begin
  if p_lease_token is null or p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then raise exception 'invalid_cleanup_lease' using errcode='22023'; end if;
  update media_cleanup_outbox set status='processing',lease_token=p_lease_token,lease_expires_at=now()+make_interval(secs=>p_lease_seconds),attempts=attempts+1,last_attempted_at=now(),updated_at=now()
    where id=p_outbox_id
      and (status='pending' or (status='processing' and lease_expires_at<=now()
        and lease_token is distinct from p_lease_token))
      and (next_attempt_at is null or next_attempt_at<=now())
      and dead_lettered_at is null returning * into v_row;
  if not found then raise exception 'cleanup_item_unavailable' using errcode='40001'; end if;
  return jsonb_build_object('leased',true,'id',v_row.id,'leaseToken',v_row.lease_token,'attempts',v_row.attempts);
exception when others then
  -- Rebuild the exception from static codes; never forward database DETAIL or
  -- an unexpected message that can contain a caller's value.
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'invalid_cleanup_lease' then 'invalid_cleanup_lease'
    when 'cleanup_item_unavailable' then 'cleanup_item_unavailable'
    when 'materialization_required' then 'materialization_required'
    when 'provider_success_required' then 'provider_success_required'
    when 'provider_failure_required' then 'provider_failure_required'
    when 'provider_unknown_required' then 'provider_unknown_required'
    else 'v76_rpc_error' end;
end $fn$;

create or replace function public.publish_cleanup_settle(p_outbox_id bigint,p_lease_token uuid,p_status text,p_error_code text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v76:publish-cleanup-settle
declare v_row media_cleanup_outbox%rowtype;
begin
  if p_status not in ('done','failed','pending') then raise exception 'invalid_cleanup_settlement' using errcode='22023'; end if;
  if p_error_code is not null and p_error_code not in
    ('object_not_found','storage_unavailable','delete_failed','timeout','rate_limited','permission_denied') then
    raise exception using errcode='22023',message='invalid_cleanup_error_code';
  end if;
  update media_cleanup_outbox set status=p_status, last_error_code=nullif(btrim(p_error_code),''),
    completed_at=case when p_status='done' then now() else null end,
    dead_lettered_at=case when p_status='failed' and attempts >= 10 then now() else null end,
    lease_token=null,lease_expires_at=null,next_attempt_at=case when p_status='pending' then now()+interval '5 minutes' else null end,updated_at=now()
    where id=p_outbox_id and status='processing' and lease_token=p_lease_token returning * into v_row;
  if not found then raise exception 'cleanup_lease_lost' using errcode='40001'; end if;
  return jsonb_build_object('settled',true,'id',v_row.id,'status',v_row.status,'deadLettered',v_row.dead_lettered_at is not null);
exception when others then
  -- Rebuild the exception from static codes; never forward database DETAIL or
  -- an unexpected message that can contain a caller's value.
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'invalid_cleanup_settlement' then 'invalid_cleanup_settlement'
    when 'invalid_cleanup_error_code' then 'invalid_cleanup_error_code'
    when 'cleanup_lease_lost' then 'cleanup_lease_lost'
    when 'materialization_required' then 'materialization_required'
    when 'provider_success_required' then 'provider_success_required'
    when 'provider_failure_required' then 'provider_failure_required'
    when 'provider_unknown_required' then 'provider_unknown_required'
    else 'v76_rpc_error' end;
end $fn$;

drop function if exists public.publish_provider_attempt_start(uuid,text,text,integer,text);
create or replace function public.publish_provider_attempt_start(
  p_user_id uuid,p_intent_id text,p_destination_id text,p_claim_token uuid,p_attempt integer
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v76:publish-provider-attempt-start
declare
  v_i publish_intents%rowtype;
  v_d publish_intent_destinations%rowtype;
  v_delivery publish_asset_deliveries%rowtype;
  v_a provider_publish_attempts%rowtype;
  v_inserted boolean := false;
  v_idempotency_key text;
begin
  if p_claim_token is null or p_attempt<1 then
    raise exception using errcode='22023',message='invalid_provider_attempt';
  end if;
  select * into v_i from public.publish_intents
   where user_id=p_user_id and intent_id=p_intent_id for update;
  if not found then raise exception using errcode='P0002',message='publish_intent_not_found'; end if;
  if v_i.lifecycle_status not in ('prepared','ready','partially_ready')
     or (v_i.schedule_at is not null and v_i.schedule_at>now()) then
    raise exception using errcode='55000',message='provider_attempt_not_due';
  end if;
  select * into v_d from public.publish_intent_destinations
   where publish_intent_id=v_i.id and destination_id=p_destination_id for update;
  if not found or v_d.status<>'claimed' or v_d.claim_token is distinct from p_claim_token
     or v_d.attempt<>p_attempt or v_d.materialization_status<>'materialized'
     or v_d.source_revision is distinct from v_i.source_revision then
    raise exception using errcode='40001',message='provider_claim_lost';
  end if;
  if not exists (
    select 1 from public.social_connections connection
     where connection.id::text=v_d.social_connection_id
       and connection.user_id=p_user_id
       and connection.provider=v_d.provider
       and connection.connection_status='connected'
       and connection.disconnected_at is null
  ) then
    raise exception using errcode='42501',message='provider_connection_not_connected';
  end if;
  select * into v_delivery from public.publish_asset_deliveries
   where publish_intent_id=v_i.id and destination_id=p_destination_id for update;
  if not found or v_delivery.status<>'ready'
     or (select count(*) from public.publish_asset_delivery_items item
          where item.delivery_id=v_delivery.id)
        <> (select count(*) from public.publish_assets asset
             where asset.publish_intent_id=v_i.id)
     or exists (
       select 1 from public.publish_assets asset
        where asset.publish_intent_id=v_i.id
          and not exists (
            select 1 from public.publish_asset_delivery_items item
             where item.delivery_id=v_delivery.id and item.asset_id=asset.id
          )
     )
     or not exists (select 1 from public.publish_asset_delivery_items item
       join public.publish_assets asset on asset.id=item.asset_id
       where item.delivery_id=v_delivery.id and item.item_status='ready' and asset.status='ready')
     or exists (select 1 from public.publish_asset_delivery_items item
       join public.publish_assets asset on asset.id=item.asset_id
       where item.delivery_id=v_delivery.id and (item.item_status<>'ready' or asset.status<>'ready'
         or asset.source_revision<>v_i.source_revision)) then
    raise exception using errcode='55000',message='provider_delivery_not_ready';
  end if;
  v_idempotency_key := 'v76:provider:'||p_user_id::text||':'||v_i.id::text||':'||p_destination_id||':'||p_attempt::text;
  insert into public.provider_publish_attempts(
    owner_user_id,publish_intent_id,destination_id,delivery_id,attempt,
    idempotency_key,status,claim_token,claim_token_identity
  ) values (
    p_user_id,v_i.id,p_destination_id,v_delivery.id,p_attempt,
    v_idempotency_key,'started',p_claim_token,p_claim_token
  ) on conflict(publish_intent_id,destination_id,attempt) do nothing returning * into v_a;
  v_inserted := found;
  if not v_inserted then
    select * into v_a from public.provider_publish_attempts
     where publish_intent_id=v_i.id and destination_id=p_destination_id and attempt=p_attempt for update;
    if not found or v_a.owner_user_id<>p_user_id or v_a.delivery_id<>v_delivery.id
       or v_a.claim_token is distinct from p_claim_token
       or v_a.idempotency_key<>v_idempotency_key then
      raise exception using errcode='23505',message='provider_attempt_conflict';
    end if;
  end if;
  return jsonb_build_object('attemptId',v_a.id,'replayed',not v_inserted,
    'inFlight',v_a.status='started','status',v_a.status,'idempotencyKey',v_a.idempotency_key);
exception when others then
  -- Rebuild the exception from static codes; never forward database DETAIL or
  -- an unexpected message that can contain a caller's value.
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'invalid_provider_attempt' then 'invalid_provider_attempt'
    when 'publish_intent_not_found' then 'publish_intent_not_found'
    when 'provider_attempt_not_due' then 'provider_attempt_not_due'
    when 'provider_claim_lost' then 'provider_claim_lost'
    when 'provider_connection_not_connected' then 'provider_connection_not_connected'
    when 'provider_delivery_not_ready' then 'provider_delivery_not_ready'
    when 'provider_attempt_conflict' then 'provider_attempt_conflict'
    when 'materialization_required' then 'materialization_required'
    when 'provider_success_required' then 'provider_success_required'
    when 'provider_failure_required' then 'provider_failure_required'
    when 'provider_unknown_required' then 'provider_unknown_required'
    else 'v76_rpc_error' end;
end $fn$;

drop function if exists public.publish_provider_attempt_settle(uuid,uuid,text,integer,text,text,jsonb);
create or replace function public.publish_provider_attempt_settle(
  p_user_id uuid,p_attempt_id uuid,p_claim_token uuid,p_status text,
  p_provider_status integer default null,p_remote_id text default null,
  p_remote_url text default null,p_evidence jsonb default '{}'::jsonb
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v76:publish-provider-attempt-settle
declare
  v_a provider_publish_attempts%rowtype;
  v_i publish_intents%rowtype;
  v_d publish_intent_destinations%rowtype;
  v_delivery publish_asset_deliveries%rowtype;
  v_attempt_intent_id uuid;
  v_attempt_destination_id text;
  v_attempt_delivery_id uuid;
begin
  if p_status not in ('succeeded','failed','unknown') then raise exception 'invalid_provider_attempt_settlement' using errcode='22023'; end if;
  if p_claim_token is null then raise exception using errcode='22023',message='claim_token_required'; end if;
  if p_status='succeeded' and (
       nullif(btrim(coalesce(p_remote_id,'')),'') is null
       or coalesce(p_provider_status,0) not between 200 and 299
     ) then
    raise exception using errcode='22023',message='provider_success_evidence_required';
  end if;
  if p_remote_url is not null and (
       length(p_remote_url)>512
       or p_remote_url !~ '^https://((www\.)?pinterest\.com/pin/[0-9]+/?|(www\.)?instagram\.com/(p|reel)/[A-Za-z0-9_-]+/?|(www\.)?facebook\.com/[A-Za-z0-9._-]+/posts/[A-Za-z0-9_-]+/?)$'
       or regexp_replace(lower(p_remote_url),'[^a-z0-9]','','g') ~ '(token|signature|credential|cookie|auth|bearer|secret|apikey|accesskey|privatekey|password|passwd|session)'
       or p_remote_url ~* '(^|[^a-z0-9])sig([^a-z0-9]|$)') then
    raise exception using errcode='22023',message='provider_remote_url_invalid';
  end if;
  if p_remote_id is not null and (
       p_remote_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
       or regexp_replace(lower(p_remote_id),'[^a-z0-9]','','g') ~ '(token|signature|credential|cookie|auth|bearer|secret|apikey|accesskey|privatekey|password|passwd|session)'
       or p_remote_id ~* '(^|[^a-z0-9])sig([^a-z0-9]|$)') then
    raise exception using errcode='22023',message='provider_remote_id_invalid';
  end if;
  if jsonb_typeof(coalesce(p_evidence,'{}'::jsonb))<>'object' then
    raise exception using errcode='22023',message='provider_evidence_invalid';
  end if;
  if exists (select 1 from jsonb_each(coalesce(p_evidence,'{}'::jsonb)) item(key,value)
    where jsonb_typeof(value)<>'string' or not (
      (key='provider' and value #>> '{}' in ('ok','pinterest','instagram','facebook'))
      or (key='reason' and value #>> '{}' in
        ('retryable','missing_success_evidence','timeout','network_error','rate_limited',
         'provider_rejected','unknown_outcome','non_retryable')))) then
    raise exception using errcode='22023',message='provider_evidence_invalid';
  end if;

  -- Discover immutable parents without taking a child lock, then use the same
  -- hierarchy as start/cancel: intent -> destination -> delivery -> attempt.
  select publish_intent_id,destination_id,delivery_id
    into v_attempt_intent_id,v_attempt_destination_id,v_attempt_delivery_id
    from public.provider_publish_attempts
   where id=p_attempt_id and owner_user_id=p_user_id;
  if not found then raise exception using errcode='P0002',message='provider_attempt_not_found'; end if;
  select * into v_i from public.publish_intents
   where id=v_attempt_intent_id and user_id=p_user_id for update;
  if not found then raise exception using errcode='P0002',message='publish_intent_not_found'; end if;
  select * into v_d from public.publish_intent_destinations
   where publish_intent_id=v_i.id and destination_id=v_attempt_destination_id for update;
  if not found then raise exception using errcode='P0002',message='publish_destination_not_found'; end if;
  -- Provider authority comes from the locked destination, never the request.
  if p_remote_url is not null and not (case v_d.provider
      when 'pinterest' then p_remote_url ~ '^https://(www\.)?pinterest\.com/pin/'
      when 'instagram' then p_remote_url ~ '^https://(www\.)?instagram\.com/(p|reel)/'
      when 'facebook' then p_remote_url ~ '^https://(www\.)?facebook\.com/'
      else false end) then
    raise exception using errcode='22023',message='provider_remote_url_provider_mismatch';
  end if;
  if (coalesce(p_evidence,'{}'::jsonb) ? 'provider' or p_status='succeeded')
     and (p_evidence->>'provider') is distinct from v_d.provider then
    raise exception using errcode='22023',message='provider_evidence_provider_mismatch';
  end if;
  select * into v_delivery from public.publish_asset_deliveries
   where id=v_attempt_delivery_id and publish_intent_id=v_i.id and destination_id=v_d.destination_id for update;
  if not found then raise exception using errcode='P0002',message='publish_delivery_not_found'; end if;
  select * into v_a from public.provider_publish_attempts
   where id=p_attempt_id and owner_user_id=p_user_id for update;
  if not found or v_a.publish_intent_id is distinct from v_i.id
     or v_a.destination_id is distinct from v_d.destination_id
     or v_a.delivery_id is distinct from v_delivery.id
     or v_a.claim_token_identity is distinct from p_claim_token then
    raise exception using errcode='40001',message='provider_claim_lost';
  end if;
  if v_a.status<>'started' then
    if v_a.status<>p_status
       or v_a.provider_status is distinct from p_provider_status
       or v_a.remote_id is distinct from nullif(btrim(p_remote_id),'')
       or v_a.remote_url is distinct from nullif(btrim(p_remote_url),'')
       or v_a.evidence is distinct from coalesce(p_evidence,'{}'::jsonb) then
      raise exception using errcode='23505',message='provider_settlement_conflict';
    end if;
    return jsonb_build_object('settled',true,'replayed',true,'status',v_a.status,'attemptId',v_a.id);
  end if;
  if v_d.status<>'claimed' or v_d.claim_token is distinct from p_claim_token then
    raise exception using errcode='40001',message='provider_claim_lost';
  end if;
  insert into public.v76_provider_settlement_context(transaction_id,attempt_id,claim_token,terminal_status)
    values(txid_current(),v_a.id,p_claim_token,p_status);
  update public.provider_publish_attempts set status=p_status,provider_status=p_provider_status,
    remote_id=nullif(btrim(p_remote_id),''),remote_url=nullif(btrim(p_remote_url),''),
    evidence=coalesce(p_evidence,'{}'::jsonb),claim_token=null,finished_at=now()
   where id=v_a.id returning * into v_a;
  delete from public.v76_provider_settlement_context
    where transaction_id=txid_current() and attempt_id=v_a.id;
  update public.publish_asset_deliveries set
    status=case when p_status='unknown' then 'delivery_unknown'
                when p_status='succeeded' then 'published' else 'failed' end,
    updated_at=now() where id=v_delivery.id;
  update public.publish_intent_destinations set
    status=case when p_status='unknown' then 'delivery_unknown'
                when p_status='succeeded' then 'published' else 'failed' end,
    retry_allowed=(p_status='failed'),provider_status=p_provider_status,
    remote_id=nullif(btrim(p_remote_id),''),remote_url=nullif(btrim(p_remote_url),''),
    evidence=coalesce(p_evidence,'{}'::jsonb),claim_token=null,finished_at=now(),updated_at=now()
   where id=v_d.id;
  -- Parent lifecycle is an aggregate, never a veto from whichever sibling
  -- happened to finish first. Untouched destinations must remain dispatchable.
  if exists (select 1 from public.publish_intent_destinations
              where publish_intent_id=v_i.id
                and status not in ('published','failed','delivery_unknown','canceled')) then
    update public.publish_intents set lifecycle_status='partially_ready',settled_at=null,updated_at=now()
     where id=v_i.id;
  elsif exists (select 1 from public.publish_intent_destinations
                 where publish_intent_id=v_i.id and status='delivery_unknown') then
    update public.publish_intents set lifecycle_status='delivery_unknown',settled_at=now(),updated_at=now()
     where id=v_i.id;
  elsif not exists (select 1 from public.publish_intent_destinations
                     where publish_intent_id=v_i.id and status<>'published') then
    update public.publish_intents set lifecycle_status='settled',settled_at=now(),updated_at=now()
     where id=v_i.id;
  else
    update public.publish_intents set lifecycle_status='partially_ready',settled_at=null,updated_at=now()
     where id=v_i.id;
  end if;
  return jsonb_build_object('settled',true,'replayed',false,'status',p_status,'attemptId',v_a.id);
exception when others then
  -- Rebuild the exception from static codes; never forward database DETAIL or
  -- an unexpected message that can contain a caller's value.
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'invalid_provider_attempt_settlement' then 'invalid_provider_attempt_settlement'
    when 'claim_token_required' then 'claim_token_required'
    when 'provider_success_evidence_required' then 'provider_success_evidence_required'
    when 'provider_remote_url_invalid' then 'provider_remote_url_invalid'
    when 'provider_remote_url_provider_mismatch' then 'provider_remote_url_provider_mismatch'
    when 'provider_evidence_provider_mismatch' then 'provider_evidence_provider_mismatch'
    when 'provider_remote_id_invalid' then 'provider_remote_id_invalid'
    when 'provider_evidence_invalid' then 'provider_evidence_invalid'
    when 'provider_attempt_not_found' then 'provider_attempt_not_found'
    when 'publish_intent_not_found' then 'publish_intent_not_found'
    when 'publish_destination_not_found' then 'publish_destination_not_found'
    when 'publish_delivery_not_found' then 'publish_delivery_not_found'
    when 'provider_claim_lost' then 'provider_claim_lost'
    when 'provider_settlement_conflict' then 'provider_settlement_conflict'
    when 'materialization_required' then 'materialization_required'
    when 'provider_success_required' then 'provider_success_required'
    when 'provider_failure_required' then 'provider_failure_required'
    when 'provider_unknown_required' then 'provider_unknown_required'
    else 'v76_rpc_error' end;
end $fn$;

comment on table public.publish_assets is 'vibepin:v76:publish-assets';
comment on table public.publish_asset_deliveries is 'vibepin:v76:publish-asset-deliveries';
comment on table public.publish_asset_delivery_items is 'vibepin:v76:publish-asset-delivery-items';
comment on table public.provider_publish_attempts is 'vibepin:v76:provider-publish-attempts';
comment on table public.v76_provider_settlement_context is 'vibepin:v76:v76-provider-settlement-context';
comment on function public.publish_intent_confirm_prepare(uuid,jsonb) is 'vibepin:v76:publish-intent-confirm-prepare';
comment on function public.publish_intent_prepare(uuid,text,text,text,jsonb,timestamptz,jsonb) is 'vibepin:v76:publish-intent-prepare';
comment on function public.publish_asset_lease_materialization(uuid,text,text,uuid,integer) is 'vibepin:v76:publish-asset-lease-materialization';
comment on function public.publish_asset_settle_materialization(uuid,text,text,uuid,text,text,text,text,bigint,text,text) is 'vibepin:v76:publish-asset-settle-materialization';
comment on function public.publish_asset_claim_ready(uuid,text,text,uuid) is 'vibepin:v76:publish-asset-claim-ready';
comment on function public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text) is 'vibepin:v76:publish-asset-settle-item';
comment on function public.publish_intent_cancel(uuid,text,text) is 'vibepin:v76:publish-intent-cancel';
comment on function public.publish_cleanup_lease(bigint,uuid,integer) is 'vibepin:v76:publish-cleanup-lease';
comment on function public.publish_cleanup_settle(bigint,uuid,text,text) is 'vibepin:v76:publish-cleanup-settle';
comment on function public.publish_provider_attempt_start(uuid,text,text,uuid,integer) is 'vibepin:v76:publish-provider-attempt-start';
comment on function public.publish_provider_attempt_settle(uuid,uuid,uuid,text,integer,text,text,jsonb) is 'vibepin:v76:publish-provider-attempt-settle';
comment on function public.v76_bind_publish_owner() is 'vibepin:v76:v76-bind-publish-owner';
comment on function public.v76_evidence_owner_guard() is 'vibepin:v76:v76-evidence-owner-guard';
comment on function public.v76_legacy_transition_guard() is 'vibepin:v76:v76-legacy-transition-guard';
-- Trigger-only guard: no caller (including service_role) may invoke it directly.
revoke all on function public.v76_legacy_transition_guard() from public,anon,authenticated,service_role;

revoke all on function public.publish_intent_confirm_prepare(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.publish_intent_prepare(uuid,text,text,text,jsonb,timestamptz,jsonb) from public,anon,authenticated;
revoke all on function public.publish_asset_lease_materialization(uuid,text,text,uuid,integer) from public,anon,authenticated;
revoke all on function public.publish_asset_settle_materialization(uuid,text,text,uuid,text,text,text,text,bigint,text,text) from public,anon,authenticated;
revoke all on function public.publish_asset_claim_ready(uuid,text,text,uuid) from public,anon,authenticated;
revoke all on function public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text) from public,anon,authenticated;
revoke all on function public.publish_intent_cancel(uuid,text,text) from public,anon,authenticated;
revoke all on function public.publish_cleanup_lease(bigint,uuid,integer) from public,anon,authenticated;
revoke all on function public.publish_cleanup_settle(bigint,uuid,text,text) from public,anon,authenticated;
revoke all on function public.publish_provider_attempt_start(uuid,text,text,uuid,integer) from public,anon,authenticated;
revoke all on function public.publish_provider_attempt_settle(uuid,uuid,uuid,text,integer,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.publish_intent_confirm_prepare(uuid,jsonb) to service_role;
grant execute on function public.publish_intent_prepare(uuid,text,text,text,jsonb,timestamptz,jsonb) to service_role;
grant execute on function public.publish_asset_lease_materialization(uuid,text,text,uuid,integer) to service_role;
grant execute on function public.publish_asset_settle_materialization(uuid,text,text,uuid,text,text,text,text,bigint,text,text) to service_role;
grant execute on function public.publish_asset_claim_ready(uuid,text,text,uuid) to service_role;
grant execute on function public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text) to service_role;
grant execute on function public.publish_intent_cancel(uuid,text,text) to service_role;
grant execute on function public.publish_cleanup_lease(bigint,uuid,integer) to service_role;
grant execute on function public.publish_cleanup_settle(bigint,uuid,text,text) to service_role;
grant execute on function public.publish_provider_attempt_start(uuid,text,text,uuid,integer) to service_role;
grant execute on function public.publish_provider_attempt_settle(uuid,uuid,uuid,text,integer,text,text,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
