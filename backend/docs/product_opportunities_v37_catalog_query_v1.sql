-- Read-only Stage 0 catalog audit for migrate_v63_product_opportunities_v1.sql.
-- The query intentionally returns every existing matching object. A clean
-- pre-migration production database must return zero rows.
WITH patterns(pattern) AS (
  VALUES
    ('%product_opportun%'),
    ('%product_evidence%'),
    ('%product_metric%'),
    ('%product_free_preview%'),
    ('%active_product%'),
    ('%product_primary%'),
    ('%saved_product%')
), catalog_objects AS (
  SELECT
    'pg_class'::text AS catalog_name,
    n.nspname AS schema_name,
    CASE c.relkind
      WHEN 'r' THEN 'table'
      WHEN 'v' THEN 'view'
      WHEN 'm' THEN 'materialized_view'
      WHEN 'S' THEN 'sequence'
      WHEN 'i' THEN 'index'
      WHEN 'I' THEN 'partitioned_index'
      ELSE 'relation_' || c.relkind::text
    END AS object_kind,
    c.relname AS object_name,
    ''::text AS parent_name
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'

  UNION ALL

  SELECT
    'pg_proc',
    n.nspname,
    'function',
    p.proname,
    pg_catalog.pg_get_function_identity_arguments(p.oid)
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'

  UNION ALL

  SELECT
    'pg_trigger',
    n.nspname,
    CASE WHEN t.tgconstraint <> 0 THEN 'constraint_trigger' ELSE 'trigger' END,
    t.tgname,
    c.relname
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT t.tgisinternal

  UNION ALL

  SELECT
    'pg_policies',
    schemaname,
    'policy',
    policyname,
    tablename
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public'

  UNION ALL

  SELECT
    'pg_constraint',
    n.nspname,
    'constraint',
    con.conname,
    COALESCE(c.relname, '')
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_namespace n ON n.oid = con.connamespace
  LEFT JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
  WHERE n.nspname = 'public'
)
SELECT DISTINCT
  catalog_name,
  schema_name,
  object_kind,
  object_name,
  parent_name
FROM catalog_objects o
WHERE EXISTS (
  SELECT 1
  FROM patterns p
  WHERE lower(o.object_name) LIKE p.pattern
     OR lower(o.parent_name) LIKE p.pattern
)
ORDER BY catalog_name, schema_name, object_kind, object_name, parent_name;
