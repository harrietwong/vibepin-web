"""
enrich_trend_history.py — Populate trend_keywords.trend_history

Pinterest's time-series API endpoints (/api/v3/trends/keywords/time_series/ etc.)
require a Business Partner account that this project doesn't have.

Instead, we reconstruct a plausible 52-week trend curve from the growth metrics
already in the DB: yearly_change, monthly_change, search_volume_level.

Method:
  1. Derive anchor values:
       now_val      = normalized from search_volume_level (0-100 scale)
       month_ago    = now_val / (1 + monthly_change/100)
       year_ago     = now_val / (1 + yearly_change/100)
  2. Linearly interpolate 52 weekly points through those anchors.
  3. Store as [{date, value}] with dates going back 52 weeks from today.

Result is directionally correct (rising/falling/flat) and proportional to
growth rates — not raw search counts. The frontend labels it "Trend direction".

Usage:
  py enrich_trend_history.py                # enrich all NULL rows
  py enrich_trend_history.py --limit 100    # first 100 only
  py enrich_trend_history.py --dry-run      # compute but don't write
  py enrich_trend_history.py --force        # re-generate even existing rows
"""

import argparse, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from dotenv import load_dotenv; load_dotenv()
except ImportError:
    pass

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent

G = "\033[92m"; Y = "\033[93m"; C = "\033[96m"; R = "\033[91m"; X = "\033[0m"
def _ok(m):   print(f"{G}  ✓  {m}{X}")
def _info(m): print(f"{C}  ·  {m}{X}")
def _warn(m): print(f"{Y}  !  {m}{X}")


# ── Volume baseline ───────────────────────────────────────────────────────────

VOL_BASE = {"very_high": 82, "high": 62, "medium": 40, "low": 20}

def _now_val(vol_level: str) -> float:
    return float(VOL_BASE.get((vol_level or "").lower(), 35))


# ── Synthetic trend generation ────────────────────────────────────────────────

def generate_trend_history(
    kw: dict,
    weeks:      int = 52,
    as_of:      datetime | None = None,
) -> list[dict]:
    """
    Build a {date, value}[] curve for `weeks` weeks ending at `as_of`.

    Data sources (all already in trend_keywords):
      search_volume_level  → absolute level (very_high/high/medium/low → 82/62/40/20)
      yearly_change        → YoY %  e.g. 200  → 3× growth over 52 weeks
      monthly_change       → MoM %  e.g.  40  → 1.4× growth over 4 weeks

    Interpolation:
      week 0  (most recent)   = now_val
      week 4  (4 weeks ago)   = now_val / (1 + mom/100)
      week 52 (52 weeks ago)  = now_val / (1 + yoy/100)

    Values are clamped to [2, 98] and rounded to nearest int.
    """
    base   = as_of or datetime.now(timezone.utc)
    yoy    = float(kw.get("yearly_change",  0) or 0)
    mom    = float(kw.get("monthly_change", 0) or 0)
    now_v  = _now_val(kw.get("search_volume_level", "medium"))

    # Derive anchor values (clamp denominators to avoid division explosion)
    def _back(pct: float) -> float:
        denom = 1.0 + pct / 100.0
        if denom < 0.05:
            denom = 0.05
        return max(1.0, min(99.0, now_v / denom))

    week4_v  = _back(mom)    # 4 weeks ago
    week52_v = _back(yoy)    # 52 weeks ago

    # Build weeks in reverse (index 0 = oldest)
    history: list[dict] = []
    for i in range(weeks):
        week_ago = weeks - 1 - i   # 0 = most recent, weeks-1 = oldest
        dt  = base - timedelta(weeks=week_ago)
        monday = dt - timedelta(days=dt.weekday())   # snap to Monday

        # Piecewise linear interpolation
        t = i / max(1, weeks - 1)      # 0.0 = oldest, 1.0 = most recent

        # Segment boundary: week 4 from end ≈ t = (weeks-5)/(weeks-1)
        t_month = (weeks - 5) / max(1, weeks - 1)  # ≈ 0.92 for 52 weeks

        if t <= t_month:
            t_local = t / t_month if t_month > 0 else 0
            val = week52_v + (week4_v - week52_v) * t_local
        else:
            t_local = (t - t_month) / max(1e-9, 1.0 - t_month)
            val = week4_v + (now_v - week4_v) * t_local

        history.append({
            "date":  monday.strftime("%Y-%m-%d"),
            "value": max(2, min(98, round(val))),
        })

    return history


