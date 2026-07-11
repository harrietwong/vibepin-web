"""
trend_seed_pipeline.py — Automated trend seed scoring, clustering, and crawl queue planning.

Extends trend_fetcher (does not replace it). CSV import remains bootstrap-only via
db/import_trend_keywords.py.

Flow:
  raw keywords → normalize category → negative filter → commercial filter
  → TrendSeedScore → crawlPriority / refreshCadence → cluster → queue eligibility
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from content_filters import evaluate_pin_content, get_filter_stats, reset_filter_stats

# Re-use commercial thresholds from trend_fetcher (import lazily in tests to avoid cycles)
MIN_YOY_GROWTH = 100.0
MIN_WEEKLY_CHANGE = 0.0
MIN_VOLUME_SCORE = 2

SOURCE_LAYER_SCORE = {
    "pinterest_trends_v5": 20,
    "pinterest_trends_api": 15,
    "internal_resource": 8,
    "typeahead_estimate": 3,
    # Human-curated bootstrap seeds. The floor (22) means ONLY "a human approved
    # this keyword for crawling" (= crawl eligibility). It is NOT trend strength,
    # search volume, growth, official demand, or any Pinterest signal. With all
    # metric fields blank a curated seed lands at the "low" tier (>=22) → weekly
    # cadence → crawl_queue eligible. It never fabricates growth/volume; real
    # numeric volume / growth (when supplied) raise it via the same scoring path.
    "manual_bootstrap": 22,
    "csv_bootstrap": 22,
}

COMMERCIAL_BONUS_TOKENS = (
    "outfit", "nails", "decor", "ideas", "aesthetic", "styling",
    "vintage", "cozy", "boho", "minimal", "printable", "template",
)

# Map interest slugs + legacy short labels → canonical category ids (matches web CATEGORIES)
CATEGORY_ALIASES: dict[str, str] = {
    "home": "home-decor",
    "home_decor": "home-decor",
    "home-decor": "home-decor",
    "womens_fashion": "womens-fashion",
    "mens_fashion": "mens-fashion",
    "childrens_fashion": "kids-fashion",
    "food": "food-and-drink",
    "food_and_drinks": "food-and-drink",
    "diy": "diy-crafts",
    "diy_and_crafts": "diy-crafts",
    "sport": "sports",
    "event_planning": "event-planning",
    "holidays": "holidays-seasonal",
}

REFRESH_CADENCE_DAYS: dict[str, int | None] = {
    "daily": 1,
    "every_3_days": 3,
    "3d": 3,
    "weekly": 7,
    "14d": 14,
    "monthly": 30,
    "paused": None,
    "none": None,
}

# P0 categories expected in production seed runs
P0_CATEGORIES = frozenset({
    "fashion", "womens-fashion", "home-decor", "beauty", "digital-products",
})

DAILY_CRAWL_BUDGET_DEFAULT = 80
CLUSTER_BUDGET_SHARE_CAP = 0.25

SEED_LAST_STATS: dict[str, int] = {
    "raw": 0,
    "accepted": 0,
    "watchlist": 0,
    "excluded": 0,
    "negative_filtered": 0,
    "commercial_filtered": 0,
    "clusters": 0,
    "queue_eligible": 0,
}

WATCHLIST_LAST: list[dict] = []
EXCLUDED_LAST: list[dict] = []
LAST_PROCESS_RESULT: ProcessResult | None = None

# Accumulated across one trends job run (reset via reset_run_accumulator)
SEED_RUN_ACCUMULATOR: dict[str, Any] = {
    "interests": [],
    "seeds": [],
    "watchlist": [],
    "excluded": [],
    "clusters": {},
    "queue_stats": {"inserted": 0, "updated_pending": 0, "requeued": 0, "skipped": 0, "written": 0},
    "errors": [],
}


@dataclass
class TrendSeed:
    keyword: str
    normalized_category: str
    trend_seed_score: float
    crawl_priority: str  # high | medium | low | watchlist | excluded
    refresh_cadence: str  # daily | every_3_days | weekly | monthly | paused
    cluster_id: str | None = None
    seed_disposition: str = "accepted"  # accepted | watchlist | excluded
    exclusion_reason: str | None = None
    crawl_queue_eligible: bool = True
    priority_score: float = 0.0
    raw: dict = field(default_factory=dict)

    def to_keyword_dict(self) -> dict:
        """Merge seed metadata back into trend_fetcher keyword dict."""
        out = dict(self.raw)
        out.update({
            "keyword": self.keyword,
            "normalized_category": self.normalized_category,
            "category": self.normalized_category,
            "trend_seed_score": self.trend_seed_score,
            "crawl_priority": self.crawl_priority,
            "refresh_cadence": self.refresh_cadence,
            "cluster_id": self.cluster_id,
            "seed_disposition": self.seed_disposition,
            "crawl_queue_eligible": self.crawl_queue_eligible,
            "priority_score": self.priority_score,
            "exclusion_reason": self.exclusion_reason,
        })
        return out


@dataclass
class ProcessResult:
    seeds: list[dict]
    watchlist: list[dict]
    excluded: list[dict]
    clusters: dict[str, list[str]]
    stats: dict[str, int]


def normalize_category(category: str | None, interest_slug: str | None = None) -> str:
    """Canonical category id for DB + UI (e.g. home-decor, fashion)."""
    slug = (interest_slug or "").strip().lower()
    cat = (category or "").strip().lower().replace("_", "-")

    try:
        from interest_discovery import slug_to_category  # type: ignore
        if slug:
            cat = slug_to_category(slug)
    except ImportError:
        pass

    cat = cat.replace("_", "-")
    return CATEGORY_ALIASES.get(cat, cat)


def _tokenize(keyword: str) -> list[str]:
    stop = frozenset({
        "the", "and", "for", "with", "from", "your", "that", "this", "are", "was",
    })
    tokens = re.findall(r"[a-z0-9]+", keyword.lower())
    return [t for t in tokens if len(t) > 2 and t not in stop]


def reset_run_accumulator() -> None:
    """Clear per-job accumulator before a trends run."""
    SEED_RUN_ACCUMULATOR.clear()
    SEED_RUN_ACCUMULATOR.update({
        "interests": [],
        "seeds": [],
        "watchlist": [],
        "excluded": [],
        "clusters": {},
        "queue_stats": {"inserted": 0, "updated_pending": 0, "requeued": 0, "skipped": 0, "written": 0},
        "errors": [],
    })


def next_crawl_at_from_cadence(now, cadence: str) -> str | None:
    """Map refreshCadence → next_crawl_at ISO timestamp. paused → None."""
    from datetime import datetime, timedelta, timezone
    if isinstance(now, str):
        now = datetime.fromisoformat(now.replace("Z", "+00:00"))
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    days = REFRESH_CADENCE_DAYS.get(cadence)
    if days is None:
        return None
    return (now + timedelta(days=days)).isoformat()


def record_interest_result(
    *,
    interest_slug: str,
    category: str,
    result: ProcessResult,
    queue_stats: dict[str, int] | None = None,
    error: str | None = None,
) -> None:
    """Append one interest's seed pipeline output to the job accumulator."""
    if error:
        SEED_RUN_ACCUMULATOR["errors"].append({"interest": interest_slug, "error": error})
    SEED_RUN_ACCUMULATOR["interests"].append(interest_slug)
    SEED_RUN_ACCUMULATOR["seeds"].extend(result.seeds)
    SEED_RUN_ACCUMULATOR["watchlist"].extend(result.watchlist)
    SEED_RUN_ACCUMULATOR["excluded"].extend(result.excluded)
    for cid, kws in result.clusters.items():
        SEED_RUN_ACCUMULATOR["clusters"].setdefault(cid, []).extend(kws)
    if queue_stats:
        for k, v in queue_stats.items():
            SEED_RUN_ACCUMULATOR["queue_stats"][k] = (
                SEED_RUN_ACCUMULATOR["queue_stats"].get(k, 0) + int(v or 0)
            )


