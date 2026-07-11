"""
audit_coverage.py — P0 Category Data Coverage Report

Queries the DB via PostgREST HEAD requests (exact count per category)
so the 1000-row pagination cap does not affect results.

Usage:
  cd backend
  py audit_coverage.py
  py audit_coverage.py --verbose      # also show all distinct DB category values
"""

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "db"))
from db import _get_http  # type: ignore  # noqa: E402

# ── P0 targets ────────────────────────────────────────────────────────────────
# Each entry: (frontend_slug, display_label, [db_category_aliases])
P0_CATEGORIES = [
    ("home-decor",       "Home Decor",     ["home-decor", "home"]),
    ("beauty",           "Beauty",         ["beauty"]),
    ("fashion",          "Fashion",        ["fashion"]),
    ("wedding",          "Wedding",        ["wedding"]),
    ("diy-crafts",       "DIY & Crafts",   ["diy-crafts", "diy", "diy_and_crafts"]),
    ("food-and-drink",   "Food & Drink",   ["food-and-drink", "food", "food_and_drinks"]),
    ("digital-products", "Digital Products", ["digital-products", "digital", "digital_products"]),
]

READY_THRESHOLDS = dict(
    opportunities    = 50,
    pins             = 300,
    products         = 80,
    top10_with_2pins = 8,
    top10_products   = 4,
    freshness_days   = 7,
)
BETA_THRESHOLDS = dict(
    opportunities    = 20,
    pins             = 100,
    products         = 20,
    top10_with_2pins = 6,
    top10_products   = 2,
    freshness_days   = 14,
)


# ── PostgREST helpers ─────────────────────────────────────────────────────────

def _count(table: str, filters: dict[str, str]) -> int:
    """Return exact row count using HEAD + Prefer: count=exact."""
    http = _get_http()
    params = {k: f"eq.{v}" for k, v in filters.items()}
    resp   = http.head(
        table,
        params=params,
        headers={"Prefer": "count=exact", "Range": "0-0"},
    )
    cr = resp.headers.get("content-range", "")
    try:
        return int(cr.split("/")[-1])
    except (ValueError, IndexError):
        return 0


def _count_multi(table: str, col: str, values: list[str]) -> int:
    """Count rows where col IN values."""
    total = 0
    for v in values:
        total += _count(table, {col: v})
    return total


def _fetch(table: str, select: str, filters: dict[str, str] | None = None,
           order: str | None = None, limit: int = 20) -> list[dict]:
    """Fetch a small result set (no pagination needed — used for top-10 analysis)."""
    http   = _get_http()
    params: dict = {"select": select, "limit": str(limit)}
    for k, v in (filters or {}).items():
        params[k] = f"eq.{v}"
    if order:
        params["order"] = order
    resp   = http.get(table, params=params)
    if resp.status_code not in (200, 206):
        return []
    return resp.json()


def _fetch_multi(table: str, select: str, col: str, values: list[str],
                 order: str | None = None, limit: int = 20) -> list[dict]:
    """Fetch rows where col IN any of values (union across multiple GETs)."""
    seen = set()
    rows = []
    for v in values:
        for r in _fetch(table, select, {col: v}, order=order, limit=limit):
            key = r.get("keyword_id") or r.get("id") or str(r)
            if key not in seen:
                seen.add(key)
                rows.append(r)
    # Re-sort if needed
    if order and rows:
        col_s, direction = (order.split(".") + ["desc"])[:2]
        rows.sort(key=lambda x: x.get(col_s) or 0, reverse=(direction == "desc"))
    return rows[:limit]


def recommend_status(row: dict) -> str:
    def meets(t: dict) -> bool:
        if row["opportunities"] < t["opportunities"]:         return False
        if row["pins"]          < t["pins"]:                  return False
        if row["products"]      < t["products"]:              return False
        if row["top10_2pins"]   < t["top10_with_2pins"]:      return False
        if row["top10_products"] < t["top10_products"]:       return False
        if (row["freshness_days"] is not None
                and row["freshness_days"] > t["freshness_days"]):
            return False
        return True
    if meets(READY_THRESHOLDS): return "[READY]"
    if meets(BETA_THRESHOLDS):  return "[BETA] "
    return "[SOON] "


