#!/usr/bin/env python3
"""
check_dataset_health.py — MVP dataset health + core category launch gate report.

Usage:
  python scripts/check_dataset_health.py
  python scripts/check_dataset_health.py --core-only
"""

from __future__ import annotations

import argparse
import os
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "db"))

from category_percentiles import CategoryPercentileIndex  # noqa: E402
from opportunity_readiness import (  # noqa: E402
    availability_tier,
    build_readiness_payload,
    effective_product_count,
    count_usable_products,
)

CORE_CATEGORIES = (
    "fashion",
    "womens-fashion",
    "home-decor",
    "beauty",
    "digital-products",
)


def _count_since(http, table: str, column: str, since: datetime) -> int | None:
    try:
        iso = since.isoformat()
        resp = http.head(
            table,
            params={"limit": "0", "select": "id", column: f"gte.{iso}"},
            headers={"Prefer": "count=exact"},
        )
        cr = resp.headers.get("Content-Range", "")
        if "/" in cr:
            total = cr.split("/")[-1]
            return int(total) if total.isdigit() else None
    except Exception:
        pass
    return None


def _head_count(http, table: str, filters: dict | None = None) -> int | None:
    try:
        params: dict = {"limit": "0", "select": "id"}
        for col, val in (filters or {}).items():
            params[col] = val if "." in str(val) else f"eq.{val}"
        resp = http.head(table, params=params, headers={"Prefer": "count=exact"})
        cr = resp.headers.get("Content-Range", "")
        if "/" in cr:
            total = cr.split("/")[-1]
            return int(total) if total.isdigit() else None
    except Exception:
        pass
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="VibePin dataset health report")
    ap.add_argument("--core-only", action="store_true", help="Only print core category launch gate")
    args = ap.parse_args()

    from db import _get_http, select_many  # type: ignore

    http = _get_http()
    now = datetime.now(tz=timezone.utc)

    kws = select_many("trend_keywords", filters={"status": "active"}, limit=5000)
    kpm = select_many("keyword_product_map", limit=25000)
    prods = select_many("pin_products", limit=10000)
    opps = select_many("opportunities", limit=5000)
    pins = select_many("pin_samples", filters={"save_count": "gte.500"}, limit=15000)

    kw_cat = {k["id"]: k.get("category") or "unknown" for k in kws}
    kw_by_id = {k["id"]: k for k in kws}
    prod_by_kw: dict[str, list[dict]] = defaultdict(list)
    prod_ids_by_kw: dict[str, set[str]] = defaultdict(set)

    prod_map = {p["id"]: p for p in prods if p.get("id")}
    for row in kpm:
        kid = row.get("keyword_id")
        pid = row.get("product_id")
        if kid and pid and pid in prod_map and pid not in prod_ids_by_kw[kid]:
            prod_ids_by_kw[kid].add(pid)
            prod_by_kw[kid].append(prod_map[pid])

    pin_by_kw: dict[str, list[dict]] = defaultdict(list)
    ref_by_kw: dict[str, int] = defaultdict(int)
    for p in pins:
        kid = p.get("trend_keyword_id")
        if kid:
            pin_by_kw[kid].append(p)
            if p.get("is_reference_eligible"):
                ref_by_kw[kid] += 1

    prod_cat = Counter()
    unknown_products = 0
    digi_fmt = Counter()
    offer = Counter()
    for p in prods:
        sk = p.get("seed_keyword")
        cat = "unknown"
        for k in kws:
            if k.get("keyword") == sk:
                cat = k.get("category") or "unknown"
                break
        if cat == "unknown":
            unknown_products += 1
        prod_cat[cat] += 1
        offer[p.get("product_type") or "null"] += 1
        if p.get("product_type") == "digital":
            digi_fmt[p.get("digital_format") or "null"] += 1

    with_url = sum(1 for p in prods if p.get("source_url"))
    with_image = sum(1 for p in prods if p.get("image_url"))
    with_price = sum(1 for p in prods if p.get("price"))

    readiness_counts = Counter()
    prod_tier_opp = Counter()
    lt5 = lt15 = gte15 = 0
    prods_per_kw: list[int] = []

    for k in kws:
        kid = k["id"]
        plist = prod_by_kw.get(kid, [])
        eff = effective_product_count(count_usable_products(plist, k.get("category")))
        prods_per_kw.append(eff)
        tier = availability_tier(eff)
        prod_tier_opp[tier] += 1
        if eff < 5:
            lt5 += 1
        if eff < 15:
            lt15 += 1
        else:
            gte15 += 1

        rd = build_readiness_payload(
            opportunity_id=None,
            keyword_id=kid,
            category=k.get("category"),
            pin_evidence_count=len(pin_by_kw.get(kid, [])),
            reference_eligible_count=ref_by_kw.get(kid, 0),
            total_saves=sum(int(x.get("save_count") or 0) for x in pin_by_kw.get(kid, [])),
            avg_save_velocity=None,
            trend_score=float(k.get("yearly_change") or 0),
            freshness_score=0,
            products=plist,
            rising=float(k.get("yearly_change") or 0) >= 80,
        )
        readiness_counts[rd["readinessStatus"]] += 1

    pin_cat = Counter()
    ref_cat = Counter()
    for p in pins:
        cat = p.get("category") or kw_cat.get(p.get("trend_keyword_id"), "unknown")
        pin_cat[cat] += 1
        if p.get("is_reference_eligible"):
            ref_cat[cat] += 1

    opp_cat = Counter(o.get("category") or "unknown" for o in opps)

    if args.core_only:
        print("=== CORE CATEGORY LAUNCH GATE ===")
        for cat in CORE_CATEGORIES:
            pin_n = pin_cat.get(cat, 0)
            ref_n = ref_cat.get(cat, 0)
            prod_n = prod_cat.get(cat, 0)
            opp_n = opp_cat.get(cat, 0)
            launch = testable = 0
            url_n = 0
            unk = 0
            for k in kws:
                if (k.get("category") or "") != cat:
                    continue
                kid = k["id"]
                plist = prod_by_kw.get(kid, [])
                eff = effective_product_count(count_usable_products(plist, cat))
                rd = build_readiness_payload(
                    opportunity_id=None,
                    keyword_id=kid,
                    category=cat,
                    pin_evidence_count=len(pin_by_kw.get(kid, [])),
                    reference_eligible_count=ref_by_kw.get(kid, 0),
                    total_saves=0,
                    avg_save_velocity=None,
                    trend_score=0,
                    freshness_score=0,
                    products=plist,
                )
                if rd["readinessStatus"] == "launch_ready":
                    launch += 1
                if rd["readinessStatus"] in ("testable", "launch_ready", "strong_opportunity"):
                    testable += 1
                url_n += sum(1 for p in plist if p.get("source_url"))
                for p in plist:
                    if not p.get("seed_keyword") or not any(
                        x.get("keyword") == p.get("seed_keyword") for x in kws
                    ):
                        unk += 1
            print(f"\n{cat}:")
            print(f"  pins: {pin_n}  reference_eligible: {ref_n}")
            print(f"  products: {prod_n}  opportunities: {opp_n}")
            print(f"  launch_ready keywords: {launch}  testable+: {testable}")
            print(f"  products_with_url (linked): {url_n}  unknown_mapping: {unk}")
        return 0

    print("VibePin Dataset Health Report")
    print("=" * 44)
    print(f"Generated: {now.strftime('%Y-%m-%d %H:%M UTC')}\n")

    print("--- Products by category ---")
    for c, n in prod_cat.most_common(25):
        print(f"  {c}: {n}")
    print(f"\n  unknown products: {unknown_products}  unknown_rate: {unknown_products/max(len(prods),1):.1%}")
    print(f"  with URL: {with_url}/{len(prods)}  with image: {with_image}/{len(prods)}  with price: {with_price}/{len(prods)}")

    print("\n--- Products by offer family ---")
    for k, v in offer.most_common():
        print(f"  {k}: {v}")

    print("\n--- Digital by digital_format ---")
    for k, v in digi_fmt.most_common():
        print(f"  {k}: {v}")

    print("\n--- Opportunities by category ---")
    for c, n in opp_cat.most_common(20):
        print(f"  {c}: {n}")

    print("\n--- Product availability per keyword ---")
    if prods_per_kw:
        print(f"  avg: {statistics.mean(prods_per_kw):.2f}  median: {statistics.median(prods_per_kw):.1f}")
        print(f"  opportunities <5 products: {lt5}/{len(kws)}")
        print(f"  opportunities <15 products: {lt15}/{len(kws)}")
        print(f"  opportunities 15+ products: {gte15}/{len(kws)}")
    print("  tier distribution:", dict(prod_tier_opp))
    print("  readiness status:", dict(readiness_counts))

    print("\n--- Pin collection windows ---")
    for label, dt in [("24h", now - timedelta(hours=24)), ("7d", now - timedelta(days=7)), ("30d", now - timedelta(days=30))]:
        print(f"  {label}: pins={_count_since(http, 'pin_samples', 'scraped_at', dt)}  products={_count_since(http, 'pin_products', 'scraped_at', dt)}")

    pct_index = CategoryPercentileIndex.from_pins(pins)
    sample = pins[:3]
    if sample:
        print("\n--- Category percentile sample (top 3 loaded pins) ---")
        for p in sample:
            m = pct_index.metrics_for_pin(p)
            print(f"  {p.get('category')} saves={p.get('save_count')} -> {m}")

    print("\n--- Core category launch gate ---")
    for cat in CORE_CATEGORIES:
        print(f"  {cat}: pins={pin_cat.get(cat,0)} ref={ref_cat.get(cat,0)} products={prod_cat.get(cat,0)} opps={opp_cat.get(cat,0)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
