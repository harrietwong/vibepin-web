-- Migration v74 — harden legacy user-owned tables and trend view.
--
-- Compatibility contract:
--   * An object absent from an environment is an intentional no-op.
--   * A legacy table that exists without user_id is an unsafe, unknown shape;
--     fail closed instead of inventing ownership or silently enabling RLS.
--   * No table, row, column, or existing policy is deleted.

begin;

do $v74_preflight$
declare
  v_item record;
  v_comment text;
begin
  -- PostgreSQL combines permissive policies with OR. An unknown pre-existing
  -- policy could therefore reopen access after this migration. Require manual
  -- reconciliation instead of guessing whether an inherited policy is safe.
  if exists (
    select 1 from pg_policy
     where polrelid = to_regclass('public.tasks')
       and polname not in (
         'vibepin_v74_tasks_owner_access',
         'vibepin_v74_tasks_owner_boundary'
       )
  ) then
    raise exception 'v74 migration refused: public.tasks has unexpected existing policies';
  end if;
  if exists (
    select 1 from pg_policy
     where polrelid = to_regclass('public.user_settings')
       and polname not in (
         'vibepin_v74_user_settings_owner_access',
         'vibepin_v74_user_settings_owner_boundary'
       )
  ) then
    raise exception 'v74 migration refused: public.user_settings has unexpected existing policies';
  end if;
  if exists (
    select 1 from pg_policy
     where polrelid = to_regclass('public.audit_log')
       and polname not in (
         'vibepin_v74_audit_owner_select',
         'vibepin_v74_audit_owner_select_boundary',
         'vibepin_v74_audit_owner_insert',
         'vibepin_v74_audit_owner_insert_boundary',
         'vibepin_v74_audit_deny_update',
         'vibepin_v74_audit_deny_delete'
       )
  ) then
    raise exception 'v74 migration refused: public.audit_log has unexpected existing policies';
  end if;

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
      raise exception 'v74 migration refused: policy %.% already exists without the v74 marker',
        v_item.table_name, v_item.policy_name;
    end if;
  end loop;
end
$v74_preflight$;

do $v74$
declare
  v_table text;
  v_policy text;
begin
  foreach v_table in array array['tasks', 'user_settings'] loop
    if to_regclass(format('public.%I', v_table)) is null then
      raise notice 'v74: public.% is absent; skipping legacy RLS hardening', v_table;
      continue;
    end if;

    if not exists (
      select 1
        from pg_attribute
       where attrelid = format('public.%I', v_table)::regclass
         and attname = 'user_id'
         and not attisdropped
    ) then
      raise exception 'v74: public.% exists without user_id; refusing unsafe ownership guess', v_table;
    end if;

    execute format('alter table public.%I enable row level security', v_table);
    execute format('alter table public.%I force row level security', v_table);

    v_policy := 'vibepin_v74_' || v_table || '_owner_access';
    execute format('drop policy if exists %I on public.%I', v_policy, v_table);
    execute format(
      'create policy %I on public.%I as permissive for all to authenticated '
      || 'using (user_id::text = (select auth.uid())::text) '
      || 'with check (user_id::text = (select auth.uid())::text)',
      v_policy,
      v_table
    );
    execute format(
      'comment on policy %I on public.%I is %L',
      v_policy,
      v_table,
      'vibepin:v74:owner-access'
    );

    v_policy := 'vibepin_v74_' || v_table || '_owner_boundary';
    execute format('drop policy if exists %I on public.%I', v_policy, v_table);
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated '
      || 'using (user_id::text = (select auth.uid())::text) '
      || 'with check (user_id::text = (select auth.uid())::text)',
      v_policy,
      v_table
    );
    execute format(
      'comment on policy %I on public.%I is %L',
      v_policy,
      v_table,
      'vibepin:v74:owner-boundary'
    );
  end loop;

  v_table := 'audit_log';
  if to_regclass('public.audit_log') is null then
    raise notice 'v74: public.audit_log is absent; skipping legacy RLS hardening';
  else
    if not exists (
      select 1
        from pg_attribute
       where attrelid = 'public.audit_log'::regclass
         and attname = 'user_id'
         and not attisdropped
    ) then
      raise exception 'v74: public.audit_log exists without user_id; refusing unsafe ownership guess';
    end if;

    alter table public.audit_log enable row level security;
    alter table public.audit_log force row level security;

    drop policy if exists vibepin_v74_audit_owner_select on public.audit_log;
    create policy vibepin_v74_audit_owner_select
      on public.audit_log as permissive for select to authenticated
      using (user_id::text = (select auth.uid())::text);
    comment on policy vibepin_v74_audit_owner_select on public.audit_log
      is 'vibepin:v74:audit-owner-select';

    drop policy if exists vibepin_v74_audit_owner_select_boundary on public.audit_log;
    create policy vibepin_v74_audit_owner_select_boundary
      on public.audit_log as restrictive for select to authenticated
      using (user_id::text = (select auth.uid())::text);
    comment on policy vibepin_v74_audit_owner_select_boundary on public.audit_log
      is 'vibepin:v74:audit-owner-select-boundary';

    drop policy if exists vibepin_v74_audit_owner_insert on public.audit_log;
    create policy vibepin_v74_audit_owner_insert
      on public.audit_log as permissive for insert to authenticated
      with check (user_id::text = (select auth.uid())::text);
    comment on policy vibepin_v74_audit_owner_insert on public.audit_log
      is 'vibepin:v74:audit-owner-insert';

    drop policy if exists vibepin_v74_audit_owner_insert_boundary on public.audit_log;
    create policy vibepin_v74_audit_owner_insert_boundary
      on public.audit_log as restrictive for insert to authenticated
      with check (user_id::text = (select auth.uid())::text);
    comment on policy vibepin_v74_audit_owner_insert_boundary on public.audit_log
      is 'vibepin:v74:audit-owner-insert-boundary';

    -- Even if a legacy permissive policy exists, authenticated users cannot
    -- mutate or delete audit evidence through PostgREST.
    drop policy if exists vibepin_v74_audit_deny_update on public.audit_log;
    create policy vibepin_v74_audit_deny_update
      on public.audit_log as restrictive for update to authenticated
      using (false) with check (false);
    comment on policy vibepin_v74_audit_deny_update on public.audit_log
      is 'vibepin:v74:audit-deny-update';

    drop policy if exists vibepin_v74_audit_deny_delete on public.audit_log;
    create policy vibepin_v74_audit_deny_delete
      on public.audit_log as restrictive for delete to authenticated
      using (false);
    comment on policy vibepin_v74_audit_deny_delete on public.audit_log
      is 'vibepin:v74:audit-deny-delete';
  end if;
end
$v74$;

do $v74_view$
declare
  v_kind "char";
begin
  select relkind
    into v_kind
    from pg_class
   where oid = to_regclass('public.trend_opportunities_view');

  if v_kind is null then
    raise notice 'v74: public.trend_opportunities_view is absent; skipping invoker hardening';
  elsif v_kind <> 'v' then
    raise exception 'v74: public.trend_opportunities_view exists but is not a normal view';
  else
    alter view public.trend_opportunities_view set (security_invoker = true);
  end if;
end
$v74_view$;

notify pgrst, 'reload schema';
commit;
