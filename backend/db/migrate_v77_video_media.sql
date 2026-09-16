-- v77: private video-upload contract and additive video media metadata.
-- This migration intentionally leaves v75's broad legacy storage-policy blocker
-- untouched; it cannot make an OR-composed pre-existing policy safe.
begin;

do $v77_preflight$
declare
  v_name text;
  v_missing text;
  v_installed boolean := to_regclass('public.video_upload_batches') is not null or to_regclass('public.video_upload_items') is not null;
  v_type text;
  v_not_null boolean;
begin
  if (to_regclass('public.video_upload_batches') is null) is distinct from (to_regclass('public.video_upload_items') is null) then
    raise exception using errcode='P0001',message='v77_schema_collision';
  end if;
  foreach v_name in array array['video_upload_batches','video_upload_items'] loop
    if to_regclass('public.' || v_name) is not null
       and obj_description(to_regclass('public.' || v_name), 'pg_class') is distinct from 'vibepin:v77:' || replace(v_name, '_', '-') then
      raise exception using errcode='P0001', message='v77_schema_collision';
    end if;
  end loop;

  if to_regclass('public.video_upload_batches') is not null then
    select string_agg(required_column, ',' order by required_column) into v_missing
      from (values ('id'),('owner_user_id'),('idempotency_key'),('status'),('expires_at')) required(required_column)
     where not exists (select 1 from pg_attribute a where a.attrelid='public.video_upload_batches'::regclass
                         and a.attname=required.required_column and not a.attisdropped);
    if v_missing is not null then raise exception using errcode='P0001', message='v77_schema_collision'; end if;
  end if;
  if to_regclass('public.video_upload_items') is not null then
    select string_agg(required_column, ',' order by required_column) into v_missing
      from (values ('batch_id'),('owner_user_id'),('ordinal'),('idempotency_key'),('private_path'),
                   ('declared_content_type'),('declared_byte_size'),('status')) required(required_column)
     where not exists (select 1 from pg_attribute a where a.attrelid='public.video_upload_items'::regclass
                         and a.attname=required.required_column and not a.attisdropped);
    if v_missing is not null then raise exception using errcode='P0001', message='v77_schema_collision'; end if;
  end if;

  -- v77's provenance extension is not an adoption point: before v77 none of
  -- these columns exist; after v77 every one must retain its exact type/shape.
  foreach v_name in array array['media_kind','content_type','byte_size','checksum_sha256','width','height','duration_ms'] loop
    select a.atttypid::regtype::text,a.attnotnull into v_type,v_not_null from pg_attribute a
      where a.attrelid='public.media_asset_provenance'::regclass and a.attname=v_name and not a.attisdropped;
    if found then
      if (v_name in ('media_kind','content_type','checksum_sha256') and v_type<>'text')
         or (v_name in ('byte_size','duration_ms') and v_type<>'bigint')
         or (v_name in ('width','height') and v_type<>'integer')
         or (v_name='media_kind' and not v_not_null) then
        raise exception using errcode='P0001',message='v77_schema_collision';
      end if;
    elsif v_installed then
      raise exception using errcode='P0001',message='v77_schema_collision';
    end if;
  end loop;
  if not v_installed and exists (select 1 from pg_attribute a where a.attrelid='public.media_asset_provenance'::regclass
    and a.attname in ('media_kind','content_type','byte_size','checksum_sha256','width','height','duration_ms') and not a.attisdropped) then
    raise exception using errcode='P0001',message='v77_schema_collision';
  end if;
  if v_installed then
    if (
    not exists(select 1 from pg_constraint where conrelid='public.video_upload_items'::regclass and conname='video_upload_items_ordinal_check')
    or not exists(select 1 from pg_constraint where conrelid='public.video_upload_items'::regclass and conname='video_upload_items_status_check')
    or not exists(select 1 from pg_constraint where conrelid='public.video_upload_items'::regclass and conname='video_upload_items_finalized_facts_check')
    or not exists(select 1 from pg_constraint where conrelid='public.video_upload_batches'::regclass and conname='video_upload_batches_status_check')
    or not exists(select 1 from pg_class where relname='video_upload_batches_owner_status_idx' and relnamespace='public'::regnamespace)
    or not exists(select 1 from pg_class where relname='video_upload_items_owner_batch_idx' and relnamespace='public'::regnamespace)
    or not (select relrowsecurity from pg_class where oid='public.video_upload_batches'::regclass)
    or not (select relrowsecurity from pg_class where oid='public.video_upload_items'::regclass)
    ) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
  end if;
  foreach v_name in array array['video_upload_batch_prepare','video_upload_item_prepare','video_upload_item_finalize'] loop
    if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=v_name)
       and (not v_installed or (select obj_description(p.oid,'pg_proc') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=v_name limit 1) is distinct from 'vibepin:v77:' || replace(v_name,'_','-')) then
      raise exception using errcode='P0001',message='v77_schema_collision';
    end if;
  end loop;