def cluster_budget_warnings(
    seeds: list[dict],
    *,
    daily_budget: int = DAILY_CRAWL_BUDGET_DEFAULT,
    cap: float = CLUSTER_BUDGET_SHARE_CAP,
) -> list[dict]:
    """Warn when one cluster root consumes > cap of daily crawl budget per category."""
    from collections import Counter, defaultdict

    by_cat: dict[str, Counter[str]] = defaultdict(Counter)
    for s in seeds:
        cat = s.get("normalized_category") or s.get("category") or "unknown"
        cid = s.get("cluster_id") or "misc"
        by_cat[cat][cid] += 1

    warnings: list[dict] = []
    for cat, clusters in by_cat.items():
        for cid, count in clusters.items():
            share = count / max(daily_budget, 1)
            if share > cap:
                root = cid.split("-")[0] if cid else "misc"
                warnings.append({
                    "rootKeyword": root,
                    "clusterId": cid,
                    "category": cat,
                    "budgetShare": round(share, 3),
                    "seedCount": count,
                    "warning": "root family exceeds 25%",
                })
    return warnings


def build_job_report(
    *,
    crawl_queue_entries_created: int | None = None,
    providers_used: list[str] | None = None,
) -> dict[str, Any]:
    """Build structured report from SEED_RUN_ACCUMULATOR."""
    from collections import Counter
    from datetime import datetime, timezone

    acc = SEED_RUN_ACCUMULATOR
    all_scored = acc["seeds"] + acc["watchlist"]
    raw_total = sum(
        int(r.get("stats", {}).get("raw", 0)) for r in acc.get("_interest_stats", [])
    )
    seeds_fetched = raw_total if raw_total else len(all_scored) + len(acc["excluded"])

    pri_counter = Counter(s.get("crawl_priority") for s in acc["seeds"])
    cat_counter = Counter(s.get("normalized_category") for s in all_scored + acc["seeds"])
    layer_counter = Counter()
    for s in all_scored + acc["seeds"]:
        src = s.get("trend_source", "typeahead_estimate")
        layer = {
            "pinterest_trends_v5": "official_v5",
            "pinterest_trends_api": "L1",
            "internal_resource": "L2",
        }.get(src, "L3")
        layer_counter[layer] += 1

    qstats = acc.get("queue_stats", {})
    cq_created = crawl_queue_entries_created if crawl_queue_entries_created is not None else qstats.get("written", 0)

    def _top(items: list[dict], n: int = 20) -> list[dict]:
        ranked = sorted(items, key=lambda x: -float(x.get("trend_seed_score") or 0))
        return [{
            "keyword": x.get("keyword"),
            "category": x.get("normalized_category"),
            "trendSeedScore": x.get("trend_seed_score"),
            "crawlPriority": x.get("crawl_priority"),
            "refreshCadence": x.get("refresh_cadence"),
            "clusterId": x.get("cluster_id"),
        } for x in ranked[:n]]

    report = {
        "jobTimestamp": datetime.now(tz=timezone.utc).isoformat(),
        "providersUsed": providers_used or ["pinterest_trends_api", "internal_resource", "typeahead_estimate"],
        "seedsFetched": seeds_fetched,
        "seedsScored": len(all_scored),
        "seedsProcessed": len(all_scored) + len(acc["excluded"]),
        "highCount": pri_counter.get("high", 0),
        "mediumCount": pri_counter.get("medium", 0),
        "lowCount": pri_counter.get("low", 0),
        "watchlistCount": len(acc["watchlist"]),
        "excludedCount": len(acc["excluded"]),
        "clustersCreated": len(acc["clusters"]),
        "crawlQueueEntriesCreated": cq_created,
        "byCategory": dict(cat_counter),
        "bySourceLayer": dict(layer_counter),
        "p0CategoriesPresent": sorted(set(cat_counter) & P0_CATEGORIES),
        "p0CategoriesMissing": sorted(P0_CATEGORIES - set(cat_counter)),
        "topHighSeeds": _top([s for s in acc["seeds"] if s.get("crawl_priority") == "high"]),
        "topMediumSeeds": _top([s for s in acc["seeds"] if s.get("crawl_priority") == "medium"]),
        "topWatchlistSeeds": _top(acc["watchlist"]),
        "topExcludedSeedsWithReasons": acc["excluded"][:20],
        "clusterBudgetWarnings": cluster_budget_warnings(acc["seeds"]),
        "errors": acc["errors"],
        "queueStats": qstats,
    }
    return report


