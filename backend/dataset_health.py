"""
dataset_health.py — MVP dataset coverage / product-availability diagnostics.

Read-only report. Does NOT change the crawler, scoring, schema, or any data.

Reports:
  • products by category (mapped via seed_keyword → trend_keywords.category)
  • unknown products count + unknown rate
  • products with URL / image / price
  • products by digital_format / product_type
  • linked products per opportunity (distribution + avg/median)
  • opportunities (active keywords) with <5, <15, and 15+ linked products

Usage:
  python dataset_health.py            # pretty report
  python dataset_health.py --json     # machine-readable JSON
"""

from __future__ import annotations

import argparse
import json
import statistics
from collections import Counter, defaultdict

from report_utils import fetch_all, normalize_keyword, norm_category


def build_report() -> dict:
    # ── Keyword → category map (for product category mapping) ──────────────
    keywords = fetch_all(
        "trend_keywords",
        columns="id,keyword,category,status,is_seed",
    )
    kw_cat_by_text: dict[str, str] = {}
    for k in keywords:
        kw_cat_by_text[normalize_keyword(k.get("keyword"))] = norm_category(k.get("category"))

    active_kw = [
        k for k in keywords
        if (k.get("status") == "active") and not k.get("is_seed")
    ]
    active_kw_ids = {k["id"] for k in active_kw}

    # ── Products ───────────────────────────────────────────────────────────
    products = fetch_all(
        "pin_products",
        columns=(
            "id,seed_keyword,source_url,canonical_product_url,image_url,"
            "price,product_type,digital_format,is_seed"
        ),
    )
    products = [p for p in products if not p.get("is_seed")]

    by_category: Counter = Counter()
    by_format: Counter = Counter()
    by_type: Counter = Counter()
    unknown = with_url = with_image = with_price = 0

    for p in products:
        cat = kw_cat_by_text.get(normalize_keyword(p.get("seed_keyword")))
        if cat and cat != "unknown":
            by_category[cat] += 1
        else:
            unknown += 1
        if (p.get("source_url") or p.get("canonical_product_url") or "").strip():
            with_url += 1
        if (p.get("image_url") or "").strip():
            with_image += 1
        if p.get("price") not in (None, ""):
            with_price += 1
        by_format[p.get("digital_format") or "none"] += 1
        by_type[p.get("product_type") or "unclassified"] += 1

    total_products = len(products)
    unknown_rate = round(unknown / total_products, 4) if total_products else 0.0

    # ── Linked products per opportunity (active keyword) ───────────────────
    kpm = fetch_all("keyword_product_map", columns="keyword_id,product_id")
    products_per_kw: dict[str, set] = defaultdict(set)
    for r in kpm:
        kid = r.get("keyword_id")
        pid = r.get("product_id")
        if kid and pid:
            products_per_kw[kid].add(pid)

    counts_per_opp = [len(products_per_kw.get(kid, ())) for kid in active_kw_ids]
    opp_total = len(counts_per_opp)
    lt5 = sum(1 for c in counts_per_opp if c < 5)
    lt15 = sum(1 for c in counts_per_opp if c < 15)
    gte15 = sum(1 for c in counts_per_opp if c >= 15)
    avg_products = round(sum(counts_per_opp) / opp_total, 2) if opp_total else 0.0
    median_products = statistics.median(counts_per_opp) if counts_per_opp else 0

    return {
        "products": {
            "total": total_products,
            "unknownCount": unknown,
            "unknownRate": unknown_rate,
            "withUrl": with_url,
            "withImage": with_image,
            "withPrice": with_price,
            "byCategory": dict(by_category.most_common()),
            "byDigitalFormat": dict(by_format.most_common()),
            "byProductType": dict(by_type.most_common()),
        },
        "opportunities": {
            "activeKeywordOpportunities": opp_total,
            "avgProductsPerOpportunity": avg_products,
            "medianProductsPerOpportunity": median_products,
            "withFewerThan5Products": lt5,
            "withFewerThan15Products": lt15,
            "with15PlusProducts": gte15,
        },
    }


def print_report(rep: dict) -> None:
    p = rep["products"]
    o = rep["opportunities"]
    line = "─" * 60
    print(f"\n{line}\n  DATASET HEALTH — PRODUCTS\n{line}")
    print(f"  Total products           : {p['total']}")
    print(f"  Unknown category         : {p['unknownCount']}  ({p['unknownRate']*100:.1f}%)")
    print(f"  With URL                 : {p['withUrl']}")
    print(f"  With image               : {p['withImage']}")
    print(f"  With price (nice-to-have): {p['withPrice']}")
    print(f"\n  Products by category:")
    for cat, n in p["byCategory"].items():
        print(f"    {cat:<24} {n}")
    print(f"\n  Products by digital_format:")
    for fmt, n in p["byDigitalFormat"].items():
        print(f"    {str(fmt):<24} {n}")
    print(f"\n  Products by type:")
    for t, n in p["byProductType"].items():
        print(f"    {str(t):<24} {n}")

    print(f"\n{line}\n  DATASET HEALTH — OPPORTUNITIES (active keywords)\n{line}")
    print(f"  Active keyword opportunities : {o['activeKeywordOpportunities']}")
    print(f"  Avg products / opportunity   : {o['avgProductsPerOpportunity']}")
    print(f"  Median products / opportunity: {o['medianProductsPerOpportunity']}")
    print(f"  < 5 products  (needs_products): {o['withFewerThan5Products']}")
    print(f"  < 15 products (not launch)    : {o['withFewerThan15Products']}")
    print(f"  >= 15 products (launch-grade) : {o['with15PlusProducts']}")
    print(line)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="VibePin dataset health report")
    ap.add_argument("--json", action="store_true", help="Emit JSON instead of pretty text")
    args = ap.parse_args()
    report = build_report()
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print_report(report)
