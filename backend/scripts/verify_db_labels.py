#!/usr/bin/env python3
"""Verify trend_keywords labels and crawl_queue health (no secrets printed)."""
from __future__ import annotations

import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "db"))

try:
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
except ImportError:
    pass


def main() -> int:
    from db import select_many  # type: ignore

    print("== trend_keywords source distribution ==")
    rows = select_many("trend_keywords", limit=5000)
    if not rows:
        print("(no rows)")
        return 1

    groups: dict[tuple, int] = defaultdict(int)
    for r in rows:
        key = (
            r.get("source"),
            r.get("source_layer"),
            r.get("data_quality"),
            r.get("confidence"),
        )
        groups[key] += 1

    for key, count in sorted(groups.items(), key=lambda x: -x[1]):
        print(f"  source={key[0]!r} layer={key[1]!r} quality={key[2]!r} conf={key[3]!r}  count={count}")

    l3 = [r for r in rows if r.get("source_layer") == "L3" or r.get("source") == "pinterest_typeahead_estimated"]
    print(f"\nL3 / typeahead rows: {len(l3)}")
    if l3:
        sample = l3[0]
        print(f"  sample: keyword={sample.get('keyword')!r} source={sample.get('source')!r} "
              f"layer={sample.get('source_layer')!r} quality={sample.get('data_quality')!r} "
              f"confidence={sample.get('confidence')!r} search_volume={sample.get('search_volume')}")

    order_col = "last_updated_at"
    print(f"\n== latest trend_keywords (top 20 by {order_col}) ==")
    try:
        latest = select_many("trend_keywords", order=f"{order_col}.desc", limit=20)
    except RuntimeError:
        order_col = "created_at"
        latest = select_many("trend_keywords", order=f"{order_col}.desc", limit=20)
    for r in latest:
        print(
            f"  {r.get('keyword')!r} src={r.get('source')} layer={r.get('source_layer')} "
            f"q={r.get('data_quality')} conf={r.get('confidence')} "
            f"search_volume={r.get('search_volume')} {order_col}={r.get(order_col)}"
        )

    null_sv_l3 = sum(1 for r in l3 if r.get("search_volume") is None)
    print(f"\nL3 rows with search_volume=null: {null_sv_l3}/{len(l3)}")

    print("\n== crawl_queue by status ==")
    cq = select_many("crawl_queue", limit=10000)
    status_counts = Counter(r.get("status") for r in cq)
    for status, count in status_counts.most_common():
        print(f"  {status}: {count}")

    print("\n== crawl_queue duplicate keywords ==")
    kw_counts = Counter(r.get("keyword") for r in cq)
    dups = [(k, c) for k, c in kw_counts.items() if c > 1]
    if dups:
        for k, c in dups[:20]:
            print(f"  DUPLICATE {k!r}: {c}")
        print(f"  total duplicate keywords: {len(dups)}")
    else:
        print("  (none — OK)")

    print("\n== pipeline_runs (recent 5) ==")
    runs = select_many("pipeline_runs", order="started_at.desc", limit=5)
    for r in runs:
        print(f"  {r.get('job_type')} {r.get('status')} started={r.get('started_at')} finished={r.get('finished_at')}")

    locks = select_many("pipeline_locks", limit=10)
    print(f"\n== pipeline_locks active: {len(locks)} ==")
    for lk in locks:
        print(f"  {lk.get('lock_name')} by {lk.get('locked_by')} expires={lk.get('expires_at')}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
