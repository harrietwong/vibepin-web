"""
reference_eligible_gap.py — quantify the reference-eligible pin gap by category.

Read-only. Does NOT loosen reference quality — reports the gap only.

Per normalized category reports:
  • total pins
  • classified pins (reference_quality_score not null)
  • reference-eligible pins + eligible rate (of classified)
  • fail reasons among classified-ineligible: watermark / text-heavy / infographic /
    collage / no-clear-subject / heavy-text-overlay / low-quality-score
Also surfaces categories with many pins but low eligible rate, and lists the
active NEGATIVE_TERMS filter (applied at crawl + reference classification).

Usage:
  python reference_eligible_gap.py
  python reference_eligible_gap.py --json
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict

from report_utils import fetch_all, norm_category
from content_filters import load_negative_terms

PIN_COLUMNS = (
    "category,is_reference_eligible,reference_quality_score,visual_format,"
    "watermark_detected,text_overlay_level,has_clear_subject"
)

LOW_QUALITY_SCORE = 50  # below this = low-quality among classified


def build_report(min_pins_for_lowrate: int = 200, lowrate_threshold: float = 0.10) -> dict:
    pins = fetch_all("pin_samples", columns=PIN_COLUMNS)

    cats: dict[str, dict] = defaultdict(lambda: {
        "total": 0, "classified": 0, "eligible": 0,
        "fail_watermark": 0, "fail_text_heavy": 0, "fail_infographic": 0,
        "fail_collage": 0, "fail_no_subject": 0, "fail_heavy_overlay": 0,
        "fail_low_score": 0,
    })

    for p in pins:
        cat = norm_category(p.get("category"))
        c = cats[cat]
        c["total"] += 1
        classified = p.get("reference_quality_score") is not None
        if not classified:
            continue
        c["classified"] += 1
        if p.get("is_reference_eligible"):
            c["eligible"] += 1
            continue
        # ineligible — attribute reasons (non-exclusive)
        vf = (p.get("visual_format") or "").lower()
        if p.get("watermark_detected"):
            c["fail_watermark"] += 1
        if vf == "text_heavy":
            c["fail_text_heavy"] += 1
        if vf == "infographic":
            c["fail_infographic"] += 1
        if vf == "collage":
            c["fail_collage"] += 1
        if p.get("has_clear_subject") is False:
            c["fail_no_subject"] += 1
        if (p.get("text_overlay_level") or "").lower() in ("high", "heavy"):
            c["fail_heavy_overlay"] += 1
        score = p.get("reference_quality_score")
        if score is not None and score < LOW_QUALITY_SCORE:
            c["fail_low_score"] += 1

    out = {}
    for cat, c in cats.items():
        rate = round(c["eligible"] / c["classified"], 4) if c["classified"] else 0.0
        out[cat] = {**c, "eligible_rate_of_classified": rate}

    # categories with enough pins but low eligible rate (of classified)
    low_rate = sorted(
        [
            {"category": cat, "total_pins": v["total"], "classified": v["classified"],
             "eligible": v["eligible"], "eligible_rate": v["eligible_rate_of_classified"]}
            for cat, v in out.items()
            if v["total"] >= min_pins_for_lowrate and v["eligible_rate_of_classified"] < lowrate_threshold
        ],
        key=lambda x: -x["total_pins"],
    )

    totals = {
        "total_pins": sum(v["total"] for v in out.values()),
        "classified": sum(v["classified"] for v in out.values()),
        "eligible": sum(v["eligible"] for v in out.values()),
    }
    totals["overall_eligible_rate_of_classified"] = (
        round(totals["eligible"] / totals["classified"], 4) if totals["classified"] else 0.0
    )

    return {
        "totals": totals,
        "by_category": dict(sorted(out.items(), key=lambda kv: -kv[1]["total"])),
        "high_pin_low_eligible_rate": low_rate,
        "negative_terms_applied": list(load_negative_terms()),
        "note": (
            "Reference quality NOT loosened. Most pins are unclassified because "
            "classify_reference_pins only processes the last RECENT_CLASSIFY_DAYS window; "
            "eligible_rate is of CLASSIFIED pins. NEGATIVE_TERMS counts are runtime-only "
            "(emitted by the classify/scrape jobs), not persisted per-row."
        ),
    }


def print_report(r: dict) -> None:
    line = "─" * 72
    t = r["totals"]
    print(f"\n{line}\n  REFERENCE-ELIGIBLE GAP REPORT\n{line}")
    print(f"  Total pins        : {t['total_pins']}")
    print(f"  Classified pins   : {t['classified']}")
    print(f"  Eligible pins     : {t['eligible']}  "
          f"({t['overall_eligible_rate_of_classified']*100:.1f}% of classified)")
    print(f"\n  {'category':<20}{'pins':>6}{'class':>7}{'elig':>6}{'rate%':>7}"
          f"{'wmrk':>6}{'txtH':>6}{'info':>6}{'noSub':>7}")
    print("  " + "─" * 70)
    for cat, c in r["by_category"].items():
        print(f"  {cat:<20}{c['total']:>6}{c['classified']:>7}{c['eligible']:>6}"
              f"{c['eligible_rate_of_classified']*100:>6.0f}%"
              f"{c['fail_watermark']:>6}{c['fail_text_heavy']:>6}{c['fail_infographic']:>6}"
              f"{c['fail_no_subject']:>7}")
    print(f"\n  Categories with >=200 pins but <10% eligible (of classified):")
    if r["high_pin_low_eligible_rate"]:
        for x in r["high_pin_low_eligible_rate"]:
            print(f"    {x['category']:<20} pins={x['total_pins']:>5} classified={x['classified']:>4} "
                  f"eligible={x['eligible']:>3} rate={x['eligible_rate']*100:.1f}%")
    else:
        print("    (none — most categories are simply under-classified, not low-quality)")
    print(f"\n  Active NEGATIVE_TERMS ({len(r['negative_terms_applied'])}): "
          f"{', '.join(r['negative_terms_applied'])}")
    print(f"\n  Note: {r['note']}")
    print(line)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Reference-eligible gap report")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    rep = build_report()
    if args.json:
        print(json.dumps(rep, indent=2, ensure_ascii=False))
    else:
        print_report(rep)
