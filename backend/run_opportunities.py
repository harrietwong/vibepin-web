#!/usr/bin/env python3
"""
run_opportunities.py — independent OPPORTUNITIES job.

Runs only: generate_opportunities → opportunities + relation tables.
  - Idempotent (upsert on conflict), safe to re-run.
  - Does NOT depend on crawl or classify running in the same process; it reads
    whatever keyword / pin / product data is already in the DB.

Fails loudly: pipeline.step_opportunities() re-raises on failure → exit non-zero.

Usage:
  python run_opportunities.py
  python run_opportunities.py --limit 2000 --created-by local
"""
from __future__ import annotations

import argparse

import pipeline
from job_entry import run_job, log


def main() -> int:
    ap = argparse.ArgumentParser(description="VibePin opportunities job (generate_opportunities)")
    ap.add_argument("--limit", type=int, default=2000, help="Max keyword rows to process")
    ap.add_argument("--category", default=None, help="Restrict to a single category (optional)")
    ap.add_argument("--created-by", default="cloud", choices=["cloud", "local", "manual"])
    args = ap.parse_args()

    async def work(ctx: dict) -> None:
        stats = await pipeline.step_opportunities(category=args.category, limit=args.limit)
        ctx["stats"] = stats
        log("opportunities", f"processed={stats.get('processed', 0)}")
        log("opportunities", f"created_or_updated={stats.get('created_or_updated', 0)}")

    return run_job("opportunities", "opportunities", work, created_by=args.created_by)


if __name__ == "__main__":
    raise SystemExit(main())
