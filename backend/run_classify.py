#!/usr/bin/env python3
"""
run_classify.py — independent CLASSIFY job.

Runs only:
  classify_product_signals  → pin_products.product_type / source_platform  (Product Ideas)
  classify_reference_pins   → pin_samples.is_reference_eligible             (Pin Ideas)

Does NOT run generate_opportunities (see run_opportunities.py).
Fails loudly: pipeline.step_classify() re-raises on any sub-step failure, so this
job exits non-zero — no silent success on partial failure.

Usage:
  python run_classify.py
  python run_classify.py --created-by local
"""
from __future__ import annotations

import argparse

import pipeline
from job_entry import run_job, log


def main() -> int:
    ap = argparse.ArgumentParser(description="VibePin classify job (product signals + reference pins)")
    ap.add_argument("--created-by", default="cloud", choices=["cloud", "local", "manual"])
    args = ap.parse_args()

    async def work(ctx: dict) -> None:
        # step_classify runs both classifiers and re-raises on failure (fail loudly).
        stats = await pipeline.step_classify()
        ctx["stats"] = stats
        log("classify", f"product_rows={stats.get('product_rows', 0)}")
        log("classify", f"reference_rows={stats.get('reference_rows', 0)}")
        log("classify", f"updated_rows={stats.get('updated_rows', 0)}")

    return run_job("classify", "classify", work, created_by=args.created_by)


if __name__ == "__main__":
    raise SystemExit(main())
