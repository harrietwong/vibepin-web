#!/usr/bin/env python3
"""Read-only Product Opportunities v3.7 production data audit.

No mutation helper is imported or called. The report estimates migration-ready
products and snapshot coverage; it does not activate products or claim that a
non-Pinterest image URL is merchant-proven without a later evidence backfill.
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "db"))

from product_opportunity_admission import SOURCE_CATEGORY_FAMILIES


PRODUCT_COLUMNS = ",".join(
    [
        "id",
        "product_name",
        "source_url",
        "canonical_product_url",
        "normalized_product_url_hash",
        "product_url_hash",
        "image_url",
        "domain",
        "product_type",
        "source_category",
        "seed_keyword",
        "parent_pin_id",
        "product_pin_id",
        "source_pin_url",
        "source_pin_save_count",
        "discovery_method",
        "detail_fetch_status",
        "lifecycle_status",
        "created_at",
        "scraped_at",
    ]
)

COVERAGE_KEYS = (
    "today",
    "anchor_7",
    "anchor_14",
    "anchor_30",
    "full_metric",
    "counter_regression",
)
OBSERVATION_DAY_BUCKETS = ("0", "1-9", "10-19", "20-29", "30+")
MAXIMUM_GAP_BUCKETS = ("0-1", "2-3", "4-7", "8+")


def _complete_counts(counts: Counter[str], keys: tuple[str, ...]) -> dict[str, int]:
    """Keep audited zeroes explicit so absence cannot be mistaken for unmeasured."""
    return {key: int(counts.get(key, 0)) for key in keys}


def _host(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        return ""
    try:
        return (urlparse(value).hostname or "").lower().rstrip(".")
    except ValueError:
        return ""


def _is_pinterest_host(host: str) -> bool:
    return host == "pinterest.com" or host.endswith(".pinterest.com") or host == "pinimg.com" or host.endswith(".pinimg.com")


def product_gate_reasons(row: dict) -> list[str]:
    reasons: list[str] = []
    if row.get("lifecycle_status") == "retired":
        reasons.append("retired")
    product_host = _host(row.get("canonical_product_url") or row.get("source_url"))
    if not product_host or _is_pinterest_host(product_host):
        reasons.append("no_real_product_url")
    image_host = _host(row.get("image_url"))
    if not image_host:
        reasons.append("no_product_image")
    elif _is_pinterest_host(image_host):
        reasons.append("pinterest_hosted_image")
    pin_id = str(row.get("product_pin_id") or row.get("parent_pin_id") or "")
    if not pin_id.isdigit() or len(pin_id) <= 10:
        reasons.append("no_auditable_pin")
    family = row.get("product_type")
    if family not in ("physical", "digital"):
        reasons.append("unknown_product_family")
    return reasons


def _parse_day(value: object) -> date | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def summarize(products: list[dict], snapshots: list[dict], *, today: date) -> dict:
    rejected = Counter()
    eligible: list[dict] = []
    identities: Counter[str] = Counter()
    by_family = Counter()
    name_missing = Counter()
    evidence_type = Counter()
    domains = Counter()
    discovery_methods = Counter()
    detail_statuses = Counter()
    categories = Counter()
    automatic_scope: list[dict] = []
    automatic_identities: Counter[str] = Counter()
    automatic_by_family = Counter()
    automatic_by_category = Counter()
    automatic_scope_exclusions = Counter()
    technical_by_category_family: dict[str, Counter] = defaultdict(Counter)
    automatic_scope_exclusions_by_category: dict[str, Counter] = defaultdict(Counter)
    for row in products:
        reasons = product_gate_reasons(row)
        if reasons:
            rejected.update(set(reasons))
            continue
        eligible.append(row)
        family = str(row["product_type"])
        by_family[family] += 1
        if not str(row.get("product_name") or "").strip():
            name_missing[family] += 1
        identity = str(
            row.get("normalized_product_url_hash")
            or row.get("product_url_hash")
            or row.get("canonical_product_url")
            or row.get("source_url")
        )
        identities[identity] += 1
        evidence_type["product_pin" if row.get("product_pin_id") else "source_pin"] += 1
        domains[_host(row.get("canonical_product_url") or row.get("source_url")) or "unknown"] += 1
        discovery_methods[str(row.get("discovery_method") or "unknown")] += 1
        detail_statuses[str(row.get("detail_fetch_status") or "legacy_unknown")] += 1
        source_category = str(row.get("source_category") or "unknown")
        categories[source_category] += 1
        technical_by_category_family[source_category][family] += 1
        expected_families = SOURCE_CATEGORY_FAMILIES.get(source_category)
        if expected_families is None:
            automatic_scope_exclusions["source_category_not_reviewed"] += 1
            automatic_scope_exclusions_by_category["source_category_not_reviewed"][source_category] += 1
        elif family not in expected_families:
            automatic_scope_exclusions["category_family_mismatch"] += 1
            automatic_scope_exclusions_by_category["category_family_mismatch"][source_category] += 1
        else:
            automatic_scope.append(row)
            automatic_identities[identity] += 1
            automatic_by_family[family] += 1
            automatic_by_category[source_category] += 1

    pin_observations: dict[str, dict[date, int]] = defaultdict(dict)
    for snap in snapshots:
        pin_id = str(snap.get("pin_id") or "")
        day = _parse_day(snap.get("captured_on"))
        if pin_id and day and snap.get("save_count") is not None:
            pin_observations[pin_id][day] = int(snap["save_count"])

    coverage = Counter()
    family_coverage: dict[str, Counter] = defaultdict(Counter)
    automatic_coverage = Counter()
    automatic_family_coverage: dict[str, Counter] = defaultdict(Counter)
    automatic_row_ids = {str(row.get("id")) for row in automatic_scope}
    observation_day_distribution = Counter()
    maximum_gap_distribution = Counter()
    for row in eligible:
        pin_id = str(row.get("product_pin_id") or row.get("parent_pin_id") or "")
        observations = pin_observations.get(pin_id, {})
        days = set(observations)
        ordered_days = sorted(days)
        family = str(row["product_type"])
        in_automatic_scope = str(row.get("id")) in automatic_row_ids
        day_count = len(days)
        observation_day_distribution[
            "0" if day_count == 0 else "1-9" if day_count < 10 else "10-19" if day_count < 20 else "20-29" if day_count < 30 else "30+"
        ] += 1
        max_gap = max(
            ((later - earlier).days for earlier, later in zip(ordered_days, ordered_days[1:])),
            default=0,
        )
        maximum_gap_distribution[
            "0-1" if max_gap <= 1 else "2-3" if max_gap <= 3 else "4-7" if max_gap <= 7 else "8+"
        ] += 1
        if any(
            observations[later] < observations[earlier]
            for earlier, later in zip(ordered_days, ordered_days[1:])
        ):
            coverage["counter_regression"] += 1
            family_coverage[family]["counter_regression"] += 1
            if in_automatic_scope:
                automatic_coverage["counter_regression"] += 1
                automatic_family_coverage[family]["counter_regression"] += 1
        if today in days:
            coverage["today"] += 1
            family_coverage[family]["today"] += 1
            if in_automatic_scope:
                automatic_coverage["today"] += 1
                automatic_family_coverage[family]["today"] += 1
        if any(today - timedelta(days=8) <= day <= today - timedelta(days=6) for day in days):
            coverage["anchor_7"] += 1
            family_coverage[family]["anchor_7"] += 1
            if in_automatic_scope:
                automatic_coverage["anchor_7"] += 1
                automatic_family_coverage[family]["anchor_7"] += 1
        if any(today - timedelta(days=15) <= day <= today - timedelta(days=13) for day in days):
            coverage["anchor_14"] += 1
            family_coverage[family]["anchor_14"] += 1
            if in_automatic_scope:
                automatic_coverage["anchor_14"] += 1
                automatic_family_coverage[family]["anchor_14"] += 1
        if any(today - timedelta(days=33) <= day <= today - timedelta(days=27) for day in days):
            coverage["anchor_30"] += 1
            family_coverage[family]["anchor_30"] += 1
            if in_automatic_scope:
                automatic_coverage["anchor_30"] += 1
                automatic_family_coverage[family]["anchor_30"] += 1
        has_anchors = (
            today in days
            and any(today - timedelta(days=8) <= day <= today - timedelta(days=6) for day in days)
            and any(today - timedelta(days=15) <= day <= today - timedelta(days=13) for day in days)
            and any(today - timedelta(days=33) <= day <= today - timedelta(days=27) for day in days)
        )
        days_14 = sorted(day for day in days if today - timedelta(days=15) <= day <= today)
        days_30 = sorted(day for day in days if today - timedelta(days=33) <= day <= today)
        gaps_ok_14 = all((later - earlier).days <= 3 for earlier, later in zip(days_14, days_14[1:]))
        gaps_ok_30 = all((later - earlier).days <= 3 for earlier, later in zip(days_30, days_30[1:]))
        if has_anchors and len(days_14) >= 10 and len(days_30) >= 20 and gaps_ok_14 and gaps_ok_30:
            coverage["full_metric"] += 1
            family_coverage[family]["full_metric"] += 1
            if in_automatic_scope:
                automatic_coverage["full_metric"] += 1
                automatic_family_coverage[family]["full_metric"] += 1

    duplicate_rows = sum(count - 1 for count in identities.values() if count > 1)
    return {
        "audited_at": datetime.now(timezone.utc).isoformat(),
        "total_pin_product_rows": len(products),
        "migration_gate_pass_rows": len(eligible),
        "migration_gate_pass_unique_products": len(identities),
        "duplicate_eligible_rows": duplicate_rows,
        "eligible_by_family": dict(by_family),
        "eligible_without_name_by_family": dict(name_missing),
        "eligible_primary_evidence_kind": dict(evidence_type),
        "eligible_top_domains": dict(domains.most_common(20)),
        "eligible_categories": dict(categories.most_common(20)),
        "migration_gate_by_source_category_family": {
            category: dict(technical_by_category_family[category])
            for category in sorted(technical_by_category_family)
        },
        "automatic_admission_scope_rows": len(automatic_scope),
        "automatic_admission_scope_unique_products": len(automatic_identities),
        "automatic_admission_scope_by_family": dict(automatic_by_family),
        "automatic_admission_scope_by_category": dict(automatic_by_category),
        "automatic_admission_scope_exclusions": dict(automatic_scope_exclusions),
        "automatic_admission_scope_exclusions_by_category": {
            reason: dict(automatic_scope_exclusions_by_category[reason].most_common())
            for reason in sorted(automatic_scope_exclusions_by_category)
        },
        "eligible_discovery_methods": dict(discovery_methods),
        "eligible_detail_fetch_status": dict(detail_statuses),
        "rejection_reasons_nonexclusive": dict(rejected),
        "legacy_snapshot_rows": len(snapshots),
        "eligible_snapshot_coverage": _complete_counts(coverage, COVERAGE_KEYS),
        "observation_day_distribution": _complete_counts(
            observation_day_distribution, OBSERVATION_DAY_BUCKETS
        ),
        "maximum_gap_distribution": _complete_counts(
            maximum_gap_distribution, MAXIMUM_GAP_BUCKETS
        ),
        "eligible_snapshot_coverage_by_family": {
            family: _complete_counts(family_coverage[family], COVERAGE_KEYS)
            for family in sorted(by_family)
        },
        "automatic_admission_scope_snapshot_coverage": _complete_counts(
            automatic_coverage, COVERAGE_KEYS
        ),
        "automatic_admission_scope_snapshot_coverage_by_family": {
            family: _complete_counts(automatic_family_coverage[family], COVERAGE_KEYS)
            for family in sorted(automatic_by_family)
        },
        "important_limit": (
            "A non-Pinterest image host is only a migration candidate, not proof of merchant image provenance. "
            "Rows must pass evidence backfill before activation."
        ),
    }


def main() -> int:
    if not os.environ.get("SUPABASE_URL") or not os.environ.get("SUPABASE_SERVICE_ROLE_KEY"):
        print("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY", file=sys.stderr)
        return 1
    from db import DB  # type: ignore

    db = DB()
    products = db.select_many("pin_products", columns=PRODUCT_COLUMNS, order="created_at.asc,id.asc")
    snapshots = db.select_many(
        "pin_save_snapshots",
        columns="pin_id,captured_on,save_count",
        order="captured_on.asc,pin_id.asc",
    )
    print(json.dumps(summarize(products, snapshots, today=datetime.now(timezone.utc).date()), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