def describe_score_reason(kw: dict, score: float | None = None) -> str:
    """Human-readable score breakdown for dry-run reports."""
    score = score if score is not None else float(kw.get("trend_seed_score") or 0)
    yoy = float(kw.get("pct_growth_yoy") or 0)
    wow = float(kw.get("pct_growth_wow") or 0)
    mom = float(kw.get("pct_growth_mom") or 0)
    vol = float(kw.get("volume_score") or 0)
    src = kw.get("trend_source", "typeahead_estimate")
    comm = kw.get("commercial_intent_score")
    rel = kw.get("category_relevance_score")
    parts = [
        f"score={score}",
        f"source={src}(+{SOURCE_LAYER_SCORE.get(src, 3)})",
        f"vol={vol}",
        f"yoy={yoy}%",
        f"wow={wow}%",
        f"mom={mom}%",
        f"tier={kw.get('crawl_priority', 'n/a')}",
    ]
    if comm is not None:
        parts.append(f"commercial={comm}")
    if rel is not None:
        parts.append(f"relevance={rel}")
    if kw.get("disposition_reason"):
        parts.append(f"reason={kw.get('disposition_reason')}")
    return "; ".join(parts)


def _seed_sample_row(kw: dict, *, interest_slug: str = "") -> dict[str, Any]:
    from datetime import datetime, timezone

    cadence = kw.get("refresh_cadence") or "paused"
    now = datetime.now(tz=timezone.utc)
    eligible = kw.get("crawl_queue_eligible", False)
    ts = kw.get("time_series") or []
    return {
        "keyword": kw.get("keyword"),
        "category": kw.get("normalized_category") or kw.get("category"),
        "interestSlug": interest_slug or kw.get("interest_slug") or kw.get("interest"),
        "v5InterestParam": kw.get("v5_interest_param"),
        "trendType": kw.get("trend_type"),
        "pctGrowthWow": kw.get("pct_growth_wow"),
        "pctGrowthMom": kw.get("pct_growth_mom"),
        "pctGrowthYoy": kw.get("pct_growth_yoy"),
        "trendSeedScore": kw.get("trend_seed_score"),
        "scoreReason": describe_score_reason(kw),
        "crawlPriority": kw.get("crawl_priority"),
        "refreshCadence": cadence,
        "projectedNextCrawlAt": next_crawl_at_from_cadence(now, cadence) if eligible else None,
        "projectedCrawlQueueAction": "insert_pending" if eligible else "skip",
        "hasTimeSeries": bool(ts),
        "timeSeriesLength": len(ts) if isinstance(ts, list) else 0,
        "trendSeriesSource": kw.get("trend_series_source"),
        "p0Bucket": kw.get("p0_bucket"),
        "commercialIntentScore": kw.get("commercial_intent_score"),
        "categoryRelevanceScore": kw.get("category_relevance_score"),
    }


