-- v75: durable owner/path provenance for private draft and publish media.
-- Additive and idempotent. This file is a candidate only; do not apply blindly.
begin;

-- Create/confirm only the new draft bucket. The legacy `generated` bucket and
-- its historical objects are untouched. `public=false` is explicit so an
-- anonymous Storage GET cannot bypass the application proxy.
insert into storage.buckets (id, name, public)
values ('generated-private', 'generated-private', false)
on conflict (id) do update set public = false;

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

drop policy if exists vibepin_v75_media_owner_select on public.media_asset_provenance;
create policy vibepin_v75_media_owner_select
  on public.media_asset_provenance for select to authenticated
  using (owner_user_id = auth.uid());

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
commit;
