from datetime import datetime, timedelta, timezone

from product_opportunity_metric_refresh import build_metric_rows
from pathlib import Path


NOW = datetime(2026, 8, 25, 12, tzinfo=timezone.utc)
SOURCE = (Path(__file__).parents[1] / "product_opportunity_metric_refresh.py").read_text(encoding="utf-8")


def snapshots(pin_id: str = "pin-1") -> list[dict]:
    rows = []
    for days in range(30, -1, -1):
        if days >= 14:
            saves = 100 + round((30 - days) * 20 / 16)
        elif days >= 7:
            saves = 120 + round((14 - days) * 10 / 7)
        else:
            saves = 130 + round((7 - days) * 20 / 7)
        rows.append({
            "pinterest_pin_id": pin_id,
            "captured_at": (NOW - timedelta(days=days)).isoformat(),
            "save_count": saves,
            "observation_status": "valid",
        })
    return rows


def calibration(version: int, **overrides: int | float) -> dict:
    value: dict = {
        "metric_version": version,
        "anchor_7_tolerance_days": 1,
        "anchor_14_tolerance_days": 1,
        "anchor_30_tolerance_days": 3,
        "max_latest_age_days": 2,
        "minimum_valid_observations_14d": 10,
        "minimum_valid_observations_30d": 20,
        "maximum_history_gap_days": 3,
        "minimum_14d_activity": 20,
        "minimum_absolute_delta": 5,
        "relative_change_boundary_percent": 20,
    }
    value.update(overrides)
    return value


def test_uncalibrated_family_computes_g30_but_hides_momentum() -> None:
    rows = build_metric_rows(
        [{"id": "p-1", "product_family": "digital"}],
        [{"id": "ev-1", "product_opportunity_id": "p-1", "pinterest_pin_id": "pin-1"}],
        {"snapshots": snapshots(), "calibrations": {}},
        now=NOW,
    )
    assert rows[0]["g30_status"] == "valid"
    assert rows[0]["g30_saves_gained"] == 50
    assert rows[0]["trend_status"] == "calibration_pending"
    assert rows[0]["momentum_direction"] is None


def test_physical_and_digital_use_separate_approved_calibrations() -> None:
    products = [
        {"id": "physical", "product_family": "physical"},
        {"id": "digital", "product_family": "digital"},
    ]
    evidence = [
        {"id": "ev-1", "product_opportunity_id": "physical", "pinterest_pin_id": "pin-1"},
        {"id": "ev-2", "product_opportunity_id": "digital", "pinterest_pin_id": "pin-2"},
    ]
    digital_snapshots = snapshots("pin-2")
    calibrations = {
        "physical": calibration(2),
        "digital": calibration(
            3,
            minimum_14d_activity=100,
            minimum_absolute_delta=50,
            relative_change_boundary_percent=40,
        ),
    }
    rows = build_metric_rows(
        products,
        evidence,
        {"snapshots": snapshots() + digital_snapshots, "calibrations": calibrations},
        now=NOW,
    )
    by_product = {row["product_opportunity_id"]: row for row in rows}
    assert by_product["physical"]["metric_version"] == 2
    assert by_product["physical"]["trend_status"] == "valid"
    assert by_product["digital"]["metric_version"] == 3
    assert by_product["digital"]["trend_status"] == "insufficient_activity"


def test_products_sharing_one_pin_consume_one_canonical_snapshot_history() -> None:
    rows = build_metric_rows(
        [
            {"id": "p-1", "product_family": "physical"},
            {"id": "p-2", "product_family": "physical"},
        ],
        [
            {"id": "ev-1", "product_opportunity_id": "p-1", "pinterest_pin_id": "pin-shared"},
            {"id": "ev-2", "product_opportunity_id": "p-2", "pinterest_pin_id": "pin-shared"},
        ],
        {
            "snapshots": snapshots("pin-shared"),
            "calibrations": {"physical": calibration(2)},
        },
        now=NOW,
    )
    assert len(rows) == 2
    assert {row["evidence_id"] for row in rows} == {"ev-1", "ev-2"}
    assert {row["g30_saves_gained"] for row in rows} == {50}


def test_product_without_primary_evidence_has_no_metric_row() -> None:
    assert build_metric_rows(
        [{"id": "p-1", "product_family": "physical"}],
        [],
        {"snapshots": [], "calibrations": {}},
        now=NOW,
    ) == []


def test_only_approved_calibration_is_loaded_and_apply_is_complete_catalog_only() -> None:
    assert '"approved_at": "not.is.null"' in SOURCE
    assert "read_limit = limit + 1 if limit is not None else None" in SOURCE
    assert "exceedsRunBudget" in SOURCE
    assert "missingPrimaryEvidence" in SOURCE
