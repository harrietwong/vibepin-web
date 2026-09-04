-- Safe, non-destructive v75 application rollback.
--
-- v75 can upgrade a pre-existing provenance ledger, so a rollback cannot know
-- which columns, constraints, indexes, tables, or bucket rows predated v75.
-- Keep every row/object/schema artifact and only revoke the two read policies
-- introduced by v75. The private bucket remains private. Re-applying v75
-- recreates the policies idempotently.
begin;
do $v75_policy_drop$
declare
  v_comment text;
begin
  select obj_description(p.oid, 'pg_policy') into v_comment
    from pg_policy p
   where p.polrelid='storage.objects'::regclass
     and p.polname='vibepin_v75_generated_private_owner_select';
  if found and v_comment is distinct from 'vibepin:v75:generated-private-owner-select' then
    raise exception 'v75 rollback refused: storage policy marker is unexpected';
  elsif found then
    drop policy vibepin_v75_generated_private_owner_select on storage.objects;
  end if;

  if to_regclass('public.media_asset_provenance') is not null then
    select obj_description(p.oid, 'pg_policy') into v_comment
      from pg_policy p
     where p.polrelid='public.media_asset_provenance'::regclass
       and p.polname='vibepin_v75_media_owner_select';
    if found and v_comment is distinct from 'vibepin:v75:media-owner-select' then
      raise exception 'v75 rollback refused: provenance policy marker is unexpected';
    elsif found then
      drop policy vibepin_v75_media_owner_select on public.media_asset_provenance;
    end if;
  end if;
end $v75_policy_drop$;
commit;
