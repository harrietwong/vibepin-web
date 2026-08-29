"""Bounded daily tracking for every active Product Opportunity Primary Evidence.

Default invocation is read-only. Production writes require both --apply and two
environment gates. The job records one canonical daily Pinterest observation per
unique Pin through the v63 transaction-safe RPC; Evidence health and metrics
consume that shared fact without duplicating the raw snapshot. It never discovers or
creates products and it never uses keyword trends or product-card fields.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from collections import defaultdict
from dataclasses import asdict, dataclass, field, replace
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "db"))

# Worst case is one initial request plus one bounded retry per unique Pin. Keep
# the reviewed 5,000-request ceiling hard, with two requests reserved for the
# Pinterest session bootstrap/transport margin.
MAX_UNIQUE_PINS_PER_RUN = 2_499
MAX_PROVIDER_REQUESTS = 5_000
SESSION_REQUEST_RESERVE = 2
POSTGRES_BIGINT_MAX = 2**63 - 1
APPLY_CONFIRM = "TRACK_ACTIVE_PRODUCTS"
EXPECTED_PROJECT_REF_ENV = "VIBEPIN_PRODUCT_TRACKING_EXPECTED_PROJECT_REF"

ObservationStatus = Literal["valid", "not_found", "provider_error", "rate_limited"]


@dataclass(frozen=True)
class TrackingTarget:
    product_opportunity_id: str
    evidence_id: str
    pinterest_pin_id: str


@dataclass(frozen=True)
class PendingPrimarySwitch:
    product_opportunity_id: str
    old_evidence_id: str
    new_evidence_id: str
    new_pinterest_pin_id: str


@dataclass(frozen=True)
class TrackingObservation:
    target: TrackingTarget
    status: ObservationStatus
    save_count: int | None
    failure_kind: str | None = None
    attempts: int = 1
    captured_at: datetime | None = None


@dataclass(frozen=True)
class TrackingInventory:
    targets: list[TrackingTarget]
    active_products_read: int
    missing_primary_evidence: int
    exceeds_run_budget: bool
    already_observed_today: int = 0
    eligible_unique_pins: int = 0
    due_unique_pins: int = 0
    pending_primary_switches: list[PendingPrimarySwitch] = field(default_factory=list)
    switch_candidates_already_valid_today: int = 0
    already_valid_switch_pin_ids: tuple[str, ...] = ()
    total_due_request_pins: int = 0
    switch_candidate_pins_due: int = 0


@dataclass(frozen=True)
class TrackingFetchBatch:
    observations: list[TrackingObservation]
    pin_observations: list[TrackingObservation]
    unique_pins: int
    deduped_pins: int
    provider_requests_attempted: int
    retries: int
    attempt_failures: dict[str, int]


def provider_run_outcome(pin_observations: list[TrackingObservation]) -> str:
    """Classify the final unique-Pin results without hiding a provider outage.

    Individual Pin failures are isolated, so a partially useful batch remains
    usable. A non-empty due batch with no confirmed Pinterest fact at all is a
    failed tracking run, not a successful zero-write run.
    """
    if not pin_observations:
        return "no_due_pins"
    facts = sum(item.status in ("valid", "not_found") for item in pin_observations)
    if facts == 0:
        return "failed_no_confirmed_observation"
    if facts < len(pin_observations):
        return "degraded_partial_observations"
    return "complete"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def require_single_utc_tracking_day(
    run_captured_at: datetime,
    observations: list[TrackingObservation],
    *,
    checked_at: datetime,
) -> None:
    """Refuse all snapshot writes when one provider run spans UTC dates."""
    timestamps = [run_captured_at, checked_at]
    timestamps.extend(
        observation.captured_at
        for observation in observations
        if observation.captured_at is not None
    )
    if any(timestamp.tzinfo is None for timestamp in timestamps):
        raise RuntimeError("tracking UTC-day guard requires timezone-aware timestamps")
    run_day = run_captured_at.astimezone(timezone.utc).date()
    observed_days = {
        timestamp.astimezone(timezone.utc).date()
        for timestamp in timestamps
    }
    if observed_days != {run_day}:
        raise RuntimeError(
            "product tracking crossed a UTC day boundary; refusing all snapshot writes"
        )


class RequestStartLimiter:
    """Space request starts while still allowing in-flight overlap."""

    def __init__(self, delay_seconds: float) -> None:
        self.delay_seconds = max(0.0, delay_seconds)
        self._last_start = 0.0
        self._lock = asyncio.Lock()

    async def wait(self) -> None:
        async with self._lock:
            elapsed = time.monotonic() - self._last_start
            if elapsed < self.delay_seconds:
                await asyncio.sleep(self.delay_seconds - elapsed)
            self._last_start = time.monotonic()


def count_live_descendants(*, grace_seconds: float = 3.0) -> int:
    """Measure child processes that survived session cleanup.

    The outer wrapper and systemd cgroup still own timeout tree-kill. This
    in-process check closes the normal-exit gap: a run must not publish a
    hard-coded orphanCount=0 when a browser/worker descendant is still alive.
    """
    import psutil

    process = psutil.Process()
    deadline = time.monotonic() + max(0.0, grace_seconds)
    while True:
        live = []
        for child in process.children(recursive=True):
            try:
                if child.is_running() and child.status() not in (
                    psutil.STATUS_DEAD,
                    psutil.STATUS_ZOMBIE,
                ):
                    live.append(child)
            except (psutil.NoSuchProcess, psutil.ZombieProcess):
                continue
        if not live or time.monotonic() >= deadline:
            return len(live)
        time.sleep(0.2)


def verify_process_cleanup(report: dict, *, grace_seconds: float = 3.0) -> None:
    orphan_count = count_live_descendants(grace_seconds=grace_seconds)
    report["orphanCount"] = orphan_count
    if orphan_count:
        raise RuntimeError(
            f"product tracking cleanup failed: {orphan_count} live descendant process(es) remain"
        )


def classify_pin_resource(target: TrackingTarget, payload: object) -> TrackingObservation:
    if not isinstance(payload, dict) or not payload:
        return TrackingObservation(target, "provider_error", None)
    resource = payload.get("resource_response")
    if not isinstance(resource, dict):
        return TrackingObservation(target, "provider_error", None)
    data = resource.get("data")
    if isinstance(data, dict) and str(data.get("id") or "") == target.pinterest_pin_id:
        aggregated = data.get("aggregated_pin_data")
        aggregated_stats = (
            aggregated.get("aggregated_stats")
            if isinstance(aggregated, dict) else None
        )
        raw_save_values = [
            data.get("save_count"),
            data.get("saves"),
            data.get("repin_count"),
            aggregated_stats.get("saves") if isinstance(aggregated_stats, dict) else None,
        ]
        # The generic scraper historically defaults an absent field to zero.
        # That is convenient for display but invalid for a cumulative trend
        # baseline: missing evidence is unknown, while an explicit 0 is real.
        if not any(value is not None for value in raw_save_values):
            return TrackingObservation(target, "provider_error", None)
        raw_save_count = next(value for value in raw_save_values if value is not None)
        if isinstance(raw_save_count, bool):
            return TrackingObservation(target, "provider_error", None)
        try:
            save_count = int(raw_save_count)
        except (TypeError, ValueError, OverflowError):
            return TrackingObservation(target, "provider_error", None)
        if save_count < 0 or save_count > POSTGRES_BIGINT_MAX or (
            isinstance(raw_save_count, float) and not raw_save_count.is_integer()
        ):
            return TrackingObservation(target, "provider_error", None)
        return TrackingObservation(target, "valid", save_count)
    if "data" in resource and data is None and not resource.get("error"):
        return TrackingObservation(target, "not_found", None)
    return TrackingObservation(target, "provider_error", None)


async def fetch_observations(
    session: object,
    targets: list[TrackingTarget],
    *,
    concurrency: int = 5,
    delay: float = 1.2,
    request_budget: int = MAX_PROVIDER_REQUESTS - SESSION_REQUEST_RESERVE,
) -> TrackingFetchBatch:
    """Fetch each unique Pin once, then retry transport failures at most once.

    The budget counts real PinResource HTTP attempts, not product rows. A Pin
    shared by several products is requested once and persisted as one Pin/day
    canonical snapshot; each distinct Evidence consumes the same fact.
    """
    semaphore = asyncio.Semaphore(max(1, min(concurrency, 10)))
    limiter = RequestStartLimiter(delay)
    by_pin: dict[str, list[TrackingTarget]] = defaultdict(list)
    for target in targets:
        by_pin[target.pinterest_pin_id].append(target)
    representatives = [rows[0] for _, rows in sorted(by_pin.items())]
    if len(representatives) * 2 > request_budget:
        raise RuntimeError(
            f"tracking request budget cannot guarantee one bounded retry for "
            f"{len(representatives)} unique Pins"
        )

    async def fetch_once(target: TrackingTarget, attempt: int) -> TrackingObservation:
        async with semaphore:
            if attempt > 1:
                await asyncio.sleep(min(8.0, 2.0 ** (attempt - 1)))
            await limiter.wait()
            pin_id = target.pinterest_pin_id
            source = f"/pin/{pin_id}/"
            params = {
                "source_url": source,
                "data": json.dumps(
                    {"options": {"id": pin_id, "field_set_key": "grid_item"}, "context": {}},
                    separators=(",", ":"),
                ),
                "_": str(int(time.time() * 1000)),
            }
            headers = {
                "Referer": f"https://www.pinterest.com/pin/{pin_id}/",
                "X-Pinterest-Source-Url": source,
                "X-Pinterest-Pws-Handler": "www/pin/[id].js",
            }
            b3_headers = getattr(session, "_b3_headers", None)
            if callable(b3_headers):
                headers.update(b3_headers())
            csrf = str(getattr(session, "_csrf", "") or "")
            app_version = str(getattr(session, "_app_version", "") or "")
            if csrf:
                headers["X-CSRFToken"] = csrf
            if app_version:
                headers["X-App-Version"] = app_version
            try:
                response = await session._request(
                    "https://www.pinterest.com/resource/PinResource/get/?" + urlencode(params),
                    headers=headers,
                    timeout=float(getattr(session, "_timeout", 30.0)),
                )
            except (asyncio.TimeoutError, TimeoutError):
                return TrackingObservation(
                    target, "provider_error", None, "timeout", attempt, datetime.now(timezone.utc)
                )
            except Exception:
                return TrackingObservation(
                    target, "provider_error", None, "network_error", attempt, datetime.now(timezone.utc)
                )

            status_code = int(getattr(response, "status_code", 0) or 0)
            observed_at = datetime.now(timezone.utc)
            if status_code == 429:
                return TrackingObservation(target, "rate_limited", None, "http_429", attempt, observed_at)
            if status_code == 404:
                # An endpoint-level 404 is not sufficient proof that the Pin is
                # gone; only a successful resource response with data=null is.
                return TrackingObservation(target, "provider_error", None, "http_404", attempt, observed_at)
            if 500 <= status_code <= 599:
                return TrackingObservation(target, "provider_error", None, "http_5xx", attempt, observed_at)
            if status_code != 200:
                return TrackingObservation(target, "provider_error", None, "http_other", attempt, observed_at)
            try:
                payload = response.json()
            except Exception:
                return TrackingObservation(target, "provider_error", None, "parse_error", attempt, observed_at)
            classified = classify_pin_resource(target, payload)
            return replace(
                classified,
                failure_kind=(None if classified.status != "provider_error" else "provider_payload_error"),
                attempts=attempt,
                captured_at=observed_at,
            )

    first = list(await asyncio.gather(*(fetch_once(target, 1) for target in representatives)))
    retryable = {"http_429", "http_5xx", "network_error", "timeout"}
    retry_targets = [item.target for item in first if item.failure_kind in retryable]
    remaining_budget = request_budget - len(first)
    retry_targets = retry_targets[:remaining_budget]
    retries = list(await asyncio.gather(*(fetch_once(target, 2) for target in retry_targets)))
    final_by_pin = {item.target.pinterest_pin_id: item for item in first}
    final_by_pin.update({item.target.pinterest_pin_id: item for item in retries})

    observations = [
        replace(final_by_pin[target.pinterest_pin_id], target=target)
        for target in targets
    ]
    pin_observations = [final_by_pin[target.pinterest_pin_id] for target in representatives]
    failures: dict[str, int] = defaultdict(int)
    for item in [*first, *retries]:
        if item.failure_kind:
            failures[item.failure_kind] += 1
    return TrackingFetchBatch(
        observations=observations,
        pin_observations=pin_observations,
        unique_pins=len(representatives),
        deduped_pins=len(targets) - len(representatives),
        provider_requests_attempted=len(first) + len(retries),
        retries=len(retries),
        attempt_failures=dict(failures),
    )


def _alternative_evidence_sort_key(row: dict) -> tuple:
    """Prefer Product Pins, then recently verified direct Source Pins.

    The selected row is still fetched before switching. This ordering only
    decides which bounded candidate receives that verification request.
    """
    evidence_type = str(row.get("evidence_type") or "")
    relationship = str(row.get("relationship_method") or "")
    last_valid = str(row.get("last_valid_observed_at") or "")
    try:
        last_valid_order = -datetime.fromisoformat(
            last_valid.replace("Z", "+00:00")
        ).timestamp()
    except (TypeError, ValueError):
        last_valid_order = float("inf")
    return (
        0 if evidence_type == "product_pin" else 1,
        0 if relationship == "direct_outbound_link" else 1,
        0 if last_valid else 1,
        last_valid_order,
        str(row.get("created_at") or ""),
        str(row.get("id") or ""),
    )


def _load_switch_candidates(db: object, primary_rows: list[dict]) -> dict[str, dict]:
    failed = [
        row for row in primary_rows
        if int(row.get("consecutive_not_found_days") or 0) >= 3
    ]
    product_ids = sorted({str(row["product_opportunity_id"]) for row in failed})
    if not product_ids:
        return {}
    alternatives: list[dict] = []
    for start in range(0, len(product_ids), 100):
        chunk = product_ids[start : start + 100]
        alternatives.extend(
            db.select_many(
                "product_opportunity_evidence",
                columns=(
                    "id,product_opportunity_id,pinterest_pin_id,evidence_type,"
                    "relationship_method,consecutive_not_found_days,"
                    "last_valid_observed_at,created_at"
                ),
                filters={
                    "product_opportunity_id": f"in.({','.join(chunk)})",
                    "is_primary": "false",
                    "evidence_status": "active",
                },
                order="product_opportunity_id.asc,created_at.asc,id.asc",
            )
        )
    by_product: dict[str, list[dict]] = defaultdict(list)
    for row in alternatives:
        if int(row.get("consecutive_not_found_days") or 0) >= 3:
            continue
        evidence_type = str(row.get("evidence_type") or "")
        relationship = str(row.get("relationship_method") or "")
        # A Source Pin may become Primary only when it independently proves the
        # direct merchant-PDP relationship. This mirrors the database check.
        if evidence_type != "product_pin" and not (
            evidence_type == "source_pin" and relationship == "direct_outbound_link"
        ):
            continue
        by_product[str(row["product_opportunity_id"])].append(row)
    return {
        product_id: sorted(rows, key=_alternative_evidence_sort_key)[0]
        for product_id, rows in by_product.items()
        if rows
    }


def load_targets(limit: int, *, captured_on: date | None = None) -> TrackingInventory:
    from db import DB  # type: ignore

    db = DB()
    products = db.select_many(
        "product_opportunities",
        columns="id",
        filters={"lifecycle_status": "active"},
        order="updated_at.asc,id.asc",
    )
    ids = [str(row["id"]) for row in products]
    if not ids:
        return TrackingInventory([], 0, 0, False)
    evidence: list[dict] = []
    for start in range(0, len(ids), 100):
        chunk = ids[start : start + 100]
        evidence.extend(
            db.select_many(
                "product_opportunity_evidence",
                columns=(
                    "id,product_opportunity_id,pinterest_pin_id,"
                    "consecutive_not_found_days"
                ),
                filters={
                    "product_opportunity_id": f"in.({','.join(chunk)})",
                    "is_primary": "true",
                    "evidence_status": "active",
                },
                order="product_opportunity_id.asc",
            )
        )
    by_product = {str(row["product_opportunity_id"]): row for row in evidence}
    switch_candidates = _load_switch_candidates(db, evidence)
    # Products lacking Primary Evidence are omitted and surfaced in stats; they
    # cannot be measured honestly and must not consume provider requests.
    primary_targets: list[TrackingTarget] = []
    switch_targets: list[TrackingTarget] = []
    pending_switches: list[PendingPrimarySwitch] = []
    for product_id in ids:
        primary = by_product.get(product_id)
        if primary is None:
            continue
        primary_targets.append(
            TrackingTarget(product_id, str(primary["id"]), str(primary["pinterest_pin_id"]))
        )
        candidate = switch_candidates.get(product_id)
        if candidate is None:
            continue
        # The current Primary remains authoritative until the switch transaction
        # succeeds. Keep observing it while one bounded alternative is verified;
        # otherwise a failed alternative would silently create a Primary data gap.
        switch_targets.append(
            TrackingTarget(product_id, str(candidate["id"]), str(candidate["pinterest_pin_id"]))
        )
        pending_switches.append(
            PendingPrimarySwitch(
                product_opportunity_id=product_id,
                old_evidence_id=str(primary["id"]),
                new_evidence_id=str(candidate["id"]),
                new_pinterest_pin_id=str(candidate["pinterest_pin_id"]),
            )
        )
    eligible_targets = [*primary_targets, *switch_targets]
    captured_on = captured_on or datetime.now(timezone.utc).date()
    observed_pin_ids: set[str] = set()
    pin_ids = sorted({target.pinterest_pin_id for target in eligible_targets})
    for start in range(0, len(pin_ids), 100):
        rows = db.select_many(
            "product_evidence_snapshots",
            columns="pinterest_pin_id",
            filters={
                "pinterest_pin_id": f"in.({','.join(pin_ids[start:start + 100])})",
                "captured_on": captured_on.isoformat(),
                "observation_status": "valid",
            },
        )
        observed_pin_ids.update(str(row["pinterest_pin_id"]) for row in rows)
    targets = [target for target in eligible_targets if target.pinterest_pin_id not in observed_pin_ids]
    eligible_unique_pins = len({target.pinterest_pin_id for target in primary_targets})
    due_unique_pins = len({
        target.pinterest_pin_id
        for target in primary_targets
        if target.pinterest_pin_id not in observed_pin_ids
    })
    switch_candidate_pins_due = len({
        target.pinterest_pin_id
        for target in switch_targets
        if target.pinterest_pin_id not in observed_pin_ids
    })
    total_due_request_pins = len({target.pinterest_pin_id for target in targets})
    return TrackingInventory(
        targets=targets,
        active_products_read=len(products),
        missing_primary_evidence=len(products) - len(primary_targets),
        # The reviewed provider budget is per unique Pin request, not per
        # Product Opportunity row. Never truncate the catalog: doing so would
        # silently leave active products untracked when several products share
        # one Primary Pin.
        exceeds_run_budget=total_due_request_pins > limit,
        already_observed_today=sum(
            target.pinterest_pin_id in observed_pin_ids for target in primary_targets
        ),
        eligible_unique_pins=eligible_unique_pins,
        due_unique_pins=due_unique_pins,
        pending_primary_switches=pending_switches,
        switch_candidates_already_valid_today=sum(
            pending.new_pinterest_pin_id in observed_pin_ids for pending in pending_switches
        ),
        already_valid_switch_pin_ids=tuple(sorted(
            {
                pending.new_pinterest_pin_id
                for pending in pending_switches
                if pending.new_pinterest_pin_id in observed_pin_ids
            }
        )),
        total_due_request_pins=total_due_request_pins,
        switch_candidate_pins_due=switch_candidate_pins_due,
    )


def switch_validated_primary_evidence(
    pending: list[PendingPrimarySwitch],
    observations: list[TrackingObservation],
    *,
    already_valid_pin_ids: set[str] | None = None,
) -> tuple[int, int]:
    """Switch only a verified candidate while the old Primary stays missing.

    A three-day not-found streak makes a candidate eligible for verification,
    but the current Primary is deliberately fetched in the same run. If that
    fetch succeeds, switching would discard a recovered Primary and reset its
    metric history for a no-longer-valid evidence-health reason.
    """
    if not pending:
        return 0, 0
    from db import _get_http  # type: ignore
    already_valid_pin_ids = already_valid_pin_ids or set()
    valid_evidence_ids = {
        observation.target.evidence_id
        for observation in observations
        if observation.status == "valid"
    }
    http = _get_http()
    switched = 0
    unverified = 0
    for item in pending:
        if item.old_evidence_id in valid_evidence_ids:
            # The current Primary recovered during candidate verification. Its
            # successful observation resets the database not-found streak, so
            # keep it authoritative and do not manufacture a switch event.
            continue
        if (
            item.new_evidence_id not in valid_evidence_ids
            and item.new_pinterest_pin_id not in already_valid_pin_ids
        ):
            unverified += 1
            continue
        response = http.post(
            "rpc/switch_product_primary_evidence",
            json={
                "p_product_opportunity_id": item.product_opportunity_id,
                "p_new_evidence_id": item.new_evidence_id,
                "p_reason": "primary_not_found_three_natural_days",
            },
        )
        if response.status_code not in (200, 204):
            raise RuntimeError(
                "Primary Evidence switch RPC failed for "
                f"{item.product_opportunity_id} [{response.status_code}]: "
                f"{response.text[:200]}"
            )
        switched += 1
    return switched, unverified


def record_observations(observations: list[TrackingObservation]) -> tuple[int, int]:
    from db import _get_http  # type: ignore

    http = _get_http()
    written = 0
    counter_regressions = 0
    if any(observation.captured_at is None for observation in observations):
        raise RuntimeError("refusing to write an observation without its real capture timestamp")
    # Provider/transport failures remain in the pipeline health report; they
    # are attempts, not Pinterest facts, and must never inflate snapshotWrites.
    persistable = [
        observation for observation in observations
        if observation.status in ("valid", "not_found")
    ]
    payload = [
        {
            "evidence_id": observation.target.evidence_id,
            "captured_on": observation.captured_at.astimezone(timezone.utc).date().isoformat(),
            "captured_at": observation.captured_at.isoformat(),
            "observation_status": observation.status,
            "save_count": observation.save_count,
            "provider_request_id": None,
            "anomaly_reason": observation.failure_kind,
        }
        for observation in persistable
    ]
    for start in range(0, len(payload), 100):
        chunk = payload[start : start + 100]
        response = http.post(
            "rpc/record_product_evidence_observation_batch",
            json={"p_observations": chunk},
        )
        if response.status_code not in (200, 204):
            raise RuntimeError(
                f"observation batch RPC failed at offset {start} "
                f"[{response.status_code}]: {response.text[:200]}"
            )
        body = response.json() if response.status_code == 200 else []
        if not isinstance(body, list) or len(body) != 1:
            raise RuntimeError("observation batch RPC returned an invalid receipt")
        written += int(body[0].get("written") or 0)
        counter_regressions += int(body[0].get("counter_regressions") or 0)
    return written, counter_regressions


def refresh_metrics_after_tracking(now: datetime) -> tuple[int, int, int, int]:
    """Recompute derived metrics inside the same locked tracking run."""
    from product_opportunity_metric_refresh import (
        build_metric_rows,
        load_inputs,
        write_metric_rows,
    )

    # Metrics cover the complete active catalog. The 2,499 limit protects
    # provider requests for unique Pins; metric computation is local/DB work.
    products, evidence, payload = load_inputs(None)
    rows = build_metric_rows(products, evidence, payload, now=now)
    counter_regressions = sum(
        row.get("g30_status") == "counter_regression"
        or row.get("trend_status") == "counter_regression"
        for row in rows
    )
    stale = sum(
        row.get("g30_status") == "stale" or row.get("trend_status") == "stale"
        for row in rows
    )
    return len(rows), write_metric_rows(rows) if rows else 0, counter_regressions, stale


async def run(args: argparse.Namespace) -> dict:
    started_monotonic = time.monotonic()
    captured_at = _utc_now()
    limit = min(max(1, args.limit), MAX_UNIQUE_PINS_PER_RUN)
    project_ref = None
    if args.apply:
        if os.environ.get("VIBEPIN_PRODUCT_TRACKING_MODE") != "production":
            raise RuntimeError("apply refused: VIBEPIN_PRODUCT_TRACKING_MODE must equal production")
        if os.environ.get("VIBEPIN_PRODUCT_TRACKING_CONFIRM") != APPLY_CONFIRM:
            raise RuntimeError(f"apply refused: VIBEPIN_PRODUCT_TRACKING_CONFIRM must equal {APPLY_CONFIRM}")
        from product_opportunity_admission import require_expected_project_ref

        project_ref = require_expected_project_ref(
            os.environ.get(EXPECTED_PROJECT_REF_ENV)
        )
    inventory = load_targets(limit, captured_on=captured_at.date())
    targets = inventory.targets
    report = {
        "mode": "apply" if args.apply else "dry-run",
        "eligiblePins": inventory.eligible_unique_pins,
        "duePins": inventory.due_unique_pins,
        "totalDueRequestPins": inventory.total_due_request_pins,
        "switchCandidatePinsDue": inventory.switch_candidate_pins_due,
        "activeTargets": inventory.active_products_read - inventory.missing_primary_evidence,
        "dueEvidenceTargets": len(targets),
        "eligibleProducts": inventory.active_products_read - inventory.missing_primary_evidence,
        "activeProductsRead": inventory.active_products_read,
        "missingPrimaryEvidence": inventory.missing_primary_evidence,
        "alreadyObservedToday": inventory.already_observed_today,
        "exceedsRunBudget": inventory.exceeds_run_budget,
        "requestBudget": MAX_PROVIDER_REQUESTS,
        "limit": limit,
        "written": 0,
        "snapshotWrites": 0,
        "providerRequestsAttempted": 0,
        "dedupedPins": 0,
        "successfulObservations": 0,
        "notFound": 0,
        "providerErrors": 0,
        "http404": 0,
        "rateLimited429": 0,
        "http5xx": 0,
        "networkFailures": 0,
        "timeouts": 0,
        "retries": 0,
        "counterRegressions": 0,
        "metricComputeFailures": 0,
        "staleActiveEvidence": 0,
        "primarySwitchCandidates": len(inventory.pending_primary_switches),
        "primarySwitchCandidatesAlreadyValidToday": (
            inventory.switch_candidates_already_valid_today
        ),
        "primarySwitches": 0,
        "primarySwitchCandidatesUnverified": 0,
        "providerRunOutcome": "no_due_pins",
        "lockReleased": False,
        "orphanCount": None,
    }
    if project_ref is not None:
        report["projectRef"] = project_ref
    if not args.apply:
        # Dry-run never creates a Pinterest session or child worker.
        report["orphanCount"] = 0
        report["lockReleased"] = True
        report["durationSeconds"] = round(time.monotonic() - started_monotonic, 3)
        return report
    if inventory.exceeds_run_budget:
        raise RuntimeError(
            f"apply refused: due Primary and switch-candidate Pins exceed the reviewed "
            f"{limit}-Pin run budget; "
            "increase the reviewed budget or add deterministic shards"
        )
    if inventory.missing_primary_evidence:
        raise RuntimeError(
            f"apply refused: {inventory.missing_primary_evidence} active products lack Primary Evidence"
        )

    from pipeline_tracking import pipeline_job
    from scraper_v2 import PinterestSession

    with pipeline_job("product-tracking", metadata={"limit": limit}) as job:
        if job.get("skipped"):
            raise RuntimeError("product tracking lock held; scheduled run did not execute")
        # Keep the mutable report attached before provider access so a failed
        # run record retains the measured diagnostics instead of empty metadata.
        job["stats"] = report
        observations: list[TrackingObservation] = []
        if targets:
            async with PinterestSession(delay=0.0) as session:
                fetched = await fetch_observations(
                    session,
                    targets,
                    concurrency=args.concurrency,
                    delay=args.delay,
                )
            observations = fetched.observations
            pin_observations = fetched.pin_observations
            report["providerRequestsAttempted"] = fetched.provider_requests_attempted
            report["dedupedPins"] = fetched.deduped_pins
            report["retries"] = fetched.retries
            report["successfulObservations"] = sum(
                item.status == "valid" for item in pin_observations
            )
            report["notFound"] = sum(item.status == "not_found" for item in pin_observations)
            report["providerErrors"] = sum(
                item.status in ("provider_error", "rate_limited")
                for item in pin_observations
            )
            report["http404"] = fetched.attempt_failures.get("http_404", 0)
            report["rateLimited429"] = fetched.attempt_failures.get("http_429", 0)
            report["http5xx"] = fetched.attempt_failures.get("http_5xx", 0)
            report["networkFailures"] = fetched.attempt_failures.get("network_error", 0)
            report["timeouts"] = fetched.attempt_failures.get("timeout", 0)
            report["providerRunOutcome"] = provider_run_outcome(pin_observations)
            if report["providerRunOutcome"] == "failed_no_confirmed_observation":
                verify_process_cleanup(report)
                report["durationSeconds"] = round(time.monotonic() - started_monotonic, 3)
                raise RuntimeError(
                    "product tracking provider batch failed: due Pins produced no "
                    "confirmed valid or not-found observation"
                )
        require_single_utc_tracking_day(
            captured_at,
            observations,
            checked_at=_utc_now(),
        )
        if observations:
            report["written"], report["counterRegressions"] = record_observations(observations)
            report["snapshotWrites"] = report["written"]
        (
            report["primarySwitches"],
            report["primarySwitchCandidatesUnverified"],
        ) = switch_validated_primary_evidence(
            inventory.pending_primary_switches,
            observations,
            already_valid_pin_ids=set(inventory.already_valid_switch_pin_ids),
        )
        projected_metrics, written_metrics, metric_regressions, stale = refresh_metrics_after_tracking(
            captured_at
        )
        report["metricRowsProjected"] = projected_metrics
        report["metricRowsWritten"] = written_metrics
        report["counterRegressions"] = max(report["counterRegressions"], metric_regressions)
        report["staleActiveEvidence"] = stale
        verify_process_cleanup(report)
        report["durationSeconds"] = round(time.monotonic() - started_monotonic, 3)
        job["stats"] = report
    report["lockReleased"] = True
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--limit", type=int, default=MAX_UNIQUE_PINS_PER_RUN)
    parser.add_argument("--concurrency", type=int, default=5)
    parser.add_argument("--delay", type=float, default=1.2)
    args = parser.parse_args()
    try:
        print(json.dumps(asyncio.run(run(args)), indent=2, sort_keys=True))
        return 0
    except Exception as exc:
        print(f"product tracking failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
