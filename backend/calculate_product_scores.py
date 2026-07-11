"""
calculate_product_scores.py — Product Intelligence Engine

Computes opportunity scores for every product and maps them to their source
trend keywords. Writes to:
  • product_scores  (one row per pin_product)
  • keyword_product_map  (one row per keyword × product pair)

Opportunity Score formula (normalised 0-100):
  40% × save_velocity_score   log10 scale, 1000 saves/day = 100
  30% × trend_score           log10 scale, 500% YoY = 100
  20% × freshness_score       linear decay over 90 days
  10% × product_density_score cap at 10 products per keyword = 100

competition_score (stored separately, not in opportunity formula):
  100 − product_density_score  (fewer competing products = higher score)

Usage:
  py calculate_product_scores.py           # score all products
  py calculate_product_scores.py --dry-run # compute only, no DB writes
  py calculate_product_scores.py --verbose # print per-product breakdown
"""

import argparse
import math
import re
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

# ── ANSI ──────────────────────────────────────────────────────────────────────
G = "\033[92m"; Y = "\033[93m"; C = "\033[96m"; R = "\033[91m"; B = "\033[1m"; X = "\033[0m"

# ── Score calibration constants ────────────────────────────────────────────────
MAX_VELOCITY_DAY    = 1_000.0   # saves/day that maps to velocity_score = 100
MAX_YOY_PCT         = 500.0     # % YoY growth that maps to trend_score = 100
FRESHNESS_WINDOW    = 90        # days; pins older than this score 0 freshness
DENSITY_CAP         = 10        # products per keyword that maps to density_score = 100

WEIGHT_VELOCITY  = 0.38
WEIGHT_TREND     = 0.27
WEIGHT_FRESHNESS = 0.15
WEIGHT_DENSITY   = 0.20


# ── DB helpers ────────────────────────────────────────────────────────────────

def _db():
    sys.path.insert(0, str(ROOT / "db"))
    from db import select_many, upsert  # type: ignore
    return select_many, upsert


def _load(table: str, filters: dict | None = None,
          limit: int | None = None) -> list[dict]:
    try:
        select_many, _ = _db()
        return select_many(table, filters=filters, limit=limit) or []
    except Exception as exc:
        print(f"{R}[db] load {table}: {exc}{X}", file=sys.stderr)
        return []


def _upsert(table: str, rows: list[dict], on_conflict: str) -> int:
    if not rows:
        return 0
    try:
        _, upsert = _db()
        result = upsert(table, rows, on_conflict=on_conflict)
        return len(result) if result else 0
    except Exception as exc:
        print(f"{R}[db] upsert {table}: {exc}{X}", file=sys.stderr)
        return 0


# ── Keyword normalization ─────────────────────────────────────────────────────

def _normalize_kw(text: str) -> str:
    """Normalize a keyword string for case/whitespace-tolerant matching.

    Transformations applied (in order):
      1. strip leading/trailing whitespace
      2. lowercase
      3. hyphens and underscores → single space
      4. collapse runs of whitespace to a single space
    """
    if not text:
        return ""
    t = text.strip().lower()
    t = re.sub(r"[-_]+", " ", t)
    t = re.sub(r"\s+",   " ", t)
    return t


# ── Sub-score functions ───────────────────────────────────────────────────────

def _velocity_score(velocity: float | None) -> float:
    """Log10-scaled save velocity score. 0 → 0, 1000+/day → 100."""
    v = float(velocity or 0)
    if v <= 0:
        return 0.0
    return min(math.log10(v) / math.log10(MAX_VELOCITY_DAY), 1.0) * 100.0


def _trend_score(yoy_pct: float | None) -> float:
    """Log10-scaled YoY growth score. 0% → 0, 500%+ → 100."""
    y = float(yoy_pct or 0)
    if y <= 0:
        return 0.0
    return min(math.log10(max(1.0, y)) / math.log10(MAX_YOY_PCT), 1.0) * 100.0


