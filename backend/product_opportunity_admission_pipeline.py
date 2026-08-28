"""Bounded Product Supply receipt -> stable Product Opportunity admission.

This is the missing automatic bridge between the legacy discovery pool and the
v3.7 Product Opportunity catalog.  It never scans an unbounded legacy table: an
apply run consumes only the exact IDs returned by one fresh, successful Product
Supply report.  Pinterest and merchant proof are rebuilt through
``product_opportunity_manifest`` before any v3.7 write.

The default CLI mode is read-only.  A real run keeps the existing admission
module's production/confirm gates and writes in independently verified atomic
batches of at most 20, with a whole-run ceiling of 50.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "db"))

from db import DB  # noqa: E402
import product_opportunity_admission as admission  # noqa: E402
import product_opportunity_manifest as manifest_builder  # noqa: E402
from product_supply_receipt_contract import (  # noqa: E402
    validate_scheduled_origin,
    validate_supply_report_quality,
)


MAX_ATOMIC_BATCH = admission.MAX_BATCH
MAX_RUN_ADMISSIONS = 50
MAX_SOURCE_REPORT_AGE = timedelta(hours=6)
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")
EXPECTED_SOURCE_MIX = {
    "fashion": 29,
    "womens-fashion": 22,
    "home-decor": 29,
    "digital-products": 20,
}
SUPPLY_SERVICE = "vibepin-product-supply.service"
SUPPLY_TIMER = "vibepin-product-supply.timer"
SUPPLY_MAX_SERVICE_DURATION_SECONDS = 6310


@dataclass(frozen=True)
class SupplyReceipt:
    path: Path
    sha256: str
    generated_at: datetime
    selected_total: int
    inserted_ids: tuple[str, ...]
    quality_funnel: dict[str, int]
    scheduled_origin_verified: bool
    scheduled_origin: dict[str, Any] | None


@dataclass
class PipelineArtifacts:
    report: dict[str, Any]
    manifests: list[list[dict[str, Any]]]


class PipelineExecutionError(RuntimeError):
    def __init__(self, message: str, artifacts: PipelineArtifacts):
        super().__init__(message)
        self.artifacts = artifacts


def _parse_utc(value: object) -> datetime:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("Product Supply report has no generatedAt timestamp")
    parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Product Supply generatedAt timestamp has no timezone")
    return parsed.astimezone(timezone.utc)


def _systemd_value(unit: str, prop: str) -> str:
    env = dict(os.environ)
    env["TZ"] = "UTC"
    return subprocess.check_output(
        ["systemctl", "show", unit, "-p", prop, "--value"],
        text=True,
        env=env,
    ).strip()


def _systemd_time(unit: str, prop: str) -> str | None:
    raw = _systemd_value(unit, prop)
    if not raw or raw == "n/a":
        return None
    return datetime.strptime(
        raw,
        "%a %Y-%m-%d %H:%M:%S UTC",
    ).replace(tzinfo=timezone.utc).isoformat()


def collect_supply_scheduled_origin(path: Path) -> dict[str, Any]:
    raw = path.read_bytes()
    payload = json.loads(raw.decode("utf-8"))
    return {
        "timerUnitFileState": _systemd_value(SUPPLY_TIMER, "UnitFileState"),
        "timerActiveState": _systemd_value(SUPPLY_TIMER, "ActiveState"),
        "timerLastTriggerAt": _systemd_time(SUPPLY_TIMER, "LastTriggerUSec"),
        "timerNextTriggerAt": _systemd_time(SUPPLY_TIMER, "NextElapseUSecRealtime"),
        "serviceResult": _systemd_value(SUPPLY_SERVICE, "Result"),
        "serviceExecMainStatus": _systemd_value(SUPPLY_SERVICE, "ExecMainStatus"),
        "serviceStartAt": _systemd_time(SUPPLY_SERVICE, "ExecMainStartTimestamp"),
        "serviceExitAt": _systemd_time(SUPPLY_SERVICE, "ExecMainExitTimestamp"),
        "serviceInvocationId": _systemd_value(SUPPLY_SERVICE, "InvocationID"),
        "serviceTriggeredBy": _systemd_value(SUPPLY_SERVICE, "TriggeredBy"),
        "reportGeneratedAt": payload.get("generatedAt"),
        "reportSha256": hashlib.sha256(raw).hexdigest(),
        "reportMtimeAt": datetime.fromtimestamp(
            path.stat().st_mtime,
            tz=timezone.utc,
        ).isoformat(),
    }


def load_supply_receipt(
    path: Path,
    *,
    now: datetime,
    max_age: timedelta = MAX_SOURCE_REPORT_AGE,
    scheduled_origin: dict[str, Any] | None = None,
    require_scheduled_origin: bool = False,
) -> SupplyReceipt:
    raw = path.read_bytes()
    payload = json.loads(raw.decode("utf-8"))
    if payload.get("engine") != "shop-the-look":
        raise ValueError("source report is not a Shop-the-Look Product Supply report")
    if payload.get("mode") != "apply":
        raise ValueError("source report must be a completed apply report")
    selected = int((payload.get("sourceSelection") or {}).get("selectedTotal") or 0)
    if selected != 100:
        raise ValueError(f"source report must prove the reviewed 100-Pin scan, got {selected}")
    per_pin = payload.get("perPin")
    if not isinstance(per_pin, list) or len(per_pin) != selected:
        raise ValueError("source report does not contain all 100 completed Pin results")
    source_pin_ids = [str(item.get("sourcePinId") or "") for item in per_pin if isinstance(item, dict)]
    if len(source_pin_ids) != selected or any(not item for item in source_pin_ids):
        raise ValueError("source report contains a malformed Pin result")
    if len(set(source_pin_ids)) != selected:
        raise ValueError("source report contains duplicate Source Pin results")
    actual_mix = {
        category: sum(
            1 for item in per_pin
            if isinstance(item, dict) and item.get("category") == category
        )
        for category in EXPECTED_SOURCE_MIX
    }
    unknown_categories = sorted({
        str(item.get("category") or "")
        for item in per_pin
        if isinstance(item, dict) and item.get("category") not in EXPECTED_SOURCE_MIX
    })
    if actual_mix != EXPECTED_SOURCE_MIX or unknown_categories:
        raise ValueError(
            "source report category mix does not match the reviewed launch mix: "
            f"expected={EXPECTED_SOURCE_MIX} actual={actual_mix} unknown={unknown_categories}"
        )

    incremental = payload.get("incrementalWrite") or {}
    failed_batches = incremental.get("failedBatches") or []
    if failed_batches:
        raise ValueError("source report contains failed Product Supply write batches")
    if int(incremental.get("runAdmissionCap") or 0) != MAX_RUN_ADMISSIONS:
        raise ValueError("source report does not prove the reviewed 50-row run cap")
    if int(incremental.get("atomicWriteBatchCap") or 0) != MAX_ATOMIC_BATCH:
        raise ValueError("source report does not prove the 20-row atomic write cap")
    if int(incremental.get("pinsFlushed") or 0) != selected:
        raise ValueError("source report did not flush all 100 completed Pin results")

    outcome = payload.get("writeOutcome") or {}
    inserted_ids = tuple(str(item).strip() for item in outcome.get("insertedIds") or [])
    if len(inserted_ids) > MAX_RUN_ADMISSIONS:
        raise ValueError("source report exceeds the 50-row Product Supply run ceiling")
    if len(set(inserted_ids)) != len(inserted_ids):
        raise ValueError("source report contains duplicate inserted IDs")
    if any(not item or not SAFE_ID.fullmatch(item) for item in inserted_ids):
        raise ValueError("source report contains an unsafe inserted ID")
    reported_writes = int((payload.get("writes") or {}).get("pin_products") or 0)
    outcome_writes = int(outcome.get("inserted", outcome.get("written", 0)) or 0)
    if reported_writes != len(inserted_ids) or outcome_writes != len(inserted_ids):
        raise ValueError("source report write counts do not match its exact inserted IDs")
    if int(outcome.get("failed") or 0) != 0 or outcome.get("errors"):
        raise ValueError("source report contains failed Product Supply rows")
    if int(incremental.get("rowsInserted") or 0) != len(inserted_ids):
        raise ValueError("source report incremental receipt does not match inserted IDs")
    quality_funnel = validate_supply_report_quality(
        payload,
        inserted_ids,
        selected_total=selected,
        atomic_batch_cap=MAX_ATOMIC_BATCH,
    )

    generated_at = _parse_utc(payload.get("generatedAt"))
    now_utc = now.astimezone(timezone.utc)
    age = now_utc - generated_at
    if age < timedelta(minutes=-5):
        raise ValueError("source report timestamp is in the future")
    if age > max_age:
        raise ValueError("source report is stale; refusing automatic admission")
    scheduled_origin_verified = False
    if scheduled_origin is not None:
        validate_scheduled_origin(
            scheduled_origin,
            timer_unit=SUPPLY_TIMER,
            max_service_duration_seconds=SUPPLY_MAX_SERVICE_DURATION_SECONDS,
        )
        if scheduled_origin.get("reportSha256") != hashlib.sha256(raw).hexdigest():
            raise ValueError("scheduled origin does not bind the exact source report bytes")
        if _parse_utc(scheduled_origin.get("reportGeneratedAt")) != generated_at:
            raise ValueError("scheduled origin report timestamp does not match source report")
        scheduled_origin_verified = True
    if require_scheduled_origin and not scheduled_origin_verified:
        raise ValueError("automatic admission requires permanent timer-origin evidence")
    return SupplyReceipt(
        path=path,
        sha256=hashlib.sha256(raw).hexdigest(),
        generated_at=generated_at,
        selected_total=selected,
        inserted_ids=inserted_ids,
        quality_funnel=quality_funnel,
        scheduled_origin_verified=scheduled_origin_verified,
        scheduled_origin=dict(scheduled_origin) if scheduled_origin_verified else None,
    )


def load_exact_legacy_rows(receipt: SupplyReceipt, *, db: DB | None = None) -> list[dict]:
    if not receipt.inserted_ids:
        return []
    database = db or DB()
    rows: list[dict] = []
    columns = (
        "id,source_url,canonical_product_url,parent_pin_id,source_pin_id,"
        "product_pin_id,product_type,source_category,discovery_method,"
        "lifecycle_status,created_at"
    )
    ids = list(receipt.inserted_ids)
    for start in range(0, len(ids), MAX_ATOMIC_BATCH):
        chunk = ids[start : start + MAX_ATOMIC_BATCH]
        rows.extend(database.select_many(
            "pin_products",
            columns=columns,
            filters={"id": f"in.({','.join(chunk)})"},
            limit=len(chunk),
        ))
    by_id = {str(row.get("id") or ""): row for row in rows}
    if len(by_id) != len(rows):
        raise RuntimeError("exact Product Supply readback contains duplicate IDs")
    missing = [item for item in ids if item not in by_id]
    extras = [item for item in by_id if item not in set(ids)]
    if missing or extras:
        raise RuntimeError(
            f"exact Product Supply readback mismatch: missing={missing[:5]} extras={extras[:5]}"
        )
    return [by_id[item] for item in ids]


def _identity_hash(row: dict) -> str:
    value = str(row.get("canonical_product_url") or "")
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


async def run_pipeline(
    receipt: SupplyReceipt,
    *,
    apply: bool,
    now: datetime,
    db: DB | None = None,
) -> PipelineArtifacts:
    report: dict[str, Any] = {
        "generatedAt": now.astimezone(timezone.utc).isoformat(),
        "mode": "apply" if apply else "dry-run",
        "status": "running",
        "sourceReport": str(receipt.path),
        "sourceReportSha256": receipt.sha256,
        "sourceReportGeneratedAt": receipt.generated_at.isoformat(),
        "sourcePins": receipt.selected_total,
        "legacyInsertedIds": list(receipt.inserted_ids),
        "legacyInsertedRows": len(receipt.inserted_ids),
        "supplyQualityFunnel": dict(receipt.quality_funnel),
        "sourceScheduledOriginVerified": receipt.scheduled_origin_verified,
        "sourceScheduledOrigin": receipt.scheduled_origin,
        "runAdmissionCap": MAX_RUN_ADMISSIONS,
        "atomicWriteBatchCap": MAX_ATOMIC_BATCH,
        "candidateRowsEvaluated": 0,
        "providerCandidateUpperBound": len(receipt.inserted_ids),
        "providerRequestUpperBound": len(receipt.inserted_ids) * 4,
        "eligibleRows": 0,
        "rejectedRows": 0,
        "rejections": [],
        "batches": [],
        "written": 0,
        "productOpportunityIds": [],
        "databaseWrites": 0,
    }
    manifests: list[list[dict[str, Any]]] = []
    artifacts = PipelineArtifacts(report=report, manifests=manifests)
    try:
        # Keep the Python entry point fail-closed even when a caller bypasses
        # the wrapper. Apply authority is checked before DB reads or providers.
        if apply:
            if os.environ.get("VIBEPIN_PRODUCT_ADMISSION_MODE") != "production":
                raise RuntimeError(
                    "apply refused: VIBEPIN_PRODUCT_ADMISSION_MODE must equal production"
                )
            if os.environ.get("VIBEPIN_PRODUCT_ADMISSION_CONFIRM") != admission.APPLY_CONFIRM:
                raise RuntimeError(
                    "apply refused: VIBEPIN_PRODUCT_ADMISSION_CONFIRM is not the reviewed token"
                )
            report["projectRef"] = admission.require_expected_project_ref(
                os.environ.get("VIBEPIN_PRODUCT_ADMISSION_EXPECTED_PROJECT_REF")
            )
            if not receipt.scheduled_origin_verified or receipt.scheduled_origin is None:
                raise RuntimeError(
                    "apply refused: Product Supply report lacks permanent timer-origin evidence"
                )
            try:
                validate_scheduled_origin(
                    receipt.scheduled_origin,
                    timer_unit=SUPPLY_TIMER,
                    max_service_duration_seconds=SUPPLY_MAX_SERVICE_DURATION_SECONDS,
                )
            except ValueError as exc:
                raise RuntimeError(
                    f"apply refused: invalid Product Supply timer-origin evidence: {exc}"
                ) from exc
            if receipt.scheduled_origin.get("reportSha256") != receipt.sha256:
                raise RuntimeError(
                    "apply refused: timer-origin evidence is not bound to source report bytes"
                )
            if _parse_utc(receipt.scheduled_origin.get("reportGeneratedAt")) != receipt.generated_at:
                raise RuntimeError(
                    "apply refused: timer-origin timestamp does not match source report"
                )

        rows = load_exact_legacy_rows(receipt, db=db)
        if not rows:
            report.update({"status": "natural_zero_new_legacy_rows", "databaseWrites": 0})
            return artifacts

        existing_hashes = manifest_builder.load_current_identity_hashes()
        for start in range(0, len(rows), MAX_ATOMIC_BATCH):
            chunk = rows[start : start + MAX_ATOMIC_BATCH]
            built, rejected = await manifest_builder._run_live(
                chunk,
                limit=len(chunk),
                now=now,
                existing_url_hashes=existing_hashes,
            )
            accepted, validation_rejections = admission.validate_manifest(built, now=now)
            if validation_rejections or len(accepted) != len(built):
                raise RuntimeError(
                    "manifest/admission validator disagreement; refusing all writes"
                )
            manifests.append(accepted)
            # Local hint/existing-identity failures can avoid provider calls, so
            # this is a candidate-row count, not a fabricated network count.
            # The immutable upper bounds above remain valid: <=1 Pinterest +
            # <=3 merchant requests for each exact Product Supply ID.
            report["candidateRowsEvaluated"] += len(chunk)
            report["eligibleRows"] += len(accepted)
            report["rejectedRows"] += len(rejected)
            report["rejections"].extend(rejected)
            report["batches"].append({
                "batch": len(manifests),
                "sourceRows": len(chunk),
                "eligibleRows": len(accepted),
                "rejectedRows": len(rejected),
                "written": 0,
                "verified": 0,
                "productOpportunityIds": [],
            })
            existing_hashes.update(_identity_hash(row) for row in accepted)

        if report["eligibleRows"] > MAX_RUN_ADMISSIONS:
            raise RuntimeError("eligible rows exceed the 50-row run ceiling")
        if not apply:
            report.update({"status": "dry_run_complete", "databaseWrites": 0})
            return artifacts

        for index, batch in enumerate(manifests):
            if not batch:
                continue
            ids: list[str] = []
            try:
                ids = admission.apply_candidates(batch)
                report["batches"][index]["productOpportunityIds"] = ids
                report["batches"][index]["written"] = len(ids)
                verified = admission.verify_candidates(ids, batch)
                report["batches"][index]["verified"] = verified
            except Exception as exc:
                if ids:
                    reason = f"pipeline_verification:{type(exc).__name__}"
                    rolled_back = admission.rollback_candidates(ids, reason)
                    admission.verify_rollback(ids, batch)
                    report["batches"][index]["rolledBack"] = rolled_back
                raise
            report["written"] += len(ids)
            report["databaseWrites"] += len(ids)
            report["productOpportunityIds"].extend(ids)

        report["status"] = (
            "apply_complete" if report["written"] else "natural_zero_eligible_rows"
        )
        return artifacts
    except Exception as exc:
        report["status"] = "failed"
        report["error"] = f"{type(exc).__name__}: {exc}"
        raise PipelineExecutionError(str(exc), artifacts) from exc


def write_artifacts(artifacts: PipelineArtifacts, output_dir: Path, *, stamp: str) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    for index, manifest in enumerate(artifacts.manifests, start=1):
        path = output_dir / f"product_opportunity_admission_manifest_{stamp}_batch{index}.json"
        path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
        artifacts.report["batches"][index - 1]["manifestPath"] = str(path)
        artifacts.report["batches"][index - 1]["manifestSha256"] = hashlib.sha256(
            path.read_bytes()
        ).hexdigest()
    report_path = output_dir / f"product_opportunity_admission_{stamp}.json"
    report_path.write_text(
        json.dumps(artifacts.report, indent=2, sort_keys=True), encoding="utf-8"
    )
    latest = output_dir / "product_opportunity_admission_latest.json"
    temporary = latest.with_suffix(".json.tmp")
    temporary.write_bytes(report_path.read_bytes())
    os.replace(temporary, latest)
    return report_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-report", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "logs")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y%m%d_%H%M%SZ")
    try:
        scheduled_origin = (
            collect_supply_scheduled_origin(args.source_report) if args.apply else None
        )
        receipt = load_supply_receipt(
            args.source_report,
            now=now,
            scheduled_origin=scheduled_origin,
            require_scheduled_origin=args.apply,
        )
        artifacts = asyncio.run(run_pipeline(receipt, apply=args.apply, now=now))
        report_path = write_artifacts(artifacts, args.output_dir, stamp=stamp)
        print(json.dumps({**artifacts.report, "reportPath": str(report_path)}, indent=2))
        return 0
    except PipelineExecutionError as exc:
        report_path = write_artifacts(exc.artifacts, args.output_dir, stamp=stamp)
        print(f"Product Opportunity admission pipeline failed: {exc}", file=sys.stderr)
        print(f"failure report: {report_path}", file=sys.stderr)
        return 1
    except Exception as exc:
        failure = PipelineArtifacts(
            report={
                "generatedAt": now.isoformat(),
                "mode": "apply" if args.apply else "dry-run",
                "status": "failed",
                "sourceReport": str(args.source_report),
                "databaseWrites": 0,
                "error": f"{type(exc).__name__}: {exc}",
            },
            manifests=[],
        )
        report_path = write_artifacts(failure, args.output_dir, stamp=stamp)
        print(f"Product Opportunity admission pipeline failed: {exc}", file=sys.stderr)
        print(f"failure report: {report_path}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
