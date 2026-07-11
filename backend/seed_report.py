"""
seed_report.py — Ops/debug reports for the automated trend seed pipeline.

Not exposed in user-facing UI.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from trend_seed_pipeline import (
    P0_CATEGORIES,
    build_job_report,
    cluster_budget_warnings,
    example_outputs,
)


def _db():
    import sys
    from pathlib import Path
    root = Path(__file__).resolve().parent
    sys.path.insert(0, str(root / "db"))
    from db import select_many, select_one  # type: ignore
    return select_many, select_one


FIXTURE_MARKERS = ("e2e-", "fixture-", "test-fixture")

# source_layer values grouped into reporting buckets
_DEGRADED_L3_LAYERS = ("l3_typeahead_degraded",)
_L3_LAYERS = ("L3", "l3_typeahead")
_OFFICIAL_LAYERS = ("official_v5",)


def is_fixture_keyword(keyword: str | None) -> bool:
    kw = (keyword or "").lower()
    return any(m in kw for m in FIXTURE_MARKERS)


def classify_source_bucket(source_layer: str | None, keyword: str | None) -> str:
    """Map a trend_keywords row to one reporting sub-bucket for seed-report separation.

    Sub-buckets are kept distinct: manual_bootstrap and csv_bootstrap are never
    merged into each other, and bootstrap rows are never mixed with official_v5
    or l3_typeahead_degraded.
    """
    if is_fixture_keyword(keyword):
        return "fixture"
    layer = source_layer or "L3"
    if layer in _OFFICIAL_LAYERS:
        return "official_v5"
    if layer == "manual_bootstrap":
        return "manual_bootstrap"
    if layer == "csv_bootstrap":
        return "csv_bootstrap"
    if layer in _DEGRADED_L3_LAYERS:
        return "l3_typeahead_degraded"
    if layer in _L3_LAYERS:
        return "l3_typeahead"
    return "other"


def build_source_separation(rows: list[dict]) -> dict[str, Any]:
    """Count trend_keywords rows by reporting sub-bucket (fixtures included, separated).

    Returns both the distinct sub-buckets and a convenience bootstrapTotal
    (manual_bootstrap + csv_bootstrap) that never folds in official or degraded rows.
    """
    from collections import Counter
    buckets: Counter[str] = Counter()
    for r in rows:
        buckets[classify_source_bucket(r.get("source_layer"), r.get("keyword"))] += 1
    # Always present so consumers can rely on the keys
    for key in (
        "official_v5", "manual_bootstrap", "csv_bootstrap",
        "l3_typeahead_degraded", "l3_typeahead", "fixture", "other",
    ):
        buckets.setdefault(key, 0)
    out = dict(buckets)
    out["bootstrapTotal"] = out["manual_bootstrap"] + out["csv_bootstrap"]
    return out


def query_legacy_queue_report(*, dry_run_backfill: bool = False) -> dict[str, Any]:
    """Separate legacy pending rows (next_crawl_at null) from scheduled seed rows."""
    select_many, _ = _db()
    pending = select_many(
        "crawl_queue",
        filters={"status": "pending"},
        order="priority_score.desc",
        limit=2000,
    )
    legacy: list[dict] = []
    scheduled: list[dict] = []
    backfill_plan: list[dict] = []
    now = datetime.now(tz=timezone.utc)

    for row in pending:
        nca = row.get("next_crawl_at")
        ps = float(row.get("priority_score") or 0)
        entry = {
            "keyword": row.get("keyword"),
            "category": row.get("category"),
            "priority_score": ps,
            "next_crawl_at": nca,
        }
        if not nca:
            legacy.append(entry)
            if dry_run_backfill:
                if ps >= 50:
                    cadence_days = 1
                    pri = "high"
                elif ps >= 20:
                    cadence_days = 3
                    pri = "medium"
                else:
                    cadence_days = 7
                    pri = "unknown"
                proposed = (now + timedelta(days=cadence_days)).isoformat()
                backfill_plan.append({**entry, "proposedPriority": pri, "proposedNextCrawlAt": proposed})
        else:
            scheduled.append(entry)

    return {
        "legacyPendingTotal": len(legacy),
        "scheduledPendingTotal": len(scheduled),
        "legacySample": legacy[:10],
        "scheduledSample": scheduled[:10],
        "backfillDryRun": backfill_plan[:20] if dry_run_backfill else None,
        "backfillDryRunCount": len(backfill_plan) if dry_run_backfill else 0,
    }


def _parse_notes(notes: str | None) -> dict:
    if not notes:
        return {}
    try:
        return json.loads(notes)
    except Exception:
        return {}


def query_queue_verification(*, hours: int = 24, include_test_fixtures: bool = False) -> dict[str, Any]:
    """Post-run crawl_queue + trend_keywords verification from DB."""
    select_many, select_one = _db()
    since = (datetime.now(tz=timezone.utc) - timedelta(hours=hours)).isoformat()

    queue_pending = select_many(
        "crawl_queue",
        filters={"status": "pending"},
        order="priority_score.desc",
        limit=500,
    )
    recent_seeds = select_many(
        "trend_keywords",
        filters={"is_seed": True},
        order="last_updated_at.desc",
        limit=300,
    )

    by_priority: dict[str, int] = {}
    by_category: dict[str, int] = {}
    next_crawl_buckets: dict[str, int] = {"due_now": 0, "within_1d": 0, "within_3d": 0, "within_7d": 0, "later": 0}
    now = datetime.now(tz=timezone.utc)

    for row in queue_pending:
        if not include_test_fixtures and is_fixture_keyword(row.get("keyword")):
            continue
        cat = row.get("category") or "unknown"
        by_category[cat] = by_category.get(cat, 0) + 1
        notes = _parse_notes(row.get("notes")) if isinstance(row.get("notes"), str) else {}
        pri = notes.get("crawlPriority") or "unknown"
        # infer from priority_score if notes missing
        ps = float(row.get("priority_score") or 0)
        if pri == "unknown":
            pri = "high" if ps >= 50 else "medium" if ps >= 20 else "low"
        by_priority[pri] = by_priority.get(pri, 0) + 1

        nca = row.get("next_crawl_at")
        if not nca:
            next_crawl_buckets["due_now"] += 1
            continue
        try:
            dt = datetime.fromisoformat(str(nca).replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            delta = (dt - now).total_seconds() / 86400
            if delta <= 0:
                next_crawl_buckets["due_now"] += 1
            elif delta <= 1:
                next_crawl_buckets["within_1d"] += 1
            elif delta <= 3:
                next_crawl_buckets["within_3d"] += 1
            elif delta <= 7:
                next_crawl_buckets["within_7d"] += 1
            else:
                next_crawl_buckets["later"] += 1
        except Exception:
            next_crawl_buckets["due_now"] += 1

    seed_keyword_set = {r.get("keyword") for r in recent_seeds if r.get("keyword")}

    high_sample = None
    medium_sample = None
    recent_seed_queue: list[dict] = []

    for kw_row in recent_seeds:
        kw = kw_row.get("keyword")
        if not kw or (not include_test_fixtures and is_fixture_keyword(kw)):
            continue
        meta = _parse_notes(kw_row.get("notes"))
        if meta.get("seedDisposition") == "watchlist" or meta.get("crawlPriority") == "watchlist":
            continue
        cq = select_one("crawl_queue", {"keyword": kw})
        if not cq:
            continue
        pri = meta.get("crawlPriority", "unknown")
        recent_seed_queue.append({
            "keyword": kw,
            "category": cq.get("category") or kw_row.get("category"),
            "crawlPriority": pri,
            "refreshCadence": meta.get("refreshCadence"),
            "priority_score": cq.get("priority_score"),
            "next_crawl_at": cq.get("next_crawl_at"),
            "status": cq.get("status"),
        })
        if pri == "high" and high_sample is None:
            high_sample = cq
        if pri == "medium" and medium_sample is None:
            medium_sample = cq

    for row in queue_pending:
        if high_sample and medium_sample:
            break
        kw = row.get("keyword")
        if kw in seed_keyword_set:
            continue
        ps = float(row.get("priority_score") or 0)
        if high_sample is None and ps >= 50:
            high_sample = row
        if medium_sample is None and 20 <= ps < 50:
            medium_sample = row

    watchlist_sample = None
    excluded_sample = None
    for kw_row in recent_seeds:
        if not include_test_fixtures and is_fixture_keyword(kw_row.get("keyword")):
            continue
        meta = _parse_notes(kw_row.get("notes"))
        disp = meta.get("seedDisposition")
        keyword = kw_row.get("keyword")
        if disp == "watchlist" and watchlist_sample is None:
            in_q = select_one("crawl_queue", {"keyword": keyword})
            watchlist_sample = {"trend_keywords": kw_row, "in_crawl_queue": bool(in_q)}
        if meta.get("exclusionReason") and excluded_sample is None:
            excluded_sample = kw_row

    multi_cluster = None
    clusters: dict[str, list[str]] = {}
    for kw_row in recent_seeds:
        if not include_test_fixtures and is_fixture_keyword(kw_row.get("keyword")):
            continue
        meta = _parse_notes(kw_row.get("notes"))
        cid = meta.get("clusterId")
        if cid:
            clusters.setdefault(cid, []).append(kw_row.get("keyword"))
    for cid, kws in clusters.items():
        if len(kws) >= 2:
            multi_cluster = {"clusterId": cid, "keywords": kws}
            break

    return {
        "pendingQueueTotal": len(queue_pending),
        "pendingByCrawlPriority": by_priority,
        "pendingByCategory": by_category,
        "nextCrawlAtDistribution": next_crawl_buckets,
        "sampleHighPriorityQueueRow": high_sample,
        "sampleMediumQueueRow": medium_sample,
        "sampleWatchlistNotInQueue": watchlist_sample,
        "sampleExcludedNotInQueue": excluded_sample,
        "sampleCluster": multi_cluster,
        "recentSeedQueueRows": recent_seed_queue[:10],
    }


def build_seed_report_from_db(*, hours: int = 24, include_test_fixtures: bool = False) -> dict[str, Any]:
    """Build ops report from recent DB state (no live fetch)."""
    select_many, _ = _db()
    since_dt = datetime.now(tz=timezone.utc) - timedelta(hours=hours)

    recent = select_many(
        "trend_keywords",
        filters={"is_seed": True},
        order="last_updated_at.desc",
        limit=500,
    )

    seeds: list[dict] = []
    watchlist: list[dict] = []
    excluded: list[dict] = []
    from collections import Counter

    pri_counter: Counter[str] = Counter()
    cat_counter: Counter[str] = Counter()
    layer_counter: Counter[str] = Counter()

    for row in recent:
        if not include_test_fixtures and is_fixture_keyword(row.get("keyword")):
            continue
        meta = _parse_notes(row.get("notes"))
        updated = row.get("last_updated_at") or row.get("created_at")
        if updated:
            try:
                dt = datetime.fromisoformat(str(updated).replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                if dt < since_dt:
                    continue
            except Exception:
                pass

        entry = {
            "keyword": row.get("keyword"),
            "normalized_category": meta.get("normalizedCategory") or row.get("category"),
            "trend_seed_score": meta.get("trendSeedScore"),
            "crawl_priority": meta.get("crawlPriority"),
            "refresh_cadence": meta.get("refreshCadence"),
            "cluster_id": meta.get("clusterId"),
            "seed_disposition": meta.get("seedDisposition"),
            "trend_source": row.get("source"),
            "source_layer": row.get("source_layer"),
        }
        disp = meta.get("seedDisposition", "accepted")
        if disp == "watchlist":
            watchlist.append(entry)
        elif meta.get("exclusionReason"):
            excluded.append({"keyword": row.get("keyword"), "reason": meta.get("exclusionReason")})
        else:
            seeds.append(entry)
            pri_counter[meta.get("crawlPriority", "unknown")] += 1
        cat_counter[entry["normalized_category"] or "unknown"] += 1
        layer_counter[row.get("source_layer") or "L3"] += 1

    examples = example_outputs()
    queue_verify = query_queue_verification(hours=hours, include_test_fixtures=include_test_fixtures)
    legacy_queue = query_legacy_queue_report(dry_run_backfill=True)
    # Source separation is computed over ALL recent rows (fixtures included but
    # bucketed separately) so manual_bootstrap / degraded-L3 / official_v5 /
    # fixture rows are never conflated.
    source_separation = build_source_separation(recent)

    return {
        "jobTimestamp": datetime.now(tz=timezone.utc).isoformat(),
        "reportSource": "database",
        "lookbackHours": hours,
        "includeTestFixtures": include_test_fixtures,
        "seedsFetched": len(seeds) + len(watchlist) + len(excluded),
        "seedsScored": len(seeds) + len(watchlist),
        "highCount": pri_counter.get("high", 0),
        "mediumCount": pri_counter.get("medium", 0),
        "lowCount": pri_counter.get("low", 0),
        "watchlistCount": len(watchlist),
        "excludedCount": len(excluded),
        "clustersCreated": len({s.get("cluster_id") for s in seeds + watchlist if s.get("cluster_id")}),
        "byCategory": dict(cat_counter),
        "bySourceLayer": dict(layer_counter),
        "sourceSeparation": source_separation,
        "p0CategoriesPresent": sorted(set(cat_counter) & P0_CATEGORIES),
        "p0CategoriesMissing": sorted(P0_CATEGORIES - set(cat_counter)),
        "clusterBudgetWarnings": cluster_budget_warnings(seeds),
        "examples": examples,
        "queueVerification": queue_verify,
        "legacyQueueReport": legacy_queue,
    }


def format_report_markdown(report: dict[str, Any]) -> str:
    lines = [
        f"# Trend Seed Report",
        f"",
        f"- **Timestamp:** {report.get('jobTimestamp')}",
        f"- **Source:** {report.get('reportSource', 'live')}",
        f"- **Seeds scored:** {report.get('seedsScored')}",
        f"- **High / Medium / Low / Watchlist / Excluded:** "
        f"{report.get('highCount')} / {report.get('mediumCount')} / {report.get('lowCount')} / "
        f"{report.get('watchlistCount')} / {report.get('excludedCount')}",
        f"- **Queue entries created:** {report.get('crawlQueueEntriesCreated', 'n/a')}",
        f"",
        f"## By category",
        f"```json",
        json.dumps(report.get("byCategory", {}), indent=2),
        f"```",
    ]
    warnings = report.get("clusterBudgetWarnings") or []
    if warnings:
        lines.extend(["", "## Cluster budget warnings", "```json", json.dumps(warnings, indent=2), "```"])
    qv = report.get("queueVerification")
    if qv:
        lines.extend(["", "## Queue verification", "```json", json.dumps(qv, indent=2)[:4000], "```"])
    return "\n".join(lines)