def _freshness_score(age_days: float | None) -> float:
    """Linear decay from 100 (brand new) to 0 (90+ days old)."""
    a = float(age_days or 0)
    return max(0.0, (1.0 - a / FRESHNESS_WINDOW)) * 100.0


def _density_score(product_count: int) -> float:
    """How many products are validated for a keyword. Cap at DENSITY_CAP."""
    return min(product_count / DENSITY_CAP, 1.0) * 100.0


def _opportunity_score(vel: float, trend: float, fresh: float, density: float) -> float:
    """Weighted composite, rounded to 1dp."""
    raw = (WEIGHT_VELOCITY  * vel
         + WEIGHT_TREND     * trend
         + WEIGHT_FRESHNESS * fresh
         + WEIGHT_DENSITY   * density)
    return round(min(raw, 100.0), 1)


# ── Core computation ──────────────────────────────────────────────────────────

def compute_scores(verbose: bool = False) -> tuple[list[dict], list[dict]]:
    """
    Load pin_products + pin_samples + trend_keywords from DB, compute all scores.
    Returns (product_score_rows, keyword_product_map_rows).
    """
    print(f"{C}  Loading data from DB…{X}")
    products = _load("pin_products", limit=10_000)
    pins_raw = _load("pin_samples",  limit=50_000)
    keywords = _load("trend_keywords", filters={"status": "active"})

    # Exclude dev_seed pins from intelligence scoring — they bypass Pinterest Trends
    pins = [p for p in pins_raw if p.get("source_type") != "dev_seed"]
    dev_excluded = len(pins_raw) - len(pins)
    if dev_excluded:
        print(f"  {Y}  {dev_excluded} dev_seed pins excluded from scoring{X}")

    print(f"  {len(products)} products  |  {len(pins)} pins (scoring)  |  {len(keywords)} trend keywords")

    if not products:
        print(f"{Y}  No products found — run pipeline.py --step stl first{X}")
        return [], []

    # ── Build fast lookup tables ─────────────────────────────────────────────
    # pin_id → pin record
    pins_by_id: dict[str, dict] = {p["pin_id"]: p for p in pins if p.get("pin_id")}

    # keyword string → keyword record (fully normalized for fallback text match)
    kw_by_text: dict[str, dict] = {_normalize_kw(k["keyword"]): k for k in keywords if k.get("keyword")}
    # keyword UUID → keyword record (for direct FK lookup)
    kw_by_id: dict[str, dict] = {k["id"]: k for k in keywords if k.get("id")}

    # keyword_id → list of product ids (for density calculation)
    kw_products: dict[str, list[str]] = {}

    # (keyword_id, product_id) → {total_pins, total_saves}
    kpm_accumulator: dict[tuple[str, str], dict] = {}

    # ── Pass 1: resolve each product → source pin → keyword ─────────────────
    stat_fk     = 0   # linked via trend_keyword_id FK
    stat_text   = 0   # linked via normalized text fallback
    stat_failed = 0   # could not resolve to any keyword

    product_contexts: list[dict] = []
    for prod in products:
        parent_pin_id = prod.get("parent_pin_id")
        pin = pins_by_id.get(parent_pin_id) if parent_pin_id else None

        if pin is None:
            # No matching pin in DB — use product's own seed_keyword if available
            kw_text = prod.get("seed_keyword") or ""
            velocity = None
            age_days = None
        else:
            kw_text  = pin.get("seed_keyword") or pin.get("source_keyword") or ""
            velocity = pin.get("save_velocity")
            age_days = pin.get("age_days") or pin.get("days_since_creation")

            # Fall back to created_at_source when pre-computed fields are NULL
            # (old scraper stored creation date there instead of pin_created_at)
            if velocity is None or age_days is None:
                raw_ts = pin.get("created_at_source") or pin.get("pin_created_at")
                if raw_ts:
                    try:
                        ct = datetime.fromisoformat(str(raw_ts).replace("Z", "+00:00"))
                        if ct.tzinfo is None:
                            ct = ct.replace(tzinfo=timezone.utc)
                        days = max(1, (datetime.now(timezone.utc) - ct).days)
                        if age_days is None:
                            age_days = days
                        if velocity is None and (sc := int(pin.get("save_count") or 0)) > 0:
                            velocity = round(sc / days, 2)
                    except Exception:
                        pass

        # Resolution order:
        #   1. trend_keyword_id FK on pin_samples  (set by scraper_v2, always reliable)
        #   2. normalized text match on kw_text    (fallback for older / dev-seed data)
        kw_id = (pin.get("trend_keyword_id") if pin else None)
        if kw_id:
            stat_fk += 1
        else:
            kw_rec = kw_by_text.get(_normalize_kw(kw_text))
            kw_id  = (kw_rec or {}).get("id")
            if kw_id:
                stat_text += 1
            else:
                stat_failed += 1
        kw_rec  = kw_by_id.get(kw_id) if kw_id else None
        yoy_pct = float((kw_rec or {}).get("yearly_change") or 0)
        prod_id  = prod.get("id")

        product_contexts.append({
            "product_id": prod_id,
            "kw_id":      kw_id,
            "kw_text":    kw_text,
            "velocity":   velocity,
            "age_days":   age_days,
            "yoy_pct":    yoy_pct,
        })

        # Accumulate keyword_product_map data
        if kw_id and prod_id:
            key = (kw_id, prod_id)
            if key not in kpm_accumulator:
                kpm_accumulator[key] = {"total_pins": 0, "total_saves": 0}
            kpm_accumulator[key]["total_pins"]  += 1
            kpm_accumulator[key]["total_saves"] += int(pin.get("save_count", 0) if pin else 0)

            kw_products.setdefault(kw_id, [])
            if prod_id not in kw_products[kw_id]:
                kw_products[kw_id].append(prod_id)

    # ── Linkage stats ────────────────────────────────────────────────────────
    total_processed = stat_fk + stat_text + stat_failed
    print(f"\n  {B}Keyword linkage  ({total_processed} products){X}")
    print(f"    {G}via trend_keyword_id FK : {stat_fk:>5}  "
          f"({100*stat_fk/max(total_processed,1):.0f}%){X}")
    print(f"    {Y}via text fallback       : {stat_text:>5}  "
          f"({100*stat_text/max(total_processed,1):.0f}%){X}")
    print(f"    {R}failed to link          : {stat_failed:>5}  "
          f"({100*stat_failed/max(total_processed,1):.0f}%){X}")
    if stat_failed > 0:
        print(f"    {Y}  → failed products won't appear in keyword_product_map{X}")
        print(f"    {Y}  → re-run pipeline --step crawl to populate trend_keyword_id{X}")

    # ── Pass 2: compute density (per keyword) then score each product ────────
    scored_rows:   list[dict] = []
    now = datetime.now(timezone.utc).isoformat()

    for ctx in product_contexts:
        prod_id  = ctx["product_id"]
        if not prod_id:
            continue

        product_count = len(kw_products.get(ctx["kw_id"] or "", [])) if ctx["kw_id"] else 1

        v_score   = _velocity_score(ctx["velocity"])
        t_score   = _trend_score(ctx["yoy_pct"])
        f_score   = _freshness_score(ctx["age_days"])
        d_score   = _density_score(product_count)
        opp_score = _opportunity_score(v_score, t_score, f_score, d_score)
        comp_score = round(max(0.0, 100.0 - d_score), 1)

        scored_rows.append({
            "product_id":          prod_id,
            "opportunity_score":   opp_score,
            "trend_score":         round(t_score, 1),
            "save_velocity_score": round(v_score, 1),
            "freshness_score":     round(f_score, 1),
            "competition_score":   comp_score,
            "scored_at":           now,
        })

        if verbose:
            print(f"  {prod_id[:8]}  opp={opp_score:5.1f}  "
                  f"vel={v_score:5.1f}  trend={t_score:5.1f}  "
                  f"fresh={f_score:5.1f}  density={d_score:5.1f}  "
                  f"kw={ctx['kw_text'][:30]}")

    # ── Pass 3: build keyword_product_map rows with relevance_score ──────────
    # relevance = total_saves for this pair / max total_saves for this keyword
    kw_max_saves: dict[str, int] = {}
    for (kw_id, _), acc in kpm_accumulator.items():
        kw_max_saves[kw_id] = max(kw_max_saves.get(kw_id, 0), acc["total_saves"])

    kpm_rows: list[dict] = []
    for (kw_id, prod_id), acc in kpm_accumulator.items():
        max_saves = kw_max_saves.get(kw_id, 1) or 1
        relevance = round(acc["total_saves"] / max_saves * 100, 1)
        kpm_rows.append({
            "keyword_id":      kw_id,
            "product_id":      prod_id,
            "relevance_score": relevance,
            "total_pins":      acc["total_pins"],
            "total_saves":     acc["total_saves"],
            "computed_at":     now,
        })

    return scored_rows, kpm_rows


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(
        description="Compute opportunity scores for all pin_products"
    )
    ap.add_argument("--dry-run", action="store_true",
                    help="Compute scores but do not write to DB")
    ap.add_argument("--verbose", action="store_true",
                    help="Print per-product score breakdown")
    args = ap.parse_args()

    from datetime import datetime as _dt
    ts = _dt.now(timezone.utc).strftime("%H:%M:%S")
    print(f"\n{B}{C}  Product Intelligence Scoring  [{ts}]{X}\n")

    scored_rows, kpm_rows = compute_scores(verbose=args.verbose)

    if not scored_rows:
        print(f"{Y}  No scores computed.{X}")
        return

    print(f"\n  {len(scored_rows)} products scored  |  {len(kpm_rows)} keyword-product links")

    def _confidence(score: float) -> str:
        if score >= 70:  return "high"
        if score >= 40:  return "medium"
        return "low"

    def _print_top(rows: list[dict], label: str, n: int = 10) -> None:
        top = sorted(rows, key=lambda r: -float(r.get("opportunity_score") or 0))[:n]
        print(f"\n  {B}{label}{X}")
        for i, r in enumerate(top, 1):
            score = float(r.get("opportunity_score") or 0)
            conf  = _confidence(score)
            color = G if conf == "high" else Y if conf == "medium" else R
            print(f"    {i:>2}. {color}score={score:5.1f}  [{conf}]{X}  "
                  f"vel={r['save_velocity_score']:5.1f}  "
                  f"trend={r['trend_score']:5.1f}  "
                  f"fresh={r['freshness_score']:5.1f}  "
                  f"comp={r['competition_score']:5.1f}  "
                  f"id={r['product_id'][:8]}")

    high   = [r for r in scored_rows if float(r.get("opportunity_score") or 0) >= 70]
    medium = [r for r in scored_rows if 40 <= float(r.get("opportunity_score") or 0) < 70]
    low    = [r for r in scored_rows if float(r.get("opportunity_score") or 0) < 40]
    print(f"\n  Confidence breakdown:")
    print(f"    {G}High   (≥70): {len(high):>4}{X}")
    print(f"    {Y}Medium (40-70): {len(medium):>4}{X}")
    print(f"    {R}Low    (<40):  {len(low):>4}{X}")

    if args.dry_run:
        print(f"{Y}  dry-run: skipping DB writes{X}")
        _print_top(scored_rows, "Top 10 by Opportunity Score (dry-run)")
        return

    written_scores = _upsert("product_scores",      scored_rows, "product_id")
    written_kpm    = _upsert("keyword_product_map", kpm_rows,    "keyword_id,product_id")

    print(f"{G}  ✓  {written_scores} product_scores upserted{X}")
    print(f"{G}  ✓  {written_kpm} keyword_product_map entries upserted{X}")
    _print_top(scored_rows, "Top 10 Opportunities")
    print()


if __name__ == "__main__":
    main()
