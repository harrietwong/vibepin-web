"""
classify_trends.py — Compute trend_lifecycle from stored 52-week history.

Reads trend_keywords rows where trend_history IS NOT NULL, runs the
lifecycle classifier, and writes trend_lifecycle back to the table.

Lifecycle rules:
  rising    Last 4 weeks avg ≥ 1.5× earlier weeks avg  (recent surge)
  seasonal  High variance + peak concentrated in ≤14 consecutive weeks,
            with non-peak baseline well below the peak
  evergreen Low variance (std ≤ 18) + sustained baseline (mean ≥ 20)
  unclear   Insufficient signal — frontend falls back to YoY/weekly heuristic

Usage:
  py classify_trends.py                          # all keywords with history
  py classify_trends.py --category home-decor    # single category
  py classify_trends.py --dry-run                # print without writing
"""

import argparse, json, statistics, sys
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT / "db"))

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass


# ── Classifier ────────────────────────────────────────────────────────────────

def classify_lifecycle(ts: list) -> str:
    """
    Classify a normalized 0-100 weekly time series (up to 52 points).

    Returns: 'rising' | 'seasonal' | 'evergreen' | 'unclear'
    """
    if not ts:
        return "unclear"

    vals = [float(v) for v in ts if v is not None]
    if len(vals) < 8:
        return "unclear"

    # ── Rising: last 4 weeks avg ≥ 1.5× the preceding trend ────────────────
    recent   = vals[-4:]
    earlier  = vals[:-4]
    if earlier:
        recent_avg  = sum(recent)  / len(recent)
        earlier_avg = sum(earlier) / len(earlier)
        # Guard against near-zero denominator (cold-start keywords)
        if earlier_avg > 5 and recent_avg >= earlier_avg * 1.5:
            return "rising"

    mean_val = sum(vals) / len(vals)
    std_val  = statistics.stdev(vals) if len(vals) > 1 else 0.0
    max_val  = max(vals)

    # ── Seasonal: volatile + concentrated peak window ────────────────────────
    if std_val > 20 and max_val >= 70:
        peak_threshold = max_val * 0.6
        peak_idx = [i for i, v in enumerate(vals) if v >= peak_threshold]
        if peak_idx:
            peak_span = peak_idx[-1] - peak_idx[0] + 1
            if 3 <= peak_span <= 14:
                non_peak = [v for i, v in enumerate(vals)
                            if i not in set(range(peak_idx[0], peak_idx[-1] + 1))]
                if non_peak:
                    non_peak_avg = sum(non_peak) / len(non_peak)
                    # Non-peak baseline must be clearly below the mean
                    if non_peak_avg < mean_val * 0.55:
                        return "seasonal"

    # ── Evergreen: stable sustained demand ───────────────────────────────────
    if std_val <= 18 and mean_val >= 20:
        return "evergreen"

    return "unclear"


def classify_lifecycle_fallback(
    yearly_change:      float | None,
    weekly_change:      float | None,
    search_volume_level: str | None,
) -> str:
    """
    Classify when trend_history is not available.
    Uses summary stats only — cannot detect Seasonal; returns 'unclear' for it.

    This mirrors the frontend getTrendStateChip heuristic but persists the
    result to trend_lifecycle so it survives server-side sorting later.
    """
    yoy     = float(yearly_change  or 0)
    weekly  = float(weekly_change  or 0)
    vol     = (search_volume_level or "").lower()

    # Rising: strong YoY acceleration
    if yoy >= 200:
        return "rising"
    if yoy >= 100 and weekly >= 0:
        return "rising"

    # Evergreen proxy: high stable volume with no strong growth signal
    if vol in ("very_high", "high") and yoy < 100 and weekly >= -5:
        return "evergreen"

    # Not enough signal to classify
    return "unclear"


# ── DB helpers ────────────────────────────────────────────────────────────────

def load_keywords(category: str | None = None, include_fallback: bool = False) -> list[dict]:
    from db import select_many  # type: ignore

    filters: dict = {"status": "active"}
    if not include_fallback:
        filters["trend_history"] = "not.is.null"
    if category:
        filters["category"] = category

    try:
        rows = select_many(
            "trend_keywords",
            filters=filters,
            order="priority_score.desc",
        )
        return rows
    except Exception as exc:
        print(f"[classify] DB read error: {exc}")
        return []


