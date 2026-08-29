-- Fail-closed rollback for migrate_v66_creem_subscription_units.sql.
--
-- Application rollback comes first.  This schema rollback is optional because
-- an unused additive column is harmless.  Dropping it after quantity-bearing
-- add-on rows exist would destroy billing evidence, so the SQL refuses unless
-- every stored value is still the migration default (1).
--
-- Idempotent when the table or column is already absent.

do $$
declare
  units_column_exists boolean;
  has_non_default_units boolean;
begin
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'creem_subscriptions'
      and column_name = 'units'
  ) into units_column_exists;

  if not units_column_exists then
    return;
  end if;

  execute 'select exists (
    select 1
    from public.creem_subscriptions
    where units <> 1
  )' into has_non_default_units;

  if has_non_default_units then
    raise exception using
      errcode = 'P0001',
      message = 'rollback_v66 blocked: creem_subscriptions.units contains non-default quantity data';
  end if;
end
$$;

alter table if exists public.creem_subscriptions
  drop column if exists units;
