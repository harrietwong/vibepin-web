-- Schema-only rollback for migrate_v63_product_opportunities_v1.sql.
-- Run only before any Product Opportunity history must be retained.

BEGIN;

DROP VIEW IF EXISTS product_opportunity_catalog_v1;

DROP FUNCTION IF EXISTS rollback_product_opportunity_admission_batch(jsonb,text);
DROP FUNCTION IF EXISTS switch_product_primary_evidence(uuid,uuid,text);
DROP FUNCTION IF EXISTS record_product_evidence_observation_batch(jsonb);
DROP FUNCTION IF EXISTS record_product_evidence_observation(uuid,date,timestamptz,text,integer,text,text);
DROP FUNCTION IF EXISTS set_product_free_preview_rank(uuid,smallint,text);
DROP FUNCTION IF EXISTS admit_product_opportunity_batch(jsonb);
DROP FUNCTION IF EXISTS activate_product_opportunity(uuid);

DROP TRIGGER IF EXISTS trg_enforce_product_opportunity_initial_lifecycle
  ON product_opportunities;
DROP TRIGGER IF EXISTS trg_enforce_product_opportunity_lifecycle_transition
  ON product_opportunities;
DROP FUNCTION IF EXISTS enforce_product_opportunity_lifecycle_transition();
DROP TRIGGER IF EXISTS trg_audit_product_free_preview_rank_change
  ON product_opportunities;
DROP FUNCTION IF EXISTS audit_product_free_preview_rank_change();
DROP TRIGGER IF EXISTS trg_enforce_product_evidence_status_transition
  ON product_opportunity_evidence;
DROP FUNCTION IF EXISTS enforce_product_evidence_status_transition();
DROP TRIGGER IF EXISTS trg_enforce_product_evidence_identity
  ON product_opportunity_evidence;
DROP FUNCTION IF EXISTS enforce_product_evidence_identity();
DROP TRIGGER IF EXISTS trg_enforce_active_product_primary_evidence
  ON product_opportunities;
DROP FUNCTION IF EXISTS enforce_active_product_primary_evidence();
DROP TRIGGER IF EXISTS trg_enforce_active_product_evidence_at_commit
  ON product_opportunity_evidence;
DROP FUNCTION IF EXISTS enforce_active_product_evidence_at_commit();
DROP TRIGGER IF EXISTS trg_enforce_product_evidence_snapshot_capture_time
  ON product_evidence_snapshots;
DROP FUNCTION IF EXISTS enforce_product_evidence_snapshot_capture_time();

DROP TRIGGER IF EXISTS trg_normalize_saved_product_opportunity_state
  ON saved_product_opportunities;
DROP FUNCTION IF EXISTS normalize_saved_product_opportunity_state();
DROP TABLE IF EXISTS saved_product_opportunities;
DROP TABLE IF EXISTS product_metric_release_gates;
DROP TABLE IF EXISTS product_opportunity_metrics;
DROP TABLE IF EXISTS product_metric_calibrations;
DROP TABLE IF EXISTS product_evidence_switches;
DROP TABLE IF EXISTS product_evidence_snapshots;
DROP TABLE IF EXISTS product_opportunity_evidence;
DROP TABLE IF EXISTS product_free_preview_rank_history;
DROP TABLE IF EXISTS product_opportunities;

-- These immutable helpers are referenced by table CHECK constraints, so they
-- must be dropped only after their dependent tables are gone.
DROP FUNCTION IF EXISTS product_opportunity_direct_provenance_matches(jsonb,text,boolean);
DROP FUNCTION IF EXISTS product_opportunity_has_field_evidence(jsonb,text);
DROP FUNCTION IF EXISTS product_opportunity_url_uses_public_literal_host(text);

COMMIT;
