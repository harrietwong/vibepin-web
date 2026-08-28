from pathlib import Path


SQL = (Path(__file__).parents[1] / "db" / "migrate_v63_product_opportunities_v1.sql").read_text(
    encoding="utf-8"
)
LOWER = SQL.lower()
ROLLBACK_SQL = (
    Path(__file__).parents[1] / "db" / "rollback_v63_product_opportunities_v1.sql"
).read_text(encoding="utf-8")
ROLLBACK_LOWER = ROLLBACK_SQL.lower()


def test_active_product_requires_real_non_pinterest_image_and_product_url() -> None:
    assert "product_opportunities_active_truth_check" in LOWER
    assert "product_image_url is not null" in LOWER
    assert "product_image_source is not null" in LOWER
    assert "product_page_verified_at is not null" in LOWER
    assert "product_page_verification_method is not null" in LOWER
    assert "pinimg" in LOWER
    assert "product_image_url !~* '(^|[./])pinimg\\.[a-z.]+'" in LOWER
    assert "external_product_url" in LOWER
    assert "pinterest" in LOWER


def test_admission_and_activation_require_fresh_merchant_verification() -> None:
    lifecycle = LOWER.split(
        "create or replace function enforce_product_opportunity_lifecycle_transition", 1
    )[1].split("$$;", 1)[0]
    assert "new.product_page_verified_at < now() - interval '24 hours'" in lifecycle
    assert "new.product_page_verified_at > now() + interval '5 minutes'" in lifecycle
    assert "active product opportunity requires a fresh merchant-page verification" in lifecycle
    assert "before update of lifecycle_status, product_page_verified_at" in LOWER
    admission = LOWER.split(
        "create or replace function admit_product_opportunity_batch", 1
    )[1].split("$$;", 1)[0]
    assert "product admission requires a fresh merchant-page verification" in admission
    assert "< now() - interval '24 hours'" in admission
    assert "> now() + interval '5 minutes'" in admission


def test_product_name_is_nullable_and_never_defaulted() -> None:
    line = next(line for line in SQL.splitlines() if "product_name" in line and "text" in line)
    assert "NOT NULL" not in line.upper()
    assert "DEFAULT" not in line.upper()
    assert "product_opportunities_product_name_provenance_check" in LOWER
    assert "provenance->'product_name_found_in_page' = 'true'::jsonb" in LOWER
    assert "provenance->>'product_name_value' = product_name" in LOWER
    assert "(provenance->'product_name_found_in_page' = 'true'::jsonb) is true" in LOWER
    assert "(provenance->>'product_name_value' = product_name) is true" in LOWER
    assert "product_opportunity_has_field_evidence(provenance, 'name:') is true" in LOWER
    assert "product name lacks exact merchant-page provenance" in LOWER


def test_product_type_is_nullable_and_requires_exact_merchant_provenance() -> None:
    line = next(line for line in SQL.splitlines() if "product_type" in line and "text" in line)
    assert "NOT NULL" not in line.upper()
    assert "DEFAULT" not in line.upper()
    assert "product_opportunities_product_type_provenance_check" in LOWER
    assert "provenance->'product_type_found_in_merchant_page' = 'true'::jsonb" in LOWER
    assert "provenance->>'product_type_value' = product_type" in LOWER
    assert "(provenance->'product_type_found_in_merchant_page' = 'true'::jsonb) is true" in LOWER
    assert "(provenance->>'product_type_value' = product_type) is true" in LOWER
    assert "product_opportunity_has_field_evidence(provenance, 'product_type:') is true" in LOWER
    assert "nullif(btrim(v_candidate->>'product_type'), '')" in LOWER
    assert "p.product_type" in LOWER
    assert "product type lacks exact merchant-page provenance" in LOWER
    assert "field_evidence.value like 'product_type:%'" in LOWER