end $v77_preflight$;

create table if not exists public.video_upload_batches (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  idempotency_key text not null,
  status text not null default 'prepared'
    constraint video_upload_batches_status_check check (status in ('prepared','uploading','finalizing','finalized','failed','expired','canceled')),
  error_code text,
  prepared_at timestamptz not null default now(),
  finalized_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, idempotency_key)
);
comment on table public.video_upload_batches is 'vibepin:v77:video-upload-batches';

create table if not exists public.video_upload_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.video_upload_batches(id) on delete restrict,
  owner_user_id uuid not null,
  ordinal integer not null constraint video_upload_items_ordinal_check check (ordinal between 0 and 19),
  idempotency_key text not null,
  private_path text not null,
  declared_content_type text not null
    constraint video_upload_items_declared_content_type_check check (declared_content_type in ('video/mp4','video/x-m4v','video/quicktime')),
  declared_byte_size bigint not null
    constraint video_upload_items_declared_byte_size_check check (declared_byte_size between 0 and 104857600),
  declared_checksum_sha256 text,
  declared_width integer,
  declared_height integer,
  declared_duration_ms bigint,
  verified_content_type text
    constraint video_upload_items_verified_content_type_check check (verified_content_type is null or verified_content_type in ('video/mp4','video/x-m4v','video/quicktime')),
  verified_byte_size bigint,
  verified_checksum_sha256 text,
  verified_width integer,
  verified_height integer,
  verified_duration_ms bigint,
  status text not null default 'prepared'
    constraint video_upload_items_status_check check (status in ('prepared','uploading','finalizing','finalized','failed','expired','canceled')),
  constraint video_upload_items_finalized_facts_check check (
    status <> 'finalized' or (
      verified_content_type in ('video/mp4','video/x-m4v','video/quicktime')
      and verified_byte_size between 0 and 104857600
      and nullif(btrim(verified_checksum_sha256),'') is not null
      and verified_width > 0 and verified_height > 0 and verified_duration_ms > 0
    )
  ),
  error_code text,
  prepared_at timestamptz not null default now(),
  finalized_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, ordinal),
  unique (batch_id, idempotency_key)
);
comment on table public.video_upload_items is 'vibepin:v77:video-upload-items';
create index if not exists video_upload_batches_owner_status_idx on public.video_upload_batches(owner_user_id,status,updated_at desc);
create index if not exists video_upload_items_owner_batch_idx on public.video_upload_items(owner_user_id,batch_id,ordinal);

alter table public.media_asset_provenance add column if not exists media_kind text not null default 'image';
alter table public.media_asset_provenance add column if not exists content_type text;
alter table public.media_asset_provenance add column if not exists byte_size bigint;
alter table public.media_asset_provenance add column if not exists checksum_sha256 text;
alter table public.media_asset_provenance add column if not exists width integer;
alter table public.media_asset_provenance add column if not exists height integer;
alter table public.media_asset_provenance add column if not exists duration_ms bigint;
do $v77_provenance_check$
declare v_definition text;
begin
  select pg_get_constraintdef(oid) into v_definition from pg_constraint
    where conrelid='public.media_asset_provenance'::regclass and conname='media_asset_provenance_media_kind_check';
  if found and v_definition <> 'CHECK ((media_kind = ANY (ARRAY[''image''::text, ''video''::text])))' then
    raise exception using errcode='P0001',message='v77_schema_collision';
  elsif not found then
    alter table public.media_asset_provenance add constraint media_asset_provenance_media_kind_check
      check (media_kind in ('image','video'));
  end if;
end $v77_provenance_check$;

alter table public.video_upload_batches enable row level security;
alter table public.video_upload_items enable row level security;
revoke all on public.video_upload_batches,public.video_upload_items from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.video_upload_batches,public.video_upload_items to service_role;

