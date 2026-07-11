#!/usr/bin/env python3
"""
P0-filtered official_v5 trends dry-run (no DB writes).

Usage (local or VPS):
  ENABLE_PINTEREST_TRENDS_EXPERIMENTAL_FALLBACK=false \\
  ENABLE_PINTEREST_TRENDS_L1=false ENABLE_PINTEREST_RESOURCE_L2=false \\
  python scripts/p0_v5_trends_dry_run.py [--top-n 8] [--region US]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

try:
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
except ImportError:
    pass

# Force official_v5-only before provider modules load env defaults
os.environ.setdefault("ENABLE_PINTEREST_TRENDS_V5", "true")
os.environ.setdefault("ENABLE_PINTEREST_TRENDS_EXPERIMENTAL_FALLBACK", "false")
os.environ.setdefault("ENABLE_PINTEREST_TRENDS_L1", "false")
os.environ.setdefault("ENABLE_PINTEREST_RESOURCE_L2", "false")

from trend_seed_pipeline import P0_CATEGORIES, normalize_category  # noqa: E402


async def main() -> int:
    ap = argparse.ArgumentParser(description="P0 official_v5 trends dry-run")
    ap.add_argument("--top-n", type=int, default=8, help="Max accepted seeds per P0 interest")
    ap.add_argument("--region", default="US")
    ap.add_argument("--out", default="", help="Optional JSON output path")
    args = ap.parse_args()

    import pipeline  # noqa: E402
    from official_v5_seed_quality import is_p0_interest_slug, resolve_p0_bucket  # noqa: E402

    all_interests = await pipeline.step_interests(args.region, run_probe=False)
    p0_interests = []
    by_cat: dict[str, list[str]] = {}
    for rec in all_interests:
        slug = rec.get("interest_slug") or rec.get("slug", "")
        if not is_p0_interest_slug(slug):
            continue
        p0_interests.append(rec)
        bucket = resolve_p0_bucket(interest_slug=slug)
        by_cat.setdefault(bucket, []).append(slug)

    print(f"P0 interests selected: {len(p0_interests)}", flush=True)
    print(json.dumps({"p0InterestsByCategory": by_cat}, indent=2, ensure_ascii=False), flush=True)

    if not p0_interests:
        print("ERROR: no P0 interests found in trend_interests", flush=True)
        return 1

    result = await pipeline.step_trends(
        interests=p0_interests,
        region=args.region,
        top_n=args.top_n,
        limit_interests=0,
        dry_run=True,
    )

    report = result.get("seedReport") if isinstance(result, dict) else {}
    summary_keys = [
        "dryRun", "seedsFetched", "seedsAfterFilters", "seedsProcessed",
        "seedsScored", "seedsAccepted", "seedsWatchlist", "seedsRejected",
        "projectedCrawlQueueEntriesCreated", "categoriesCovered",
        "missingP0Categories", "p0CategoriesPresent", "p0CategoriesMissing",
        "selectedPrimaryProvider", "providerStatus", "fallbackUsed",
        "layerCounts", "rejectedByReason", "trendTypeCoverage",
        "timeSeriesPresence", "projectedRefreshCadence", "reportingNote",
    ]
    summary = {k: report.get(k) for k in summary_keys if k in report}
    print("\n=== P0 DRY-RUN SUMMARY ===", flush=True)
    print(json.dumps(summary, indent=2, ensure_ascii=False, default=str), flush=True)

    samples = report.get("topScoredSeedsByCategory") or {}
    print("\n=== SCORED SAMPLES BY P0 CATEGORY ===", flush=True)
    print(json.dumps(samples, indent=2, ensure_ascii=False, default=str)[:12000], flush=True)

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        print(f"\nFull report: {out_path}", flush=True)

    return 0 if not report.get("providerBlocker") else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