def test_business_category_is_separate_and_matches_product_family() -> None:
    assert "product_opportunities_category_family_check" in LOWER
    assert "category in ('fashion', 'home-decor', 'jewelry-accessories')" in LOWER
    assert "category in ('wedding-celebrations', 'gifts')" in LOWER
    assert "product_family in ('physical', 'digital')" in LOWER
    assert "category = 'digital-products' and product_family = 'digital'" in LOWER
    assert ") is true" in LOWER.split(
        "product_opportunities_category_family_check", 1
    )[1].split("constraint", 1)[0]
    admission = LOWER.split(
        "create or replace function admit_product_opportunity_batch", 1
    )[1].split("$$;", 1)[0]
    assert "product category must be a reviewed business category matching product family" in admission
    assert "when 'wedding-celebrations' then 'wedding celebrations bridal'" in LOWER
    assert "when 'gifts' then 'gifts'" in LOWER
    assert "when 'jewelry-accessories' then 'jewelry jewellery accessories'" in LOWER
    assert "when 'home-decor' then 'home decor'" in LOWER
    assert "when 'digital-products' then 'digital products'" in LOWER


def test_acquisition_source_category_is_persisted_separately_in_provenance() -> None:
    assert "product_opportunities_source_category_provenance_check" in LOWER
    assert "'jewelry', 'jewelry-accessories'" in LOWER
    constraint = LOWER.split(
        "product_opportunities_source_category_provenance_check", 1
    )[1].split("constraint", 1)[0]
    assert "provenance->>'source_category'" in constraint
    assert "'wedding', 'wedding-celebrations', 'gifts'" in constraint
    assert "and product_family = 'physical'" in constraint
    assert "and product_family = 'digital'" in constraint
    admission = LOWER.split(
        "create or replace function admit_product_opportunity_batch", 1
    )[1].split("$$;", 1)[0]
    assert "product source category provenance must match product family" in admission
    lifecycle = LOWER.split(
        "create or replace function enforce_product_opportunity_lifecycle_transition", 1
    )[1].split("$$;", 1)[0]
    assert "old.provenance->>'source_category'" in lifecycle
    assert "is distinct from new.provenance->>'source_category'" in lifecycle
    assert "product opportunity acquisition source category is immutable" in lifecycle
    trigger = LOWER.split(
        "create trigger trg_enforce_product_opportunity_lifecycle_transition", 1
    )[1].split("execute function", 1)[0]
    assert "before update of lifecycle_status, product_page_verified_at, provenance" in trigger


def test_merchant_is_nullable_and_requires_exact_merchant_provenance() -> None:
    assert "product_opportunities_merchant_provenance_check" in LOWER
    assert "provenance->'merchant_found_in_page' = 'true'::jsonb" in LOWER
    assert "provenance->>'merchant_value' = merchant" in LOWER
    assert "product_opportunity_has_field_evidence(provenance, 'merchant:') is true" in LOWER
    assert "merchant lacks exact merchant-page provenance" in LOWER
    assert "field_evidence.value like 'merchant:%'" in LOWER


def test_optional_display_fields_are_trimmed_and_bounded() -> None:
    assert "product_opportunities_optional_display_text_check" in LOWER
    assert "product_name = btrim(product_name)" in LOWER
    assert "char_length(product_name) <= 500" in LOWER
    assert "merchant = btrim(merchant)" in LOWER
    assert "char_length(merchant) <= 200" in LOWER
    assert "product_type = btrim(product_type)" in LOWER
    assert "char_length(product_type) <= 160" in LOWER


def test_database_provenance_checks_are_null_fail_closed() -> None:
    assert "create or replace function product_opportunity_has_field_evidence" in LOWER
    assert "jsonb_array_elements_text" in LOWER.split(
        "create or replace function product_opportunity_has_field_evidence", 1
    )[1].split("$$;", 1)[0]
    assert "(provenance->>'merchant_page_url' = canonical_product_url) is true" in LOWER
    assert "(provenance->>'product_image_url' = product_image_url) is true" in LOWER
    assert "(provenance->>'pinterest_pin_id' = pinterest_pin_id) is true" in LOWER
    assert "(provenance->>'source_pin_id' = pinterest_pin_id) is true" in LOWER
    assert "pinterest\\.com/pin/[0-9]{11,}" in LOWER
    assert "substring(pinterest_pin_url from '/pin/([0-9]{11,})') = pinterest_pin_id" in LOWER
    assert ") is true;" in LOWER.split("pin_redirect_chain_sha256", 1)[1].split("end;", 1)[0]


