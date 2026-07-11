#!/usr/bin/env python3
"""
Verify that persisted `opportunities` rows now carry the readiness key
(internal_reason_codes.readiness) and report launch-ready / testable counts
per core category. Read-only — safe to run any time.

Run:  py backend/readiness_persisted_report.py
"""
import json
import sys
from collections import defaultdict

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from report_utils import fetch_all, norm_category  # noqa: E402

CORE = ["fashion", "home-decor", "beauty", "food-and-drink", "diy-crafts", "travel", "digital-products"]


def main() -> None:
    rows = fetch_all(
        "opportunities",
        columns="category,primary_label,trend_state,internal_reason_codes,last_computed_at",
    )
    total = len(rows)
    if total == 0:
        print("No opportunities rows found.")
        return

    with_key = 0
    # category -> readinessStatus -> count
    by_cat: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    status_totals: dict[str, int] = defaultdict(int)
    newest = ""

    for r in rows:
        newest = max(newest, r.get("last_computed_at") or "")
        cat = norm_category(r.get("category"))
        raw = r.get("internal_reason_codes")
        irc = {}
        if isinstance(raw, str):
            try: irc = json.loads(raw)
            except Exception: irc = {}
        elif isinstance(raw, dict):
            irc = raw
        readiness = irc.get("readiness") if isinstance(irc, dict) else None
        if isinstance(readiness, dict) and readiness.get("readinessStatus"):
            with_key += 1
            status = str(readiness.get("readinessStatus"))
        else:
            status = "(no readiness key)"
        by_cat[cat][status] += 1
        status_totals[status] += 1

    pct = round(100 * with_key / total, 1)
    print(f"\n=== Persisted opportunities readiness coverage ===")
    print(f"  total rows           : {total}")
    print(f"  rows w/ readiness key: {with_key} ({pct}%)")
    print(f"  newest last_computed : {newest or 'n/a'}")

    print(f"\n  readinessStatus totals (all categories):")
    for s, n in sorted(status_totals.items(), key=lambda kv: -kv[1]):
        print(f"    {s:<22} {n}")

    print(f"\n=== Core category breakdown (launch_ready / testable / needs_products / insight_only) ===")
    header = f"  {'category':<16} {'opps':>5} {'launch':>7} {'testable':>9} {'needs_prod':>11} {'insight':>8} {'no_key':>7}"
    print(header)
    for cat in CORE:
        m = by_cat.get(cat, {})
        opps = sum(m.values())
        launch = m.get("launch_ready", 0)
        testable = m.get("testable", 0)
        needs = m.get("needs_products", 0)
        insight = m.get("insight_only", 0)
        nokey = m.get("(no readiness key)", 0)
        print(f"  {cat:<16} {opps:>5} {launch:>7} {testable:>9} {needs:>11} {insight:>8} {nokey:>7}")

    # any non-core categories present
    others = [c for c in by_cat if c not in CORE]
    if others:
        oc = sum(sum(by_cat[c].values()) for c in others)
        print(f"  {'(other cats)':<16} {oc:>5}")


if __name__ == "__main__":
    main()