def enrich_dry_run_report() -> dict[str, Any]:
    """Extra dry-run fields: samples, rejections, provenance coverage."""
    from collections import Counter, defaultdict
    from datetime import datetime, timezone

    acc = SEED_RUN_ACCUMULATOR
    all_accepted = acc["seeds"]
    all_watchlist = acc["watchlist"]
    all_excluded = acc["excluded"]
    all_scored = all_accepted + all_watchlist

    raw_total = sum(int(r.get("stats", {}).get("raw", 0)) for r in acc.get("_interest_stats", []))
    processed = raw_total or (len(all_scored) + len(all_excluded))

    rej_counter: Counter[str] = Counter()
    for ex in all_excluded:
        rej_counter[ex.get("reason") or "unknown"] += 1

    cadence_counter: Counter[str] = Counter()
    cadence_all: Counter[str] = Counter()
    for s in all_accepted:
        cad = s.get("refresh_cadence") or "paused"
        cadence_all[cad] += 1
        if s.get("crawl_queue_eligible"):
            cadence_counter[cad] += 1
    for s in all_watchlist:
        cadence_all["watchlist"] += 1

    viral_rejected = [
        ex for ex in all_excluded
        if ex.get("reason") and (
            str(ex.get("reason", "")).startswith("viral")
            or "love_island" in str(ex.get("reason", ""))
            or "world_cup" in str(ex.get("reason", ""))
            or ex.get("reason") in ("category_irrelevant", "low_commercial_intent", "v5_quality_gate")
        )
    ][:20]

    dedup_report = acc.get("_dedup_report") or {}

    p0_bucket_counter: Counter[str] = Counter()
    womens_fashion_seeds: list[dict] = []
    for s in all_accepted:
        bucket = s.get("p0_bucket") or s.get("normalized_category") or "unknown"
        p0_bucket_counter[bucket] += 1
        if bucket == "womens-fashion" and len(womens_fashion_seeds) < 10:
            womens_fashion_seeds.append(_seed_sample_row(s, interest_slug=s.get("interest_slug") or ""))

    from official_v5_seed_quality import digital_products_v5_status
    digital_status = digital_products_v5_status(acc.get("interests", []))

    trend_types: Counter[str] = Counter()
    with_ts = 0
    ts_lengths: list[int] = []
    for s in all_accepted + all_watchlist:
        tt = s.get("trend_type")
        if tt:
            trend_types[tt] += 1
        ts = s.get("time_series") or []
        if ts:
            with_ts += 1
            ts_lengths.append(len(ts))

    by_cat: dict[str, list[dict]] = defaultdict(list)
    for s in all_accepted:
        cat = s.get("p0_bucket") or s.get("normalized_category") or s.get("category") or "unknown"
        if len(by_cat[cat]) < 10:
            slug = s.get("interest_slug") or ""
            by_cat[cat].append(_seed_sample_row(s, interest_slug=slug))

    interest_by_cat: dict[str, list[str]] = defaultdict(list)
    for slug in acc.get("interests", []):
        from official_v5_seed_quality import resolve_p0_bucket
        bucket = resolve_p0_bucket(interest_slug=slug, normalized_category=normalize_category(None, slug))
        if bucket not in interest_by_cat[bucket]:
            interest_by_cat[bucket].append(slug)

    return {
        "seedsProcessed": processed,
        "seedsAccepted": len(all_accepted),
        "rawAcceptedCount": dedup_report.get("rawAcceptedCount", len(all_accepted)),
        "uniqueAcceptedCount": dedup_report.get("uniqueAcceptedCount", len(all_accepted)),
        "seedsWatchlist": len(all_watchlist),
        "seedsRejected": len(all_excluded),
        "rejectedByReason": dict(rej_counter),
        "rejectedSamples": all_excluded[:30],
        "topRejectedViralNoise": viral_rejected,
        "topScoredSeedsByCategory": dict(by_cat),
        "projectedRefreshCadence": dict(cadence_counter),
        "cadenceDistribution": dict(cadence_all),
        "dedupReport": dedup_report,
        "trendTypeCoverage": dict(trend_types),
        "timeSeriesPresence": {
            "withTimeSeries": with_ts,
            "withoutTimeSeries": max(0, len(all_scored) - with_ts),
            "acceptedWithTimeSeries": sum(1 for s in all_accepted if s.get("time_series")),
            "sampleTrendSeriesLength": ts_lengths[:5],
            "trendSeriesSource": "pinterest_v5_official",
        },
        "p0InterestsByCategory": {k: v for k, v in interest_by_cat.items() if k in P0_CATEGORIES},
        "p0BucketCoverage": dict(p0_bucket_counter),
        "womensFashionCoverage": {
            "acceptedCount": p0_bucket_counter.get("womens-fashion", 0),
            "samples": womens_fashion_seeds,
        },
        "digitalProductsOfficialV5": digital_status,
        "applyPathUsesDedupedSet": dedup_report.get("applySafe", True),
        "reportingNote": (
            "seedsScored = accepted + watchlist after global dedup; "
            "uniqueAcceptedCount = deduped queue-eligible seeds; "
            "p0_bucket tracks womens-fashion separately from fashion category"
        ),
    }


