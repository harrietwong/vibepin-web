-- v75: durable owner/path provenance for private draft and publish media.
-- Additive and idempotent. This file is a candidate only; do not apply blindly.
begin;

-- Create/confirm only the new draft bucket. The legacy `generated` bucket and
-- its historical objects are untouched. `public=false` is explicit so an
-- anonymous Storage GET cannot bypass the application proxy.
insert into storage.buckets (id, name, public)
values ('generated-private', 'generated-private', false)
on conflict (id) do update set public = false;

-- Existing ledgers must have the identity and lifecycle columns before any
-- additive work starts. This check is deliberately inside the transaction.
do $v75_shape$
declare v_missing text;
begin
  if to_regclass('public.media_asset_provenance') is not null then
    select string_agg(required_column, ', ' order by required_column)
      into v_missing
      from (values ('owner_user_id'), ('object_path'), ('source_type'), ('lifecycle_state')) as required(required_column)
     where not exists (
       select 1 from pg_attribute a
        where a.attrelid = 'public.media_asset_provenance'::regclass
          and a.attname = required.required_column and not a.attisdropped
     );
    if v_missing is not null then
      raise exception 'v75 refused: existing media_asset_provenance missing core columns: %', v_missing;
    end if;
  end if;
end
$v75_shape$;

create table if not exists public.media_asset_provenance (
  owner_user_id uuid not null,
  bucket_id text not null,
  object_path text not null,
  source_type text not null check (source_type in ('upload','generation','publish_copy','legacy')),
  -- Existing generation/publish intent identifiers are text (e.g. publish:...);
  -- keep this compatible instead of assuming UUID semantics.
  intent_id text,
  lifecycle_state text not null default 'draft' check (lifecycle_state in ('draft','publish_pending','published','failed','unresolved','retained')),
  published_object_path text,
  provider_remote_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (bucket_id, object_path)
);

-- Older ledgers are upgraded in place while retaining every row.
alter table public.media_asset_provenance
  add column if not exists bucket_id text not null default 'generated-private';
alter table public.media_asset_provenance add column if not exists intent_id text;
alter table public.media_asset_provenance add column if not exists published_object_path text;
alter table public.media_asset_provenance add column if not exists provider_remote_id text;
alter table public.media_asset_provenance add column if not exists created_at timestamptz default now();
alter table public.media_asset_provenance add column if not exists updated_at timestamptz default now();
update public.media_asset_provenance set created_at = now() where created_at is null;
update public.media_asset_provenance set updated_at = now() where updated_at is null;
alter table public.media_asset_provenance alter column owner_user_id set not null;
alter table public.media_asset_provenance alter column bucket_id set not null;
alter table public.media_asset_provenance alter column object_path set not null;
alter table public.media_asset_provenance alter column source_type set not null;
alter table public.media_asset_provenance alter column lifecycle_state set not null;
alter table public.media_asset_provenance alter column lifecycle_state set default 'draft';
alter table public.media_asset_provenance alter column created_at set default now();
alter table public.media_asset_provenance alter column created_at set not null;
alter table public.media_asset_provenance alter column updated_at set default now();
alter table public.media_asset_provenance alter column updated_at set not null;

do $v75_constraints$
declare
  v_definition text;
begin
  select pg_get_constraintdef(oid) into v_definition
    from pg_constraint
   where conrelid='public.media_asset_provenance'::regclass
     and conname='media_asset_provenance_source_type_check';
  if found and v_definition <> 'CHECK ((source_type = ANY (ARRAY[''upload''::text, ''generation''::text, ''publish_copy''::text, ''legacy''::text])))' then
    raise exception 'v75 refused: media_asset_provenance_source_type_check definition is unexpected';
  elsif not found then
    alter table public.media_asset_provenance add constraint media_asset_provenance_source_type_check check (source_type in ('upload','generation','publish_copy','legacy'));
  end if;

  select pg_get_constraintdef(oid) into v_definition
    from pg_constraint
   where conrelid='public.media_asset_provenance'::regclass
     and conname='media_asset_provenance_lifecycle_state_check';
  if found and v_definition <> 'CHECK ((lifecycle_state = ANY (ARRAY[''draft''::text, ''publish_pending''::text, ''published''::text, ''failed''::text, ''unresolved''::text, ''retained''::text])))' then
    raise exception 'v75 refused: media_asset_provenance_lifecycle_state_check definition is unexpected';
  elsif not found then
    alter table public.media_asset_provenance add constraint media_asset_provenance_lifecycle_state_check check (lifecycle_state in ('draft','publish_pending','published','failed','unresolved','retained'));
  end if;
