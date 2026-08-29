-- Read-only Stage 1 post-apply contract audit for v63 Product Opportunities.
-- This query must run only after the exact v63 migration transaction succeeds.
-- It returns catalog/security facts and row counts; it performs no mutation.

WITH relation_contract AS (
  SELECT c.relname AS name,
         c.relkind::text AS kind,
         c.relrowsecurity AS rls_enabled
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = ANY (ARRAY[
      'product_opportunities',
      'product_free_preview_rank_history',
      'product_opportunity_evidence',
      'product_evidence_snapshots',
      'product_evidence_switches',
      'product_opportunity_metrics',
      'product_metric_calibrations',
      'product_metric_release_gates',
      'saved_product_opportunities',
      'product_opportunity_catalog_v1'
    ])
), function_contract AS (
  SELECT p.proname AS name,
         pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
         p.prosecdef AS security_definer
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = ANY (ARRAY[
      'product_opportunity_has_field_evidence',
      'product_opportunity_url_uses_public_literal_host',
      'enforce_product_opportunity_lifecycle_transition',
      'audit_product_free_preview_rank_change',
      'set_product_free_preview_rank',
      'product_opportunity_direct_provenance_matches',
      'enforce_product_evidence_status_transition',
      'enforce_product_evidence_identity',
      'enforce_active_product_primary_evidence',
      'enforce_active_product_evidence_at_commit',
      'activate_product_opportunity',
      'admit_product_opportunity_batch',
      'enforce_product_evidence_snapshot_capture_time',
      'rollback_product_opportunity_admission_batch',
      'normalize_saved_product_opportunity_state',
      'record_product_evidence_observation',
      'record_product_evidence_observation_batch',
      'switch_product_primary_evidence'
    ])
), trigger_contract AS (
  SELECT t.tgname AS name,
         c.relname AS table_name,
         t.tgenabled::text AS enabled,
         t.tgdeferrable AS deferrable,
         t.tginitdeferred AS initially_deferred
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND NOT t.tgisinternal
    AND t.tgname LIKE 'trg_%product%'
), policy_contract AS (
  SELECT policyname AS name,
         tablename AS table_name,
         cmd,
         permissive,
         roles
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'saved_product_opportunities'
), index_contract AS (
  SELECT c.relname AS name,
         i.indisunique AS is_unique,
         (i.indpred IS NOT NULL) AS is_partial
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = ANY (ARRAY[
      'uq_product_opportunities_current_identity',
      'uq_product_opportunities_free_preview_rank',
      'uq_product_opportunity_evidence_pin',
      'uq_product_opportunity_primary_evidence'
    ])
), constraint_contract AS (
  SELECT con.conname AS name,
         con.contype::text AS type,
         c.relname AS table_name,
         con.condeferrable AS deferrable,
         con.condeferred AS initially_deferred
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_namespace n ON n.oid = con.connamespace
  JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
  WHERE n.nspname = 'public'
    AND con.contype <> 'n'
    AND c.relname = ANY (ARRAY[
      'product_opportunities',
      'product_free_preview_rank_history',
      'product_opportunity_evidence',
      'product_evidence_snapshots',
      'product_evidence_switches',
      'product_opportunity_metrics',
      'product_metric_calibrations',
      'product_metric_release_gates',
      'saved_product_opportunities'
    ])
), row_counts AS (
  SELECT
    (SELECT count(*)::bigint FROM public.pin_products) AS legacy_products,
    (SELECT count(*)::bigint FROM public.pin_save_snapshots) AS legacy_snapshots,
    (SELECT md5(COALESCE(string_agg(to_jsonb(p)::text, E'\n' ORDER BY to_jsonb(p)::text), ''))
       FROM public.pin_products p) AS legacy_products_md5,
    (SELECT md5(COALESCE(string_agg(to_jsonb(s)::text, E'\n' ORDER BY to_jsonb(s)::text), ''))
       FROM public.pin_save_snapshots s) AS legacy_snapshots_md5,
    (SELECT count(*)::bigint FROM public.product_opportunities) AS products,
    (SELECT count(*)::bigint FROM public.product_free_preview_rank_history) AS preview_history,
    (SELECT count(*)::bigint FROM public.product_opportunity_evidence) AS evidence,
    (SELECT count(*)::bigint FROM public.product_evidence_snapshots) AS evidence_snapshots,
    (SELECT count(*)::bigint FROM public.product_evidence_switches) AS evidence_switches,
    (SELECT count(*)::bigint FROM public.product_opportunity_metrics) AS metrics,
    (SELECT count(*)::bigint FROM public.product_metric_calibrations) AS calibrations,
    (SELECT count(*)::bigint FROM public.product_metric_release_gates) AS release_gates,
    (SELECT count(*)::bigint FROM public.saved_product_opportunities) AS saved
), privilege_contract AS (
  SELECT jsonb_build_object(
    'authenticated_product_select', has_table_privilege('authenticated', 'public.product_opportunities', 'SELECT'),
    'anon_product_select', has_table_privilege('anon', 'public.product_opportunities', 'SELECT'),
    'service_product_select', has_table_privilege('service_role', 'public.product_opportunities', 'SELECT'),
    'service_product_insert', has_table_privilege('service_role', 'public.product_opportunities', 'INSERT'),
    'service_product_update', has_table_privilege('service_role', 'public.product_opportunities', 'UPDATE'),
    'service_product_delete', has_table_privilege('service_role', 'public.product_opportunities', 'DELETE'),
    'service_evidence_select', has_table_privilege('service_role', 'public.product_opportunity_evidence', 'SELECT'),
    'service_evidence_insert', has_table_privilege('service_role', 'public.product_opportunity_evidence', 'INSERT'),
    'service_evidence_update', has_table_privilege('service_role', 'public.product_opportunity_evidence', 'UPDATE'),
    'service_evidence_delete', has_table_privilege('service_role', 'public.product_opportunity_evidence', 'DELETE'),
    'authenticated_saved_select', has_table_privilege('authenticated', 'public.saved_product_opportunities', 'SELECT'),
    'authenticated_saved_insert', has_table_privilege('authenticated', 'public.saved_product_opportunities', 'INSERT'),
    'authenticated_saved_update', has_table_privilege('authenticated', 'public.saved_product_opportunities', 'UPDATE'),
    'service_saved_select', has_table_privilege('service_role', 'public.saved_product_opportunities', 'SELECT'),
    'service_saved_insert', has_table_privilege('service_role', 'public.saved_product_opportunities', 'INSERT'),
    'service_saved_update', has_table_privilege('service_role', 'public.saved_product_opportunities', 'UPDATE'),
    'service_snapshot_select', has_table_privilege('service_role', 'public.product_evidence_snapshots', 'SELECT'),
    'service_snapshot_insert', has_table_privilege('service_role', 'public.product_evidence_snapshots', 'INSERT'),
    'service_snapshot_update', has_table_privilege('service_role', 'public.product_evidence_snapshots', 'UPDATE'),
    'service_snapshot_delete', has_table_privilege('service_role', 'public.product_evidence_snapshots', 'DELETE'),
    'service_catalog_select', has_table_privilege('service_role', 'public.product_opportunity_catalog_v1', 'SELECT'),
    'authenticated_catalog_select', has_table_privilege('authenticated', 'public.product_opportunity_catalog_v1', 'SELECT'),
    'anon_catalog_select', has_table_privilege('anon', 'public.product_opportunity_catalog_v1', 'SELECT'),
    'service_admit_execute', has_function_privilege('service_role', 'public.admit_product_opportunity_batch(jsonb)', 'EXECUTE'),
    'authenticated_admit_execute', has_function_privilege('authenticated', 'public.admit_product_opportunity_batch(jsonb)', 'EXECUTE'),
    'anon_admit_execute', has_function_privilege('anon', 'public.admit_product_opportunity_batch(jsonb)', 'EXECUTE'),
    'service_activate_execute', has_function_privilege('service_role', 'public.activate_product_opportunity(uuid)', 'EXECUTE'),
    'authenticated_activate_execute', has_function_privilege('authenticated', 'public.activate_product_opportunity(uuid)', 'EXECUTE'),
    'service_rank_execute', has_function_privilege('service_role', 'public.set_product_free_preview_rank(uuid,smallint,text)', 'EXECUTE'),
    'authenticated_rank_execute', has_function_privilege('authenticated', 'public.set_product_free_preview_rank(uuid,smallint,text)', 'EXECUTE'),
    'service_observe_one_execute', has_function_privilege('service_role', 'public.record_product_evidence_observation(uuid,date,timestamptz,text,integer,text,text)', 'EXECUTE'),
    'authenticated_observe_one_execute', has_function_privilege('authenticated', 'public.record_product_evidence_observation(uuid,date,timestamptz,text,integer,text,text)', 'EXECUTE'),
    'service_observe_execute', has_function_privilege('service_role', 'public.record_product_evidence_observation_batch(jsonb)', 'EXECUTE'),
    'authenticated_observe_execute', has_function_privilege('authenticated', 'public.record_product_evidence_observation_batch(jsonb)', 'EXECUTE'),
    'service_switch_execute', has_function_privilege('service_role', 'public.switch_product_primary_evidence(uuid,uuid,text)', 'EXECUTE'),
    'authenticated_switch_execute', has_function_privilege('authenticated', 'public.switch_product_primary_evidence(uuid,uuid,text)', 'EXECUTE'),
    'service_rollback_execute', has_function_privilege('service_role', 'public.rollback_product_opportunity_admission_batch(jsonb,text)', 'EXECUTE'),
    'authenticated_rollback_execute', has_function_privilege('authenticated', 'public.rollback_product_opportunity_admission_batch(jsonb,text)', 'EXECUTE'),
    'service_preview_sequence_usage', has_sequence_privilege('service_role', 'public.product_free_preview_rank_history_id_seq', 'USAGE'),
    'authenticated_preview_sequence_usage', has_sequence_privilege('authenticated', 'public.product_free_preview_rank_history_id_seq', 'USAGE'),
    'service_snapshot_sequence_usage', has_sequence_privilege('service_role', 'public.product_evidence_snapshots_id_seq', 'USAGE'),
    'authenticated_snapshot_sequence_usage', has_sequence_privilege('authenticated', 'public.product_evidence_snapshots_id_seq', 'USAGE'),
    'service_switch_sequence_usage', has_sequence_privilege('service_role', 'public.product_evidence_switches_id_seq', 'USAGE'),
    'authenticated_switch_sequence_usage', has_sequence_privilege('authenticated', 'public.product_evidence_switches_id_seq', 'USAGE')
  ) AS facts
)
SELECT jsonb_build_object(
  'relations', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.name) FROM relation_contract r), '[]'::jsonb),
  'functions', COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.name, f.identity_arguments) FROM function_contract f), '[]'::jsonb),
  'triggers', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.name) FROM trigger_contract t), '[]'::jsonb),
  'policies', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.name) FROM policy_contract p), '[]'::jsonb),
  'indexes', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.name) FROM index_contract i), '[]'::jsonb),
  'constraints', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.name) FROM constraint_contract c), '[]'::jsonb),
  'row_counts', (SELECT to_jsonb(rc) FROM row_counts rc),
  'privileges', (SELECT facts FROM privilege_contract)
) AS contract;
