#!/usr/bin/env python3
"""
run_crawl.py — independent CRAWL job.

Runs only: trends (best-effort) → crawl → write pin_samples.
  - Safe to run on its own.
  - Does NOT require classify or opportunities.
  - Does NOT touch STL / Playwright / Shop-the-Look.

The trends prelude is best-effort so a flaky Trends API never blocks crawling the
existing queue (step_crawl(replenish=True) also tops the queue up when low).
Crawl failure is fatal (exit 1). See job_entry.py for the cron contract.

Usage:
  python run_crawl.py
  python run_crawl.py --limit-keywords 80 --concurrency 3 --created-by local
"""
from __future__ import annotations

import argparse

import pipeline
from job_entry import run_job, log


def main() -> int:
    ap = argparse.ArgumentParser(description="VibePin crawl job (trends → crawl)")
    ap.add_argument("--limit-keywords", type=int, default=80, help="Max crawl_queue items this run")
    ap.add_argument("--concurrency", type=int, default=3, help="Parallel keyword crawlers (max 5)")
    ap.add_argument("--top", "--top-n", dest="top_n", type=int, default=30, help="Keywords per interest for trends")
    ap.add_argument("--region", default="US")
    ap.add_argument("--created-by", default="cloud", choices=["cloud", "local", "manual"])
    args = ap.parse_args()

    async def work(ctx: dict) -> None:
        # 1) trends — best-effort (keeps crawl independent of Trends API health)
        keywords = 0
        try:
            interests = await pipeline.step_interests(args.region, run_probe=False)
            if interests:
                keywords = await pipeline.step_trends(
                    interests=interests, region=args.region, top_n=args.top_n,
                )
                if isinstance(keywords, dict):
                    keywords = keywords.get("keywords", 0)
            else:
                log("crawl", "no interests available — skipping trends, crawling existing queue")
        except Exception as exc:  # noqa: BLE001 — trends is non-fatal by design
            log("crawl", f"trends prelude failed (non-fatal, using existing queue): {exc}")

        # 2) crawl — fatal on failure
        stats = await pipeline.step_crawl(
            concurrency=args.concurrency,
            limit_keywords=args.limit_keywords,
            replenish=True,
            region=args.region,
            top_n=args.top_n,
        ) or {}
        ctx["stats"] = {"keywords": keywords, **stats}

        # Required [crawl] metric lines (pins_found == pins_inserted; crawl reports saved pins)
        selected = stats.get("processed", 0) + stats.get("failed_keywords", 0)
        pins = stats.get("pins", 0)
        log("crawl", f"keywords_selected={selected}")
        log("crawl", f"pins_found={pins}")
        log("crawl", f"pins_inserted={pins}")

    return run_job("crawl", "crawl", work, created_by=args.created_by)


if __name__ == "__main__":
    raise SystemExit(main())