def main(verbose: bool = False) -> None:
    print("\n" + "=" * 80)
    print("  VibePin P0 Category Coverage Report")
    print("  " + datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))
    print("=" * 80)

    # ── Verbose: all distinct DB category values ────────────────────────────────
    if verbose:
        print("\n-- Distinct category values present in DB (opportunities view):")
        opps_sample = _fetch(
            "trend_opportunities_view",
            "category",
            limit=1000,
        )
        # Unique categories from opp view
        seen_cats: dict[str, int] = {}
        for o in opps_sample:
            c = o.get("category", "")
            seen_cats[c] = seen_cats.get(c, 0) + 1

        for c in sorted(seen_cats):
            total = _count("trend_opportunities_view", {"category": c})
            pins  = _count("pin_samples", {"category": c})
            print(f"  {c:<30} opps={total:>4}  pins={pins:>5}")
        print()

    # ── Per-category audit ──────────────────────────────────────────────────────
    print("\nQuerying counts per category (exact)...")

    header = (
        f"  {'Category':<20} {'Opps':>5} {'Pins':>6} {'Prods':>6}"
        f" {'Top10:2p':>9} {'Top10:pr':>9} {'Fresh':>6} Status"
    )
    sep = "  " + "-" * (len(header) - 2)
    print("\n" + header)
    print(sep)

    report_rows = []

    for slug, label, db_aliases in P0_CATEGORIES:
        # -- Opportunities ---------------------------------------------------
        opp_count = sum(_count("trend_opportunities_view", {"category": a}) for a in db_aliases)

        # -- Pin samples -----------------------------------------------------
        pin_count = sum(_count("pin_samples", {"category": a}) for a in db_aliases)

        # -- Products (via trend_opportunities_view.linked_products_count sum)
        top10_opps = _fetch_multi(
            "trend_opportunities_view",
            "keyword_id,keyword,category,opportunity_score,linked_pins_count,linked_products_count,last_scored_at",
            "category",
            db_aliases,
            order="opportunity_score.desc.nullslast",
            limit=10,
        )
        top10_2pins    = sum(1 for o in top10_opps if (o.get("linked_pins_count") or 0) >= 2)
        top10_products = sum(1 for o in top10_opps if (o.get("linked_products_count") or 0) >= 1)

        # Total product count: sum linked_products_count across ALL opps
        all_opps = _fetch_multi(
            "trend_opportunities_view",
            "keyword_id,linked_products_count",
            "category",
            db_aliases,
            limit=200,
        )
        prod_count = sum(o.get("linked_products_count") or 0 for o in all_opps)

        # -- Freshness -------------------------------------------------------
        scored_dates = [o["last_scored_at"] for o in top10_opps if o.get("last_scored_at")]
        freshness_str  = "n/a"
        freshness_days = None
        if scored_dates:
            latest = max(scored_dates)
            try:
                dt    = datetime.fromisoformat(latest.replace("Z", "+00:00"))
                delta = (datetime.now(timezone.utc) - dt).days
                freshness_days = delta
                freshness_str  = f"{delta}d"
            except Exception:
                freshness_str = latest[:10]

        row = dict(
            slug=slug, label=label,
            opportunities=opp_count,
            pins=pin_count,
            products=prod_count,
            top10_2pins=top10_2pins,
            top10_products=top10_products,
            freshness_str=freshness_str,
            freshness_days=freshness_days,
        )
        report_rows.append(row)

        status = recommend_status(row)
        print(
            f"  {label:<20} {opp_count:>5} {pin_count:>6} {prod_count:>6}"
            f" {top10_2pins:>9} {top10_products:>9} {freshness_str:>6}  {status}"
        )

    print(sep)

    # ── Gap analysis ────────────────────────────────────────────────────────────
    print("\n-- Gap Analysis (vs thresholds):")
    for row in report_rows:
        status = recommend_status(row)
        t = BETA_THRESHOLDS if "SOON" in status else READY_THRESHOLDS

        gaps = []
        if "SOON" in status:
            bt = BETA_THRESHOLDS
            if row["opportunities"] < bt["opportunities"]:
                gaps.append(f"opps:{row['opportunities']}/{bt['opportunities']}")
            if row["pins"] < bt["pins"]:
                gaps.append(f"pins:{row['pins']}/{bt['pins']}")
            if row["products"] < bt["products"]:
                gaps.append(f"products:{row['products']}/{bt['products']}")
            if row["top10_2pins"] < bt["top10_with_2pins"]:
                gaps.append(f"top10_2p:{row['top10_2pins']}/{bt['top10_with_2pins']}")
        elif "BETA" in status:
            rt = READY_THRESHOLDS
            if row["opportunities"] < rt["opportunities"]:
                gaps.append(f"opps:{row['opportunities']}/{rt['opportunities']}")
            if row["pins"] < rt["pins"]:
                gaps.append(f"pins:{row['pins']}/{rt['pins']}")
            if row["products"] < rt["products"]:
                gaps.append(f"products:{row['products']}/{rt['products']}")

        if "READY" in status:
            print(f"  {row['label']:<20} [READY] meets all ready thresholds")
        elif "BETA" in status:
            need = ", ".join(gaps) if gaps else "none — ready candidate"
            print(f"  {row['label']:<20} [BETA]  ready gaps: {need}")
        else:
            need = ", ".join(gaps) if gaps else "—"
            print(f"  {row['label']:<20} [SOON]  beta gaps:  {need}")

    # ── Action priority ──────────────────────────────────────────────────────────
    print("\n-- Action Priority to reach Beta:")
    soon_rows = [r for r in report_rows if "SOON" in recommend_status(r)]
    beta_rows = [r for r in report_rows if "BETA" in recommend_status(r)]
    ready_rows = [r for r in report_rows if "READY" in recommend_status(r)]

    if ready_rows:
        print(f"  Ready now : {', '.join(r['label'] for r in ready_rows)}")
    if beta_rows:
        print(f"  Beta now  : {', '.join(r['label'] for r in beta_rows)}")
    if soon_rows:
        print(f"  Need work : {', '.join(r['label'] for r in soon_rows)}")
        pin_needed = [(r['label'], max(0, 100 - r['pins'])) for r in soon_rows]
        prod_needed = [(r['label'], max(0, 20 - r['products'])) for r in soon_rows]
        pin_gap_str  = ", ".join(f"{l} +{n}" for l, n in pin_needed  if n > 0)
        prod_gap_str = ", ".join(f"{l} +{n}" for l, n in prod_needed if n > 0)
        print(f"\n  Pin gap   : {pin_gap_str}")
        print(f"  Prod gap  : {prod_gap_str}")

    print("\n  Next steps:")
    print("    1. Run scraper for pin-deficient categories:")
    for r in soon_rows:
        if r['pins'] < 100:
            need = 100 - r['pins']
            print(f"       py pipeline.py --step crawl --category {r['slug']}  # need +{need} pins")
    print("    2. Run shop_the_look for product-deficient categories")
    print("    3. Run: py pipeline.py --step score")
    print("    4. Re-run this audit to verify")
    print()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--verbose", "-v", action="store_true",
                    help="show all distinct DB category values")
    args = ap.parse_args()
    main(verbose=args.verbose)