# ── DB helpers ────────────────────────────────────────────────────────────────

def _load_keywords(force: bool = False, limit: int = 0) -> list[dict]:
    sys.path.insert(0, str(ROOT / "db"))
    from db import _get_http  # type: ignore
    http = _get_http()

    params: dict = {
        "select": ("id,keyword,category,yearly_change,"
                   "monthly_change,weekly_change,search_volume_level"),
        "status": "eq.active",
        "order":  "priority_score.desc",
        "limit":  str(limit) if limit else "2000",
    }
    if not force:
        params["trend_history"] = "is.null"

    rows = http.get("trend_keywords", params=params).json()
    return rows if isinstance(rows, list) else []


def _update_batch(rows: list[dict]) -> int:
    """PATCH trend_history for each row. Returns written count."""
    sys.path.insert(0, str(ROOT / "db"))
    from db import _get_http  # type: ignore
    http = _get_http()

    written = 0
    for row in rows:
        now_iso = datetime.now(timezone.utc).isoformat()
        resp = http.patch(
            "trend_keywords",
            params={"id": f"eq.{row['id']}"},
            json={
                "trend_history": row["_history"],
                # Tag synthetic curves — UI must not render as official 12-month chart
                "trend_series_source": "derived_growth_metrics",
                "trend_series_granularity": "weekly",
                "trend_series_updated_at": now_iso,
            },
            headers={"Prefer": "return=minimal"},
        )
        if resp.status_code in (200, 204):
            written += 1
        else:
            _warn(f"  PATCH failed [{resp.status_code}] for {row['keyword']!r}: {resp.text[:80]}")
    return written


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(
        description="Populate trend_keywords.trend_history from growth metrics"
    )
    ap.add_argument("--limit",   type=int, default=0,
                    help="Max keywords to enrich (0 = all)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Generate but do not write to DB")
    ap.add_argument("--force",   action="store_true",
                    help="Re-generate even rows that already have trend_history")
    ap.add_argument("--sample",  action="store_true",
                    help="Print sample output for 3 keywords and exit")
    args = ap.parse_args()

    if args.sample:
        samples = [
            {"keyword": "nail ideas 2026",  "yearly_change": 580, "monthly_change": 45, "search_volume_level": "very_high"},
            {"keyword": "japandi bedroom",   "yearly_change": 120, "monthly_change": 8,  "search_volume_level": "high"},
            {"keyword": "boho home decor",   "yearly_change": 0,   "monthly_change": -5, "search_volume_level": "medium"},
        ]
        for s in samples:
            hist = generate_trend_history(s)
            print(f"\n{s['keyword']} (YoY={s['yearly_change']}%, MoM={s['monthly_change']}%):")
            print(f"  n={len(hist)}  first={hist[0]}  last={hist[-1]}")
        return

    _info("Loading keywords from DB...")
    keywords = _load_keywords(force=args.force, limit=args.limit)
    _info(f"Loaded: {len(keywords)} keywords to enrich")
    if not keywords:
        _ok("Nothing to enrich — all keywords already have trend_history.")
        return

    now = datetime.now(timezone.utc)

    # Generate in memory
    for kw in keywords:
        kw["_history"] = generate_trend_history(kw, as_of=now)

    _info(f"Generated histories for {len(keywords)} keywords")

    if args.dry_run:
        # Preview 3 examples
        _info("Dry-run: sample output:")
        for kw in keywords[:3]:
            h = kw["_history"]
            print(f"  [{kw['keyword']}]  n={len(h)}  first={h[0]}  last={h[-1]}")
        return

    # Write in batches of 50
    BATCH = 50
    total_written = 0
    for i in range(0, len(keywords), BATCH):
        batch = keywords[i:i + BATCH]
        written = _update_batch(batch)
        total_written += written
        _info(f"  Batch {i//BATCH + 1}: wrote {written}/{len(batch)}")

    print(f"\n{'─'*50}")
    _ok(f"Written: {total_written}/{len(keywords)}")


if __name__ == "__main__":
    main()
