"""Pure fail-closed contract for Product Supply reports consumed downstream."""

from __future__ import annotations

import datetime as dt
from typing import Any, Sequence


def _non_negative_int(value: object) -> bool:
    return type(value) is int and value >= 0


def _parse_aware_timestamp(value: object, field: str) -> dt.datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"scheduled origin has no {field}")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"scheduled origin has invalid {field}") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"scheduled origin {field} has no timezone")
    return parsed.astimezone(dt.timezone.utc)


def validate_scheduled_origin(
    origin: object,
    *,
    timer_unit: str,
    max_service_duration_seconds: int,
) -> None:
    """Prove one report belongs to the permanent timer's exact last service run."""
    if not isinstance(origin, dict):
        raise ValueError("scheduled timer-origin evidence is missing")
    if origin.get("timerUnitFileState") != "enabled" or origin.get("timerActiveState") != "active":
        raise ValueError("scheduled timer is not enabled and active")
    if (
        origin.get("serviceResult") != "success"
        or str(origin.get("serviceExecMainStatus")) != "0"
        or origin.get("serviceTriggeredBy") != timer_unit
    ):
        raise ValueError("scheduled service did not complete successfully from the timer unit")
    invocation_id = str(origin.get("serviceInvocationId") or "")
    if len(invocation_id) != 32 or any(ch not in "0123456789abcdef" for ch in invocation_id.lower()):
        raise ValueError("scheduled service invocation identity is missing or invalid")
    timer_trigger = _parse_aware_timestamp(origin.get("timerLastTriggerAt"), "timerLastTriggerAt")
    service_start = _parse_aware_timestamp(origin.get("serviceStartAt"), "serviceStartAt")
    service_exit = _parse_aware_timestamp(origin.get("serviceExitAt"), "serviceExitAt")
    report_generated = _parse_aware_timestamp(origin.get("reportGeneratedAt"), "reportGeneratedAt")
    report_mtime = _parse_aware_timestamp(origin.get("reportMtimeAt"), "reportMtimeAt")
    next_trigger = _parse_aware_timestamp(origin.get("timerNextTriggerAt"), "timerNextTriggerAt")
    if abs((service_start - timer_trigger).total_seconds()) > 2:
        raise ValueError("service start does not match the timer's exact last trigger")
    duration = (service_exit - service_start).total_seconds()
    if duration <= 0 or duration > max_service_duration_seconds:
        raise ValueError("scheduled service duration is invalid or exceeded its systemd bound")
    if not (
        service_start <= report_generated <= service_exit + dt.timedelta(seconds=2)
        and service_start <= report_mtime <= service_exit + dt.timedelta(seconds=2)
        and abs((report_mtime - report_generated).total_seconds()) <= 5
    ):
        raise ValueError("audited report does not belong to the timer's last service invocation")
    if next_trigger <= service_exit:
        raise ValueError("scheduled timer has no future trigger after the audited run")


def batch_receipts_are_safe(
    batch_receipts: object,
    inserted_ids: list[str] | tuple[str, ...],
    *,
    atomic_batch_cap: int = 20,
) -> bool:
    if not isinstance(batch_receipts, list) or atomic_batch_cap < 1:
        return False
    receipt_ids: list[str] = []
    for receipt in batch_receipts:
        if not isinstance(receipt, dict):
            return False
        local_ids = [str(value) for value in (receipt.get("insertedIds") or []) if value]
        if len(local_ids) > atomic_batch_cap or len(local_ids) != len(set(local_ids)):
            return False
        receipt_ids.extend(local_ids)
        if (
            receipt.get("preWriteViolationSamples")
            or receipt.get("rolledBack")
            or receipt.get("rollbackRemainingIds")
        ):
            return False
        verification = receipt.get("postWriteVerification")
        created_window = receipt.get("createdAtWindow")
        rollback = receipt.get("rollback")
        if local_ids:
            if not isinstance(verification, dict):
                return False
            exact = verification.get("exactWriteReadback") or {}
            if (
                verification.get("allRedLinesPass") is not True
                or verification.get("rowsReadBack") != len(local_ids)
                or exact.get("pass") is not True
                or sorted(str(value) for value in (exact.get("expectedIds") or []))
                != sorted(local_ids)
                or sorted(str(value) for value in (exact.get("actualIds") or []))
                != sorted(local_ids)
                or not isinstance(created_window, list)
                or len(created_window) != 2
                or not all(isinstance(value, str) and value for value in created_window)
                or not isinstance(rollback, str)
                or not rollback.strip()
            ):
                return False
        elif verification is not None or created_window is not None or rollback is not None:
            return False
    return sorted(receipt_ids) == sorted(str(value) for value in inserted_ids)


