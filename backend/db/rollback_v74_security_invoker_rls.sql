-- v74 rollback removes only v74-owned policy objects.
-- It intentionally keeps RLS/FORCE RLS enabled: restoring an unprotected
-- public table is not a safe rollback. It also keeps security_invoker=true:
-- without a persisted pre-migration state, RESET could downgrade a view that
-- was already safe. No rows, tables, or columns are deleted.

begin;

do $v74_rollback$
declare
  v_item record;
  v_comment text;
begin
  for v_item in
    select * from (values
      ('tasks', 'vibepin_v74_tasks_owner_access', 'vibepin:v74:owner-access'),
      ('tasks', 'vibepin_v74_tasks_owner_boundary', 'vibepin:v74:owner-boundary'),
      ('user_settings', 'vibepin_v74_user_settings_owner_access', 'vibepin:v74:owner-access'),
      ('user_settings', 'vibepin_v74_user_settings_owner_boundary', 'vibepin:v74:owner-boundary'),
      ('audit_log', 'vibepin_v74_audit_owner_select', 'vibepin:v74:audit-owner-select'),
      ('audit_log', 'vibepin_v74_audit_owner_select_boundary', 'vibepin:v74:audit-owner-select-boundary'),
      ('audit_log', 'vibepin_v74_audit_owner_insert', 'vibepin:v74:audit-owner-insert'),
      ('audit_log', 'vibepin_v74_audit_owner_insert_boundary', 'vibepin:v74:audit-owner-insert-boundary'),
      ('audit_log', 'vibepin_v74_audit_deny_update', 'vibepin:v74:audit-deny-update'),
      ('audit_log', 'vibepin_v74_audit_deny_delete', 'vibepin:v74:audit-deny-delete')
    ) as expected(table_name, policy_name, marker)
  loop
    if to_regclass(format('public.%I', v_item.table_name)) is null then
      continue;
    end if;

    select obj_description(p.oid, 'pg_policy')
      into v_comment
      from pg_policy p
     where p.polrelid = format('public.%I', v_item.table_name)::regclass
       and p.polname = v_item.policy_name;

    if found and v_comment is distinct from v_item.marker then
      raise exception 'v74 rollback refused: policy %.% marker is unexpected',
        v_item.table_name, v_item.policy_name;
    end if;

    if found then
      execute format('drop policy %I on public.%I', v_item.policy_name, v_item.table_name);
    end if;
  end loop;
end
$v74_rollback$;

do $v74_view_rollback$
declare
  v_kind "char";
  v_options text[];
begin
  select relkind, reloptions
    into v_kind, v_options
    from pg_class
   where oid = to_regclass('public.trend_opportunities_view');

  if v_kind is null then
    raise notice 'v74 rollback: public.trend_opportunities_view is absent';
  elsif v_kind <> 'v' then
    raise exception 'v74 rollback refused: public.trend_opportunities_view is not a normal view';
  elsif not ('security_invoker=true' = any(coalesce(v_options, array[]::text[]))) then
    raise exception 'v74 rollback refused: trend_opportunities_view invoker option is unexpected';
  else
    raise notice 'v74 rollback: retaining security_invoker=true (fail-closed)';
  end if;
end
$v74_view_rollback$;

notify pgrst, 'reload schema';
commit;