-- Only server callers receive these RPCs. Their owner argument is server-derived
-- from the authenticated request or parent intent; no browser role can call them.
create or replace function public.video_upload_batch_prepare(
  p_owner_user_id uuid,p_idempotency_key text,p_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v77:video-upload-batch-prepare
declare v_batch public.video_upload_batches%rowtype;
begin
  if p_owner_user_id is null or nullif(btrim(p_idempotency_key),'') is null or p_expires_at is null or p_expires_at<=now() then
    raise exception using errcode='22023',message='invalid_video_upload_batch';
  end if;
  insert into public.video_upload_batches(owner_user_id,idempotency_key,expires_at)
    values(p_owner_user_id,btrim(p_idempotency_key),p_expires_at)
    on conflict(owner_user_id,idempotency_key) do update
      set idempotency_key=excluded.idempotency_key
    returning * into v_batch;
  return jsonb_build_object('batchId',v_batch.id,'status',v_batch.status,'expiresAt',v_batch.expires_at);
exception when others then
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'invalid_video_upload_batch' then 'invalid_video_upload_batch'
    else 'v77_video_upload_error' end;
end $fn$;
comment on function public.video_upload_batch_prepare(uuid,text,timestamptz) is 'vibepin:v77:video-upload-batch-prepare';

create or replace function public.video_upload_item_prepare(
  p_owner_user_id uuid,p_batch_id uuid,p_ordinal integer,p_idempotency_key text,p_private_path text,
  p_declared_content_type text,p_declared_byte_size bigint,p_declared_checksum_sha256 text,
  p_declared_width integer,p_declared_height integer,p_declared_duration_ms bigint
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v77:video-upload-item-prepare
declare v_batch public.video_upload_batches%rowtype; v_item public.video_upload_items%rowtype;
begin
  if p_owner_user_id is null or p_batch_id is null or p_ordinal is null or p_ordinal<0 or p_ordinal>=20
     or nullif(btrim(p_idempotency_key),'') is null or nullif(btrim(p_private_path),'') is null
     or p_private_path like '%..%' or split_part(p_private_path,'/',1) is distinct from p_owner_user_id::text then
    raise exception using errcode='22023',message=case when p_ordinal is null or p_ordinal<0 or p_ordinal>=20 then 'video_upload_batch_limit_exceeded' else 'invalid_video_upload_item' end;
  end if;
  if p_declared_content_type not in ('video/mp4','video/x-m4v','video/quicktime') then
    raise exception using errcode='22023',message='invalid_video_content_type';
  end if;
  if p_declared_byte_size is null or p_declared_byte_size<0 or p_declared_byte_size>104857600 then
    raise exception using errcode='22023',message='video_upload_too_large';
  end if;
  select * into v_batch from public.video_upload_batches where id=p_batch_id and owner_user_id=p_owner_user_id for update;
  if not found then raise exception using errcode='P0002',message='video_upload_batch_not_found'; end if;
  select * into v_item from public.video_upload_items where batch_id=v_batch.id and ordinal=p_ordinal for update;
  if found then
    if v_item.idempotency_key is distinct from btrim(p_idempotency_key)
       or v_item.private_path is distinct from btrim(p_private_path)
       or v_item.declared_content_type is distinct from p_declared_content_type
       or v_item.declared_byte_size is distinct from p_declared_byte_size
       or v_item.declared_checksum_sha256 is distinct from nullif(btrim(coalesce(p_declared_checksum_sha256,'')), '')
       or v_item.declared_width is distinct from p_declared_width
       or v_item.declared_height is distinct from p_declared_height
       or v_item.declared_duration_ms is distinct from p_declared_duration_ms then
      raise exception using errcode='23505',message='video_upload_item_idempotency_conflict';
    end if;
    return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'batchId',v_batch.id);
  end if;
  if v_batch.expires_at<=now() then raise exception using errcode='55000',message='video_upload_batch_expired'; end if;
  if v_batch.status not in ('prepared','uploading') then raise exception using errcode='55000',message='video_upload_batch_not_preparable'; end if;
  if exists (select 1 from public.video_upload_items where batch_id=v_batch.id and idempotency_key=btrim(p_idempotency_key)) then
    raise exception using errcode='23505',message='video_upload_item_idempotency_conflict';
  end if;
  insert into public.video_upload_items(
    batch_id,owner_user_id,ordinal,idempotency_key,private_path,declared_content_type,declared_byte_size,
    declared_checksum_sha256,declared_width,declared_height,declared_duration_ms,expires_at
  ) values (
    v_batch.id,p_owner_user_id,p_ordinal,btrim(p_idempotency_key),btrim(p_private_path),p_declared_content_type,p_declared_byte_size,
    nullif(btrim(coalesce(p_declared_checksum_sha256,'')),''),p_declared_width,p_declared_height,p_declared_duration_ms,v_batch.expires_at
  ) returning * into v_item;
  update public.video_upload_batches set status='uploading',updated_at=now() where id=v_batch.id;
  return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'batchId',v_batch.id);
