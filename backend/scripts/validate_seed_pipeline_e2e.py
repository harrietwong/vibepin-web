#!/usr/bin/env python3
"""
validate_seed_pipeline_e2e.py — End-to-end seed pipeline validation (DB write path).

Uses fixture keywords when live Pinterest Trends APIs are unavailable (404).
Does NOT change crawler behavior.

Usage:
  python scripts/validate_seed_pipeline_e2e.py
  python scripts/validate_seed_pipeline_e2e.py --dry-run
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from trend_seed_pipeline import (  # noqa: E402
    build_job_report,
    process_trend_seeds,
    reset_run_accumulator,
    record_interest_result,
)
from trend_fetcher import upsert_trend_keywords, upsert_crawl_queue, CRAWL_QUEUE_LAST_STATS  # noqa: E402
from seed_report import query_queue_verification  # noqa: E402


FIXTURES = [
    {
        "interest": "home_decor",
        "category": "home",
        "keywords": [
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
        ],
    },
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    reset_run_accumulator()
    tag = f"e2e-{datetime.now(tz=timezone.utc).strftime('%Y%m%d%H%M%S')}"

    for fx in FIXTURES:
        result = process_trend_seeds(
            fx["keywords"],
            category=fx["category"],
            interest_slug=fx["interest"],
            top_n=10,
        )
        # Tag keywords so we can find them in verification
        for bucket in (result.seeds, result.watchlist):
            for kw in bucket:
                kw["keyword"] = f"{kw['keyword']} {tag}"

        if not args.dry_run:
            if result.seeds:
                upsert_trend_keywords(result.seeds, fx["category"], fx["interest"])
                upsert_crawl_queue(result.seeds, fx["interest"], fx["category"])
            if result.watchlist:
                upsert_trend_keywords(result.watchlist, fx["category"], fx["interest"])

        record_interest_result(
            interest_slug=fx["interest"],
            category=fx["category"],
            result=result,
            queue_stats=dict(CRAWL_QUEUE_LAST_STATS),
        )

    report = build_job_report(crawl_queue_entries_created=CRAWL_QUEUE_LAST_STATS.get("written", 0))
    report["validationTag"] = tag
    report["mode"] = "dry-run" if args.dry_run else "e2e-fixture"
    report["queueVerification"] = query_queue_verification(hours=1) if not args.dry_run else None

    # Assert invariants
    assert report["excludedCount"] >= 1, "expected excluded seed"
    assert report["watchlistCount"] >= 1, "expected watchlist seed"
    assert report["highCount"] >= 1 or report["mediumCount"] >= 1, "expected queue-eligible seed"

    if not args.dry_run:
        qv = report["queueVerification"] or {}
        wl = qv.get("sampleWatchlistNotInQueue")
        assert wl is None or wl.get("in_crawl_queue") is False, "watchlist must not be queued"

    print(json.dumps(report, indent=2, default=str, ensure_ascii=False))
    print(f"\nValidation OK (tag={tag})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