end
$v75_constraints$;

-- Backfill the bucket dimension for installations that created the ledger during
-- the draft rollout; all pre-v75 rows represented the private draft bucket.
alter table public.media_asset_provenance
  add column if not exists bucket_id text not null default 'generated-private';
alter table public.media_asset_provenance
  alter column bucket_id drop default;

-- Existing deployments may have the old owner/path key from an earlier draft.
-- The physical object is the identity: one bucket/path can have only one owner.
alter table public.media_asset_provenance
  drop constraint if exists media_asset_provenance_pkey;
alter table public.media_asset_provenance
  add constraint media_asset_provenance_pkey primary key (bucket_id, object_path);

create index if not exists media_asset_provenance_path_idx
  on public.media_asset_provenance (object_path);
create index if not exists media_asset_provenance_intent_idx
  on public.media_asset_provenance (intent_id)
  where intent_id is not null;

alter table public.media_asset_provenance enable row level security;
revoke all on public.media_asset_provenance from anon, authenticated;
grant select on public.media_asset_provenance to authenticated;
grant select, insert, update, delete on public.media_asset_provenance to service_role;

do $v75_policy_preflight$
declare
  v_comment text;
begin
  select obj_description(p.oid, 'pg_policy') into v_comment
    from pg_policy p
   where p.polrelid='public.media_asset_provenance'::regclass
     and p.polname='vibepin_v75_media_owner_select';
  if found and v_comment is distinct from 'vibepin:v75:media-owner-select' then
    raise exception 'v75 refused: provenance policy name collision without v75 marker';
  end if;

  select obj_description(p.oid, 'pg_policy') into v_comment
    from pg_policy p
   where p.polrelid='storage.objects'::regclass
     and p.polname='vibepin_v75_generated_private_owner_select';
  if found and v_comment is distinct from 'vibepin:v75:generated-private-owner-select' then
    raise exception 'v75 refused: storage policy name collision without v75 marker';
  end if;
end
$v75_policy_preflight$;

drop policy if exists vibepin_v75_media_owner_select on public.media_asset_provenance;
create policy vibepin_v75_media_owner_select
  on public.media_asset_provenance for select to authenticated
  using (
    owner_user_id = auth.uid()
    and lifecycle_state not in ('unresolved', 'failed')
  );
comment on policy vibepin_v75_media_owner_select on public.media_asset_provenance
  is 'vibepin:v75:media-owner-select';

-- Writes are service-role-only. Unknown/unresolved history is never readable by users.
comment on table public.media_asset_provenance is
  'Exact owner/path authorization ledger. Unresolved rows fail closed and are retained.';

create table if not exists public.media_cleanup_outbox (
  id bigint generated always as identity primary key,
  owner_user_id uuid not null,
  bucket_id text not null,
  object_path text not null,
  reason text not null,
  attempts integer not null default 0,
  status text not null default 'pending' check (status in ('pending','processing','done','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_attempted_at timestamptz,
  completed_at timestamptz
);
alter table public.media_cleanup_outbox enable row level security;
revoke all on public.media_cleanup_outbox from anon, authenticated;
grant select, insert, update, delete on public.media_cleanup_outbox to service_role;
comment on table public.media_cleanup_outbox is
  'Service-role-only durable compensation queue for failed private-media cleanup.';

-- Private generated media may be selected only by its authenticated owner through
-- the exact application ledger. Before deployment, audit every broad existing
-- storage.objects policy; this migration intentionally does not modify/delete
-- legacy generated objects or policies.
drop policy if exists vibepin_v75_generated_private_owner_select on storage.objects;
create policy vibepin_v75_generated_private_owner_select
  on storage.objects for select to authenticated
  using (
    bucket_id = 'generated-private'
    and exists (
      select 1
      from public.media_asset_provenance provenance
      where provenance.bucket_id = storage.objects.bucket_id
        and provenance.object_path = storage.objects.name
        and provenance.owner_user_id = (select auth.uid())
        and provenance.lifecycle_state not in ('unresolved', 'failed')
    )
  );
comment on policy vibepin_v75_generated_private_owner_select on storage.objects
  is 'vibepin:v75:generated-private-owner-select';
commit;