exception when others then
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'video_upload_batch_limit_exceeded' then 'video_upload_batch_limit_exceeded'
    when 'invalid_video_upload_item' then 'invalid_video_upload_item'
    when 'invalid_video_content_type' then 'invalid_video_content_type'
    when 'video_upload_too_large' then 'video_upload_too_large'
    when 'video_upload_batch_not_found' then 'video_upload_batch_not_found'
    when 'video_upload_batch_expired' then 'video_upload_batch_expired'
    when 'video_upload_batch_not_preparable' then 'video_upload_batch_not_preparable'
    when 'video_upload_item_idempotency_conflict' then 'video_upload_item_idempotency_conflict'
    else 'v77_video_upload_error' end;
end $fn$;
comment on function public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint) is 'vibepin:v77:video-upload-item-prepare';

create or replace function public.video_upload_item_finalize(
  p_owner_user_id uuid,p_batch_id uuid,p_ordinal integer,p_verified_content_type text,p_verified_byte_size bigint,
  p_verified_checksum_sha256 text,p_verified_width integer,p_verified_height integer,p_verified_duration_ms bigint
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v77:video-upload-item-finalize
declare v_batch public.video_upload_batches%rowtype; v_item public.video_upload_items%rowtype; v_done boolean;
begin
  if nullif(btrim(coalesce(p_verified_content_type,'')),'') is null
     or p_verified_content_type not in ('video/mp4','video/x-m4v','video/quicktime') then raise exception using errcode='22023',message='invalid_video_content_type'; end if;
  if p_verified_byte_size is null or p_verified_byte_size<0 or p_verified_byte_size>104857600 then raise exception using errcode='22023',message='video_upload_too_large'; end if;
  if nullif(btrim(coalesce(p_verified_checksum_sha256,'')),'') is null
     or p_verified_width is null or p_verified_width<=0 or p_verified_height is null or p_verified_height<=0
     or p_verified_duration_ms is null or p_verified_duration_ms<=0 then raise exception using errcode='22023',message='invalid_verified_video_facts'; end if;
  select * into v_batch from public.video_upload_batches where id=p_batch_id and owner_user_id=p_owner_user_id for update;
  if not found then raise exception using errcode='P0002',message='video_upload_batch_not_found'; end if;
  if v_batch.expires_at<=now() then raise exception using errcode='55000',message='video_upload_batch_expired'; end if;
  select * into v_item from public.video_upload_items where batch_id=v_batch.id and ordinal=p_ordinal and owner_user_id=p_owner_user_id for update;
  if not found then raise exception using errcode='P0002',message='video_upload_item_not_found'; end if;
  if v_item.status='finalized' then
    if v_item.verified_content_type is distinct from p_verified_content_type or v_item.verified_byte_size is distinct from p_verified_byte_size
       or v_item.verified_checksum_sha256 is distinct from nullif(btrim(coalesce(p_verified_checksum_sha256,'')), '')
       or v_item.verified_width is distinct from p_verified_width or v_item.verified_height is distinct from p_verified_height
       or v_item.verified_duration_ms is distinct from p_verified_duration_ms then
      raise exception using errcode='23505',message='video_upload_finalize_conflict';
    end if;
    return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'batchStatus',v_batch.status);
  elsif v_batch.status not in ('uploading','finalizing') then raise exception using errcode='55000',message='video_upload_batch_not_finalizable';
  elsif v_item.status<>'prepared' then raise exception using errcode='55000',message='video_upload_item_not_finalizable';
  else
    update public.video_upload_items set verified_content_type=p_verified_content_type,verified_byte_size=p_verified_byte_size,
      verified_checksum_sha256=nullif(btrim(coalesce(p_verified_checksum_sha256,'')),''),verified_width=p_verified_width,
      verified_height=p_verified_height,verified_duration_ms=p_verified_duration_ms,status='finalized',finalized_at=now(),updated_at=now()
      where id=v_item.id returning * into v_item;
  end if;
  select not exists(select 1 from public.video_upload_items where batch_id=v_batch.id and status<>'finalized') into v_done;
  update public.video_upload_batches set status=case when v_done then 'finalized' else 'finalizing' end,
    finalized_at=case when v_done then coalesce(finalized_at,now()) else null end,updated_at=now() where id=v_batch.id returning * into v_batch;
  return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'batchStatus',v_batch.status);
