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
      ('video_upload_items','finalize_claim_token','uuid',false,null),('video_upload_items','finalize_claim_expires_at','timestamp with time zone',false,null),
      ('video_upload_items','capability_expires_at','timestamp with time zone',true,null),
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
          ('video_upload_items','id'),('video_upload_items','batch_id'),('video_upload_items','owner_user_id'),('video_upload_items','ordinal'),('video_upload_items','idempotency_key'),('video_upload_items','private_path'),('video_upload_items','declared_content_type'),('video_upload_items','declared_byte_size'),('video_upload_items','declared_checksum_sha256'),('video_upload_items','declared_width'),('video_upload_items','declared_height'),('video_upload_items','declared_duration_ms'),('video_upload_items','verified_content_type'),('video_upload_items','verified_byte_size'),('video_upload_items','verified_checksum_sha256'),('video_upload_items','verified_width'),('video_upload_items','verified_height'),('video_upload_items','verified_duration_ms'),('video_upload_items','finalize_claim_token'),('video_upload_items','finalize_claim_expires_at'),('video_upload_items','capability_expires_at'),('video_upload_items','status'),('video_upload_items','error_code'),('video_upload_items','prepared_at'),('video_upload_items','finalized_at'),('video_upload_items','expires_at'),('video_upload_items','created_at'),('video_upload_items','updated_at')
        ) expected(table_name,column_name) where expected.table_name=c.relname and expected.column_name=a.attname)) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
  end if;
  -- Provenance is additive: v77 owns these columns and its discriminator check,
  -- while v75 continues to own the rest of its legacy relation.
  for v_name,v_expected_type,v_expected_not_null,v_expected_default in select * from (values
    ('media_kind','text',true,'''image''::text'),('content_type','text',false,null),('byte_size','bigint',false,null),
    ('checksum_sha256','text',false,null),('width','integer',false,null),('height','integer',false,null),('duration_ms','bigint',false,null),
    ('content_type_source','text',false,null),('byte_size_source','text',false,null),('checksum_source','text',false,null),
    ('dimensions_source','text',false,null),('duration_source','text',false,null)
  ) expected(column_name,type_name,not_null,default_expr) loop
    select format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid) into v_type,v_not_null,v_definition
      from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid='public.media_asset_provenance'::regclass and a.attname=v_name and not a.attisdropped;
    if (not found and v_installed) or (found and (v_type is distinct from v_expected_type or v_not_null is distinct from v_expected_not_null or v_definition is distinct from v_expected_default)) then
      raise exception using errcode='P0001',message='v77_schema_collision';
    end if;
  end loop;
  if not v_installed and exists (select 1 from pg_attribute a where a.attrelid='public.media_asset_provenance'::regclass and a.attname in ('media_kind','content_type','byte_size','checksum_sha256','width','height','duration_ms','content_type_source','byte_size_source','checksum_source','dimensions_source','duration_source') and not a.attisdropped) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
  if v_installed then
    for v_table,v_name,v_expected_definition in select * from (values
      ('video_upload_batches','video_upload_batches_pkey','PRIMARY KEY (id)'),
      ('video_upload_batches','video_upload_batches_owner_user_id_idempotency_key_key','UNIQUE (owner_user_id, idempotency_key)'),
      ('video_upload_batches','video_upload_batches_status_check','CHECK ((status = ANY (ARRAY[''prepared''::text, ''uploading''::text, ''finalizing''::text, ''finalized''::text, ''failed''::text, ''expired''::text, ''canceled''::text])))'),
      ('video_upload_items','video_upload_items_pkey','PRIMARY KEY (id)'),('video_upload_items','video_upload_items_batch_id_fkey','FOREIGN KEY (batch_id) REFERENCES video_upload_batches(id) ON DELETE RESTRICT'),
      ('video_upload_items','video_upload_items_batch_id_ordinal_key','UNIQUE (batch_id, ordinal)'),('video_upload_items','video_upload_items_batch_id_idempotency_key_key','UNIQUE (batch_id, idempotency_key)'),
      ('video_upload_items','video_upload_items_ordinal_check','CHECK (((ordinal >= 0) AND (ordinal <= 19)))'),
      ('video_upload_items','video_upload_items_declared_content_type_check','CHECK ((declared_content_type = ANY (ARRAY[''video/mp4''::text, ''video/x-m4v''::text, ''video/quicktime''::text])))'),
      ('video_upload_items','video_upload_items_declared_byte_size_check','CHECK (((declared_byte_size >= 1) AND (declared_byte_size <= 104857600)))'),
      ('video_upload_items','video_upload_items_declared_checksum_check','CHECK (((declared_checksum_sha256 IS NULL) OR (declared_checksum_sha256 ~ ''^[0-9a-f]{64}$''::text)))'),
      ('video_upload_items','video_upload_items_declared_dimensions_check','CHECK (((declared_width > 0) AND (declared_height > 0)))'),
      ('video_upload_items','video_upload_items_declared_duration_check','CHECK (((declared_duration_ms >= 4000) AND (declared_duration_ms <= 300000)))'),
      ('video_upload_items','video_upload_items_verified_content_type_check','CHECK (((verified_content_type IS NULL) OR (verified_content_type = ANY (ARRAY[''video/mp4''::text, ''video/x-m4v''::text, ''video/quicktime''::text]))))'),
      ('video_upload_items','video_upload_items_status_check','CHECK ((status = ANY (ARRAY[''prepared''::text, ''uploading''::text, ''finalizing''::text, ''finalized''::text, ''failed''::text, ''expired''::text, ''canceled''::text])))'),
      ('video_upload_items','video_upload_items_claim_shape_check','CHECK (((status = ''finalizing''::text) = ((finalize_claim_token IS NOT NULL) AND (finalize_claim_expires_at IS NOT NULL))))'),
      ('video_upload_items','video_upload_items_finalized_facts_check','CHECK ((((status <> ''finalized''::text) OR ((verified_content_type = ANY (ARRAY[''video/mp4''::text, ''video/x-m4v''::text, ''video/quicktime''::text])) AND ((verified_byte_size >= 1) AND (verified_byte_size <= 104857600)) AND ((verified_checksum_sha256 IS NULL) OR (verified_checksum_sha256 ~ ''^[0-9a-f]{64}$''::text)) AND (verified_width IS NULL) AND (verified_height IS NULL) AND (verified_duration_ms IS NULL) AND (finalize_claim_token IS NULL) AND (finalize_claim_expires_at IS NULL))) IS TRUE))')
    ) expected(table_name,constraint_name,constraint_definition) loop
      select pg_get_constraintdef(p.oid) into v_default from pg_constraint p
        where p.conrelid=to_regclass('public.'||v_table) and p.conname=v_name;
      if not found or v_default is distinct from v_expected_definition then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
    end loop;
    if exists (select 1 from pg_constraint p where p.conrelid in ('public.video_upload_batches'::regclass,'public.video_upload_items'::regclass)
      and p.contype in ('p','u','f','c') and p.conname not in ('video_upload_batches_pkey','video_upload_batches_owner_user_id_idempotency_key_key','video_upload_batches_status_check','video_upload_items_pkey','video_upload_items_batch_id_fkey','video_upload_items_batch_id_ordinal_key','video_upload_items_batch_id_idempotency_key_key','video_upload_items_ordinal_check','video_upload_items_declared_content_type_check','video_upload_items_declared_byte_size_check','video_upload_items_declared_checksum_check','video_upload_items_declared_dimensions_check','video_upload_items_declared_duration_check','video_upload_items_verified_content_type_check','video_upload_items_status_check','video_upload_items_claim_shape_check','video_upload_items_finalized_facts_check')) then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
    select pg_get_constraintdef(oid) into v_default from pg_constraint where conrelid='public.media_asset_provenance'::regclass and conname='media_asset_provenance_media_kind_check';
    if not found or v_default is distinct from 'CHECK ((media_kind = ANY (ARRAY[''image''::text, ''video''::text])))' then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
    select pg_get_constraintdef(oid) into v_default from pg_constraint where conrelid='public.media_asset_provenance'::regclass and conname='media_asset_provenance_video_fact_sources_check';
    if not found or v_default is distinct from 'CHECK (((media_kind <> ''video''::text) OR ((content_type_source = ''storage_head_verified''::text) AND (byte_size_source = ''storage_head_verified''::text) AND (checksum_source = ANY (ARRAY[''storage_digest_verified''::text, ''unavailable''::text])) AND (dimensions_source = ''browser_declared''::text) AND (duration_source = ''browser_declared''::text) AND (((checksum_source = ''unavailable''::text) AND (checksum_sha256 IS NULL)) OR ((checksum_source = ''storage_digest_verified''::text) AND (checksum_sha256 ~ ''^[0-9a-f]{64}$''::text))) AND (width > 0) AND (height > 0) AND ((duration_ms >= 4000) AND (duration_ms <= 300000)))))' then raise exception using errcode='P0001',message='v77_schema_collision'; end if;
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
    ('public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint)','vibepin:v77:video-upload-item-prepare','2ba41a1ad29086bdca6cfce6e25cafad'),
    ('public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz)','vibepin:v77:video-upload-item-claim','1e7a9a9f8cda0fecf9b121e83caec3e1'),
    ('public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text)','vibepin:v77:video-upload-item-finalize','02f3e0537c0e882230e159243cb92bae'),
    ('public.video_upload_item_fail(uuid,uuid,integer,uuid,text)','vibepin:v77:video-upload-item-fail','71955fb29596ec65c0b9b8f4f2894f84')
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
      ('public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz)'),
      ('public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text)'),
      ('public.video_upload_item_fail(uuid,uuid,integer,uuid,text)')
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
        to_regprocedure('public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz)'),
        to_regprocedure('public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text)'),
        to_regprocedure('public.video_upload_item_fail(uuid,uuid,integer,uuid,text)')
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
    constraint video_upload_items_declared_byte_size_check check (declared_byte_size between 1 and 104857600),
  declared_checksum_sha256 text
    constraint video_upload_items_declared_checksum_check check (declared_checksum_sha256 is null or declared_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  declared_width integer,
  declared_height integer,
  declared_duration_ms bigint,
  constraint video_upload_items_declared_dimensions_check check (declared_width > 0 and declared_height > 0),
  constraint video_upload_items_declared_duration_check check (declared_duration_ms between 4000 and 300000),
  verified_content_type text
    constraint video_upload_items_verified_content_type_check check (verified_content_type is null or verified_content_type in ('video/mp4','video/x-m4v','video/quicktime')),
  verified_byte_size bigint,
  verified_checksum_sha256 text,
  verified_width integer,
  verified_height integer,
  verified_duration_ms bigint,
  finalize_claim_token uuid,
  finalize_claim_expires_at timestamptz,
  capability_expires_at timestamptz not null,
  status text not null default 'prepared'
    constraint video_upload_items_status_check check (status in ('prepared','uploading','finalizing','finalized','failed','expired','canceled')),
  constraint video_upload_items_claim_shape_check check (
    (status = 'finalizing') = (finalize_claim_token is not null and finalize_claim_expires_at is not null)
  ),
  constraint video_upload_items_finalized_facts_check check ((
    status <> 'finalized' or (
      verified_content_type in ('video/mp4','video/x-m4v','video/quicktime')
      and verified_byte_size between 1 and 104857600
      and (verified_checksum_sha256 is null or verified_checksum_sha256 ~ '^[0-9a-f]{64}$')
      and verified_width is null and verified_height is null and verified_duration_ms is null
      and finalize_claim_token is null and finalize_claim_expires_at is null
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
alter table public.media_asset_provenance add column if not exists content_type_source text;
alter table public.media_asset_provenance add column if not exists byte_size_source text;
alter table public.media_asset_provenance add column if not exists checksum_source text;
alter table public.media_asset_provenance add column if not exists dimensions_source text;
alter table public.media_asset_provenance add column if not exists duration_source text;
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
do $v77_provenance_fact_sources$
declare v_definition text;
begin
  select pg_get_constraintdef(oid) into v_definition from pg_constraint
    where conrelid='public.media_asset_provenance'::regclass and conname='media_asset_provenance_video_fact_sources_check';
  if found and v_definition <> 'CHECK (((media_kind <> ''video''::text) OR ((content_type_source = ''storage_head_verified''::text) AND (byte_size_source = ''storage_head_verified''::text) AND (checksum_source = ANY (ARRAY[''storage_digest_verified''::text, ''unavailable''::text])) AND (dimensions_source = ''browser_declared''::text) AND (duration_source = ''browser_declared''::text) AND (((checksum_source = ''unavailable''::text) AND (checksum_sha256 IS NULL)) OR ((checksum_source = ''storage_digest_verified''::text) AND (checksum_sha256 ~ ''^[0-9a-f]{64}$''::text))) AND (width > 0) AND (height > 0) AND ((duration_ms >= 4000) AND (duration_ms <= 300000)))))' then
    raise exception using errcode='P0001',message='v77_schema_collision';
  elsif not found then
    alter table public.media_asset_provenance add constraint media_asset_provenance_video_fact_sources_check check (
      media_kind <> 'video' or (
        content_type_source='storage_head_verified' and byte_size_source='storage_head_verified'
        and checksum_source in ('storage_digest_verified','unavailable')
        and dimensions_source='browser_declared' and duration_source='browser_declared'
        and ((checksum_source='unavailable' and checksum_sha256 is null)
          or (checksum_source='storage_digest_verified' and checksum_sha256 ~ '^[0-9a-f]{64}$'))
        and width>0 and height>0 and duration_ms between 4000 and 300000
      )
    );
  end if;
end $v77_provenance_fact_sources$;

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
  v_capability_expires_at timestamptz := now()+interval '2 hours';
begin
  if p_owner_user_id is null or p_batch_id is null or p_ordinal is null or p_ordinal<0 or p_ordinal>=20
     or nullif(btrim(p_idempotency_key),'') is null or nullif(btrim(p_private_path),'') is null
     or p_private_path like '%..%' or split_part(p_private_path,'/',1) is distinct from p_owner_user_id::text then
    raise exception using errcode='22023',message=case when p_ordinal is null or p_ordinal<0 or p_ordinal>=20 then 'video_upload_batch_limit_exceeded' else 'invalid_video_upload_item' end;
  end if;
  if p_declared_content_type not in ('video/mp4','video/x-m4v','video/quicktime') then
    raise exception using errcode='22023',message='invalid_video_content_type';
  end if;
  if p_declared_byte_size is null or p_declared_byte_size<1 or p_declared_byte_size>104857600 then
    raise exception using errcode='22023',message='video_upload_too_large';
  end if;
  if p_declared_checksum_sha256 is null or btrim(p_declared_checksum_sha256) !~ '^[0-9a-fA-F]{64}$'
     or p_declared_width is null or p_declared_width<=0 or p_declared_height is null or p_declared_height<=0
     or p_declared_duration_ms is null or p_declared_duration_ms<4000 or p_declared_duration_ms>300000 then
    raise exception using errcode='22023',message='invalid_declared_video_facts';
  end if;
  select * into v_batch from public.video_upload_batches where id=p_batch_id and owner_user_id=p_owner_user_id for update;
  if not found then raise exception using errcode='P0002',message='video_upload_batch_not_found'; end if;
  if v_batch.expires_at<=now() then raise exception using errcode='55000',message='video_upload_batch_expired'; end if;
  if v_batch.status not in ('prepared','uploading') then raise exception using errcode='55000',message='video_upload_batch_not_preparable'; end if;
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
    update public.video_upload_items set capability_expires_at=v_capability_expires_at,updated_at=now()
      where id=v_item.id returning * into v_item;
    insert into public.media_cleanup_outbox(owner_user_id,bucket_id,object_path,reason,dedupe_key,next_attempt_at)
      values(p_owner_user_id,'generated-private',v_item.private_path,'video_upload_capability_expired','video-upload:'||v_item.id::text,v_capability_expires_at)
      on conflict(dedupe_key) where dedupe_key is not null do update set
        owner_user_id=excluded.owner_user_id,bucket_id=excluded.bucket_id,object_path=excluded.object_path,
        reason=excluded.reason,status='pending',lease_token=null,lease_expires_at=null,
        next_attempt_at=excluded.next_attempt_at,last_error_code=null,dead_lettered_at=null,completed_at=null,updated_at=now();
    return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'batchId',v_batch.id,'capabilityExpiresAt',v_item.capability_expires_at);
  end if;
  if exists (select 1 from public.video_upload_items where batch_id=v_batch.id and idempotency_key=btrim(p_idempotency_key)) then
    raise exception using errcode='23505',message='video_upload_item_idempotency_conflict';
  end if;
  insert into public.video_upload_items(
    batch_id,owner_user_id,ordinal,idempotency_key,private_path,declared_content_type,declared_byte_size,
    declared_checksum_sha256,declared_width,declared_height,declared_duration_ms,capability_expires_at,expires_at
  ) values (
    v_batch.id,p_owner_user_id,p_ordinal,btrim(p_idempotency_key),btrim(p_private_path),p_declared_content_type,p_declared_byte_size,
    nullif(btrim(coalesce(p_declared_checksum_sha256,'')),''),p_declared_width,p_declared_height,p_declared_duration_ms,v_capability_expires_at,v_batch.expires_at
  ) returning * into v_item;
  insert into public.media_cleanup_outbox(owner_user_id,bucket_id,object_path,reason,dedupe_key,next_attempt_at)
    values(p_owner_user_id,'generated-private',v_item.private_path,'video_upload_capability_expired','video-upload:'||v_item.id::text,v_capability_expires_at)
    on conflict(dedupe_key) where dedupe_key is not null do update set
      owner_user_id=excluded.owner_user_id,bucket_id=excluded.bucket_id,object_path=excluded.object_path,
      reason=excluded.reason,status='pending',lease_token=null,lease_expires_at=null,
      next_attempt_at=excluded.next_attempt_at,last_error_code=null,dead_lettered_at=null,completed_at=null,updated_at=now();
  update public.video_upload_batches set status='uploading',updated_at=now() where id=v_batch.id;
  return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'batchId',v_batch.id,'capabilityExpiresAt',v_item.capability_expires_at);
exception when others then
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'video_upload_batch_limit_exceeded' then 'video_upload_batch_limit_exceeded'
    when 'invalid_video_upload_item' then 'invalid_video_upload_item'
    when 'invalid_video_content_type' then 'invalid_video_content_type'
    when 'video_upload_too_large' then 'video_upload_too_large'
    when 'invalid_declared_video_facts' then 'invalid_declared_video_facts'
    when 'video_upload_batch_not_found' then 'video_upload_batch_not_found'
    when 'video_upload_batch_expired' then 'video_upload_batch_expired'
    when 'video_upload_batch_not_preparable' then 'video_upload_batch_not_preparable'
    when 'video_upload_item_idempotency_conflict' then 'video_upload_item_idempotency_conflict'
    else 'v77_video_upload_error' end;
end $fn$;
comment on function public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint) is 'vibepin:v77:video-upload-item-prepare';

create or replace function public.video_upload_item_claim(
  p_owner_user_id uuid,p_batch_id uuid,p_ordinal integer,p_claim_token uuid,p_claim_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v77:video-upload-item-claim
declare v_batch public.video_upload_batches%rowtype; v_item public.video_upload_items%rowtype; v_provenance_ready boolean;
begin
  if p_owner_user_id is null or p_batch_id is null or p_ordinal is null or p_claim_token is null
     or p_claim_expires_at is null or p_claim_expires_at<=now() or p_claim_expires_at>now()+interval '5 minutes' then
    raise exception using errcode='22023',message='invalid_video_upload_claim';
  end if;
  select * into v_batch from public.video_upload_batches where id=p_batch_id and owner_user_id=p_owner_user_id for update;
  if not found then raise exception using errcode='P0002',message='video_upload_batch_not_found'; end if;
  select * into v_item from public.video_upload_items
    where batch_id=v_batch.id and ordinal=p_ordinal and owner_user_id=p_owner_user_id for update;
  if not found then raise exception using errcode='P0002',message='video_upload_item_not_found'; end if;
  if v_item.status='finalized' then
    select exists(select 1 from public.media_asset_provenance p
      where p.owner_user_id=p_owner_user_id and p.bucket_id='generated-private' and p.object_path=v_item.private_path
        and p.source_type='upload' and p.lifecycle_state='draft' and p.media_kind='video'
        and p.content_type is not distinct from v_item.verified_content_type
        and p.byte_size is not distinct from v_item.verified_byte_size
        and p.checksum_sha256 is not distinct from v_item.verified_checksum_sha256
        and p.width is not distinct from v_item.declared_width and p.height is not distinct from v_item.declared_height
        and p.duration_ms is not distinct from v_item.declared_duration_ms
        and p.content_type_source='storage_head_verified' and p.byte_size_source='storage_head_verified'
        and p.checksum_source=case when v_item.verified_checksum_sha256 is null then 'unavailable' else 'storage_digest_verified' end
        and p.dimensions_source='browser_declared' and p.duration_source='browser_declared') into v_provenance_ready;
    if not v_provenance_ready then raise exception using errcode='55000',message='video_upload_provenance_incomplete'; end if;
    return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'claimToken',null,'provenanceReady',true);
  end if;
  if v_batch.expires_at<=now() then raise exception using errcode='55000',message='video_upload_batch_expired'; end if;
  if v_batch.status not in ('uploading','finalizing') then raise exception using errcode='55000',message='video_upload_batch_not_finalizable'; end if;
  if v_item.status='prepared' or (v_item.status='finalizing' and v_item.finalize_claim_expires_at<=now()) then
    update public.video_upload_items set status='finalizing',finalize_claim_token=p_claim_token,
      finalize_claim_expires_at=p_claim_expires_at,error_code=null,updated_at=now()
      where id=v_item.id returning * into v_item;
  elsif v_item.status='finalizing' and v_item.finalize_claim_token=p_claim_token and v_item.finalize_claim_expires_at>now() then
    null;
  elsif v_item.status='finalizing' then
    raise exception using errcode='55000',message='video_upload_item_claimed';
  else
    raise exception using errcode='55000',message='video_upload_item_not_finalizable';
  end if;
  update public.video_upload_batches set status='finalizing',updated_at=now() where id=v_batch.id;
  return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'claimToken',v_item.finalize_claim_token,
    'claimExpiresAt',v_item.finalize_claim_expires_at);
exception when others then
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'invalid_video_upload_claim' then 'invalid_video_upload_claim'
    when 'video_upload_batch_not_found' then 'video_upload_batch_not_found'
    when 'video_upload_batch_expired' then 'video_upload_batch_expired'
    when 'video_upload_batch_not_finalizable' then 'video_upload_batch_not_finalizable'
    when 'video_upload_item_not_found' then 'video_upload_item_not_found'
    when 'video_upload_provenance_incomplete' then 'video_upload_provenance_incomplete'
    when 'video_upload_item_claimed' then 'video_upload_item_claimed'
    when 'video_upload_item_not_finalizable' then 'video_upload_item_not_finalizable'
    else 'v77_video_upload_error' end;
end $fn$;
comment on function public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz) is 'vibepin:v77:video-upload-item-claim';

create or replace function public.video_upload_item_finalize(
  p_owner_user_id uuid,p_batch_id uuid,p_ordinal integer,p_claim_token uuid,p_bucket_id text,
  p_verified_content_type text,p_verified_byte_size bigint,p_verified_checksum_sha256 text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v77:video-upload-item-finalize
declare v_batch public.video_upload_batches%rowtype; v_item public.video_upload_items%rowtype; v_done boolean; v_has_nonfinal boolean; v_written boolean;
begin
  if p_owner_user_id is null or p_batch_id is null or p_ordinal is null or p_claim_token is null
     or p_bucket_id is distinct from 'generated-private' then raise exception using errcode='22023',message='invalid_video_finalize_identity'; end if;
  if nullif(btrim(coalesce(p_verified_content_type,'')),'') is null
     or p_verified_content_type not in ('video/mp4','video/x-m4v','video/quicktime') then raise exception using errcode='22023',message='invalid_video_content_type'; end if;
  if p_verified_byte_size is null or p_verified_byte_size<1 or p_verified_byte_size>104857600 then raise exception using errcode='22023',message='video_upload_too_large'; end if;
  if p_verified_checksum_sha256 is not null and btrim(p_verified_checksum_sha256) !~ '^[0-9a-fA-F]{64}$' then
    raise exception using errcode='22023',message='invalid_verified_video_checksum';
  end if;
  select * into v_batch from public.video_upload_batches where id=p_batch_id and owner_user_id=p_owner_user_id for update;
  if not found then raise exception using errcode='P0002',message='video_upload_batch_not_found'; end if;
  select * into v_item from public.video_upload_items
    where batch_id=v_batch.id and ordinal=p_ordinal and owner_user_id=p_owner_user_id for update;
  if not found then raise exception using errcode='P0002',message='video_upload_item_not_found'; end if;
  if v_item.status<>'finalizing' or v_item.finalize_claim_token is distinct from p_claim_token
     or v_item.finalize_claim_expires_at<=now() then raise exception using errcode='55000',message='video_upload_claim_lost'; end if;
  insert into public.media_asset_provenance(
    owner_user_id,bucket_id,object_path,source_type,intent_id,lifecycle_state,media_kind,
    content_type,byte_size,checksum_sha256,width,height,duration_ms,
    content_type_source,byte_size_source,checksum_source,dimensions_source,duration_source,updated_at
  ) values (
    p_owner_user_id,p_bucket_id,v_item.private_path,'upload',null,'draft','video',
    p_verified_content_type,p_verified_byte_size,nullif(lower(btrim(coalesce(p_verified_checksum_sha256,''))),''),
    v_item.declared_width,v_item.declared_height,v_item.declared_duration_ms,
    'storage_head_verified','storage_head_verified',case when p_verified_checksum_sha256 is null then 'unavailable' else 'storage_digest_verified' end,
    'browser_declared','browser_declared',now()
  ) on conflict(bucket_id,object_path) do update set
    owner_user_id=excluded.owner_user_id,source_type=excluded.source_type,intent_id=excluded.intent_id,
    lifecycle_state=excluded.lifecycle_state,media_kind=excluded.media_kind,content_type=excluded.content_type,
    byte_size=excluded.byte_size,checksum_sha256=excluded.checksum_sha256,width=excluded.width,height=excluded.height,
    duration_ms=excluded.duration_ms,content_type_source=excluded.content_type_source,byte_size_source=excluded.byte_size_source,
    checksum_source=excluded.checksum_source,dimensions_source=excluded.dimensions_source,duration_source=excluded.duration_source,
    updated_at=now()
    where media_asset_provenance.owner_user_id=excluded.owner_user_id
      and media_asset_provenance.source_type='upload'
    returning true into v_written;
  if not coalesce(v_written,false) then raise exception using errcode='23505',message='video_provenance_conflict'; end if;
  update public.video_upload_items set verified_content_type=p_verified_content_type,verified_byte_size=p_verified_byte_size,
    verified_checksum_sha256=nullif(lower(btrim(coalesce(p_verified_checksum_sha256,''))),''),
    verified_width=null,verified_height=null,verified_duration_ms=null,status='finalized',finalized_at=now(),
    finalize_claim_token=null,finalize_claim_expires_at=null,updated_at=now()
    where id=v_item.id returning * into v_item;
  update public.media_cleanup_outbox set status='done',completed_at=now(),lease_token=null,lease_expires_at=null,
    next_attempt_at=null,last_error_code=null,dead_lettered_at=null,updated_at=now()
    where dedupe_key='video-upload:'||v_item.id::text;
  if not found then raise exception using errcode='55000',message='video_cleanup_schedule_missing'; end if;
  select not exists(select 1 from public.video_upload_items where batch_id=v_batch.id and status in ('prepared','finalizing')),
    exists(select 1 from public.video_upload_items where batch_id=v_batch.id and status<>'finalized')
    into v_done,v_has_nonfinal;
  update public.video_upload_batches set status=case when not v_done then 'finalizing' when v_has_nonfinal then 'failed' else 'finalized' end,
    finalized_at=case when v_done and not v_has_nonfinal then coalesce(finalized_at,now()) else null end,updated_at=now()
    where id=v_batch.id returning * into v_batch;
  return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'batchStatus',v_batch.status,'provenanceReady',true);
exception when others then
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'invalid_video_finalize_identity' then 'invalid_video_finalize_identity'
    when 'invalid_video_content_type' then 'invalid_video_content_type'
    when 'video_upload_too_large' then 'video_upload_too_large'
    when 'invalid_verified_video_checksum' then 'invalid_verified_video_checksum'
    when 'video_upload_batch_not_found' then 'video_upload_batch_not_found'
    when 'video_upload_item_not_found' then 'video_upload_item_not_found'
    when 'video_upload_claim_lost' then 'video_upload_claim_lost'
    when 'video_provenance_conflict' then 'video_provenance_conflict'
    when 'video_cleanup_schedule_missing' then 'video_cleanup_schedule_missing'
    else 'v77_video_upload_error' end;
end $fn$;
comment on function public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text) is 'vibepin:v77:video-upload-item-finalize';

create or replace function public.video_upload_item_fail(
  p_owner_user_id uuid,p_batch_id uuid,p_ordinal integer,p_claim_token uuid,p_error_code text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v77:video-upload-item-fail
declare v_batch public.video_upload_batches%rowtype; v_item public.video_upload_items%rowtype; v_done boolean;
begin
  if p_owner_user_id is null or p_batch_id is null or p_ordinal is null or p_claim_token is null
     or nullif(btrim(coalesce(p_error_code,'')),'') is null then raise exception using errcode='22023',message='invalid_video_upload_failure'; end if;
  select * into v_batch from public.video_upload_batches where id=p_batch_id and owner_user_id=p_owner_user_id for update;
  if not found then raise exception using errcode='P0002',message='video_upload_batch_not_found'; end if;
  select * into v_item from public.video_upload_items
    where batch_id=v_batch.id and ordinal=p_ordinal and owner_user_id=p_owner_user_id for update;
  if not found then raise exception using errcode='P0002',message='video_upload_item_not_found'; end if;
  if v_item.status<>'finalizing' or v_item.finalize_claim_token is distinct from p_claim_token
     or v_item.finalize_claim_expires_at<=now() then raise exception using errcode='55000',message='video_upload_claim_lost'; end if;
  update public.video_upload_items set status='failed',error_code=btrim(p_error_code),
    finalize_claim_token=null,finalize_claim_expires_at=null,updated_at=now()
    where id=v_item.id returning * into v_item;
  insert into public.media_cleanup_outbox(owner_user_id,bucket_id,object_path,reason,dedupe_key,next_attempt_at)
    values(p_owner_user_id,'generated-private',v_item.private_path,btrim(p_error_code),'video-upload:'||v_item.id::text,v_item.capability_expires_at)
    on conflict(dedupe_key) where dedupe_key is not null do update set
      owner_user_id=excluded.owner_user_id,bucket_id=excluded.bucket_id,object_path=excluded.object_path,
      reason=excluded.reason,status='pending',lease_token=null,lease_expires_at=null,
      next_attempt_at=greatest(public.media_cleanup_outbox.next_attempt_at,excluded.next_attempt_at),
      last_error_code=null,dead_lettered_at=null,completed_at=null,updated_at=now();
  select not exists(select 1 from public.video_upload_items where batch_id=v_batch.id and status in ('prepared','finalizing')) into v_done;
  update public.video_upload_batches set status=case when v_done then 'failed' else 'finalizing' end,
    error_code=case when v_done then btrim(p_error_code) else null end,updated_at=now() where id=v_batch.id;
  return jsonb_build_object('itemId',v_item.id,'status',v_item.status,'cleanupAllowed',true,'cleanupScheduled',true,'privatePath',v_item.private_path);
exception when others then
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'invalid_video_upload_failure' then 'invalid_video_upload_failure'
    when 'video_upload_batch_not_found' then 'video_upload_batch_not_found'
    when 'video_upload_item_not_found' then 'video_upload_item_not_found'
    when 'video_upload_claim_lost' then 'video_upload_claim_lost'
    else 'v77_video_upload_error' end;
end $fn$;
comment on function public.video_upload_item_fail(uuid,uuid,integer,uuid,text) is 'vibepin:v77:video-upload-item-fail';

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
revoke all on function public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz) from public,anon,authenticated;
revoke all on function public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text) from public,anon,authenticated;
revoke all on function public.video_upload_item_fail(uuid,uuid,integer,uuid,text) from public,anon,authenticated;
grant execute on function public.video_upload_batch_prepare(uuid,text,timestamptz) to service_role;
grant execute on function public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint) to service_role;
grant execute on function public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz) to service_role;
grant execute on function public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text) to service_role;
grant execute on function public.video_upload_item_fail(uuid,uuid,integer,uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
