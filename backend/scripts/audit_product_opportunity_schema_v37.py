#!/usr/bin/env python3
"""Read-only Stage 1 post-apply verifier for Product Opportunities v3.7."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from run_migration import _load_canonical_sql, _mgmt_query, load_credentials


ROOT = Path(__file__).resolve().parent.parent
BASELINE_QUERY_PATH = ROOT / "docs" / "product_opportunities_v37_stage1_baseline_query_v1.sql"
POST_APPLY_QUERY_PATH = (
    ROOT / "docs" / "product_opportunities_v37_stage1_post_apply_query_v1.sql"
)

RELATIONS = {
    "product_opportunities": ("r", False),
    "product_free_preview_rank_history": ("r", False),
    "product_opportunity_evidence": ("r", False),
    "product_evidence_snapshots": ("r", False),
    "product_evidence_switches": ("r", False),
    "product_opportunity_metrics": ("r", False),
    "product_metric_calibrations": ("r", False),
    "product_metric_release_gates": ("r", False),
    "saved_product_opportunities": ("r", True),
    "product_opportunity_catalog_v1": ("v", False),
}

FUNCTION_SIGNATURES = {
    "product_opportunity_has_field_evidence": "p_provenance jsonb, p_prefix text",
    "product_opportunity_url_uses_public_literal_host": "p_url text",
    "enforce_product_opportunity_lifecycle_transition": "",
    "audit_product_free_preview_rank_change": "",
    "set_product_free_preview_rank": (
        "p_product_opportunity_id uuid, p_new_rank smallint, p_reason text"
    ),
    "product_opportunity_direct_provenance_matches": (
        "p_provenance jsonb, p_canonical text, p_source_pin boolean"
    ),
    "enforce_product_evidence_status_transition": "",
    "enforce_product_evidence_identity": "",
    "enforce_active_product_primary_evidence": "",
    "enforce_active_product_evidence_at_commit": "",
    "activate_product_opportunity": "p_product_opportunity_id uuid",
    "admit_product_opportunity_batch": "p_candidates jsonb",
    "enforce_product_evidence_snapshot_capture_time": "",
    "rollback_product_opportunity_admission_batch": "p_ids jsonb, p_reason text",
    "normalize_saved_product_opportunity_state": "",
    "record_product_evidence_observation": (
        "p_evidence_id uuid, p_captured_on date, p_captured_at timestamp with time zone, "
        "p_observation_status text, p_save_count integer, p_provider_request_id text, "
        "p_anomaly_reason text"
    ),
    "record_product_evidence_observation_batch": "p_observations jsonb",
    "switch_product_primary_evidence": (
        "p_product_opportunity_id uuid, p_new_evidence_id uuid, p_reason text"
    ),
}
FUNCTIONS = set(FUNCTION_SIGNATURES)

SECURITY_DEFINER_FUNCTIONS = {
    "audit_product_free_preview_rank_change",
    "set_product_free_preview_rank",
    "enforce_product_evidence_identity",
    "enforce_active_product_primary_evidence",
    "enforce_active_product_evidence_at_commit",
    "activate_product_opportunity",
    "admit_product_opportunity_batch",
    "rollback_product_opportunity_admission_batch",
    "record_product_evidence_observation",
    "record_product_evidence_observation_batch",
    "switch_product_primary_evidence",
}

TRIGGERS = {
    "trg_enforce_product_opportunity_initial_lifecycle": ("product_opportunities", False),
    "trg_enforce_product_opportunity_lifecycle_transition": ("product_opportunities", False),
    "trg_audit_product_free_preview_rank_change": ("product_opportunities", False),
    "trg_enforce_product_evidence_status_transition": ("product_opportunity_evidence", False),
    "trg_enforce_product_evidence_identity": ("product_opportunity_evidence", False),
    "trg_enforce_active_product_primary_evidence": ("product_opportunities", False),
    "trg_enforce_active_product_evidence_at_commit": ("product_opportunity_evidence", True),
    "trg_enforce_product_evidence_snapshot_capture_time": ("product_evidence_snapshots", False),
    "trg_normalize_saved_product_opportunity_state": ("saved_product_opportunities", False),
}

POLICIES = {
    "Users read own saved product opportunities": "SELECT",
    "Users insert own saved product opportunities": "INSERT",
    "Users update own saved product opportunities": "UPDATE",
}

INDEXES = {
    "uq_product_opportunities_current_identity": True,
    "uq_product_opportunities_free_preview_rank": True,
    "uq_product_opportunity_evidence_pin": False,
    "uq_product_opportunity_primary_evidence": True,
}

CRITICAL_CONSTRAINTS = {
    "product_opportunities_category_family_check",
    "product_opportunities_source_category_provenance_check",
    "product_opportunities_provenance_check",
    "product_opportunities_public_url_hosts_check",
    "product_opportunities_product_name_provenance_check",
    "product_opportunities_merchant_provenance_check",
    "product_opportunities_product_type_provenance_check",
    "product_opportunities_optional_display_text_check",
    "product_opportunities_identity_shape_check",
    "product_opportunities_active_truth_check",
    "product_opportunity_evidence_provenance_check",
    "product_opportunity_source_direct_provenance_check",
    "product_opportunity_primary_source_direct_check",
    "product_opportunity_evidence_url_check",
    "product_evidence_snapshot_capture_day_check",
    "product_evidence_snapshot_status_check",
    "product_evidence_snapshot_value_check",
    "product_opportunity_metrics_g30_status_check",
    "product_opportunity_metrics_trend_status_check",
    "product_opportunity_metrics_latest_value_check",
    "product_opportunity_metrics_valid_g30_shape_check",
    "product_opportunity_metrics_valid_trend_shape_check",
    "product_opportunity_momentum_check",
    "product_metric_release_gate_calibration_fk",
    "saved_product_opportunities_status_check",
    "saved_product_opportunities_time_state_check",
    "saved_product_opportunities_time_order_check",
    "trg_enforce_active_product_evidence_at_commit",
}

PRIVILEGES = {
    "authenticated_product_select": False,
    "anon_product_select": False,
    "service_product_select": True,
    "service_product_insert": True,
    "service_product_update": True,
    "service_product_delete": False,
    "service_evidence_select": True,
    "service_evidence_insert": True,
    "service_evidence_update": True,
    "service_evidence_delete": False,
    "authenticated_saved_select": True,
    "authenticated_saved_insert": False,
    "authenticated_saved_update": False,
    "service_saved_select": True,
    "service_saved_insert": True,
    "service_saved_update": True,
    "service_snapshot_select": True,
    "service_snapshot_insert": False,
    "service_snapshot_update": False,
    "service_snapshot_delete": False,
    "service_catalog_select": True,
    "authenticated_catalog_select": False,
    "anon_catalog_select": False,
    "service_admit_execute": True,
    "authenticated_admit_execute": False,
    "anon_admit_execute": False,
    "service_activate_execute": True,
    "authenticated_activate_execute": False,
    "service_rank_execute": True,
    "authenticated_rank_execute": False,
    "service_observe_one_execute": True,
    "authenticated_observe_one_execute": False,
    "service_observe_execute": True,
    "authenticated_observe_execute": False,
    "service_switch_execute": True,
    "authenticated_switch_execute": False,
    "service_rollback_execute": True,
    "authenticated_rollback_execute": False,
    "service_preview_sequence_usage": True,
    "authenticated_preview_sequence_usage": False,
    "service_snapshot_sequence_usage": True,
    "authenticated_snapshot_sequence_usage": False,
    "service_switch_sequence_usage": True,
    "authenticated_switch_sequence_usage": False,
}

NEW_ROW_COUNT_KEYS = {
    "products",
    "preview_history",
    "evidence",
    "evidence_snapshots",
    "evidence_switches",
    "metrics",
    "calibrations",
    "release_gates",
    "saved",
}


def _set_mismatch(label: str, actual: set[str], expected: set[str], errors: list[str]) -> None:
    if actual != expected:
        errors.append(
            f"{label} mismatch: missing={sorted(expected - actual)!r}, "
            f"unexpected={sorted(actual - expected)!r}"
        )


def validate_contract(
    contract: dict[str, Any],
    *,
    expected_legacy_products: int,
    expected_legacy_snapshots: int,
    expected_legacy_products_md5: str,
    expected_legacy_snapshots_md5: str,
) -> list[str]:
    errors: list[str] = []

    relations = {row.get("name"): row for row in contract.get("relations", [])}
    _set_mismatch("relations", set(relations), set(RELATIONS), errors)
    for name, (kind, rls) in RELATIONS.items():
        row = relations.get(name, {})
        if row.get("kind") != kind or row.get("rls_enabled") is not rls:
            errors.append(f"relation {name} kind/RLS mismatch")

    function_rows = contract.get("functions", [])
    function_names = {row.get("name") for row in function_rows}
    _set_mismatch("functions", function_names, FUNCTIONS, errors)
    if len(function_rows) != len(FUNCTIONS):
        errors.append("function overload/count mismatch")
    for row in function_rows:
        name = row.get("name")
        if name in FUNCTION_SIGNATURES and row.get("identity_arguments") != FUNCTION_SIGNATURES[name]:
            errors.append(f"function {name} signature mismatch")
    definer_names = {row.get("name") for row in function_rows if row.get("security_definer") is True}
    _set_mismatch("security-definer functions", definer_names, SECURITY_DEFINER_FUNCTIONS, errors)

    triggers = {row.get("name"): row for row in contract.get("triggers", [])}
    _set_mismatch("triggers", set(triggers), set(TRIGGERS), errors)
    for name, (table, deferred) in TRIGGERS.items():
        row = triggers.get(name, {})
        if row.get("table_name") != table or row.get("enabled") != "O":
            errors.append(f"trigger {name} table/enabled mismatch")
        if row.get("deferrable") is not deferred or row.get("initially_deferred") is not deferred:
            errors.append(f"trigger {name} deferral mismatch")

    policies = {row.get("name"): row for row in contract.get("policies", [])}
    _set_mismatch("policies", set(policies), set(POLICIES), errors)
    for name, command in POLICIES.items():
        row = policies.get(name, {})
        if row.get("table_name") != "saved_product_opportunities" or row.get("cmd") != command:
            errors.append(f"policy {name} table/command mismatch")
        if row.get("permissive") != "PERMISSIVE" or row.get("roles") != ["public"]:
            errors.append(f"policy {name} role/permissive mismatch")

    indexes = {row.get("name"): row for row in contract.get("indexes", [])}
    _set_mismatch("indexes", set(indexes), set(INDEXES), errors)
    for name, partial in INDEXES.items():
        row = indexes.get(name, {})
        if row.get("is_unique") is not True or row.get("is_partial") is not partial:
            errors.append(f"index {name} uniqueness/predicate mismatch")

    constraint_names = {row.get("name") for row in contract.get("constraints", [])}
    missing_constraints = CRITICAL_CONSTRAINTS - constraint_names
    if missing_constraints:
        errors.append(f"critical constraints missing: {sorted(missing_constraints)!r}")

    privileges = contract.get("privileges")
    if privileges != PRIVILEGES:
        errors.append("privilege contract mismatch")

    counts = contract.get("row_counts", {})
    for key in sorted(NEW_ROW_COUNT_KEYS):
        if counts.get(key) != 0:
            errors.append(f"new table {key} is not empty: {counts.get(key)!r}")
    if counts.get("legacy_products") != expected_legacy_products:
        errors.append("legacy pin_products count changed")
    if counts.get("legacy_snapshots") != expected_legacy_snapshots:
        errors.append("legacy pin_save_snapshots count changed")
    if counts.get("legacy_products_md5") != expected_legacy_products_md5:
        errors.append("legacy pin_products content hash changed")
    if counts.get("legacy_snapshots_md5") != expected_legacy_snapshots_md5:
        errors.append("legacy pin_save_snapshots content hash changed")

    return errors


def _parse_single_object(status: int, body: str, key: str) -> tuple[dict[str, Any], list[str]]:
    if status not in (200, 201):
        return {}, [f"Management API read-only query failed with HTTP {status}"]
    try:
        rows = json.loads(body)
        if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
            raise ValueError("expected exactly one result row")
        value = rows[0].get(key)
        if not isinstance(value, dict):
            raise ValueError(f"result row has no {key} object")
        return value, []
    except (json.JSONDecodeError, ValueError) as exc:
        return {}, [f"invalid Management API response shape: {exc}"]


def _load_baseline_receipt(
    path: Path,
    *,
    expected_sha256: str,
    project_ref: str,
    candidate_sha: str,
    max_age_seconds: int,
) -> tuple[dict[str, Any], list[str]]:
    try:
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != expected_sha256:
            return {}, ["baseline receipt SHA-256 does not match expected bytes"]
        receipt = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        return {}, [f"cannot read baseline receipt: {exc}"]
    errors: list[str] = []
    if receipt.get("verdict") != "PASS" or receipt.get("mutation") is not False:
        errors.append("baseline receipt is not a read-only PASS")
    if receipt.get("project_ref") != project_ref:
        errors.append("baseline project_ref does not match post-apply target")
    if receipt.get("candidate_sha") != candidate_sha:
        errors.append("baseline candidate SHA does not match post-apply candidate")
    try:
        audited_at = datetime.fromisoformat(str(receipt["audited_at"]).replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - audited_at).total_seconds()
        if age < 0 or age > max_age_seconds:
            errors.append(f"baseline receipt age {age:.0f}s is outside 0..{max_age_seconds}s")
    except (KeyError, TypeError, ValueError):
        errors.append("baseline audited_at is missing or invalid")
    baseline = receipt.get("baseline")
    if not isinstance(baseline, dict):
        errors.append("baseline receipt has no baseline object")
        baseline = {}
    return baseline, errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("baseline", "post-apply"))
    parser.add_argument("--project-ref", required=True)
    parser.add_argument("--expected-project-ref", required=True)
    parser.add_argument("--expected-query-sha256", required=True)
    parser.add_argument("--candidate-sha", required=True)
    parser.add_argument("--baseline-receipt", type=Path)
    parser.add_argument("--expected-baseline-sha256")
    parser.add_argument("--max-baseline-age-seconds", type=int, default=900)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    if not re.fullmatch(r"[a-z0-9]+", args.project_ref):
        parser.error("--project-ref must be a bare lowercase alphanumeric project ref")
    if args.project_ref != args.expected_project_ref:
        parser.error("--project-ref and --expected-project-ref must match exactly")
    if not re.fullmatch(r"[0-9a-f]{64}", args.expected_query_sha256):
        parser.error("--expected-query-sha256 must be 64 lowercase hex characters")
    if not re.fullmatch(r"[0-9a-f]{40}", args.candidate_sha):
        parser.error("--candidate-sha must be a full lowercase Git SHA-1")
    if not 60 <= args.max_baseline_age_seconds <= 3600:
        parser.error("--max-baseline-age-seconds must be between 60 and 3600")
    if args.mode == "post-apply" and not args.baseline_receipt:
        parser.error("post-apply requires --baseline-receipt")
    if args.mode == "post-apply" and not re.fullmatch(
        r"[0-9a-f]{64}", args.expected_baseline_sha256 or ""
    ):
        parser.error("post-apply requires --expected-baseline-sha256")

    query_path = BASELINE_QUERY_PATH if args.mode == "baseline" else POST_APPLY_QUERY_PATH
    query, query_sha256 = _load_canonical_sql(query_path)
    if query_sha256 != args.expected_query_sha256:
        parser.error("post-apply query SHA-256 does not match expected bytes")

    key = "baseline" if args.mode == "baseline" else "contract"
    baseline: dict[str, Any] = {}
    errors: list[str] = []
    if args.mode == "post-apply":
        baseline, errors = _load_baseline_receipt(
            args.baseline_receipt,
            expected_sha256=args.expected_baseline_sha256,
            project_ref=args.project_ref,
            candidate_sha=args.candidate_sha,
            max_age_seconds=args.max_baseline_age_seconds,
        )

    observed: dict[str, Any] = {}
    status = 0
    if not errors:
        token = load_credentials().get("SUPABASE_MIGRATION_TOKEN", "")
        if not token:
            parser.error("SUPABASE_MIGRATION_TOKEN is missing")
        status, body = _mgmt_query(query, token=token, project_ref=args.project_ref)
        observed, query_errors = _parse_single_object(status, body, key)
        errors.extend(query_errors)

    if args.mode == "baseline" and observed:
        baseline = observed
        if baseline.get("v63_matching_object_count") != 0:
            errors.append("v63 Product Opportunity objects already exist before apply")
        for count_key in ("legacy_products", "legacy_snapshots"):
            if not isinstance(baseline.get(count_key), int) or baseline[count_key] < 0:
                errors.append(f"baseline {count_key} is invalid")
        for hash_key in ("legacy_products_md5", "legacy_snapshots_md5"):
            if not re.fullmatch(r"[0-9a-f]{32}", str(baseline.get(hash_key, ""))):
                errors.append(f"baseline {hash_key} is invalid")
    elif args.mode == "post-apply":
        if observed and not errors:
            errors.extend(
                validate_contract(
                    observed,
                    expected_legacy_products=baseline.get("legacy_products"),
                    expected_legacy_snapshots=baseline.get("legacy_snapshots"),
                    expected_legacy_products_md5=baseline.get("legacy_products_md5"),
                    expected_legacy_snapshots_md5=baseline.get("legacy_snapshots_md5"),
                )
            )

    report = {
        "audited_at": datetime.now(timezone.utc).isoformat(),
        "candidate_sha": args.candidate_sha,
        "project_ref": args.project_ref,
        "mode": args.mode,
        "query_file": f"backend/docs/{query_path.name}",
        "query_sha256": query_sha256,
        "http_status": status,
        "mutation": False,
        key: observed,
        "baseline": baseline if args.mode == "post-apply" else observed,
        "baseline_receipt": str(args.baseline_receipt) if args.baseline_receipt else None,
        "violations": errors,
        "verdict": "PASS" if not errors else "BLOCK",
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
