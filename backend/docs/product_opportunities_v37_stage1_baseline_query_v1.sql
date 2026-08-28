-- Read-only Stage 1 cutover baseline for Product Opportunities v3.7.
-- Captures exact legacy table content identity and proves v63 names are absent.

WITH patterns(pattern) AS (
  VALUES
    ('%product_opportun%'),
    ('%product_evidence%'),
    ('%product_metric%'),
    ('%product_free_preview%'),
    ('%active_product%'),
    ('%product_primary%'),
    ('%saved_product%')
), matching_objects AS (
  SELECT c.relname AS object_name
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND EXISTS (SELECT 1 FROM patterns p WHERE c.relname LIKE p.pattern)
  UNION ALL
  SELECT p.proname
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND EXISTS (SELECT 1 FROM patterns x WHERE p.proname LIKE x.pattern)
  UNION ALL
  SELECT t.tgname
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND NOT t.tgisinternal
    AND EXISTS (SELECT 1 FROM patterns p WHERE t.tgname LIKE p.pattern)
  UNION ALL
  SELECT policyname
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public'
    AND EXISTS (
      SELECT 1 FROM patterns p
      WHERE policyname LIKE p.pattern OR tablename LIKE p.pattern
    )
  UNION ALL
  SELECT con.conname
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_namespace n ON n.oid = con.connamespace
  LEFT JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
  WHERE n.nspname = 'public'
    AND EXISTS (
      SELECT 1 FROM patterns p
      WHERE con.conname LIKE p.pattern OR COALESCE(c.relname, '') LIKE p.pattern
    )
), legacy AS (
  SELECT
    (SELECT count(*)::bigint FROM public.pin_products) AS legacy_products,
    (SELECT count(*)::bigint FROM public.pin_save_snapshots) AS legacy_snapshots,
    (SELECT md5(COALESCE(string_agg(to_jsonb(p)::text, E'\n' ORDER BY to_jsonb(p)::text), ''))
       FROM public.pin_products p) AS legacy_products_md5,
    (SELECT md5(COALESCE(string_agg(to_jsonb(s)::text, E'\n' ORDER BY to_jsonb(s)::text), ''))
       FROM public.pin_save_snapshots s) AS legacy_snapshots_md5
)
SELECT jsonb_build_object(
  'legacy_products', legacy_products,
  'legacy_snapshots', legacy_snapshots,
  'legacy_products_md5', legacy_products_md5,
  'legacy_snapshots_md5', legacy_snapshots_md5,
  'v63_matching_object_count', (SELECT count(*)::bigint FROM matching_objects)
) AS baseline
FROM legacy;
