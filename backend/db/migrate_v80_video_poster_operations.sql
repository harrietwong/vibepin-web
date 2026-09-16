-- v80: server-owned association between a browser-generated poster and exactly
-- one v77 private-video upload operation.  This is deliberately additive: it
-- neither changes the v77 ledger nor trusts a browser supplied lifecycle state.
begin;

do $v80_preflight$
declare
  v_marker text;
begin
  if to_regclass('public.video_upload_items') is null
     or to_regclass('public.media_asset_provenance') is null
     or to_regclass('public.pin_drafts') is null then
    raise exception using errcode='P0001', message='v80_requires_v77';
  end if;
  if to_regclass('public.video_poster_operations') is not null then
    select obj_description('public.video_poster_operations'::regclass, 'pg_class') into v_marker;
    if v_marker is distinct from 'vibepin:v80:video-poster-operations' then
      raise exception using errcode='P0001', message='v80_schema_collision';
    end if;
  end if;
end $v80_preflight$;

create table if not exists public.video_poster_operations (
  video_item_id uuid primary key references public.video_upload_items(id) on delete restrict,
  owner_user_id uuid not null,
  bucket_id text not null,
  object_path text not null,
  -- associated means a failed/cancelled v77 operation may prove cleanup. retained
  -- is a one-way server record for a finalised/attached poster and is never cleanable.
  state text not null default 'associated'
    constraint video_poster_operations_state_check check (state in ('associated','retained')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint video_poster_operations_path_check check (
    object_path ~ '^studio/uploads/[0-9A-Fa-f-]{8,64}/[A-Za-z0-9][A-Za-z0-9_.-]{0,200}\.(png|jpg|jpeg|webp|gif)$'
  ),
  unique (bucket_id, object_path)
);
comment on table public.video_poster_operations is 'vibepin:v80:video-poster-operations';
comment on column public.video_poster_operations.state is 'Server-owned lifecycle. Client input cannot mark an operation cleanable.';

create index if not exists video_poster_operations_owner_path_idx
  on public.video_poster_operations(owner_user_id, bucket_id, object_path);

alter table public.video_poster_operations enable row level security;
alter table public.video_poster_operations force row level security;
revoke all on public.video_poster_operations from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.video_poster_operations to service_role;

create or replace function public.video_poster_operation_associate(
  p_owner_user_id uuid,
  p_batch_id uuid,
  p_ordinal integer,
  p_bucket_id text,
  p_object_path text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $v80_associate$
declare
  v_item_id uuid;
  v_existing public.video_poster_operations%rowtype;
begin
  if p_owner_user_id is null or p_batch_id is null or p_ordinal not between 0 and 19
     or p_bucket_id is null or length(p_bucket_id) not between 1 and 100
     or p_object_path is null
     or p_object_path !~ ('^studio/uploads/' || p_owner_user_id::text || '/[A-Za-z0-9][A-Za-z0-9_.-]{0,200}\.(png|jpg|jpeg|webp|gif)$')
     or p_object_path like '%..%' or p_object_path like '%\\%' or p_object_path like '%//%' then
    raise exception using errcode='P0001', message='v80_poster_operation_invalid';
  end if;

  select i.id into v_item_id
  from public.video_upload_items i
  join public.video_upload_batches b on b.id=i.batch_id
  where i.batch_id=p_batch_id and i.ordinal=p_ordinal
    and i.owner_user_id=p_owner_user_id and b.owner_user_id=p_owner_user_id
    and i.status in ('prepared','uploading','finalizing')
  for update of i;
  if not found then
    raise exception using errcode='P0001', message='v80_poster_operation_not_associable';
  end if;

  if not exists (
    select 1 from public.media_asset_provenance p
    where p.owner_user_id=p_owner_user_id and p.bucket_id=p_bucket_id and p.object_path=p_object_path
      and p.source_type='upload' and p.lifecycle_state='draft' and p.media_kind='image'
  ) then
    raise exception using errcode='P0001', message='v80_poster_provenance_missing';
  end if;

  select * into v_existing from public.video_poster_operations where video_item_id=v_item_id for update;
  if found then
    if v_existing.owner_user_id is distinct from p_owner_user_id
       or v_existing.bucket_id is distinct from p_bucket_id
       or v_existing.object_path is distinct from p_object_path then
      raise exception using errcode='P0001', message='v80_poster_operation_conflict';
    end if;
    update public.video_poster_operations set updated_at=now() where video_item_id=v_item_id;
    return jsonb_build_object('ok',true,'state',v_existing.state);
  end if;

  insert into public.video_poster_operations(video_item_id,owner_user_id,bucket_id,object_path)
  values(v_item_id,p_owner_user_id,p_bucket_id,p_object_path);
  return jsonb_build_object('ok',true,'state','associated');
end $v80_associate$;
comment on function public.video_poster_operation_associate(uuid,uuid,integer,text,text) is 'vibepin:v80:video-poster-operation-associate';

create or replace function public.video_poster_operation_retain(
  p_owner_user_id uuid,
  p_batch_id uuid,
  p_ordinal integer,
  p_bucket_id text,
  p_object_path text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $v80_retain$
declare v_updated integer;
begin
  update public.video_poster_operations o
  set state='retained', updated_at=now()
  from public.video_upload_items i
  where o.video_item_id=i.id and i.batch_id=p_batch_id and i.ordinal=p_ordinal
    and o.owner_user_id=p_owner_user_id and i.owner_user_id=p_owner_user_id
    and o.bucket_id=p_bucket_id and o.object_path=p_object_path
    and i.status='finalized' and o.state='associated';
  get diagnostics v_updated = row_count;
  if v_updated=1 then return jsonb_build_object('ok',true,'state','retained'); end if;
  if exists(select 1 from public.video_poster_operations o where o.owner_user_id=p_owner_user_id and o.bucket_id=p_bucket_id and o.object_path=p_object_path and o.state='retained') then
    return jsonb_build_object('ok',true,'state','retained');
  end if;
  raise exception using errcode='P0001', message='v80_poster_operation_not_retainable';
end $v80_retain$;
comment on function public.video_poster_operation_retain(uuid,uuid,integer,text,text) is 'vibepin:v80:video-poster-operation-retain';

create or replace function public.video_poster_cleanup_authorize(
  p_owner_user_id uuid,
  p_bucket_id text,
  p_object_path text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $v80_cleanup$
declare
  v_state text;
  v_status text;
  v_encoded_path text;
begin
  -- This is a positive capability check.  It deliberately does not accept a
  -- browser lifecycle/status declaration: v77's server ledger is the authority.
  select o.state,i.status into v_state,v_status
  from public.video_poster_operations o
  join public.video_upload_items i on i.id=o.video_item_id
  where o.owner_user_id=p_owner_user_id and i.owner_user_id=p_owner_user_id
    and o.bucket_id=p_bucket_id and o.object_path=p_object_path;
  if not found then return jsonb_build_object('allowed',false,'reason','not_associated'); end if;
  if v_state <> 'associated' then return jsonb_build_object('allowed',false,'reason','retained'); end if;
  if v_status not in ('failed','canceled') then return jsonb_build_object('allowed',false,'reason','operation_not_terminal'); end if;

  -- pin_drafts is the server-side content authority.  A matching live payload
  -- (raw or URL-encoded storage path) blocks deletion even if the operation was
  -- later marked failed by a duplicate/late browser request.
  v_encoded_path := replace(p_object_path, '/', '%2F');
  if exists (
    select 1 from public.pin_drafts d
    where d.vibepin_user_id=p_owner_user_id and d.deleted_at is null
      and (d.payload::text like '%' || p_object_path || '%' or d.payload::text like '%' || v_encoded_path || '%')
  ) then return jsonb_build_object('allowed',false,'reason','attached'); end if;
  return jsonb_build_object('allowed',true,'reason','failed_or_cancelled_unreferenced');
end $v80_cleanup$;
comment on function public.video_poster_cleanup_authorize(uuid,text,text) is 'vibepin:v80:video-poster-cleanup-authorize';

revoke all on function public.video_poster_operation_associate(uuid,uuid,integer,text,text) from public, anon, authenticated, service_role;
revoke all on function public.video_poster_operation_retain(uuid,uuid,integer,text,text) from public, anon, authenticated, service_role;
revoke all on function public.video_poster_cleanup_authorize(uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.video_poster_operation_associate(uuid,uuid,integer,text,text) to service_role;
grant execute on function public.video_poster_operation_retain(uuid,uuid,integer,text,text) to service_role;
grant execute on function public.video_poster_cleanup_authorize(uuid,text,text) to service_role;
notify pgrst,'reload schema';
commit;