def cluster_keywords(seeds: list[TrendSeed]) -> dict[str, list[str]]:
    """
    Group near-duplicate keywords by shared token prefix (first 2 tokens).
    Returns cluster_id → [keywords].
    """
    buckets: dict[str, list[str]] = {}
    for seed in seeds:
        tokens = _tokenize(seed.keyword)
        if not tokens:
            cid = "misc"
        elif len(tokens) == 1:
            cid = tokens[0]
        else:
            cid = f"{tokens[0]}-{tokens[1]}"
        seed.cluster_id = cid
        buckets.setdefault(cid, []).append(seed.keyword)
    return buckets


def passes_commercial_filter(
    kw: dict,
    *,
    min_yoy: float = MIN_YOY_GROWTH,
    min_wow: float = MIN_WEEKLY_CHANGE,
    min_vol: int = MIN_VOLUME_SCORE,
) -> bool:
    source = kw.get("trend_source", "")
    is_est = source == "typeahead_estimate"
    if is_est:
        if kw.get("volume_score", 0) < 1:
            return False
        if kw.get("pct_growth_wow", 0) < 0:
            return False
        return True
    if kw.get("pct_growth_yoy", 0) < min_yoy:
        return False
    if kw.get("pct_growth_wow", 0) < min_wow:
        return False
    if kw.get("volume_score", 0) < min_vol:
        return False
    return True