def validate_supply_report_quality(
    payload: dict[str, Any],
    inserted_ids: Sequence[str],
    *,
    selected_total: int,
    atomic_batch_cap: int,
) -> dict[str, int]:
    """Validate trust, receipts and the complete pre-admission Supply funnel."""
    quality = payload.get("dataQuality") or {}
    aggregate = payload.get("aggregate") or {}
    incremental = payload.get("incrementalWrite") or {}
    outcome = payload.get("writeOutcome") or {}
    if quality.get("resultTrust") != "trusted" or quality.get("authenticatedRun") is not True:
        raise ValueError("source report is not a trusted authenticated Product Supply run")
    if aggregate.get("renderFailureCount") != 0:
        raise ValueError("source report contains rendered-page failures")
    if incremental.get("failedBatches") or incremental.get("batchesFailed") != 0:
        raise ValueError("source report contains failed Product Supply write batches")
    if outcome.get("preWriteViolationSamples"):
        raise ValueError("source report contains pre-write red-line violations")
    if outcome.get("failed") != 0 or outcome.get("errors"):
        raise ValueError("source report contains failed Product Supply rows")
    if not batch_receipts_are_safe(
        outcome.get("batchReceipts"),
        inserted_ids,
        atomic_batch_cap=atomic_batch_cap,
    ):
        raise ValueError("source report atomic batch receipts are missing or unsafe")

    funnel = {
        "sourcePinsScanned": aggregate.get("sourcePinsScanned"),
        "rawProductCandidates": aggregate.get("rawProductCandidates"),
        "rejectedProductCandidates": aggregate.get("rejectedProducts"),
        "acceptedBeforeDedup": aggregate.get("acceptedBeforeDedup"),
        "duplicatesSkippedWithinRun": aggregate.get("duplicatesSkipped"),
        "uniqueAcceptedCandidates": aggregate.get("uniqueAcceptedProducts"),
        "alreadyInDatabase": incremental.get("rowsSkippedAlreadyInDb"),
        "crossBatchDuplicates": incremental.get("rowsSkippedCrossBatchDuplicate"),
        "skippedByRunAdmissionCap": incremental.get("rowsSkippedRunAdmissionCap"),
        "merchantDiscoveryAttempts": outcome.get("coreCandidates"),
        "merchantVerified": outcome.get("merchantDiscovered"),
        "merchantVerificationFailures": outcome.get("merchantDiscoveryFailures"),
        "writeDuplicates": outcome.get("duplicates"),
        "safeLegacyRowsWritten": outcome.get("inserted", outcome.get("written", 0)),
    }
    if any(not _non_negative_int(value) for value in funnel.values()):
        raise ValueError("source report Supply funnel is missing or invalid")
    if (
        funnel["sourcePinsScanned"] != selected_total
        or funnel["rawProductCandidates"]
        != funnel["rejectedProductCandidates"] + funnel["acceptedBeforeDedup"]
        or funnel["acceptedBeforeDedup"]
        != funnel["duplicatesSkippedWithinRun"] + funnel["uniqueAcceptedCandidates"]
        or funnel["merchantDiscoveryAttempts"]
        != funnel["merchantVerified"] + funnel["merchantVerificationFailures"]
        or funnel["merchantVerified"]
        != funnel["safeLegacyRowsWritten"] + funnel["writeDuplicates"]
        or funnel["safeLegacyRowsWritten"] != len(inserted_ids)
        or incremental.get("rowsInserted") != len(inserted_ids)
    ):
        raise ValueError("source report Supply funnel arithmetic does not close")
    return funnel
