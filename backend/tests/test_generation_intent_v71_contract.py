from pathlib import Path
import importlib.util

import pytest


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = (ROOT / "backend/db/migrate_v71_generation_intent_idempotency.sql").read_text(encoding="utf-8").lower()
ROLLBACK = (ROOT / "backend/db/rollback_v71_generation_intent_idempotency.sql").read_text(encoding="utf-8").lower()
HARNESS = (ROOT / "backend/tests/postgres_v71/replay_generation_intent_postgres_v71.py").read_text(encoding="utf-8").lower()
REMOTE_HARNESS = (ROOT / "backend/tests/postgres_v71/remote_generation_intent_supabase_v71.py").read_text(encoding="utf-8").lower()


def _remote_module():
    path = ROOT / "backend/tests/postgres_v71/remote_generation_intent_supabase_v71.py"
    spec = importlib.util.spec_from_file_location("remote_v71_gate", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_v71_is_additive_and_legacy_safe() -> None:
    assert "alter table generation_jobs add column if not exists generation_intent_key" in MIGRATION
    assert "generation_intent_fingerprint ~ '^[0-9a-f]{64}$'" in MIGRATION
    assert "where generation_intent_key is not null" in MIGRATION
    assert "generation_jobs_intent_immutable_trigger" in MIGRATION
    assert "conrelid = 'public.generation_jobs'::regclass" in MIGRATION
    assert "has an incompatible definition" in MIGRATION
    assert "create or replace function usage_reserve_generation_job(" not in MIGRATION


def test_v71_has_one_atomic_anchor_for_plain_and_metered_modes() -> None:
    assert "generation_enqueue_job_idempotent" in MIGRATION
    assert "usage_reserve_generation_job_v2" in MIGRATION
    assert "generation_lookup_job_by_intent" in MIGRATION
    assert "on conflict (vibepin_user_id, generation_intent_key)" in MIGRATION
    assert "exception when unique_violation" in MIGRATION
    assert "generation intent conflict" in MIGRATION


def test_v71_rollback_removes_only_additive_objects() -> None:
    assert "drop function if exists usage_reserve_generation_job_v2" in ROLLBACK
    assert "drop function if exists generation_enqueue_job_idempotent" in ROLLBACK
    assert "drop function if exists generation_lookup_job_by_intent" in ROLLBACK
    assert "drop column if exists generation_intent_fingerprint" in ROLLBACK
    assert "delete from" not in ROLLBACK
    assert "drop table" not in ROLLBACK


def test_real_postgres_gate_is_loopback_only_and_covers_p0_matrix() -> None:
    assert "refuses every non-loopback" in HARNESS
    assert "database.startswith(\"vibepin_v71_\")" in HARNESS
    assert "hostaddr" in HARNESS
    assert "refuses libpq service indirection" in HARNESS
    assert "inet_server_addr()" in HARNESS
    assert 'delete from usage_events' not in HARNESS
    assert "max_workers=20" in HARNESS
    for marker in (
        "count", "prompt", "product_images", "style_ref", "model_key", "format",
        "retryofoutputid", "response-loss", "precommit", "settle-once",
        "rollbackreadback",
    ):
        assert marker in HARNESS


def test_remote_test_project_gate_binds_ref_shas_and_full_schema_lifecycle() -> None:
    assert 'expected_ref = "snulmwprsahzqvdbyenc"' in REMOTE_HARNESS
    assert '"jaxteelkecvlozdrdoog"' in REMOTE_HARNESS
    assert "expected-migration-sha" in REMOTE_HARNESS
    assert "expected-rollback-sha" in REMOTE_HARNESS
    assert "apply-test-v71:" in REMOTE_HARNESS
    assert "serviceidentity" in REMOTE_HARNESS
    assert "assert_anon_rpc_blocked" in REMOTE_HARNESS
    assert "public_blocked" in REMOTE_HARNESS
    assert "before snapshot" in REMOTE_HARNESS
    assert "apply v71" in REMOTE_HARNESS
    assert "rollback v71" in REMOTE_HARNESS
    assert "rollbackzeroresidue" in REMOTE_HARNESS
    assert "final re-apply v71" in REMOTE_HARNESS
    assert "finalreapplied" in REMOTE_HARNESS


def test_remote_test_project_gate_covers_the_required_real_postgres_matrix() -> None:
    assert "max_workers=20" in REMOTE_HARNESS
    for marker in (
        "20-way-mixed", "off_to_shadow", "shadow_to_off", "shadow_to_enforce",
        "response-loss", "precommit-plain", "precommit-metered", "conflicts",
        "count", "prompt", "product_images", "style_ref", "model_key", "format",
        "retryofoutputid", "lifecycle", "crossuser", "legacynull", "settleonce",
        "immutable trigger", "syntheticusers",
    ):
        assert marker in REMOTE_HARNESS


def test_remote_gate_accepts_only_the_exact_https_supabase_origin() -> None:
    module = _remote_module()
    ref = module.EXPECTED_REF
    module.SupabaseGate(ref, f"https://{ref}.supabase.co", "opaque-service", "opaque-anon", "opaque-migration")
    module.SupabaseGate(ref, f"https://{ref}.supabase.co:443/", "opaque-service", "opaque-anon", "opaque-migration")
    bad_urls = [
        f"http://{ref}.supabase.co",
        f"https://{ref}evil.supabase.co",
        f"https://{ref}.supabase.co.attacker.tld",
        f"https://user@{ref}.supabase.co",
        f"https://{ref}.supabase.co:8443",
        f"https://{ref}.supabase.co/rest/v1",
        f"https://{ref}.supabase.co?next=attacker",
        f"https://{ref}.supabase.co#fragment",
    ]
    for url in bad_urls:
        with pytest.raises(module.GateError):
            module.SupabaseGate(ref, url, "opaque-service", "opaque-anon", "opaque-migration")


def test_remote_gate_marks_uncertain_apply_before_network_and_never_swallows_recovery() -> None:
    marker = "may_be_applied = true\n        gate.management_query(migration.read_text"
    assert marker in REMOTE_HARNESS
    assert "failure residue readback" in REMOTE_HARNESS
    assert "recovery proof failed" in REMOTE_HARNESS
    assert 'recovery_errors.append(f"cleanup: {exc}")' in REMOTE_HARNESS
    assert 'recovery_errors.append(f"rollback: {exc}")' in REMOTE_HARNESS