def test_schema_only_rollback_is_complete_and_dependency_ordered() -> None:
    for name in (
        "trg_normalize_saved_product_opportunity_state",
        "normalize_saved_product_opportunity_state()",
        "trg_enforce_product_opportunity_initial_lifecycle",
        "trg_enforce_product_opportunity_lifecycle_transition",
        "enforce_product_opportunity_lifecycle_transition()",
        "trg_enforce_product_evidence_status_transition",
        "enforce_product_evidence_status_transition()",
        "trg_enforce_active_product_primary_evidence",
        "trg_enforce_active_product_evidence_at_commit",
        "enforce_active_product_primary_evidence()",
        "enforce_active_product_evidence_at_commit()",
        "product_opportunity_direct_provenance_matches(jsonb,text,boolean)",
        "product_opportunity_has_field_evidence(jsonb,text)",
        "product_opportunity_url_uses_public_literal_host(text)",
    ):
        assert name in ROLLBACK_LOWER
    product_drop = ROLLBACK_LOWER.index("drop table if exists product_opportunities")
    assert product_drop < ROLLBACK_LOWER.index(
        "drop function if exists product_opportunity_has_field_evidence"
    )
    evidence_drop = ROLLBACK_LOWER.index("drop table if exists product_opportunity_evidence")
    assert evidence_drop < ROLLBACK_LOWER.index(
        "drop function if exists product_opportunity_direct_provenance_matches"
    )


def test_one_current_identity_and_one_active_primary_evidence() -> None:
    assert "external_product_url = canonical_product_url" in LOWER
    assert "domain is not null" in LOWER
    assert "substring(canonical_product_url from '^https?://([^/:?#]+)')" in LOWER
    assert "digest(convert_to(canonical_product_url, 'utf8'), 'sha256')" in LOWER
    assert "product_opportunities_public_url_hosts_check" in LOWER
    assert "product_opportunity_url_uses_public_literal_host(canonical_product_url) is true" in LOWER
    assert "product_opportunity_url_uses_public_literal_host(product_image_url) is true" in LOWER
    assert "uq_product_opportunities_current_identity" in LOWER
    assert "where lifecycle_status <> 'retired'" in LOWER
    assert "uq_product_opportunity_primary_evidence" in LOWER
    assert "where is_primary = true and evidence_status = 'active'" in LOWER
    assert "enforce_product_evidence_identity" in LOWER
    assert "evidence canonical identity does not match" in LOWER
    evidence_identity = LOWER.split(
        "create or replace function enforce_product_evidence_identity", 1
    )[1].split("$$;", 1)[0]
    assert "new.external_product_url is distinct from v_product_url" in evidence_identity
    assert "product_opportunity_primary_source_direct_check" in LOWER
    assert "trg_enforce_active_product_primary_evidence" in LOWER
    assert "active product opportunity requires exactly one matching active primary evidence" in LOWER
    active_identity = LOWER.split(
        "create or replace function enforce_active_product_primary_evidence", 1
    )[1].split("$$;", 1)[0]
    assert "e.external_product_url = new.external_product_url" in active_identity
    assert "trg_enforce_active_product_evidence_at_commit" in LOWER
    assert "deferrable initially deferred" in LOWER
    assert "active product opportunity cannot commit without exactly one matching active primary evidence" in LOWER


def test_admission_persists_bounded_primary_and_additional_evidence_provenance() -> None:
    evidence_table = LOWER.split(
        "create table if not exists product_opportunity_evidence", 1
    )[1].split(");", 1)[0]
    admission = LOWER.split(
        "create or replace function admit_product_opportunity_batch", 1
    )[1].split("$$;", 1)[0]
    assert "provenance                 jsonb not null" in evidence_table
    assert "product_opportunity_evidence_provenance_check" in evidence_table
    assert "coalesce(btrim(provenance->>'verified_by'), '') <> ''" in evidence_table
    assert "provenance->>'pinterest_pin_id' = pinterest_pin_id" in evidence_table
    assert "product_opportunity_direct_provenance_matches(" in evidence_table
    assert "provenance, external_product_url, evidence_type = 'source_pin'" in evidence_table
    redirect_guard = LOWER.split(
        "create or replace function product_opportunity_direct_provenance_matches", 1
    )[1].split("$$;", 1)[0]
    assert "jsonb_array_length(v_chain) not between 1 and 2" in redirect_guard
    assert "v_hop->>'status' not in ('301', '302', '303', '307', '308')" in redirect_guard
    assert "v_from is distinct from v_current" in redirect_guard
    assert "v_current = p_canonical" in redirect_guard
    assert "encode(digest(convert_to(v_canonical_json, 'utf8'), 'sha256'), 'hex')" in redirect_guard
    assert "evidence_type <> 'source_pin'" in evidence_table
    assert "relationship_method = 'direct_outbound_link'" in evidence_table
    assert "coalesce(jsonb_array_length(v_candidate->'additional_evidence'), 0) > 19" in admission
    assert "primary evidence lacks exact pin/direct-pdp provenance" in admission
    assert "additional evidence lacks exact pin/direct-pdp provenance" in admission
    assert "additional source pin lacks exact direct-pdp provenance" in admission
    assert "v_additional->'provenance'" in admission
    assert "false" in admission


