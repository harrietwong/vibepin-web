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
  v_default text;
  v_table text;
  v_definition text;
  v_expected_type text;
  v_expected_not_null boolean;
  v_expected_default text;
  v_expected_definition text;
  v_active_privileges boolean := true;
  v_rollback_privileges boolean := true;
  v_grantee text;
  v_actual boolean;
  v_signature text;
  v_marker text;
  v_hash text;
  v_proc pg_proc%rowtype;
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

  -- v77 owns both ledger relations. Reapply compares an explicit catalog rather
  -- than adopting a merely similar table, including defaults and nullability.
  if v_installed then
    for v_table,v_name,v_expected_type,v_expected_not_null,v_expected_default in select * from (values
      ('video_upload_batches','id','uuid',true,'gen_random_uuid()'),('video_upload_batches','owner_user_id','uuid',true,null),
      ('video_upload_batches','idempotency_key','text',true,null),('video_upload_batches','status','text',true,'''prepared''::text'),
      ('video_upload_batches','error_code','text',false,null),('video_upload_batches','prepared_at','timestamp with time zone',true,'now()'),
      ('video_upload_batches','finalized_at','timestamp with time zone',false,null),('video_upload_batches','expires_at','timestamp with time zone',true,null),
      ('video_upload_batches','created_at','timestamp with time zone',true,'now()'),('video_upload_batches','updated_at','timestamp with time zone',true,'now()'),
      ('video_upload_items','id','uuid',true,'gen_random_uuid()'),('video_upload_items','batch_id','uuid',true,null),
      ('video_upload_items','owner_user_id','uuid',true,null),('video_upload_items','ordinal','integer',true,null),
      ('video_upload_items','idempotency_key','text',true,null),('video_upload_items','private_path','text',true,null),
      ('video_upload_items','declared_content_type','text',true,null),('video_upload_items','declared_byte_size','bigint',true,null),
      ('video_upload_items','declared_checksum_sha256','text',false,null),('video_upload_items','declared_width','integer',false,null),
      ('video_upload_items','declared_height','integer',false,null),('video_upload_items','declared_duration_ms','bigint',false,null),
      ('video_upload_items','verified_content_type','text',false,null),('video_upload_items','verified_byte_size','bigint',false,null),
      ('video_upload_items','verified_checksum_sha256','text',false,null),('video_upload_items','verified_width','integer',false,null),
      ('video_upload_items','verified_height','integer',false,null),('video_upload_items','verified_duration_ms','bigint',false,null),
      ('video_upload_items','status','text',true,'''prepared''::text'),('video_upload_items','error_code','text',false,null),
      ('video_upload_items','prepared_at','timestamp with time zone',true,'now()'),('video_upload_items','finalized_at','timestamp with time zone',false,null),
      ('video_upload_items','expires_at','timestamp with time zone',true,null),('video_upload_items','created_at','timestamp with time zone',true,'now()'),
      ('video_upload_items','updated_at','timestamp with time zone',true,'now()')
    ) expected(table_name,column_name,type_name,not_null,default_expr) loop
      select format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid) into v_type,v_not_null,v_definition
        from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
        where a.attrelid=to_regclass('public.'||v_table) and a.attname=v_name and a.attnum>0 and not a.attisdropped;
      if not found or v_type is distinct from v_expected_type or v_not_null is distinct from v_expected_not_null
        or v_definition is distinct from v_expected_default then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
    end loop;
    if exists (select 1 from pg_attribute a join pg_class c on c.oid=a.attrelid
      where c.relnamespace='public'::regnamespace and c.relname in ('video_upload_batches','video_upload_items') and a.attnum>0 and not a.attisdropped
        and not exists (select 1 from (values
          ('video_upload_batches','id'),('video_upload_batches','owner_user_id'),('video_upload_batches','idempotency_key'),('video_upload_batches','status'),('video_upload_batches','error_code'),('video_upload_batches','prepared_at'),('video_upload_batches','finalized_at'),('video_upload_batches','expires_at'),('video_upload_batches','created_at'),('video_upload_batches','updated_at'),
          ('video_upload_items','id'),('video_upload_items','batch_id'),('video_upload_items','owner_user_id'),('video_upload_items','ordinal'),('video_upload_items','idempotency_key'),('video_upload_items','private_path'),('video_upload_items','declared_content_type'),('video_upload_items','declared_byte_size'),('video_upload_items','declared_checksum_sha256'),('video_upload_items','declared_width'),('video_upload_items','declared_height'),('video_upload_items','declared_duration_ms'),('video_upload_items','verified_content_type'),('video_upload_items','verified_byte_size'),('video_upload_items','verified_checksum_sha256'),('video_upload_items','verified_width'),('video_upload_items','verified_height'),('video_upload_items','verified_duration_ms'),('video_upload_items','status'),('video_upload_items','error_code'),('video_upload_items','prepared_at'),('video_upload_items','finalized_at'),('video_upload_items','expires_at'),('video_upload_items','created_at'),('video_upload_items','updated_at')
        ) expected(table_name,column_name) where expected.table_name=c.relname and expected.column_name=a.attname)) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
  end if;
  -- Provenance is additive: v77 owns these columns and its discriminator check,
  -- while v75 continues to own the rest of its legacy relation.
  for v_name,v_expected_type,v_expected_not_null,v_expected_default in select * from (values
    ('media_kind','text',true,'''image''::text'),('content_type','text',false,null),('byte_size','bigint',false,null),
    ('checksum_sha256','text',false,null),('width','integer',false,null),('height','integer',false,null),('duration_ms','bigint',false,null)
  ) expected(column_name,type_name,not_null,default_expr) loop
    select format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid) into v_type,v_not_null,v_definition
      from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid='public.media_asset_provenance'::regclass and a.attname=v_name and not a.attisdropped;
    if (not found and v_installed) or (found and (v_type is distinct from v_expected_type or v_not_null is distinct from v_expected_not_null or v_definition is distinct from v_expected_default)) then
      raise exception using errcode='P0001',message='v77_schema_collision';
    end if;
  end loop;
  if not v_installed and exists (select 1 from pg_attribute a where a.attrelid='public.media_asset_provenance'::regclass and a.attname in ('media_kind','content_type','byte_size','checksum_sha256','width','height','duration_ms') and not a.attisdropped) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
  if v_installed then
    for v_table,v_name,v_expected_definition in select * from (values
      ('video_upload_batches','video_upload_batches_pkey','PRIMARY KEY (id)'),
      ('video_upload_batches','video_upload_batches_owner_user_id_idempotency_key_key','UNIQUE (owner_user_id, idempotency_key)'),
      ('video_upload_batches','video_upload_batches_status_check','CHECK ((status = ANY (ARRAY[''prepared''::text, ''uploading''::text, ''finalizing''::text, ''finalized''::text, ''failed''::text, ''expired''::text, ''canceled''::text])))'),
      ('video_upload_items','video_upload_items_pkey','PRIMARY KEY (id)'),('video_upload_items','video_upload_items_batch_id_fkey','FOREIGN KEY (batch_id) REFERENCES video_upload_batches(id) ON DELETE RESTRICT'),
      ('video_upload_items','video_upload_items_batch_id_ordinal_key','UNIQUE (batch_id, ordinal)'),('video_upload_items','video_upload_items_batch_id_idempotency_key_key','UNIQUE (batch_id, idempotency_key)'),
      ('video_upload_items','video_upload_items_ordinal_check','CHECK (((ordinal >= 0) AND (ordinal <= 19)))'),
      ('video_upload_items','video_upload_items_declared_content_type_check','CHECK ((declared_content_type = ANY (ARRAY[''video/mp4''::text, ''video/x-m4v''::text, ''video/quicktime''::text])))'),
      ('video_upload_items','video_upload_items_declared_byte_size_check','CHECK (((declared_byte_size >= 0) AND (declared_byte_size <= 104857600)))'),
      ('video_upload_items','video_upload_items_verified_content_type_check','CHECK (((verified_content_type IS NULL) OR (verified_content_type = ANY (ARRAY[''video/mp4''::text, ''video/x-m4v''::text, ''video/quicktime''::text]))))'),
      ('video_upload_items','video_upload_items_status_check','CHECK ((status = ANY (ARRAY[''prepared''::text, ''uploading''::text, ''finalizing''::text, ''finalized''::text, ''failed''::text, ''expired''::text, ''canceled''::text])))'),
      ('video_upload_items','video_upload_items_finalized_facts_check','CHECK ((((status <> ''finalized''::text) OR ((verified_content_type = ANY (ARRAY[''video/mp4''::text, ''video/x-m4v''::text, ''video/quicktime''::text])) AND ((verified_byte_size >= 0) AND (verified_byte_size <= 104857600)) AND (NULLIF(btrim(verified_checksum_sha256), ''''::text) IS NOT NULL) AND (verified_width > 0) AND (verified_height > 0) AND (verified_duration_ms > 0))) IS TRUE))')
    ) expected(table_name,constraint_name,constraint_definition) loop
      select pg_get_constraintdef(p.oid) into v_default from pg_constraint p
        where p.conrelid=to_regclass('public.'||v_table) and p.conname=v_name;
      if not found or v_default is distinct from v_expected_definition then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
    end loop;
    if exists (select 1 from pg_constraint p where p.conrelid in ('public.video_upload_batches'::regclass,'public.video_upload_items'::regclass)
      and p.contype in ('p','u','f','c') and p.conname not in ('video_upload_batches_pkey','video_upload_batches_owner_user_id_idempotency_key_key','video_upload_batches_status_check','video_upload_items_pkey','video_upload_items_batch_id_fkey','video_upload_items_batch_id_ordinal_key','video_upload_items_batch_id_idempotency_key_key','video_upload_items_ordinal_check','video_upload_items_declared_content_type_check','video_upload_items_declared_byte_size_check','video_upload_items_verified_content_type_check','video_upload_items_status_check','video_upload_items_finalized_facts_check')) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
    select pg_get_constraintdef(oid) into v_default from pg_constraint where conrelid='public.media_asset_provenance'::regclass and conname='media_asset_provenance_media_kind_check';
    if not found or v_default is distinct from 'CHECK ((media_kind = ANY (ARRAY[''image''::text, ''video''::text])))' then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
    for v_name,v_expected_definition in select * from (values
      ('video_upload_batches_owner_status_idx','CREATE INDEX video_upload_batches_owner_status_idx ON public.video_upload_batches USING btree (owner_user_id, status, updated_at DESC)'),
      ('video_upload_items_owner_batch_idx','CREATE INDEX video_upload_items_owner_batch_idx ON public.video_upload_items USING btree (owner_user_id, batch_id, ordinal)')
    ) expected(index_name,index_definition) loop
      select pg_get_indexdef(indexrelid) into v_default from pg_index where indexrelid=to_regclass('public.'||v_name);
      if not found or v_default is distinct from v_expected_definition then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
    end loop;
    if exists (select 1 from pg_index i where i.indrelid in ('public.video_upload_batches'::regclass,'public.video_upload_items'::regclass)
      and not exists(select 1 from pg_constraint p where p.conindid=i.indexrelid)
      and i.indexrelid not in ('public.video_upload_batches_owner_status_idx'::regclass,'public.video_upload_items_owner_batch_idx'::regclass)) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
    if exists(select 1 from pg_policy p where p.polrelid in ('public.video_upload_batches'::regclass,'public.video_upload_items'::regclass))
      or exists(select 1 from pg_class c where c.oid in ('public.video_upload_batches'::regclass,'public.video_upload_items'::regclass) and (not c.relrowsecurity or c.relforcerowsecurity)) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
    -- Both states are intentional: active v77 permits only service DML; its
    -- nondestructive rollback preserves service read evidence and no RPC writes.
    -- Anything mixed is drift, and must fail before this migration restores grants.
    foreach v_table in array array['video_upload_batches','video_upload_items'] loop
      foreach v_grantee in array array['anon','authenticated','service_role'] loop
        foreach v_name in array array['select','insert','update','delete','truncate','references','trigger'] loop
          v_actual := has_table_privilege(v_grantee,to_regclass('public.'||v_table),v_name);
          if v_actual is distinct from (v_grantee='service_role' and v_name in ('select','insert','update','delete')) then v_active_privileges := false; end if;
          if v_actual is distinct from (v_grantee='service_role' and v_name='select') then v_rollback_privileges := false; end if;
        end loop;
      end loop;
      -- Table grants are effective on every column; attacl records only direct
      -- column grants and so exposes a grant that a later REVOKE would otherwise hide.
      if exists(select 1 from pg_attribute a where a.attrelid=to_regclass('public.'||v_table) and a.attnum>0 and not a.attisdropped and a.attacl is not null) then
        v_active_privileges := false; v_rollback_privileges := false;
      end if;
    end loop;
    if exists(select 1 from pg_class c cross join lateral aclexplode(c.relacl) acl
      where c.oid in ('public.video_upload_batches'::regclass,'public.video_upload_items'::regclass) and acl.is_grantable
        and (acl.grantee=0 or acl.grantee in (select oid from pg_roles where rolname in ('anon','authenticated','service_role')))) then
      v_active_privileges := false; v_rollback_privileges := false;
    end if;
  end if;
  for v_signature,v_marker,v_hash in select * from (values
    ('public.video_upload_batch_prepare(uuid,text,timestamptz)','vibepin:v77:video-upload-batch-prepare','73821871844f2b858bfc441d80919bbc'),
    ('public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint)','vibepin:v77:video-upload-item-prepare','56f6733502f5b8c6570581cfb981d558'),
    ('public.video_upload_item_finalize(uuid,uuid,integer,text,bigint,text,integer,integer,bigint)','vibepin:v77:video-upload-item-finalize','c72ba5b25af6037114491ad89da675ce')
  ) expected(signature,marker,body_hash) loop
    if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=split_part(replace(v_signature,'public.',''),'(',1)
        and p.oid is distinct from to_regprocedure(v_signature)) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
    if to_regprocedure(v_signature) is not null then
      select * into v_proc from pg_proc where oid=to_regprocedure(v_signature);
      if not v_installed or obj_description(v_proc.oid,'pg_proc') is distinct from v_marker
         or not v_proc.prosecdef or v_proc.prokind<>'f' or v_proc.prorettype<>to_regtype('jsonb')
         or v_proc.proretset or v_proc.provariadic<>0 or v_proc.prolang<>(select oid from pg_language where lanname='plpgsql')
         or v_proc.proconfig is distinct from array['search_path=public, pg_temp']::text[]
         or md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>v_hash then
        raise exception using errcode='P0001',message='v77_schema_collision';
      end if;
    elsif v_installed then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
  end loop;
  if v_installed then
    for v_signature in select signature from (values
      ('public.video_upload_batch_prepare(uuid,text,timestamptz)'),
      ('public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint)'),
      ('public.video_upload_item_finalize(uuid,uuid,integer,text,bigint,text,integer,integer,bigint)')
    ) expected(signature) loop
      foreach v_grantee in array array['anon','authenticated','service_role'] loop
        v_actual := has_function_privilege(v_grantee,to_regprocedure(v_signature),'execute');
        if v_actual is distinct from (v_grantee='service_role') then v_active_privileges := false; end if;
        if v_actual then v_rollback_privileges := false; end if;
      end loop;
    end loop;
    if exists(select 1 from pg_proc p cross join lateral aclexplode(p.proacl) acl
      where p.oid in (
        to_regprocedure('public.video_upload_batch_prepare(uuid,text,timestamptz)'),
        to_regprocedure('public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint)'),
        to_regprocedure('public.video_upload_item_finalize(uuid,uuid,integer,text,bigint,text,integer,integer,bigint)')
      ) and acl.is_grantable and (acl.grantee=0 or acl.grantee in (select oid from pg_roles where rolname in ('anon','authenticated','service_role')))) then
      v_active_privileges := false; v_rollback_privileges := false;
    end if;
    if not v_active_privileges and not v_rollback_privileges then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
  end if;
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
  constraint video_upload_items_finalized_facts_check check ((
    status <> 'finalized' or (
      verified_content_type in ('video/mp4','video/x-m4v','video/quicktime')
      and verified_byte_size between 0 and 104857600
      and nullif(btrim(verified_checksum_sha256),'') is not null
      and verified_width > 0 and verified_height > 0 and verified_duration_ms > 0
    )
  ) is true),
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