def compute_trend_seed_score(kw: dict) -> float:
    """0–100 TrendSeedScore combining volume, growth, and source quality."""
    yoy = float(kw.get("pct_growth_yoy") or 0)
    wow = float(kw.get("pct_growth_wow") or 0)
    mom = float(kw.get("pct_growth_mom") or 0)
    vol = float(kw.get("volume_score") or 0)
    src = kw.get("trend_source", "typeahead_estimate")

    score = 0.0
    score += min(vol / 4.0, 1.0) * 25.0
    score += min(max(yoy, 0) / 500.0, 1.0) * 30.0
    score += min(max(wow, 0) / 50.0, 1.0) * 15.0
    score += min(max(mom, 0) / 100.0, 1.0) * 10.0
    score += SOURCE_LAYER_SCORE.get(src, 3)

    keyword = (kw.get("keyword") or "").lower()
    if any(t in keyword for t in COMMERCIAL_BONUS_TOKENS):
        score += 5.0
    if yoy >= 200:
        score += 8.0
    elif yoy >= 100:
        score += 4.0

    return round(min(100.0, max(0.0, score)), 2)


def assign_crawl_priority(trend_seed_score: float, kw: dict) -> tuple[str, str, bool]:
    """
    Returns (crawl_priority, refresh_cadence, crawl_queue_eligible).
    """
    src = kw.get("trend_source", "")
    if trend_seed_score >= 65:
        return "high", "daily", True
    if trend_seed_score >= 42:
        return "medium", "every_3_days", True
    if trend_seed_score >= 22:
        return "low", "weekly", True
    return "watchlist", "paused", False


def crawl_priority_to_score(crawl_priority: str, trend_seed_score: float) -> float:
    """Map seed tier to crawl_queue priority_score (compatible with crawl_queue_ops tiers)."""
    base = {
        "high": 75.0,
        "medium": 35.0,
        "low": 15.0,
        "watchlist": 8.0,
        "excluded": 0.0,
    }.get(crawl_priority, 10.0)
    return round(min(100.0, base + trend_seed_score * 0.15), 2)


def build_seed_notes(seed: TrendSeed) -> str:
    payload = {
        "trendSeedScore": seed.trend_seed_score,
        "normalizedCategory": seed.normalized_category,
        "crawlPriority": seed.crawl_priority,
        "refreshCadence": seed.refresh_cadence,
        "clusterId": seed.cluster_id,
        "seedDisposition": seed.seed_disposition,
    }
    if seed.exclusion_reason:
        payload["exclusionReason"] = seed.exclusion_reason
    raw = seed.raw or {}
    if raw.get("p0_bucket"):
        payload["p0Bucket"] = raw["p0_bucket"]
    prov = raw.get("_provenance") or raw.get("matched_interests")
    if isinstance(prov, dict):
        payload.update(prov)
    elif raw.get("matched_interests"):
        payload["matchedInterests"] = raw["matched_interests"]
        payload["matchedP0Buckets"] = raw.get("matched_p0_buckets")
    return json.dumps(payload, separators=(",", ":"))


