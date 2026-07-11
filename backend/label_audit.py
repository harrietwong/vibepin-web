"""
label_audit.py — post-regeneration opportunity label + readiness audit.

Read-only. Reads opportunities + readiness payload from internal_reason_codes.

Overall counts:
  total, Best Bet, Rising, Rising · Needs Products, Insight Only,
  Testable, Launch Ready, Strong Opportunity, Needs Products

By normalized category:
  total, Best Bet, Needs Products, Testable, Launch Ready, Strong Opportunity,
  avg linked products, avg reference-eligible count

Acceptance guard:
  Best Bet opportunities with <=5 effective products  → must be 0

Usage:
  python label_audit.py
  python label_audit.py --json
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict

from report_utils import fetch_all, norm_category


def _readiness(irc) -> dict:
    if isinstance(irc, str):
        try:
            irc = json.loads(irc)
        except Exception:
            return {}
    if isinstance(irc, dict):
        rd = irc.get("readiness")
        return rd if isinstance(rd, dict) else {}
    return {}


def build_report() -> dict:
    opps = fetch_all(
        "opportunities",
        columns="canonical_keyword,category,primary_label,trend_state,internal_reason_codes,is_seed",
    )
    opps = [o for o in opps if not o.get("is_seed")]

    overall = {
        "total": 0, "BestBet": 0, "Rising": 0, "RisingNeedsProducts": 0,
        "InsightOnly": 0, "Testable": 0, "LaunchReady": 0,
        "StrongOpportunity": 0, "NeedsProducts": 0,
        "readiness_persisted": 0,
    }
    by_cat: dict[str, dict] = defaultdict(lambda: {
        "total": 0, "BestBet": 0, "NeedsProducts": 0, "Testable": 0,
        "LaunchReady": 0, "StrongOpportunity": 0,
        "_sum_products": 0, "_sum_refelig": 0,
    })

    best_bet_low_supply = []  # acceptance violation list

    for o in opps:
        cat = norm_category(o.get("category"))
        label = o.get("primary_label")
        state = o.get("trend_state")
        rd = _readiness(o.get("internal_reason_codes"))
        status = rd.get("readinessStatus")
        eff = rd.get("effectiveProductCount")
        if eff is None:
            eff = rd.get("linkedProductsCount", 0)
        refelig = rd.get("referenceEligibleCount", 0) or 0

        overall["total"] += 1
        c = by_cat[cat]
        c["total"] += 1
        if rd:
            overall["readiness_persisted"] += 1
        c["_sum_products"] += rd.get("linkedProductsCount", 0) or 0
        c["_sum_refelig"] += refelig

        if label == "Best Bet":
            overall["BestBet"] += 1
            c["BestBet"] += 1
            if (eff or 0) <= 5:
                best_bet_low_supply.append({
                    "keyword": o.get("canonical_keyword"), "category": cat,
                    "effectiveProducts": eff, "readinessStatus": status,
                })
        if state == "Rising":
            overall["Rising"] += 1
        elif state == "Rising · Needs Products":
            overall["RisingNeedsProducts"] += 1
        elif state == "Insight Only":
            overall["InsightOnly"] += 1

        if status == "testable":
            overall["Testable"] += 1; c["Testable"] += 1
        elif status == "launch_ready":
            overall["LaunchReady"] += 1; c["LaunchReady"] += 1
        elif status == "strong_opportunity":
            overall["StrongOpportunity"] += 1; c["StrongOpportunity"] += 1
        elif status == "needs_products":
            overall["NeedsProducts"] += 1; c["NeedsProducts"] += 1

    cat_out = {}
    for cat, c in sorted(by_cat.items(), key=lambda kv: -kv[1]["total"]):
        n = c["total"] or 1
        cat_out[cat] = {
            "total": c["total"], "BestBet": c["BestBet"],
            "NeedsProducts": c["NeedsProducts"], "Testable": c["Testable"],
            "LaunchReady": c["LaunchReady"], "StrongOpportunity": c["StrongOpportunity"],
            "avgLinkedProducts": round(c["_sum_products"] / n, 2),
            "avgReferenceEligible": round(c["_sum_refelig"] / n, 2),
        }

    return {
        "overall": overall,
        "by_category": cat_out,
        "acceptance": {
            "best_bet_with_le5_products": len(best_bet_low_supply),
            "passes": len(best_bet_low_supply) == 0,
            "violations_sample": best_bet_low_supply[:10],
        },
    }


def print_report(r: dict) -> None:
    o = r["overall"]
    line = "═" * 70
    print(f"\n{line}\n  OPPORTUNITY LABEL + READINESS AUDIT\n{line}")
    print(f"  total opportunities      : {o['total']}")
    print(f"  readiness persisted      : {o['readiness_persisted']}  "
          f"({100*o['readiness_persisted']/max(o['total'],1):.1f}%)")
    print(f"  Best Bet                 : {o['BestBet']}")
    print(f"  Rising                   : {o['Rising']}")
    print(f"  Rising · Needs Products  : {o['RisingNeedsProducts']}")
    print(f"  Insight Only             : {o['InsightOnly']}")
    print(f"  Testable                 : {o['Testable']}")
    print(f"  Launch Ready             : {o['LaunchReady']}")
    print(f"  Strong Opportunity       : {o['StrongOpportunity']}")
    print(f"  Needs Products           : {o['NeedsProducts']}")

    print(f"\n  {'category':<20}{'tot':>5}{'BBet':>6}{'Need':>6}{'Test':>6}{'Lnch':>6}"
          f"{'Strg':>6}{'avgProd':>9}{'avgRef':>8}")
    print("  " + "─" * 66)
    for cat, c in r["by_category"].items():
        print(f"  {cat:<20}{c['total']:>5}{c['BestBet']:>6}{c['NeedsProducts']:>6}"
              f"{c['Testable']:>6}{c['LaunchReady']:>6}{c['StrongOpportunity']:>6}"
              f"{c['avgLinkedProducts']:>9}{c['avgReferenceEligible']:>8}")

    a = r["acceptance"]
    print(f"\n  ACCEPTANCE — Best Bet with <=5 effective products: {a['best_bet_with_le5_products']}  "
          f"=> {'PASS' if a['passes'] else 'FAIL'}")
    for v in a["violations_sample"]:
        print(f"    VIOLATION {v['keyword']!r} cat={v['category']} eff={v['effectiveProducts']} status={v['readinessStatus']}")
    print(line)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Opportunity label + readiness audit")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    rep = build_report()
    if args.json:
        print(json.dumps(rep, indent=2, ensure_ascii=False))
    else:
        print_report(rep)
