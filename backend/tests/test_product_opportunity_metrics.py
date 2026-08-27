from datetime import datetime, timedelta, timezone

import pytest

from product_opportunity_metrics import MetricPolicy, Observation, calculate_product_metrics


NOW = datetime(2026, 8, 25, 12, tzinfo=timezone.utc)


def obs(
    days_ago: int,
    saves: int,
    evidence: str = "ev-1",
    hour: int = 12,
    status: str = "valid",
) -> Observation:
    return Observation(
        evidence_id=evidence,
        captured_at=(NOW - timedelta(days=days_ago)).replace(hour=hour),
        save_count=saves,
        status=status,
    )


def permissive_policy(**overrides: object) -> MetricPolicy:
    values = {
        "minimum_14d_activity": 1,
        "minimum_absolute_delta": 1,
        "relative_change_boundary_percent": 20,
        "minimum_valid_observations_14d": 2,
        "minimum_valid_observations_30d": 2,
        "maximum_history_gap_days": 40,
    }
    values.update(overrides)
    return MetricPolicy(**values)


def test_calculates_g30_and_current_vs_previous_g7_from_one_evidence() -> None:
    result = calculate_product_metrics(
        "ev-1",
        [obs(30, 100), obs(14, 120), obs(7, 130), obs(0, 150)],
        now=NOW,
        policy=permissive_policy(),
    )

    assert result.g30_status == "valid"
    assert result.trend_status == "valid"
    assert result.g30_saves_gained == 50
    assert result.current_g7_gained == 20
    assert result.previous_g7_gained == 10
    assert result.momentum_direction == "rising"
    assert result.momentum_percent == 100.0


def test_anchors_accept_prd_tolerances_and_store_actual_days() -> None:
    result = calculate_product_metrics(
        "ev-1",
        [obs(32, 100), obs(15, 110), obs(8, 120), obs(0, 140)],
        now=NOW,
        policy=permissive_policy(),
    )

    assert result.g30_status == "valid"
    assert result.trend_status == "valid"
    assert result.g30_actual_days == 32
    assert result.current_g7_actual_days == 8
    assert result.previous_g7_actual_days == 7


def test_missing_anchor_fails_closed_without_partial_trend() -> None:
    result = calculate_product_metrics(
        "ev-1",
        [obs(20, 100), obs(7, 120), obs(0, 140)],
        now=NOW,
    )

    assert result.g30_status == "insufficient_history"
    assert result.trend_status == "insufficient_history"
    assert result.g30_saves_gained is None
    assert result.momentum_direction is None


def test_g30_can_be_valid_while_trend_history_is_not() -> None:
    result = calculate_product_metrics(
        "ev-1",
        [obs(30, 100), obs(0, 140)],
        now=NOW,
        policy=permissive_policy(),
    )

    assert result.g30_status == "valid"
    assert result.g30_saves_gained == 40
    assert result.trend_status == "insufficient_history"
    assert result.momentum_direction is None


def test_low_absolute_activity_does_not_turn_one_to_three_into_rising() -> None:
    result = calculate_product_metrics(
        "ev-1",
        [obs(30, 0), obs(14, 1), obs(7, 2), obs(0, 4)],
        now=NOW,
        policy=MetricPolicy(
            minimum_14d_activity=20,
            minimum_absolute_delta=5,
            minimum_valid_observations_14d=2,
            minimum_valid_observations_30d=2,
            maximum_history_gap_days=40,
        ),
    )

    assert result.g30_status == "valid"
    assert result.trend_status == "insufficient_activity"
    assert result.current_g7_gained == 2
    assert result.previous_g7_gained == 1
    assert result.momentum_direction is None


@pytest.mark.parametrize(
    "override",
    [
        {"minimum_14d_activity": 0},
        {"minimum_absolute_delta": 0},
        {"relative_change_boundary_percent": 0},
    ],
)
def test_zero_truthfulness_gate_is_rejected(override: dict[str, int]) -> None:
    with pytest.raises(ValueError):
        MetricPolicy(**override)


def test_latest_counter_regression_is_anomaly_and_never_clamped_to_zero() -> None:
    result = calculate_product_metrics(
        "ev-1",
        [obs(30, 100), obs(14, 130), obs(7, 150), obs(0, 120, status="counter_regression")],
        now=NOW,
        policy=permissive_policy(),
    )

    assert result.g30_status == "counter_regression"
    assert result.trend_status == "counter_regression"
    assert result.g30_saves_gained is None


def test_counter_reset_starts_new_baseline_instead_of_splicing_old_history() -> None:
    result = calculate_product_metrics(
        "ev-1",
        [
            obs(30, 100),
            obs(14, 130),
            obs(7, 90, status="counter_regression"),
            obs(0, 110),
        ],
        now=NOW,
        policy=permissive_policy(),
    )
    assert result.g30_status == "insufficient_history"
    assert result.trend_status == "insufficient_history"
    assert result.latest_save_count == 110


def test_sparse_history_with_anchors_still_fails_minimum_observation_gate() -> None:
    result = calculate_product_metrics(
        "ev-1",
        [obs(30, 100), obs(14, 120), obs(7, 130), obs(0, 150)],
        now=NOW,
    )
    assert result.g30_status == "insufficient_history"
    assert result.trend_status == "insufficient_history"


def test_large_history_gap_fails_closed() -> None:
    rows = [obs(days, 100 + (30 - days)) for days in range(30, -1, -1) if days not in range(17, 23)]
    result = calculate_product_metrics(
        "ev-1",
        rows,
        now=NOW,
        policy=MetricPolicy(maximum_history_gap_days=3),
    )
    assert result.g30_status == "insufficient_history"


def test_stale_latest_observation_does_not_generate_metrics() -> None:
    result = calculate_product_metrics(
        "ev-1",
        [obs(35, 100), obs(19, 120), obs(12, 130), obs(5, 150)],
        now=NOW,
    )

    assert result.g30_status == "stale"
    assert result.trend_status == "stale"
    assert result.latest_save_count == 150
    assert result.g30_saves_gained is None


def test_mixed_primary_evidence_history_is_rejected() -> None:
    with pytest.raises(ValueError, match="one evidence_id"):
        calculate_product_metrics(
            "ev-1",
            [obs(30, 100, "ev-1"), obs(0, 150, "ev-2")],
            now=NOW,
        )


def test_same_utc_day_uses_latest_observation_deterministically() -> None:
    result = calculate_product_metrics(
        "ev-1",
        [obs(30, 100), obs(14, 120), obs(7, 130), obs(0, 140, hour=8), obs(0, 150, hour=18)],
        now=NOW.replace(hour=20),
        policy=permissive_policy(),
    )

    assert result.latest_save_count == 150
    assert result.current_g7_gained == 20


def test_negative_save_count_is_invalid_input() -> None:
    with pytest.raises(ValueError, match="non-negative"):
        obs(0, -1)