def process_trend_seeds(
    keywords: list[dict],
    *,
    category: str,
    interest_slug: str = "",
    top_n: int = 20,
    min_yoy: float = MIN_YOY_GROWTH,
    min_wow: float = MIN_WEEKLY_CHANGE,
    min_vol: int = MIN_VOLUME_SCORE,
    include_watchlist_in_db: bool = True,
    reset_filter_stats_flag: bool = True,
) -> ProcessResult:
    """
    Full automated seed pipeline. Returns ranked seeds for crawl + optional watchlist rows.
    """
    if reset_filter_stats_flag:
        reset_filter_stats()

    normalized_cat = normalize_category(category, interest_slug)
    stats = dict(SEED_LAST_STATS)
    stats["raw"] = len(keywords)

    candidates: list[TrendSeed] = []
    excluded_rows: list[dict] = []

    for kw in keywords:
        keyword = (kw.get("keyword") or "").strip()
        if not keyword:
            continue

        decision = evaluate_pin_content(title=keyword, category=normalized_cat)
        if decision.reject:
            stats["negative_filtered"] += 1
            stats["excluded"] += 1
            excluded_rows.append({
                "keyword": keyword,
                "reason": decision.reason or "negative_term",
                "matched_term": decision.matched_term,
            })
            continue

        is_v5 = kw.get("trend_source") == "pinterest_trends_v5"
        p0_bucket = None
        commercial_intent = 0.0
        category_relevance = 0.0

        if is_v5:
            from official_v5_seed_quality import (
                annotate_seed_provenance,
                assign_v5_crawl_tier,
                compute_v5_composite_score,
                passes_v5_category_gate,
                resolve_p0_bucket,
                route_best_p0_bucket,
                score_category_relevance,
                score_commercial_intent,
            )
            p0_bucket = resolve_p0_bucket(interest_slug=interest_slug, normalized_category=normalized_cat)
            gate_bucket = route_best_p0_bucket(keyword) or p0_bucket
            ok, gate_reason = passes_v5_category_gate(keyword, p0_bucket=gate_bucket)
            if not ok:
                stats["excluded"] += 1
                excluded_rows.append({"keyword": keyword, "reason": gate_reason or "v5_quality_gate"})
                continue
            commercial_intent = score_commercial_intent(keyword)
            category_relevance = score_category_relevance(keyword, p0_bucket=gate_bucket)
        elif not passes_commercial_filter(kw, min_yoy=min_yoy, min_wow=min_wow, min_vol=min_vol):
            stats["commercial_filtered"] += 1
            stats["excluded"] += 1
            excluded_rows.append({
                "keyword": keyword,
                "reason": "commercial_filter",
            })
            continue

        base_score = compute_trend_seed_score(kw)
        tier_reason: str | None = None
        if is_v5:
            score = compute_v5_composite_score(
                kw,
                base_score=base_score,
                commercial_intent=commercial_intent,
                category_relevance=category_relevance,
            )
            crawl_pri, refresh, queue_ok, tier_reason = assign_v5_crawl_tier(
                trend_seed_score=score,
                commercial_intent=commercial_intent,
                category_relevance=category_relevance,
                kw=kw,
            )
            if crawl_pri == "excluded":
                stats["excluded"] += 1
                excluded_rows.append({"keyword": keyword, "reason": tier_reason or "v5_tier_excluded"})
                continue
            disposition = "accepted" if crawl_pri in ("high", "medium", "low") else "watchlist"
            exclusion_reason = None if disposition != "excluded" else tier_reason
        else:
            score = base_score
            crawl_pri, refresh, queue_ok = assign_crawl_priority(score, kw)
            disposition = "accepted" if crawl_pri in ("high", "medium", "low") else "watchlist"
            exclusion_reason = None
            tier_reason = None

        seed = TrendSeed(
            keyword=keyword,
            normalized_category=normalized_cat,
            trend_seed_score=score,
            crawl_priority=crawl_pri,
            refresh_cadence=refresh,
            seed_disposition=disposition,
            crawl_queue_eligible=queue_ok,
            priority_score=crawl_priority_to_score(crawl_pri, score),
            raw=kw,
            exclusion_reason=exclusion_reason,
        )
        seed_dict = seed.to_keyword_dict()
        if is_v5:
            seed_dict = annotate_seed_provenance(seed_dict, interest_slug=interest_slug)
            seed_dict["disposition_reason"] = tier_reason
            seed_dict["commercial_intent_score"] = commercial_intent
            seed_dict["category_relevance_score"] = category_relevance
            seed_dict["base_growth_score"] = base_score
        seed = TrendSeed(
            keyword=keyword,
            normalized_category=normalized_cat,
            trend_seed_score=score,
            crawl_priority=crawl_pri,
            refresh_cadence=refresh,
            seed_disposition=disposition,
            crawl_queue_eligible=queue_ok,
            priority_score=crawl_priority_to_score(crawl_pri, score),
            raw=seed_dict,
            exclusion_reason=exclusion_reason,
        )
        candidates.append(seed)

    # Rank before clustering / top_n cut
    candidates.sort(
        key=lambda s: (-s.trend_seed_score, -float(s.raw.get("volume_score") or 0), s.keyword),
    )

    clusters = cluster_keywords(candidates)
    stats["clusters"] = len(clusters)

    accepted: list[TrendSeed] = []
    watchlist: list[TrendSeed] = []
    for seed in candidates:
        if seed.seed_disposition == "accepted":
            accepted.append(seed)
        else:
            watchlist.append(seed)

    top_seeds = accepted[:top_n]
    stats["accepted"] = len(top_seeds)
    stats["watchlist"] = len(watchlist) if include_watchlist_in_db else 0
    stats["queue_eligible"] = sum(1 for s in top_seeds if s.crawl_queue_eligible)

    filter_stats = get_filter_stats()
    stats["content_filter_negative"] = filter_stats.get("negative_term", 0)
    stats["content_filter_skipped_digital"] = filter_stats.get("skipped_digital", 0)

    SEED_LAST_STATS.update(stats)
    global WATCHLIST_LAST, EXCLUDED_LAST
    WATCHLIST_LAST = [s.to_keyword_dict() for s in watchlist] if include_watchlist_in_db else []
    EXCLUDED_LAST = list(excluded_rows)

    # Track raw count per interest for job report
    SEED_RUN_ACCUMULATOR.setdefault("_interest_stats", []).append({"stats": stats})

    global LAST_PROCESS_RESULT
    result = ProcessResult(
        seeds=[s.to_keyword_dict() for s in top_seeds],
        watchlist=[s.to_keyword_dict() for s in watchlist] if include_watchlist_in_db else [],
        excluded=excluded_rows,
        clusters=clusters,
        stats=stats,
    )
    LAST_PROCESS_RESULT = result
    return result