def test_snapshots_metrics_and_switches_cannot_splice_evidence_between_products() -> None:
    assert "uq_product_opportunity_evidence_identity_product" in LOWER
    assert "uq_product_opportunity_evidence_identity_pin" in LOWER
    assert "product_evidence_snapshot_product_identity_fk" in LOWER
    assert "product_evidence_snapshot_pin_identity_fk" in LOWER
    assert "product_opportunity_metrics_evidence_identity_fk" in LOWER
    assert "product_evidence_switch_old_identity_fk" in LOWER
    assert "product_evidence_switch_new_identity_fk" in LOWER


def test_daily_snapshot_is_idempotent_and_valid_cannot_be_downgraded() -> None:
    assert "uq_product_evidence_snapshots_pin_day" in LOWER
    assert "unique (pinterest_pin_id, captured_on)" in LOWER
    assert "product_evidence_snapshot_capture_day_check" in LOWER
    assert "captured_on = (captured_at at time zone 'utc')::date" in LOWER
    assert "on conflict (pinterest_pin_id, captured_on) do update" in LOWER
    assert "where s.pinterest_pin_id = v_pin_id" in LOWER
    assert "record_product_evidence_observation" in LOWER
    assert "product_evidence_snapshots.observation_status <> 'valid'" in LOWER
    assert "excluded.observation_status in ('valid', 'counter_regression')" in LOWER
    assert "record_product_evidence_observation_batch" in LOWER
    assert "jsonb_array_length(p_observations) > 100" in LOWER
    assert "('valid', 'counter_regression', 'not_found')" in LOWER
    assert "p_observation_status not in ('valid', 'not_found')" in LOWER
    assert "p_captured_on is null or p_captured_at is null" in LOWER
    assert "p_captured_on <> (p_captured_at at time zone 'utc')::date" in LOWER
    assert "p_captured_at < now() - interval '24 hours'" in LOWER
    assert "p_captured_at > now() + interval '5 minutes'" in LOWER
    assert "p_captured_at < v_evidence_created_at - interval '5 minutes'" in LOWER
    assert "enforce_product_evidence_snapshot_capture_time" in LOWER
    assert "trg_enforce_product_evidence_snapshot_capture_time" in LOWER
    assert "new.captured_on <> (new.captured_at at time zone 'utc')::date" in LOWER
    assert "new.captured_at < now() - interval '24 hours'" in LOWER
    assert "new.captured_at > now() + interval '5 minutes'" in LOWER
    snapshot_table = LOWER.split(
        "create table if not exists product_evidence_snapshots", 1
    )[1].split(");", 1)[0]
    assert "provider_error" not in snapshot_table
    assert "rate_limited" not in snapshot_table


def test_three_consecutive_not_found_days_required_for_primary_switch() -> None:
    assert "p_captured_on > v_last_not_found" in LOWER
    assert "p_captured_on = v_last_not_found + 1" in LOWER
    assert "else 1" in LOWER
    assert "least(consecutive_not_found_days + 1, 3)" in LOWER
    assert "v_old.consecutive_not_found_days < 3" in LOWER
    switch_rpc = LOWER.split(
        "create or replace function switch_product_primary_evidence", 1
    )[1].split("revoke all on function switch_product_primary_evidence", 1)[0]
    assert "s.pinterest_pin_id = v_new.pinterest_pin_id" in switch_rpc
    assert "s.captured_on = (now() at time zone 'utc')::date" in switch_rpc
    assert "s.observation_status = 'valid'" in switch_rpc
    assert "new primary evidence requires a valid observation on the current utc day" in switch_rpc
    assert "product_evidence_switches" in LOWER