def write_lifecycles(updates: list[dict]) -> int:
    """
    Batch-PATCH trend_lifecycle for each lifecycle value using PostgREST in.() filter.
    Groups by lifecycle so 4 HTTP calls handle all 1000 rows instead of N individual ones.
    """
    import os, httpx
    from dotenv import load_dotenv
    load_dotenv()

    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        print("[classify] missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
        return 0

    client = httpx.Client(
        base_url=f"{url}/rest/v1/",
        headers={"apikey": key, "Authorization": f"Bearer {key}",
                 "Content-Type": "application/json"},
        timeout=30,
    )

    # Group ids by lifecycle value
    by_lc: dict[str, list[str]] = {}
    for row in updates:
        by_lc.setdefault(row["trend_lifecycle"], []).append(row["id"])

    written = 0
    for lifecycle, ids in by_lc.items():
        # Split into chunks of 500 to stay within URL length limits
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            resp = client.patch(
                "trend_keywords",
                json={"trend_lifecycle": lifecycle},
                params={"id": f"in.({','.join(chunk)})"},
                headers={"Prefer": "return=minimal"},
            )
            if resp.status_code in (200, 204):
                written += len(chunk)
            else:
                print(f"[classify] PATCH error [{lifecycle}]: "
                      f"{resp.status_code} {resp.text[:120]}")

    client.close()
    return written


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(
        description="Classify trend_lifecycle from 52-week trend_history"
    )
    ap.add_argument("--category", default=None,
                    help="Limit to a single category (e.g. home-decor)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print results without writing to the database")
    ap.add_argument("--fallback", action="store_true",
                    help="Also classify keywords without trend_history using "
                         "yearly_change / weekly_change / search_volume_level heuristics. "
                         "Cannot detect Seasonal via fallback (will be 'unclear').")
    args = ap.parse_args()

    keywords = load_keywords(args.category, include_fallback=args.fallback)
    if not keywords:
        if args.fallback:
            print("[classify] No active keywords found.")
        else:
            print("[classify] No keywords with trend_history found.")
            print("           Run:  py trend_fetcher.py --enrich --db")
            print("           Or:   py classify_trends.py --fallback  (uses YoY heuristic)")
        return

    print(f"\n[classify] {len(keywords)} keywords loaded"
          + (f" for category={args.category}" if args.category else "")
          + (" (including fallback)" if args.fallback else ""))

    counters: dict = {"rising": 0, "seasonal": 0, "evergreen": 0, "unclear": 0}
    updates: list[dict] = []

    for kw in keywords:
        raw_history = kw.get("trend_history")

        if isinstance(raw_history, str):
            try:
                raw_history = json.loads(raw_history)
            except (json.JSONDecodeError, TypeError):
                raw_history = None

        ts = raw_history if isinstance(raw_history, list) else []

        if ts:
            lifecycle = classify_lifecycle(ts)
            source    = "history"
        elif args.fallback:
            lifecycle = classify_lifecycle_fallback(
                kw.get("yearly_change"),
                kw.get("weekly_change"),
                kw.get("search_volume_level"),
            )
            source = "fallback"
        else:
            continue   # should not happen when include_fallback=False

        counters[lifecycle] = counters.get(lifecycle, 0) + 1
        updates.append({"id": kw["id"], "trend_lifecycle": lifecycle})

        if args.dry_run:
            kw_label = kw.get("keyword", "?")[:36]
            if ts:
                detail = (f"n={len(ts):>3}  "
                          f"mean={sum(ts)/max(len(ts),1):>5.1f}  "
                          f"std={statistics.stdev(ts) if len(ts) > 1 else 0:>5.1f}")
            else:
                yoy = kw.get("yearly_change", 0) or 0
                vol = kw.get("search_volume_level", "?")
                detail = f"yoy={yoy:>6.0f}%  vol={str(vol or '?'):<9}  [{source}]"
            print(f"  {lifecycle:<10}  {kw_label:<38}  {detail}")

    print(f"\n  rising={counters.get('rising',0)}  seasonal={counters.get('seasonal',0)}  "
          f"evergreen={counters.get('evergreen',0)}  unclear={counters.get('unclear',0)}")

    if args.dry_run:
        print("\n[classify] dry-run — no changes written.")
        return

    written = write_lifecycles(updates)
    print(f"[classify] {written}/{len(updates)} rows updated.")


if __name__ == "__main__":
    main()