def _legacy_process_return(result: ProcessResult) -> list[dict]:
    """Seeds list for trend_fetcher callers."""
    return result.seeds


def example_outputs() -> dict[str, Any]:
    """Deterministic examples for docs/tests (no network)."""
    samples = [
        {
            "keyword": "boho living room decor ideas",
            "trend_source": "pinterest_trends_api",
            "pct_growth_yoy": 280, "pct_growth_wow": 12, "pct_growth_mom": 40,
            "volume_score": 4,
        },
        {
            "keyword": "spring nail aesthetic",
            "trend_source": "internal_resource",
            "pct_growth_yoy": 150, "pct_growth_wow": 5, "pct_growth_mom": 20,
            "volume_score": 3,
        },
        {
            "keyword": "soft pastel aesthetic",
            "trend_source": "typeahead_estimate",
            "pct_growth_yoy": 15, "pct_growth_wow": 1, "pct_growth_mom": 3,
            "volume_score": 1,
        },
        {
            "keyword": "funny cat meme wallpaper",
            "trend_source": "pinterest_trends_api",
            "pct_growth_yoy": 500, "pct_growth_wow": 50, "volume_score": 4,
        },
        {
            "keyword": "boho living room aesthetic",
            "trend_source": "pinterest_trends_api",
            "pct_growth_yoy": 260, "pct_growth_wow": 10, "volume_score": 4,
        },
    ]
    result = process_trend_seeds(
        samples, category="home_decor", interest_slug="home_decor", top_n=10,
    )
    high = next(s for s in result.seeds if s["crawl_priority"] == "high")
    medium = next(s for s in result.seeds if s["crawl_priority"] == "medium")
    watch = result.watchlist[0] if result.watchlist else {}
    excluded = result.excluded[0]
    cluster = next((kws for cid, kws in result.clusters.items() if len(kws) > 1), [])
    queue_entry = {
        "keyword": high["keyword"],
        "category": high["normalized_category"],
        "priority_score": high["priority_score"],
        "status": "pending",
        "source_interest": "home_decor",
    }
    return {
        "high_priority_seed": high,
        "medium_priority_seed": medium,
        "watchlist_seed": watch,
        "excluded_seed": excluded,
        "keyword_cluster": {"cluster_id": high.get("cluster_id"), "keywords": cluster},
        "crawl_queue_entry": queue_entry,
        "stats": result.stats,
    }
