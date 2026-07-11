"""
core_category_report.py — launch-gate report for the MVP core categories.

Read-only. Computes readiness per opportunity on the fly using the canonical
opportunity_readiness helpers, so it is correct even before generate_opportunities
has re-persisted readiness payloads. No schema/data/crawler changes.

Core categories: fashion, womens-fashion, home-decor, beauty, digital-products.

For each category reports:
  • pin count
  • reference-eligible pin count
  • product count
  • opportunity count
  • launch_ready opportunity count
  • testable opportunity count
  • products-with-URL count
  • unknown mapping count

Usage:
  python core_category_report.py
  python core_category_report.py --json
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict

from report_utils import fetch_all, count_exact, normalize_keyword, norm_category
from opportunity_readiness import (
    availability_tier,
    count_usable_products,
    effective_product_count,
    compute_readiness_status,
)

CORE_CATEGORIES = ["fashion", "womens-fashion", "home-decor", "beauty", "digital-products"]

# MVP minimum launch targets (per core category).
TARGETS = {
    "launch_ready": 15,
    "testable": 30,
    "reference_eligible_pins": 120,
    "qualified_products": 250,
}

# Categories the targets are formally evaluated against (Task 7).
TARGET_CATEGORIES = ["fashion", "home-decor", "beauty", "digital-products"]


def build_report() -> dict:
    # ── Keywords (opportunities) ───────────────────────────────────────────
    keywords = fetch_all(
        "trend_keywords",
        columns="id,keyword,category,status,is_seed,yearly_change,trend_lifecycle",
    )
    kw_cat_by_text: dict[str, str] = {
        normalize_keyword(k.get("keyword")): norm_category(k.get("category"))
        for k in keywords
    }
    core_kw = [
        k for k in keywords
        if k.get("status") == "active"
        and not k.get("is_seed")
        and norm_category(k.get("category")) in CORE_CATEGORIES
    ]
    core_kw_ids = {k["id"] for k in core_kw}

    # ── Pins per keyword (evidence + reference-eligible) ───────────────────
    pins = fetch_all(
        "pin_samples",
        columns="trend_keyword_id,save_count,image_url,is_reference_eligible",
        filters={"trend_keyword_id": "not.is.null", "save_count": "gte.100"},
    )
    evidence_by_kw: dict[str, int] = defaultdict(int)
    refelig_by_kw: dict[str, int] = defaultdict(int)
    for p in pins:
        kid = p.get("trend_keyword_id")
        if kid not in core_kw_ids:
            continue
        if (p.get("image_url") or "").strip():
            evidence_by_kw[kid] += 1
        if p.get("is_reference_eligible"):
            refelig_by_kw[kid] += 1

    # ── Products per keyword (via keyword_product_map) ─────────────────────
    kpm = fetch_all("keyword_product_map", columns="keyword_id,product_id")
    pids_by_kw: dict[str, list[str]] = defaultdict(list)
    needed_pids: set[str] = set()
    for r in kpm:
        kid = r.get("keyword_id")
        pid = r.get("product_id")
        if kid in core_kw_ids and pid:
            pids_by_kw[kid].append(pid)
            needed_pids.add(pid)

    products = fetch_all(
        "pin_products",
        columns="id,seed_keyword,source_url,canonical_product_url,image_url,product_name",
    )
    prod_by_id = {p["id"]: p for p in products if p.get("id")}

    # ── Per-category aggregation ───────────────────────────────────────────
    report: dict[str, dict] = {}
    for cat in CORE_CATEGORIES:
        report[cat] = {
            "pinCount": count_exact("pin_samples", filters={"category": cat}),
            "referenceEligiblePinCount": count_exact(
                "pin_samples", filters={"category": cat, "is_reference_eligible": "is.true"}
            ),
            "productCount": 0,
            "qualifiedProductCount": 0,
            "productsWithUrlCount": 0,
            "opportunityCount": 0,
            "launchReadyCount": 0,
            "strongOpportunityCount": 0,
            "testableCount": 0,
            "needsProductsCount": 0,
            "insightOnlyCount": 0,
            "unknownMappingCount": 0,
        }

    for k in core_kw:
        cat = norm_category(k.get("category"))
        bucket = report[cat]
        bucket["opportunityCount"] += 1

        kid = k["id"]
        kid_products = [prod_by_id[pid] for pid in pids_by_kw.get(kid, []) if pid in prod_by_id]

        # category mapping diagnostics
        for prod in kid_products:
            bucket["productCount"] += 1
            has_url = bool((prod.get("source_url") or prod.get("canonical_product_url") or "").strip())
            has_img = bool((prod.get("image_url") or "").strip())
            has_title = bool((prod.get("product_name") or "").strip())
            if has_url:
                bucket["productsWithUrlCount"] += 1
            if has_url and has_img and has_title:
                bucket["qualifiedProductCount"] += 1
            mapped = kw_cat_by_text.get(normalize_keyword(prod.get("seed_keyword")))
            if not mapped or mapped == "unknown":
                bucket["unknownMappingCount"] += 1

        # readiness (canonical logic)
        counts = count_usable_products(kid_products, cat)
        eff = effective_product_count(counts)
        product_tier = availability_tier(eff)
        ref_count = refelig_by_kw.get(kid, 0)
        reference_tier = availability_tier(ref_count)
        pin_evidence = evidence_by_kw.get(kid, 0)
        yoy = float(k.get("yearly_change") or 0)
        trend_score = min(yoy, 500) / 500 * 100
        rising = (k.get("trend_lifecycle") or "").lower() == "rising" or yoy >= 80

        status, _ = compute_readiness_status(
            product_tier=product_tier,
            reference_tier=reference_tier,
            pin_evidence_count=pin_evidence,
            trend_score=trend_score,
            rising=rising,
        )
        if status == "launch_ready":
            bucket["launchReadyCount"] += 1
        elif status == "strong_opportunity":
            bucket["strongOpportunityCount"] += 1
        elif status == "testable":
            bucket["testableCount"] += 1
        elif status == "needs_products":
            bucket["needsProductsCount"] += 1
        elif status == "insight_only":
            bucket["insightOnlyCount"] += 1

    return report


def gap_analysis(rep: dict) -> dict:
    """Current vs target with recommended next action, for TARGET_CATEGORIES."""
    out: dict[str, dict] = {}
    for cat in TARGET_CATEGORIES:
        b = rep.get(cat)
        if not b:
            continue
        current = {
            "launch_ready": b["launchReadyCount"] + b["strongOpportunityCount"],
            "testable": b["testableCount"],
            "reference_eligible_pins": b["referenceEligiblePinCount"],
            "qualified_products": b["qualifiedProductCount"],
        }
        gaps = {k: max(0, TARGETS[k] - current[k]) for k in TARGETS}

        # recommend the action that closes the largest *proportional* gap
        actions = []
        if gaps["qualified_products"] > 0:
            actions.append(
                f"link/backfill products (+{gaps['qualified_products']} qualified) "
                f"via category_backfill_dryrun + product_link_dryrun, then STL"
            )
        if gaps["reference_eligible_pins"] > 0:
            actions.append(
                f"crawl more high-save {cat} pins (+{gaps['reference_eligible_pins']} ref-eligible needed)"
            )
        if gaps["launch_ready"] > 0 and gaps["qualified_products"] == 0:
            actions.append(f"sufficient supply; promote {gaps['launch_ready']} testable→launch_ready")
        out[cat] = {
            "current": current,
            "target": dict(TARGETS),
            "gap": gaps,
            "meets_all_targets": all(v == 0 for v in gaps.values()),
            "recommended_actions": actions or ["meets all targets"],
        }
    return out


def print_report(rep: dict) -> None:
    line = "═" * 78
    print(f"\n{line}\n  CORE CATEGORY LAUNCH REPORT\n{line}")
    hdr = (f"  {'category':<16}{'pins':>6}{'refPin':>7}{'prods':>6}{'wURL':>6}"
           f"{'opps':>6}{'launch':>7}{'strong':>7}{'testbl':>7}{'needs':>6}{'unkMap':>7}")
    print(hdr)
    print("  " + "─" * 76)
    for cat, b in rep.items():
        print(
            f"  {cat:<16}{b['pinCount']:>6}{b['referenceEligiblePinCount']:>7}"
            f"{b['productCount']:>6}{b['productsWithUrlCount']:>6}{b['opportunityCount']:>6}"
            f"{b['launchReadyCount']:>7}{b['strongOpportunityCount']:>7}{b['testableCount']:>7}"
            f"{b['needsProductsCount']:>6}{b['unknownMappingCount']:>7}"
        )
    print(line)


def print_gap(gaps: dict) -> None:
    line = "═" * 78
    print(f"\n{line}\n  CORE CATEGORY GAP vs MVP TARGETS\n{line}")
    print(f"  targets: launch_ready>={TARGETS['launch_ready']}  testable>={TARGETS['testable']}  "
          f"ref_pins>={TARGETS['reference_eligible_pins']}  qualified_products>={TARGETS['qualified_products']}")
    for cat, g in gaps.items():
        c, t, gp = g["current"], g["target"], g["gap"]
        status = "OK" if g["meets_all_targets"] else "GAP"
        print(f"\n  [{status}] {cat}")
        print(f"     launch_ready  {c['launch_ready']:>4} / {t['launch_ready']:<4} gap {gp['launch_ready']}")
        print(f"     testable      {c['testable']:>4} / {t['testable']:<4} gap {gp['testable']}")
        print(f"     ref_pins      {c['reference_eligible_pins']:>4} / {t['reference_eligible_pins']:<4} gap {gp['reference_eligible_pins']}")
        print(f"     qual_products {c['qualified_products']:>4} / {t['qualified_products']:<4} gap {gp['qualified_products']}")
        for a in g["recommended_actions"]:
            print(f"       -> {a}")
    print(line)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="VibePin core-category launch report")
    ap.add_argument("--json", action="store_true", help="Emit JSON instead of pretty text")
    args = ap.parse_args()
    report = build_report()
    gaps = gap_analysis(report)
    if args.json:
        print(json.dumps({"categories": report, "gap_analysis": gaps}, indent=2, ensure_ascii=False))
    else:
        print_report(report)
        print_gap(gaps)
