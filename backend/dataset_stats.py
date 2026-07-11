"""
dataset_stats.py — Coverage metrics and funnel audit for VibePin Intelligence Pipeline.

Usage:
  py dataset_stats.py                        # summary table
  py dataset_stats.py --json                 # machine-readable JSON
  py dataset_stats.py --targets              # progress toward coverage targets
  py dataset_stats.py --funnel               # full pipeline funnel report
  py dataset_stats.py --funnel --category home    # funnel for one category
  py dataset_stats.py --funnel --category beauty
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent

# ── Coverage targets ──────────────────────────────────────────────────────────
TARGETS = {
    "interests":          20,
    "trend_keywords":    500,
    "keyword_expansions": 2000,
    "pins":              5000,
    "products":          1000,
}

# ── ANSI ──────────────────────────────────────────────────────────────────────
G = "\033[92m"; Y = "\033[93m"; C = "\033[96m"; R = "\033[91m"; B = "\033[1m"; X = "\033[0m"


# ── DB helpers ────────────────────────────────────────────────────────────────

def _db():
    sys.path.insert(0, str(ROOT / "db"))
    from db import select_many  # type: ignore
    return select_many


def _q(table: str, filters: dict | None = None,
       order: str | None = None, limit: int | None = None) -> list[dict]:
    try:
        select = _db()
        return select(table, filters=filters, order=order, limit=limit) or []
    except Exception as exc:
        print(f"  [db] {table}: {exc}", file=sys.stderr)
        return []


# ── Aggregation helpers ───────────────────────────────────────────────────────

def _count_by(rows: list[dict], key: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for r in rows:
        v = r.get(key) or "unknown"
        counts[v] = counts.get(v, 0) + 1
    return dict(sorted(counts.items(), key=lambda x: -x[1]))


def _avg_by(rows: list[dict], group_key: str, val_key: str) -> dict[str, float]:
    buckets: dict[str, list[float]] = {}
    for r in rows:
        g = r.get(group_key) or "unknown"
        v = r.get(val_key)
        if v is not None:
            try:
                buckets.setdefault(g, []).append(float(v))
            except (TypeError, ValueError):
                pass
    return {g: round(sum(vs) / len(vs), 1) for g, vs in buckets.items()}


# ── Stats collection ──────────────────────────────────────────────────────────

def collect_stats() -> dict:
    stats: dict = {}

    # ── Top-level counts ─────────────────────────────────────────────────────
    interests  = _q("trend_interests", filters={"is_active": "true"})
    keywords   = _q("trend_keywords",  filters={"status": "active"})
    expansions = _q("keyword_expansions")
    queue_all  = _q("crawl_queue")
    pins       = _q("pin_samples", order="save_count.desc", limit=10_000)
    products   = _q("pin_products", order="save_count.desc", limit=5_000)

    stats["interests"]          = len(interests)
    stats["trend_keywords"]     = len(keywords)
    stats["keyword_expansions"] = len(expansions)
    stats["pins"]               = len(pins)
    stats["products"]           = len(products)

    # Queue breakdown
    queue_by_status = _count_by(queue_all, "status")
    stats["queue"] = {
        "total":      len(queue_all),
        "pending":    queue_by_status.get("pending", 0),
        "completed":  queue_by_status.get("completed", 0),
        "processing": queue_by_status.get("processing", 0),
        "failed":     queue_by_status.get("failed", 0),
    }

    # ── Interest breakdown ───────────────────────────────────────────────────
    stats["interests_list"] = [
        {"slug": r.get("interest_slug"), "name": r.get("interest_name"),
         "keyword_count": r.get("keyword_count", 0),
         "last_fetched": r.get("last_fetched_at")}
        for r in interests
    ]

    # ── Pins by category ─────────────────────────────────────────────────────
    stats["pins_by_category"] = _count_by(pins, "category")

    # ── Pins by trend_stage ──────────────────────────────────────────────────
    stats["pins_by_stage"] = _count_by(pins, "trend_stage")

    # ── Top save velocity by category ────────────────────────────────────────
    avg_vel = _avg_by(pins, "category", "save_velocity")
    stats["avg_velocity_by_category"] = dict(
        sorted(avg_vel.items(), key=lambda x: -x[1])[:10]
    )

    # ── High-growth pins ─────────────────────────────────────────────────────
    stats["high_growth_pins"] = sum(
        1 for p in pins if p.get("is_high_growth")
    )

    # ── Products by category (via seed_keyword) ──────────────────────────────
    stats["products_by_category"] = _count_by(products, "seed_keyword")

    # ── Products by merchant/domain ──────────────────────────────────────────
    stats["products_by_domain"] = dict(
        list(_count_by(products, "domain").items())[:10]
    )

    # ── Pins with ecommerce link ─────────────────────────────────────────────
    stats["ecommerce_pins"] = sum(1 for p in pins if p.get("is_ecommerce"))

    # ── Freshness (pins created in last 90 days) ─────────────────────────────
    now = datetime.now(tz=timezone.utc)
    fresh = 0
    for p in pins:
        created = p.get("pin_created_at")
        if created:
            try:
                dt = datetime.fromisoformat(str(created).replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                if (now - dt).days <= 90:
                    fresh += 1
            except Exception:
                pass
    stats["fresh_pins_90d"] = fresh

    stats["generated_at"] = now.isoformat()
    return stats


# ── Funnel collection ─────────────────────────────────────────────────────────

# Pin signal tier thresholds (mirrors scraper_v2.py constants)
_PIN_CANDIDATE  = 500
_PIN_VIRAL      = 5_000
_PIN_PREMIUM    = 10_000

# Opportunity confidence thresholds
_CONF_HIGH   = 70.0
_CONF_MEDIUM = 40.0


def collect_funnel_stats(category: str | None = None) -> dict:
    """
    Full pipeline funnel: keywords → queue → pins → products → intelligence.
    If category is given, pin/product counts are filtered to that category.
    """
    funnel: dict = {}

    # ── Trend keywords ───────────────────────────────────────────────────────
    all_kw   = _q("trend_keywords", filters={"status": "active"})
    all_q    = _q("crawl_queue")
    active_kw_texts = {k.get("keyword", "") for k in all_kw if k.get("keyword")}

    if category:
        all_kw = [k for k in all_kw if k.get("category") == category]

    pending   = [q for q in all_q if q.get("status") == "pending"
                 and q.get("keyword") in active_kw_texts]
    completed = [q for q in all_q if q.get("status") == "completed"
                 and q.get("keyword") in active_kw_texts]
    failed    = [q for q in all_q if q.get("status") == "failed"
                 and q.get("keyword") in active_kw_texts]

    if category:
        pending   = [q for q in pending   if q.get("category") == category]
        completed = [q for q in completed if q.get("category") == category]
        failed    = [q for q in failed    if q.get("category") == category]

    funnel["keywords"] = {
        "active":       len(all_kw),
        "queued":       len(pending),
        "crawled":      len(completed),
        "failed":       len(failed),
    }

    # ── Pins ─────────────────────────────────────────────────────────────────
    pin_filters: dict = {}
    if category:
        pin_filters["category"] = category
    all_pins = _q("pin_samples", filters=pin_filters or None, limit=50_000)

    candidate_pins = [p for p in all_pins if int(p.get("save_count") or 0) >= _PIN_CANDIDATE]
    viral_pins     = [p for p in all_pins if int(p.get("save_count") or 0) >= _PIN_VIRAL]
    premium_pins   = [p for p in all_pins if int(p.get("save_count") or 0) >= _PIN_PREMIUM]
    dev_seed_pins  = [p for p in all_pins if p.get("source_type") == "dev_seed"]

    stage_counts: dict[str, int] = {}
    for p in all_pins:
        s = p.get("trend_stage") or "unclassified"
        stage_counts[s] = stage_counts.get(s, 0) + 1

    funnel["pins"] = {
        "total":            len(all_pins),
        "candidate_500":    len(candidate_pins),
        "viral_5k":         len(viral_pins),
        "premium_10k":      len(premium_pins),
        "stl_eligible":     len(viral_pins),
        "dev_seed_tagged":  len(dev_seed_pins),
        "by_stage":         dict(sorted(stage_counts.items(), key=lambda x: -x[1])),
        "rejection_note":   "Rejected pins filtered before DB insert — not tracked",
    }

    # ── Products ─────────────────────────────────────────────────────────────
    all_products = _q("pin_products", limit=10_000)
    if category:
        cat_pin_ids = {p.get("pin_id") for p in all_pins}
        all_products = [p for p in all_products
                        if p.get("parent_pin_id") in cat_pin_ids]

    with_url   = [p for p in all_products if p.get("source_url")]
    with_image = [p for p in all_products if p.get("image_url")]
    stl_src    = [p for p in all_products
                  if int(p.get("source_pin_save_count") or 0) >= _PIN_VIRAL]

    domain_counts: dict[str, int] = {}
    for p in all_products:
        d = p.get("domain") or "unknown"
        domain_counts[d] = domain_counts.get(d, 0) + 1

    funnel["products"] = {
        "total":            len(all_products),
        "with_source_url":  len(with_url),
        "with_image_url":   len(with_image),
        "stl_sourced":      len(stl_src),
        "by_domain":        dict(sorted(domain_counts.items(), key=lambda x: -x[1])[:12]),
    }

    # ── Intelligence ─────────────────────────────────────────────────────────
    all_scores = _q("product_scores", limit=20_000)
    all_kpm    = _q("keyword_product_map", limit=50_000)
    all_opps   = _q("trend_opportunities_view")

    if category:
        all_scores = [s for s in all_scores
                      if s.get("product_id") in {p.get("id") for p in all_products}]
        all_kpm    = [m for m in all_kpm
                      if m.get("product_id") in {p.get("id") for p in all_products}]
        all_opps   = [o for o in all_opps if o.get("category") == category]

    opps_scored  = [o for o in all_opps if o.get("opportunity_score") is not None]
    high_conf    = [s for s in all_scores
                    if float(s.get("opportunity_score") or 0) >= _CONF_HIGH]
    mid_conf     = [s for s in all_scores
                    if _CONF_MEDIUM <= float(s.get("opportunity_score") or 0) < _CONF_HIGH]
    low_conf     = [s for s in all_scores
                    if float(s.get("opportunity_score") or 0) < _CONF_MEDIUM]

    total_prods = len(all_products)
    scored      = len(all_scores)
    coverage    = f"{100 * scored // max(1, total_prods)}%" if total_prods else "n/a"

    funnel["intelligence"] = {
        "product_scores":       scored,
        "keyword_product_map":  len(all_kpm),
        "opportunities_total":  len(all_opps),
        "opportunities_scored": len(opps_scored),
        "scoring_coverage":     coverage,
        "high_confidence":      len(high_conf),
        "medium_confidence":    len(mid_conf),
        "low_confidence":       len(low_conf),
    }

    funnel["generated_at"] = datetime.now(tz=timezone.utc).isoformat()
    return funnel


# ── Funnel printer ────────────────────────────────────────────────────────────

def print_funnel(funnel: dict, category: str | None = None) -> None:
    cat_label = f"  [{category}]" if category else ""
    print(f"\n{B}{C}  VibePin Pipeline Funnel{cat_label}  "
          f"{funnel.get('generated_at', '')[:19]}{X}\n")

    # ── Keywords ────────────────────────────────────────────────────────────
    kw = funnel.get("keywords", {})
    print(f"  {B}Trend Keywords{X}")
    print(f"    {'Active keywords':<28}  {kw.get('active', 0):>6}")
    print(f"    {'Queued (pending)':<28}  {kw.get('queued', 0):>6}")
    print(f"    {'Crawled (completed)':<28}  {kw.get('crawled', 0):>6}")
    print(f"    {'Failed':<28}  {kw.get('failed', 0):>6}")
    crawled = kw.get("crawled", 0)
    active  = kw.get("active", 1)
    pct = f"{100 * crawled // active}%" if active else "n/a"
    print(f"    {'Crawl completion':<28}  {pct:>6}")

    # ── Pins ────────────────────────────────────────────────────────────────
    pins = funnel.get("pins", {})
    print(f"\n  {B}Pins{X}")
    total_pins = pins.get("total", 0)
    print(f"    {'Total in DB':<28}  {total_pins:>6}")
    print(f"    {'Candidate (≥500 saves)':<28}  {pins.get('candidate_500', 0):>6}"
          f"   ← all pins (filtered before insert)")
    print(f"    {'Viral (≥5k saves)':<28}  {pins.get('viral_5k', 0):>6}"
          f"   ← STL eligible")
    print(f"    {'Premium (≥10k saves)':<28}  {pins.get('premium_10k', 0):>6}"
          f"   ← top intelligence signal")
    if pins.get("dev_seed_tagged", 0):
        print(f"    {Y}{'Dev-seed tagged':<28}  {pins['dev_seed_tagged']:>6}"
              f"   ← excluded from scoring{X}")
    by_stage = pins.get("by_stage", {})
    if by_stage:
        print(f"    {'By trend stage':<28}")
        for stage, n in by_stage.items():
            bar = "█" * min(20, n * 20 // max(1, total_pins))
            print(f"      {(stage or 'unclassified'):<20}  {n:>5}  {bar}")
    if pins.get("rejection_note"):
        print(f"    {Y}ⓘ  {pins['rejection_note']}{X}")

    # ── Products ────────────────────────────────────────────────────────────
    prods = funnel.get("products", {})
    total_prods = prods.get("total", 0)
    print(f"\n  {B}Products{X}")
    print(f"    {'Total in DB':<28}  {total_prods:>6}")
    print(f"    {'With source_url':<28}  {prods.get('with_source_url', 0):>6}")
    print(f"    {'With image_url':<28}  {prods.get('with_image_url', 0):>6}")
    print(f"    {'STL-sourced (pin ≥5k)':<28}  {prods.get('stl_sourced', 0):>6}")
    dom = prods.get("by_domain", {})
    if dom:
        print(f"    {'Top domains':<28}")
        for domain, n in list(dom.items())[:8]:
            print(f"      {(domain or 'unknown'):<28}  {n:>4}")

    # ── Intelligence ────────────────────────────────────────────────────────
    intel = funnel.get("intelligence", {})
    scored = intel.get("product_scores", 0)
    print(f"\n  {B}Intelligence{X}")
    print(f"    {'keyword_product_map':<28}  {intel.get('keyword_product_map', 0):>6}")
    print(f"    {'product_scores':<28}  {scored:>6}")
    print(f"    {'Scoring coverage':<28}  {intel.get('scoring_coverage', 'n/a'):>6}")
    print(f"    {'Opportunities (view)':<28}  {intel.get('opportunities_total', 0):>6}")
    print(f"    {'Opportunities scored':<28}  {intel.get('opportunities_scored', 0):>6}")
    print(f"    {G}{'High confidence (≥70)':<28}  {intel.get('high_confidence', 0):>6}{X}")
    print(f"    {Y}{'Medium confidence (40-70)':<28}  {intel.get('medium_confidence', 0):>6}{X}")
    print(f"    {R}{'Low confidence (<40)':<28}  {intel.get('low_confidence', 0):>6}{X}")

    # ── Health checks ────────────────────────────────────────────────────────
    print(f"\n  {B}Health{X}")
    if total_prods == 0:
        print(f"  {R}✗  No products — run: py pipeline.py --step stl{X}")
    elif scored == 0:
        print(f"  {R}✗  product_scores empty — run: py pipeline.py --step score{X}")
    elif scored < total_prods:
        gap = total_prods - scored
        print(f"  {Y}!  {gap} products unscored — run: py pipeline.py --step score{X}")
    else:
        print(f"  {G}✓  Scoring coverage complete{X}")

    if intel.get("keyword_product_map", 0) == 0 and total_prods > 0:
        print(f"  {R}✗  keyword_product_map empty — run: py pipeline.py --step score{X}")
    elif intel.get("keyword_product_map", 0) > 0:
        print(f"  {G}✓  keyword_product_map populated{X}")

    if kw.get("crawled", 0) == 0:
        print(f"  {Y}!  No crawl_queue completions — run: py pipeline.py --step crawl{X}")
    else:
        print(f"  {G}✓  {kw.get('crawled', 0)} keywords crawled{X}")
    print()


# ── Formatters ────────────────────────────────────────────────────────────────

def _bar(value: int, target: int, width: int = 20) -> str:
    pct   = min(1.0, value / max(1, target))
    filled = int(pct * width)
    bar   = "█" * filled + "░" * (width - filled)
    color = G if pct >= 1.0 else Y if pct >= 0.5 else R
    return f"{color}{bar}{X} {value:>5}/{target}"


def print_human(stats: dict) -> None:
    print(f"\n{B}{C}  VibePin Dataset Coverage  {stats.get('generated_at','')[:19]}{X}\n")

    # Summary table
    print(f"  {'Metric':<28}  {'Count':>7}  {'Target':>7}  Progress")
    print(f"  {'─'*28}  {'─'*7}  {'─'*7}  {'─'*32}")
    rows = [
        ("Interests (active)",    "interests",          "interests"),
        ("Trend Keywords",        "trend_keywords",     "trend_keywords"),
        ("Expanded Keywords",     "keyword_expansions", "keyword_expansions"),
        ("Pins",                  "pins",               "pins"),
        ("Products",              "products",           "products"),
    ]
    for label, key, tgt_key in rows:
        val    = stats.get(key, 0)
        target = TARGETS.get(tgt_key, 0)
        bar    = _bar(val, target) if target else f"{val:>5}"
        print(f"  {label:<28}  {val:>7}  {target:>7}  {bar}")

    # Queue
    q = stats.get("queue", {})
    print(f"\n  {B}Crawl Queue{X}")
    print(f"    pending={q.get('pending',0)}  processing={q.get('processing',0)}  "
          f"completed={q.get('completed',0)}  failed={q.get('failed',0)}")

    # Pins by category
    cat_counts = stats.get("pins_by_category", {})
    if cat_counts:
        print(f"\n  {B}Pins by Category{X}")
        for cat, n in list(cat_counts.items())[:12]:
            print(f"    {cat:<22}  {n:>5}")

    # Pins by stage
    stage_counts = stats.get("pins_by_stage", {})
    if stage_counts:
        print(f"\n  {B}Pins by Trend Stage{X}")
        for stage, n in stage_counts.items():
            print(f"    {(stage or 'unknown'):<22}  {n:>5}")

    # Top velocity categories
    vel = stats.get("avg_velocity_by_category", {})
    if vel:
        print(f"\n  {B}Top Categories by Avg Save Velocity (saves/day){X}")
        for cat, v in list(vel.items())[:8]:
            print(f"    {cat:<22}  {v:>7.1f}/day")

    # Products by domain
    dom = stats.get("products_by_domain", {})
    if dom:
        print(f"\n  {B}Top Product Domains{X}")
        for domain, n in list(dom.items())[:8]:
            print(f"    {(domain or 'unknown'):<28}  {n:>5}")

    # Extra signals
    print(f"\n  High-growth pins (🔥):  {stats.get('high_growth_pins', 0)}")
    print(f"  Ecommerce-linked pins:  {stats.get('ecommerce_pins', 0)}")
    print(f"  Fresh pins (≤90 days):  {stats.get('fresh_pins_90d', 0)}")
    print()


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(
        description="Dataset coverage metrics for the Pinterest Intelligence pipeline"
    )
    ap.add_argument("--json",     action="store_true", help="Output raw JSON")
    ap.add_argument("--targets",  action="store_true", help="Show target progress only")
    ap.add_argument("--funnel",   action="store_true", help="Full pipeline funnel report")
    ap.add_argument("--category", default=None,
                    help="Filter funnel report to one category (e.g. home, beauty, fashion)")
    args = ap.parse_args()

    # ── Funnel mode ──────────────────────────────────────────────────────────
    if args.funnel:
        funnel = collect_funnel_stats(category=args.category)
        if args.json:
            print(json.dumps(funnel, indent=2, default=str))
        else:
            print_funnel(funnel, category=args.category)
        return

    # ── Standard summary mode ────────────────────────────────────────────────
    stats = collect_stats()

    if args.json:
        print(json.dumps(stats, indent=2, default=str))
        return

    print_human(stats)

    if args.targets:
        print(f"\n  {B}Target Checklist{X}")
        all_met = True
        for key, target in TARGETS.items():
            val  = stats.get(key, 0)
            met  = val >= target
            icon = f"{G}✓{X}" if met else f"{R}✗{X}"
            print(f"    {icon}  {key:<25}  {val:>5} / {target}")
            if not met:
                all_met = False
        if all_met:
            print(f"\n  {G}{B}All targets met! Ready for Product Intelligence development.{X}")
        else:
            print(f"\n  {Y}Run the pipeline to collect more data: py pipeline.py{X}")


if __name__ == "__main__":
    main()
