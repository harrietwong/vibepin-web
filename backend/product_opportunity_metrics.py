"""Pure Product Opportunities metric model.

Only cumulative saves from one persisted Primary Evidence Pin are accepted. The
module does not read keywords, scores, prices, reviews, or other products, so the
old percentile/keyword metric model cannot leak into v1 calculations.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Iterable, Literal


MetricStatus = Literal[
    "valid",
    "insufficient_history",
    "insufficient_activity",
    "counter_regression",
    "stale",
]
MomentumDirection = Literal["rising", "steady", "cooling"]
ObservationStatus = Literal["valid", "counter_regression"]


@dataclass(frozen=True)
class Observation:
    evidence_id: str
    captured_at: datetime
    save_count: int
    status: ObservationStatus = "valid"

    def __post_init__(self) -> None:
        if self.save_count < 0:
            raise ValueError("save_count must be non-negative")
        if self.captured_at.tzinfo is None:
            raise ValueError("captured_at must be timezone-aware")
        if self.status not in ("valid", "counter_regression"):
            raise ValueError("unsupported observation status")

    @property
    def captured_on(self) -> date:
        return self.captured_at.astimezone(timezone.utc).date()


@dataclass(frozen=True)
class MetricPolicy:
    anchor_7_tolerance_days: int = 1
    anchor_14_tolerance_days: int = 1
    anchor_30_tolerance_days: int = 3
    max_latest_age_days: int = 2
    minimum_valid_observations_14d: int = 10
    minimum_valid_observations_30d: int = 20
    maximum_history_gap_days: int = 3
    minimum_14d_activity: int = 20
    minimum_absolute_delta: int = 5
    relative_change_boundary_percent: float = 20.0

    def __post_init__(self) -> None:
        # These are truthfulness gates, not optional tuning knobs. Zero would
        # allow a zero-volume or one-save change to become a published momentum
        # conclusion, contradicting the PRD's low-activity fail-closed rule.
        if self.minimum_14d_activity <= 0:
            raise ValueError("minimum_14d_activity must be positive")
        if self.minimum_absolute_delta <= 0:
            raise ValueError("minimum_absolute_delta must be positive")
        if self.relative_change_boundary_percent <= 0:
            raise ValueError("relative_change_boundary_percent must be positive")


@dataclass(frozen=True)
class ProductMetrics:
    evidence_id: str
    g30_status: MetricStatus
    trend_status: MetricStatus
    latest_save_count: int | None
    latest_snapshot_at: datetime | None
    g30_saves_gained: int | None
    g30_anchor_at: datetime | None
    g30_actual_days: int | None
    current_g7_gained: int | None
    current_g7_anchor_at: datetime | None
    current_g7_actual_days: int | None
    previous_g7_gained: int | None
    previous_g7_anchor_at: datetime | None
    previous_g7_actual_days: int | None
    momentum_percent: float | None
    momentum_direction: MomentumDirection | None


def _empty(evidence_id: str, status: MetricStatus) -> ProductMetrics:
    return ProductMetrics(
        evidence_id=evidence_id,
        g30_status=status,
        trend_status=status,
        latest_save_count=None,
        latest_snapshot_at=None,
        g30_saves_gained=None,
        g30_anchor_at=None,
        g30_actual_days=None,
        current_g7_gained=None,
        current_g7_anchor_at=None,
        current_g7_actual_days=None,
        previous_g7_gained=None,
        previous_g7_anchor_at=None,
        previous_g7_actual_days=None,
        momentum_percent=None,
        momentum_direction=None,
    )


def _canonical_daily(observations: Iterable[Observation]) -> list[Observation]:
    """Keep the latest valid observation for each UTC day, deterministically."""
    by_day: dict[date, Observation] = {}
    for item in observations:
        current = by_day.get(item.captured_on)
        if current is None or item.captured_at > current.captured_at:
            by_day[item.captured_on] = item
    return sorted(by_day.values(), key=lambda item: item.captured_at)


def _anchor(
    observations: list[Observation],
    latest: Observation,
    target_days: int,
    tolerance_days: int,
) -> Observation | None:
    candidates = []
    for item in observations:
        if item.captured_at >= latest.captured_at:
            continue
        actual_days = (latest.captured_on - item.captured_on).days
        distance = abs(actual_days - target_days)
        if distance <= tolerance_days:
            # Prefer closest day, then the earlier observation on a tie. This
            # prevents a rerun from moving an anchor forward unpredictably.
            candidates.append((distance, item.captured_at, item))
    if not candidates:
        return None
    candidates.sort(key=lambda value: (value[0], value[1]))
    return candidates[0][2]


def _last_regression_index(observations: list[Observation]) -> int | None:
    """Find the latest explicit or numeric counter reset."""
    latest: int | None = None
    for index, item in enumerate(observations):
        if item.status == "counter_regression":
            latest = index
        if index and item.save_count < observations[index - 1].save_count:
            latest = index
    return latest


def _window_is_complete(
    observations: list[Observation],
    anchor: Observation,
    latest: Observation,
    *,
    minimum_observations: int,
    maximum_gap_days: int,
) -> bool:
    window = [item for item in observations if anchor.captured_on <= item.captured_on <= latest.captured_on]
    if len(window) < minimum_observations:
        return False
    return all(
        (later.captured_on - earlier.captured_on).days <= maximum_gap_days
        for earlier, later in zip(window, window[1:])
    )


def calculate_product_metrics(
    evidence_id: str,
    observations: Iterable[Observation],
    *,
    now: datetime,
    policy: MetricPolicy = MetricPolicy(),
) -> ProductMetrics:
    """Calculate G30 and current-vs-previous G7 for one Primary Evidence.

    Mixed evidence histories fail closed. A Primary Evidence switch therefore
    cannot splice two Pins into one trend line.
    """
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")

    supplied = list(observations)
    if any(item.evidence_id != evidence_id for item in supplied):
        raise ValueError("observations must belong to exactly one evidence_id")
    all_daily = _canonical_daily(supplied)
    if not all_daily:
        return _empty(evidence_id, "insufficient_history")

    regression_index = _last_regression_index(all_daily)
    if regression_index is not None:
        if regression_index == len(all_daily) - 1:
            previous_valid = next(
                (item for item in reversed(all_daily[:regression_index]) if item.status == "valid"),
                None,
            )
            result = _empty(evidence_id, "counter_regression")
            return ProductMetrics(
                **{
                    **result.__dict__,
                    "latest_save_count": previous_valid.save_count if previous_valid else None,
                    "latest_snapshot_at": previous_valid.captured_at if previous_valid else None,
                }
            )
        # Raw history remains stored; metrics deliberately start a new baseline
        # after the latest reset so two counter regimes can never be spliced.
        all_daily = all_daily[regression_index + 1 :]

    daily = [item for item in all_daily if item.status == "valid"]
    if not daily:
        return _empty(evidence_id, "insufficient_history")
    latest = daily[-1]
    latest_age = (now.astimezone(timezone.utc).date() - latest.captured_on).days
    if latest_age > policy.max_latest_age_days:
        result = _empty(evidence_id, "stale")
        return ProductMetrics(**{**result.__dict__, "latest_save_count": latest.save_count,
                                 "latest_snapshot_at": latest.captured_at})
    a7 = _anchor(daily, latest, 7, policy.anchor_7_tolerance_days)
    a14 = _anchor(daily, latest, 14, policy.anchor_14_tolerance_days)
    a30 = _anchor(daily, latest, 30, policy.anchor_30_tolerance_days)

    g30_ready = a30 is not None and _window_is_complete(
        daily,
        a30,
        latest,
        minimum_observations=policy.minimum_valid_observations_30d,
        maximum_gap_days=policy.maximum_history_gap_days,
    )
    g30_status: MetricStatus = "valid" if g30_ready else "insufficient_history"
    g30 = latest.save_count - a30.save_count if g30_ready and a30 is not None else None

    trend_status: MetricStatus = "valid"
    direction: MomentumDirection | None = None
    percent: float | None = None
    current_g7: int | None = None
    previous_g7: int | None = None
    trend_history_ready = a7 is not None and a14 is not None and _window_is_complete(
        daily,
        a14,
        latest,
        minimum_observations=policy.minimum_valid_observations_14d,
        maximum_gap_days=policy.maximum_history_gap_days,
    )
    if not trend_history_ready:
        trend_status = "insufficient_history"
    else:
        current_g7 = latest.save_count - a7.save_count
        previous_g7 = a7.save_count - a14.save_count
        activity_14d = current_g7 + previous_g7
        delta = current_g7 - previous_g7
        if activity_14d < policy.minimum_14d_activity or abs(delta) < policy.minimum_absolute_delta:
            trend_status = "insufficient_activity"
        else:
            denominator = max(previous_g7, policy.minimum_14d_activity)
            percent = round(delta / denominator * 100.0, 1)
            if percent >= policy.relative_change_boundary_percent:
                direction = "rising"
            elif percent <= -policy.relative_change_boundary_percent:
                direction = "cooling"
            else:
                direction = "steady"

    return ProductMetrics(
        evidence_id=evidence_id,
        g30_status=g30_status,
        trend_status=trend_status,
        latest_save_count=latest.save_count,
        latest_snapshot_at=latest.captured_at,
        g30_saves_gained=g30,
        g30_anchor_at=a30.captured_at if g30_ready and a30 else None,
        g30_actual_days=(latest.captured_on - a30.captured_on).days if g30_ready and a30 else None,
        current_g7_gained=current_g7,
        current_g7_anchor_at=a7.captured_at if a7 else None,
        current_g7_actual_days=(latest.captured_on - a7.captured_on).days if a7 else None,
        previous_g7_gained=previous_g7,
        previous_g7_anchor_at=a14.captured_at if a14 else None,
        previous_g7_actual_days=(a7.captured_on - a14.captured_on).days if a7 and a14 else None,
        momentum_percent=percent,
        momentum_direction=direction,
    )
