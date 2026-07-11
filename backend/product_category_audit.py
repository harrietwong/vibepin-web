"""
product_category_audit.py — quantify the unknown product-category problem by cause.

Read-only. No schema or data changes.

A product's category is derived via seed_keyword -> trend_keywords.category.
"Unknown" = seed_keyword missing, unresolved, or maps to a null/unknown category.

Usage:
  python product_category_audit.py
  python product_category_audit.py --json
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from urllib.parse import urlparse

from report_utils import fetch_all, normalize_keyword, norm_category

PRODUCT_COLUMNS = (
    "id,seed_keyword,parent_pin_id,product_name,source_url,canonical_product_url,"
    "image_url,domain,normalized_merchant,source_platform,product_type,"
    "digital_format,is_seed,product_signal_confidence"
)


def _domain_of(p: dict) -> str:
    d = (p.get("domain") or p.get("normalized_merchant") or "").strip().lower()
    if d:
        return d.replace("www.", "")
    url = (p.get("source_url") or p.get("canonical_product_url") or "").strip()
    if url:
        try:
            return (urlparse(url).netloc or "").lower().replace("www.", "")
        except Exception:
            return "unparseable"
    return "none"


def build_report() -> dict:
    keywords = fetch_all("trend_keywords", columns="keyword,category")
    kw_cat = {normalize_keyword(k.get("keyword")): norm_category(k.get("category")) for k in keywords}
    known_kw = set(kw_cat.keys())

    products = fetch_all("pin_products", columns=PRODUCT_COLUMNS)
    products = [p for p in products if not p.get("is_seed")]
    total = len(products)

    unknown: list[dict] = []
    for p in products:
        sk = normalize_keyword(p.get("seed_keyword"))
        cat = kw_cat.get(sk)
        if not cat or cat == "unknown":
            unknown.append(p)

    n_unknown = len(unknown)

    # ── Breakdowns over the unknown pool ───────────────────────────────────
    by_type: Counter = Counter()
    by_format: Counter = Counter()
    by_domain: Counter = Counter()
    with_url = with_image = with_parent = with_seed = 0

    # cause attribution (mutually-ordered: first matching cause wins)
    cause: Counter = Counter()

    for p in unknown:
        by_type[p.get("product_type") or "null"] += 1
        by_format[p.get("digital_format") or "none"] += 1
        by_domain[_domain_of(p)] += 1
        has_url = bool((p.get("source_url") or p.get("canonical_product_url") or "").strip())
        has_img = bool((p.get("image_url") or "").strip())
        has_parent = bool((p.get("parent_pin_id") or "").strip() if isinstance(p.get("parent_pin_id"), str) else p.get("parent_pin_id"))
        sk_raw = (p.get("seed_keyword") or "").strip()
        if has_url:
            with_url += 1
        if has_img:
            with_image += 1
        if has_parent:
            with_parent += 1
        if sk_raw:
            with_seed += 1

        # cause
        if not sk_raw:
            cause["missing_seed_keyword"] += 1
        elif normalize_keyword(sk_raw) not in known_kw:
            cause["seed_keyword_not_in_trend_keywords"] += 1
        else:
            cause["seed_keyword_maps_to_unknown_category"] += 1
        if not has_parent:
            cause["_also_missing_parent_pin_id"] += 1
        if not (p.get("digital_format")):
            cause["_also_digital_format_unset"] += 1

    return {
        "total_products": total,
        "unknown_count": n_unknown,
        "unknown_rate": round(n_unknown / total, 4) if total else 0.0,
        "unknown_with_url": with_url,
        "unknown_with_image": with_image,
        "unknown_with_parent_pin_id": with_parent,
        "unknown_with_seed_keyword": with_seed,
        "unknown_by_product_type": dict(by_type.most_common()),
        "unknown_by_digital_format": dict(by_format.most_common()),
        "unknown_by_domain_top20": dict(by_domain.most_common(20)),
        "top_causes": {
            "missing_seed_keyword": cause.get("missing_seed_keyword", 0),
            "seed_keyword_not_in_trend_keywords": cause.get("seed_keyword_not_in_trend_keywords", 0),
            "seed_keyword_maps_to_unknown_category": cause.get("seed_keyword_maps_to_unknown_category", 0),
            "also_missing_parent_pin_id": cause.get("_also_missing_parent_pin_id", 0),
            "also_digital_format_unset": cause.get("_also_digital_format_unset", 0),
        },
    }


def print_report(r: dict) -> None:
    line = "─" * 64
    print(f"\n{line}\n  UNKNOWN PRODUCT CATEGORY AUDIT\n{line}")
    print(f"  Total products              : {r['total_products']}")
    print(f"  Unknown category            : {r['unknown_count']}  ({r['unknown_rate']*100:.1f}%)")
    print(f"  Unknown with URL            : {r['unknown_with_url']}")
    print(f"  Unknown with image          : {r['unknown_with_image']}")
    print(f"  Unknown with parent_pin_id  : {r['unknown_with_parent_pin_id']}")
    print(f"  Unknown with seed_keyword   : {r['unknown_with_seed_keyword']}")
    print(f"\n  Unknown by product_type:")
    for k, v in r["unknown_by_product_type"].items():
        print(f"    {k:<14} {v}")
    print(f"\n  Unknown by digital_format:")
    for k, v in r["unknown_by_digital_format"].items():
        print(f"    {str(k):<14} {v}")
    print(f"\n  Unknown by domain (top 20):")
    for k, v in r["unknown_by_domain_top20"].items():
        print(f"    {k:<28} {v}")
    print(f"\n  Top causes:")
    for k, v in r["top_causes"].items():
        print(f"    {k:<42} {v}")
    print(line)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Unknown product category audit")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    rep = build_report()
    if args.json:
        print(json.dumps(rep, indent=2, ensure_ascii=False))
    else:
        print_report(rep)
