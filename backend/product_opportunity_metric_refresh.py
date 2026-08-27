"""Recompute Product Opportunities v1 metrics from immutable daily snapshots.

The default is a read-only dry run. Physical and Digital thresholds come only
from approved product_metric_calibrations rows. Until a family is calibrated,
raw G30 may be computed but no Momentum conclusion is published.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "db"))

from product_opportunity_metrics import MetricPolicy, Observation, calculate_product_metrics


MAX_PRODUCTS_PER_RUN = 5_000
APPLY_CONFIRM = "REFRESH_PRODUCT_METRICS"


def _parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def load_inputs(limit: int | None) -> tuple[list[dict], list[dict], dict[str, object]]:
    from db import DB  # type: ignore

    db = DB()
    read_limit = limit + 1 if limit is not None else None
    products = db.select_many(
        "product_opportunities",
        columns="id,product_family",
        filters={"lifecycle_status": "active"},
        order="updated_at.asc,id.asc",
        limit=read_limit,
    )
    exceeds_run_budget = limit is not None and len(products) > limit
    if limit is not None:
        products = products[:limit]
    if not products:
        return [], [], {"exceedsRunBudget": exceeds_run_budget, "missingPrimaryEvidence": 0}
    product_ids = [str(row["id"]) for row in products]
    evidence: list[dict] = []
    for start in range(0, len(product_ids), 100):
        evidence.extend(
            db.select_many(
                "product_opportunity_evidence",
                columns="id,product_opportunity_id,pinterest_pin_id",
                filters={
                    "product_opportunity_id": f"in.({','.join(product_ids[start:start + 100])})",
                    "is_primary": "true",
                    "evidence_status": "active",
                },
            )
        )
    pin_ids = sorted({str(row["pinterest_pin_id"]) for row in evidence})
    snapshots: list[dict] = []
    for start in range(0, len(pin_ids), 100):
        snapshots.extend(
            db.select_many(
                "product_evidence_snapshots",
                columns="pinterest_pin_id,captured_at,save_count,observation_status",
                filters={
                    "pinterest_pin_id": f"in.({','.join(pin_ids[start:start + 100])})",
                    "observation_status": "in.(valid,counter_regression)",
                },
                order="captured_at.asc",
            )
        )
    calibrations = db.select_many(
        "product_metric_calibrations",
        columns=(
            "product_family,metric_version,minimum_14d_activity,minimum_absolute_delta,"
            "relative_change_boundary_percent,anchor_7_tolerance_days,"
            "anchor_14_tolerance_days,anchor_30_tolerance_days,max_latest_age_days,"
            "minimum_valid_observations_14d,minimum_valid_observations_30d,"
            "maximum_history_gap_days,effective_from,approved_at"
        ),
        filters={
            "effective_from": f"lte.{datetime.now(timezone.utc).isoformat()}",
            "approved_at": "not.is.null",
        },
        order="effective_from.desc",
    )
    latest: dict[str, dict] = {}
    for row in calibrations:
        latest.setdefault(str(row["product_family"]), row)
    return products, evidence, {
        "snapshots": snapshots,
        "calibrations": latest,
        "exceedsRunBudget": exceeds_run_budget,
        "missingPrimaryEvidence": len(products) - len(evidence),
    }


def build_metric_rows(
    products: list[dict],
    evidence: list[dict],
    payload: dict[str, object],
    *,
    now: datetime,
) -> list[dict]:
    evidence_by_product = {str(row["product_opportunity_id"]): row for row in evidence}
    snapshots_by_pin: dict[str, list[dict]] = defaultdict(list)
    for row in payload.get("snapshots", []):
        if row.get("save_count") is None:
            continue
        snapshots_by_pin[str(row["pinterest_pin_id"])].append(row)
    calibrations = payload.get("calibrations", {})
    rows: list[dict] = []
    for product in products:
        product_id = str(product["id"])
        primary = evidence_by_product.get(product_id)
        if not primary:
            continue
        evidence_id = str(primary["id"])
        pin_id = str(primary["pinterest_pin_id"])
        family = str(product["product_family"])
        calibration = calibrations.get(family) if isinstance(calibrations, dict) else None
        policy = MetricPolicy()
        version = 1
        if isinstance(calibration, dict):
            policy = MetricPolicy(
                anchor_7_tolerance_days=int(calibration["anchor_7_tolerance_days"]),
                anchor_14_tolerance_days=int(calibration["anchor_14_tolerance_days"]),
                anchor_30_tolerance_days=int(calibration["anchor_30_tolerance_days"]),
                max_latest_age_days=int(calibration["max_latest_age_days"]),
                minimum_valid_observations_14d=int(calibration["minimum_valid_observations_14d"]),
                minimum_valid_observations_30d=int(calibration["minimum_valid_observations_30d"]),
                maximum_history_gap_days=int(calibration["maximum_history_gap_days"]),
                minimum_14d_activity=int(calibration["minimum_14d_activity"]),
                minimum_absolute_delta=int(calibration["minimum_absolute_delta"]),
                relative_change_boundary_percent=float(calibration["relative_change_boundary_percent"]),
            )
            version = int(calibration["metric_version"])
        metric = calculate_product_metrics(
            evidence_id,
            [
                Observation(
                    evidence_id,
                    _parse_datetime(str(row["captured_at"])),
                    int(row["save_count"]),
                    str(row.get("observation_status") or "valid"),
                )
                for row in snapshots_by_pin.get(pin_id, [])
            ],
            now=now,
            policy=policy,
        )
        data = asdict(metric)
        if calibration is None:
            data["trend_status"] = "calibration_pending"
            data["momentum_percent"] = None
            data["momentum_direction"] = None
        rows.append(
            {
                "product_opportunity_id": product_id,
                "evidence_id": data.pop("evidence_id"),
                "metric_version": version,
                **data,
                "computed_at": now.isoformat(),
            }
        )
    return rows


def write_metric_rows(rows: list[dict]) -> int:
    from db import DB  # type: ignore

    db = DB()
    written = 0
    for start in range(0, len(rows), 100):
        receipt = db.upsert(
            "product_opportunity_metrics",
            rows[start : start + 100],
            on_conflict="product_opportunity_id",
            returning="product_opportunity_id",
        )
        if len(receipt) != len(rows[start : start + 100]):
            raise RuntimeError(f"metric write receipt mismatch at offset {start}")
        written += len(receipt)
    return written


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--limit", type=int, default=MAX_PRODUCTS_PER_RUN)
    args = parser.parse_args()
    try:
        limit = min(max(1, args.limit), MAX_PRODUCTS_PER_RUN)
        products, evidence, payload = load_inputs(limit)
        rows = build_metric_rows(products, evidence, payload, now=datetime.now(timezone.utc))
        report = {
            "mode": "apply" if args.apply else "dry-run",
            "activeProductsRead": len(products),
            "metricRowsProjected": len(rows),
            "familiesCalibrated": sorted(payload.get("calibrations", {}).keys()),
            "exceedsRunBudget": bool(payload.get("exceedsRunBudget")),
            "missingPrimaryEvidence": int(payload.get("missingPrimaryEvidence", 0)),
            "written": 0,
        }
        if args.apply:
            if os.environ.get("VIBEPIN_PRODUCT_METRICS_MODE") != "production":
                raise RuntimeError("apply refused: VIBEPIN_PRODUCT_METRICS_MODE must equal production")
            if os.environ.get("VIBEPIN_PRODUCT_METRICS_CONFIRM") != APPLY_CONFIRM:
                raise RuntimeError(f"apply refused: VIBEPIN_PRODUCT_METRICS_CONFIRM must equal {APPLY_CONFIRM}")
            if report["exceedsRunBudget"]:
                raise RuntimeError(
                    f"apply refused: active catalog exceeds the {limit}-product metric budget"
                )
            if report["missingPrimaryEvidence"]:
                raise RuntimeError(
                    f"apply refused: {report['missingPrimaryEvidence']} active products lack Primary Evidence"
                )
            report["written"] = write_metric_rows(rows)
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0
    except Exception as exc:
        print(f"metric refresh failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
