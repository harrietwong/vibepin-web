-- v78 rollback policy: remove only the versioned RPC surface. The additive
-- identity column and its historical evidence are deliberately retained.
begin;
do $v78_rollback_preflight$
declare v_expected record; v_oid oid; v_proc pg_proc%rowtype; v_attnum smallint;
begin
  for v_expected in select * from (values
    ('public.publish_intent_confirm_prepare_v78(uuid,jsonb,text)','vibepin:v78:publish-intent-confirm-prepare','222da5a68936647d910421fc8535a103'),
    ('public.publish_asset_claim_ready_v78(uuid,text,text,uuid)','vibepin:v78:publish-asset-claim-ready','ee50c7392dd17d7ed8b597312223f65c'),
    ('public.publish_asset_ready_sources_v78(uuid,text,text)','vibepin:v78:publish-asset-ready-sources','8df858a2e93b6e11952759332a738706'),
    ('public.publish_provider_attempt_settle_v78(uuid,uuid,uuid,text,integer,text,text,jsonb)','vibepin:v78:publish-provider-attempt-settle','b4bc74adeb3e3d320e261c7129472e41')
  ) expected(signature,marker,body_hash) loop
    v_oid:=to_regprocedure(v_expected.signature);
    if v_oid is not null then
      select * into v_proc from pg_proc where oid=v_oid;
      if obj_description(v_oid,'pg_proc') is distinct from v_expected.marker
         or not v_proc.prosecdef or v_proc.prokind<>'f' or v_proc.prorettype<>to_regtype('jsonb')
         or v_proc.proretset or v_proc.provariadic<>0
         or v_proc.prolang<>(select oid from pg_language where lanname='plpgsql')
         or v_proc.proconfig is distinct from array['search_path=public, pg_temp']::text[]
         or md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>v_expected.body_hash then
        raise exception using errcode='P0001',message='v78_rollback_definition_tamper';
      end if;
    end if;
  end loop;
  select attnum into v_attnum from pg_attribute
   where attrelid='public.publish_intents'::regclass
     and attname='source_identity_fingerprint' and not attisdropped;
  if found and col_description('public.publish_intents'::regclass,v_attnum)
      is distinct from 'vibepin:v78:source-identity-fingerprint' then
    raise exception using errcode='P0001',message='v78_rollback_definition_tamper';
  end if;
end $v78_rollback_preflight$;
drop function if exists public.publish_provider_attempt_settle_v78(uuid,uuid,uuid,text,integer,text,text,jsonb);
drop function if exists public.publish_asset_ready_sources_v78(uuid,text,text);
drop function if exists public.publish_asset_claim_ready_v78(uuid,text,text,uuid);
drop function if exists public.publish_intent_confirm_prepare_v78(uuid,jsonb,text);
notify pgrst,'reload schema';
commit;