exception when others then
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'invalid_video_content_type' then 'invalid_video_content_type'
    when 'video_upload_too_large' then 'video_upload_too_large'
    when 'video_upload_batch_not_found' then 'video_upload_batch_not_found'
    when 'video_upload_batch_expired' then 'video_upload_batch_expired'
    when 'video_upload_item_not_found' then 'video_upload_item_not_found'
    when 'video_upload_batch_not_finalizable' then 'video_upload_batch_not_finalizable'
    when 'video_upload_item_not_finalizable' then 'video_upload_item_not_finalizable'
    when 'video_upload_finalize_conflict' then 'video_upload_finalize_conflict'
    when 'invalid_verified_video_facts' then 'invalid_verified_video_facts'
    else 'v77_video_upload_error' end;
end $fn$;
comment on function public.video_upload_item_finalize(uuid,uuid,integer,text,bigint,text,integer,integer,bigint) is 'vibepin:v77:video-upload-item-finalize';

-- v76 remains the provider settlement boundary. Replace only its MIME literals;
-- all private-bucket, owner, checksum, revision, lease, claim and settlement code stays byte-for-byte intact.
do $v77_v76_video_mime$
declare v_signature text; v_definition text; v_marker text; v_hash text; v_proc pg_proc%rowtype; v_old text := '(''image/png'',''image/jpeg'',''image/webp'')'; v_new text := '(''image/png'',''image/jpeg'',''image/webp'',''video/mp4'',''video/x-m4v'',''video/quicktime'')';
begin
  for v_signature,v_marker,v_hash in select * from (values
    ('public.publish_asset_settle_materialization(uuid,text,text,uuid,text,text,text,text,bigint,text,text)','vibepin:v76:publish-asset-settle-materialization','05aeaf68837a95a5cdc6177383ee6092'),
    ('public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)','vibepin:v76:publish-asset-settle-item','a05aef6619c3ec795b6ceee080e04843')
  ) expected(signature,marker,body_hash) loop
    if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=split_part(replace(v_signature,'public.',''),'(',1)
        and p.oid is distinct from to_regprocedure(v_signature)) then
      raise exception using errcode='P0001',message='v77_v76_function_collision';
    end if;
    select * into v_proc from pg_proc where oid=to_regprocedure(v_signature);
    select pg_get_functiondef(to_regprocedure(v_signature)) into v_definition;
    if v_definition is null or obj_description(to_regprocedure(v_signature),'pg_proc') is distinct from v_marker
       or not v_proc.prosecdef or v_proc.prokind<>'f' or v_proc.prorettype<>to_regtype('jsonb')
       or v_proc.proretset or v_proc.provariadic<>0 or v_proc.prolang<>(select oid from pg_language where lanname='plpgsql')
       or v_proc.proconfig is distinct from array['search_path=public, pg_temp']::text[]
       or md5(replace(replace(replace(v_proc.prosrc,v_new,v_old),chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>v_hash then
      raise exception using errcode='P0001',message='v77_v76_function_collision';
    end if;
    if position(v_old in v_definition)>0 then v_definition := replace(v_definition,v_old,v_new);
    elsif position(v_new in v_definition)=0 then raise exception using errcode='P0001',message='v77_v76_function_collision'; end if;
    execute v_definition;
  end loop;
end $v77_v76_video_mime$;

revoke all on function public.video_upload_batch_prepare(uuid,text,timestamptz) from public,anon,authenticated;
revoke all on function public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint) from public,anon,authenticated;
revoke all on function public.video_upload_item_finalize(uuid,uuid,integer,text,bigint,text,integer,integer,bigint) from public,anon,authenticated;
grant execute on function public.video_upload_batch_prepare(uuid,text,timestamptz) to service_role;
grant execute on function public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint) to service_role;
grant execute on function public.video_upload_item_finalize(uuid,uuid,integer,text,bigint,text,integer,integer,bigint) to service_role;
notify pgrst,'reload schema';
commit;