def test_saved_products_are_account_scoped_relation_not_copied_product_truth() -> None:
    saved_section = LOWER.split("create table if not exists saved_product_opportunities", 1)[1]
    saved_table = saved_section.split(");", 1)[0]
    assert "user_id" in saved_table
    assert "product_opportunity_id" in saved_table
    assert "product_name" not in saved_table
    assert "image_url" not in saved_table
    assert "saved_product_opportunities_time_state_check" in saved_table
    assert "saved_product_opportunities_time_order_check" in saved_table
    assert "trg_normalize_saved_product_opportunity_state" in LOWER
    normalize = LOWER.split(
        "create or replace function normalize_saved_product_opportunity_state", 1
    )[1].split("$$;", 1)[0]
    assert "new.saved_at := old.saved_at" in normalize
    assert "new.removed_at := old.removed_at" in normalize
    assert "new.saved_at := v_now" in normalize
    assert "new.removed_at := null" in normalize
    assert "unique (user_id, product_opportunity_id)" in saved_table
    assert "enable row level security" in LOWER


def test_free_preview_is_stable_curated_rank_one_to_ten() -> None:
    assert "free_preview_rank between 1 and 10" in LOWER
    assert "uq_product_opportunities_free_preview_rank" in LOWER


def test_catalog_view_joins_only_active_primary_evidence_and_matching_metrics() -> None:
    assert "create or replace view product_opportunity_catalog_v1" in LOWER
    assert "e.is_primary = true" in LOWER
    assert "e.evidence_status = 'active'" in LOWER
    assert "m.evidence_id = e.id" in LOWER
    assert "where p.lifecycle_status = 'active'" in LOWER
    assert "grant select on product_opportunity_catalog_v1 to service_role" in LOWER
    assert "then m.latest_snapshot_at end as latest_snapshot_at" in LOWER
    assert "then m.current_g7_gained end as current_g7_gained" in LOWER
    assert "then m.previous_g7_gained end as previous_g7_gained" in LOWER
    assert "end as high_recent_demand" in LOWER
    assert "left join lateral" in LOWER
    assert "calibration.product_family = p.product_family" in LOWER
    assert "calibration.metric_version = m.metric_version" in LOWER
    assert "calibration.approved_at is not null" in LOWER
    assert "calibration.effective_from <= now()" in LOWER


def test_family_release_gate_cannot_enable_below_seventy_percent() -> None:
    assert "product_metric_release_gates" in LOWER
    assert "product_metric_release_gate_calibration_fk" in LOWER
    assert "references product_metric_calibrations(product_family, metric_version)" in LOWER
    assert "valid_g30_g7_coverage >= 0.70" in LOWER
    assert "visible_product_count > 0" in LOWER
    assert "quality_review_passed = true" in LOWER
    assert "approved_at is not null" in LOWER


def test_metric_calibration_cannot_disable_low_activity_truthfulness_gates() -> None:
    assert "high_demand_g30_threshold is null or high_demand_g30_threshold > 0" in LOWER
    assert "check (minimum_14d_activity > 0)" in LOWER
    assert "check (minimum_absolute_delta > 0)" in LOWER


def test_free_preview_replacement_requires_reason_and_is_audited() -> None:
    assert "product_free_preview_rank_history" in LOWER
    assert "free preview rank changes require an audited reason" in LOWER
    assert "set_product_free_preview_rank" in LOWER
    assert "for update" in LOWER
    assert "grant execute on function set_product_free_preview_rank" in LOWER


def test_counter_regression_is_raw_auditable_data_and_cannot_advance_not_found_health() -> None:
    assert "'valid', 'counter_regression', 'not_found'" in LOWER
    assert "v_effective_status := 'counter_regression'" in LOWER
    assert "p_captured_on > v_last_not_found" in LOWER
    assert "and v_changed_count = 1" not in LOWER
    assert "return query select v_effective_status, v_changed_count = 1" in LOWER


