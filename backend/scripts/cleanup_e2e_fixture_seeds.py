#!/usr/bin/env python3
"""Remove e2e/fixture trend seed rows from production DB."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "db"))

from db import select_many, _request  # type: ignore
from seed_report import FIXTURE_MARKERS, is_fixture_keyword


def main() -> int:
    ap = argparse.ArgumentParser(description="Delete fixture trend_keywords + crawl_queue rows")
    ap.add_argument("--dry-run", action="store_true", help="List rows only, do not delete")
    ap.add_argument("--tag", default="e2e-", help="Substring match for fixture keywords")
    args = ap.parse_args()

    seeds = select_many("trend_keywords", filters={"is_seed": True}, limit=2000)
    fixture_seeds = [r for r in seeds if args.tag in (r.get("keyword") or "")]
    keywords = [r["keyword"] for r in fixture_seeds if r.get("keyword")]

    queue = select_many("crawl_queue", filters={"status": "pending"}, limit=2000)
    fixture_queue = [r for r in queue if is_fixture_keyword(r.get("keyword"))]

    print(f"fixture trend_keywords: {len(fixture_seeds)}")
    print(f"fixture crawl_queue: {len(fixture_queue)}")
    for r in fixture_seeds[:10]:
        print(f"  seed: {r.get('keyword')}")
    for r in fixture_queue[:10]:
        print(f"  queue: {r.get('keyword')}")

    if args.dry_run:
        print("dry-run — no deletes")
        return 0

    deleted_kw = 0
    for kw in keywords:
        resp = _request("delete", "trend_keywords", params={"keyword": f"eq.{kw}"})
        if resp.status_code not in (200, 204):
            raise RuntimeError(
                f"Delete trend_keywords failed [{resp.status_code}] for {kw!r}: {resp.text[:200]}"
            )
        deleted_kw += 1

    deleted_q = 0
    for r in fixture_queue:
        kw = r.get("keyword")
        if kw:
            resp = _request("delete", "crawl_queue", params={"keyword": f"eq.{kw}"})
            if resp.status_code not in (200, 204):
                raise RuntimeError(
                    f"Delete crawl_queue failed [{resp.status_code}] for {kw!r}: {resp.text[:200]}"
                )
            deleted_q += 1

    print(f"deleted trend_keywords={deleted_kw} crawl_queue={deleted_q}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