def test_activation_is_fail_closed_and_retired_history_is_never_reactivated() -> None:
    assert "activate_product_opportunity" in LOWER
    assert "activation requires exactly one matching active primary evidence" in LOWER
    assert "retired history cannot be reactivated in place" in LOWER
    assert "enforce_product_opportunity_lifecycle_transition" in LOWER
    assert "trg_enforce_product_opportunity_initial_lifecycle" in LOWER
    assert "new product opportunities must enter through discovered" in LOWER
    assert "discovered product opportunity cannot carry lifecycle timestamps" in LOWER
    assert "old.lifecycle_status = 'discovered' and new.lifecycle_status in ('active', 'retired')" in LOWER
    assert "old.lifecycle_status = 'active' and new.lifecycle_status in ('inactive', 'retired')" in LOWER
    assert "old.lifecycle_status = 'inactive' and new.lifecycle_status in ('active', 'retired')" in LOWER
    assert "invalid product opportunity lifecycle transition" in LOWER
    assert "new.activated_at := coalesce(new.activated_at, old.activated_at, now())" in LOWER
    assert "new.inactive_at := coalesce(new.inactive_at, now())" in LOWER
    assert "new.retired_at := coalesce(new.retired_at, now())" in LOWER
    assert "enforce_product_evidence_status_transition" in LOWER
    assert "retired product opportunity evidence cannot be reactivated in place" in LOWER
    assert "grant execute on function activate_product_opportunity" in LOWER
    assert "admit_product_opportunity_batch" in LOWER
    assert "jsonb_array_length(p_candidates) = 0" in LOWER
    assert "product opportunity admission batch must not be empty" in LOWER
    assert "jsonb_array_length(p_candidates) > 20" in LOWER
    assert "perform activate_product_opportunity(v_product_id)" in LOWER
    assert "rollback_product_opportunity_admission_batch" in LOWER
    assert "admission rollback exceeds 20 rows" in LOWER
    assert "lifecycle_reason = 'admission_rollback:'" in LOWER
    rollback = LOWER.split(
        "create or replace function rollback_product_opportunity_admission_batch", 1
    )[1].split("$$;", 1)[0]
    assert "delete from product_opportunities" not in rollback
    assert "delete from product_opportunity_evidence" not in rollback


def test_core_tables_and_saved_mutations_are_server_only() -> None:
    assert "from public, anon, authenticated" in LOWER
    assert "revoke all on saved_product_opportunities from public, anon, authenticated" in LOWER
    assert "grant select on saved_product_opportunities to authenticated" in LOWER
    assert "grant select, insert, update on saved_product_opportunities to authenticated" not in LOWER
    assert "grant select, insert, update on saved_product_opportunities to service_role" in LOWER
    assert "grant select on product_opportunities, product_opportunity_evidence" in LOWER
    assert "grant insert, update on product_opportunities" in LOWER
    assert "revoke insert, update, delete on product_evidence_snapshots from service_role" in LOWER
    service_role_grants = LOWER.split(
        "revoke all on product_opportunities, product_free_preview_rank_history", 1
    )[1].split("commit;", 1)[0]
    assert "grant insert, update on product_evidence_snapshots" not in service_role_grants


def test_metric_history_quality_rules_are_persisted_per_family_calibration() -> None:
    for column in (
        "anchor_7_tolerance_days",
        "anchor_14_tolerance_days",
        "anchor_30_tolerance_days",
        "minimum_valid_observations_14d",
        "minimum_valid_observations_30d",
        "maximum_history_gap_days",
    ):
        assert column in LOWER


def test_valid_metric_status_requires_complete_non_negative_values_and_anchors() -> None:
    assert "product_opportunity_metrics_latest_value_check" in LOWER
    assert "product_opportunity_metrics_valid_g30_shape_check" in LOWER
    assert "g30_saves_gained >= 0" in LOWER
    assert "g30_anchor_at is not null" in LOWER
    assert "product_opportunity_metrics_valid_trend_shape_check" in LOWER
    assert "current_g7_gained >= 0" in LOWER
    assert "previous_g7_gained >= 0" in LOWER
    assert "momentum_percent is not null" in LOWER
    assert "momentum_direction is not null" in LOWER
