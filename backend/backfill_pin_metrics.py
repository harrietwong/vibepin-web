"""
backfill_pin_metrics.py — Backfill pin_samples velocity / freshness metrics

Pins scraped before save_velocity / age_days were added to the scraper
have NULL for these fields. This script derives them from created_at_source
(the original Pinterest pin creation timestamp) and writes the results back.

Fields always written (available before migrate_v8.sql):
  days_since_creation — days since pin was created on Pinterest
  save_velocity       — save_count / max(days, 1)  [saves/day]
  is_high_growth      — True if save_velocity >= 100

Fields written only after migrate_v8.sql is applied:
  age_days            — same as days_since_creation
  trend_stage         — 'emerging' | 'growing' | 'viral' | 'stable'

Usage:
  py backfill_pin_metrics.py            # backfill all pins with NULL metrics
  py backfill_pin_metrics.py --dry-run  # compute only, no DB writes
  py backfill_pin_metrics.py --verbose  # print per-pin breakdown
  py backfill_pin_metrics.py --all      # re-compute all pins (including ones with values)
"""

import argparse
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

G = "\033[92m"; Y = "\033[93m"; C = "\033[96m"; R = "\033[91m"; B = "\033[1m"; X = "\033[0m"

# Stage thresholds — must stay in sync with scraper_v2.py
VELOCITY_HIGH_GROWTH = 100.0
STAGE_EMERGING       = 100.0   # saves/day
STAGE_GROWING        =  50.0
STAGE_VIRAL          =  20.0


def _db():
    sys.path.insert(0, str(ROOT / "db"))
    from db import select_many, upsert  # type: ignore
    return select_many, upsert


def _compute(pin: dict, now: datetime) -> dict | None:
    raw_ts = pin.get("created_at_source") or pin.get("pin_created_at")
    if not raw_ts:
        return None

    try:
        ct = datetime.fromisoformat(str(raw_ts).replace("Z", "+00:00"))
        if ct.tzinfo is None:
            ct = ct.replace(tzinfo=timezone.utc)
        days = max(1, (now - ct).days)
    except Exception:
        return None

    save_count = int(pin.get("save_count") or 0)
    velocity   = round(save_count / days, 2)

    if   velocity >= STAGE_EMERGING: stage = "emerging"
    elif velocity >= STAGE_GROWING:  stage = "growing"
    elif velocity >= STAGE_VIRAL:    stage = "viral"
    else:                             stage = "stable"

    return {
        "id":                  pin["id"],
        "days_since_creation": days,
        "save_velocity":       velocity,
        "is_high_growth":      velocity >= VELOCITY_HIGH_GROWTH,
        "age_days":            days,    # requires migrate_v8.sql
        "trend_stage":         stage,   # requires migrate_v8.sql
    }


def _columns_exist(pins_sample: list[dict]) -> set[str]:
    """Return set of column names present in the pin_samples schema."""
    if not pins_sample:
        return set()
    return set(pins_sample[0].keys())


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Backfill save_velocity / age_days for existing pin_samples"
    )
    ap.add_argument("--dry-run", action="store_true",
                    help="Compute but do not write to DB")
    ap.add_argument("--verbose", action="store_true",
                    help="Print per-pin breakdown")
    ap.add_argument("--all", action="store_true",
                    help="Re-compute all pins, not just those with NULL metrics")
    args = ap.parse_args()

    now = datetime.now(timezone.utc)
    print(f"\n{B}{C}  Backfill Pin Metrics  [{now.strftime('%H:%M:%S')}]{X}\n")

    select_many, upsert = _db()
    pins = select_many("pin_samples", limit=50_000) or []
    print(f"{C}  {len(pins)} total pins loaded{X}")

    # Detect which columns are available in the current schema
    available_cols = _columns_exist(pins)
    has_age_days   = "age_days"   in available_cols
    has_trend_stage= "trend_stage" in available_cols

    if not has_age_days:
        print(f"{Y}  ! age_days column missing — run migrate_v8.sql first to backfill it{X}")
    if not has_trend_stage:
        print(f"{Y}  ! trend_stage column missing — run migrate_v8.sql first to backfill it{X}")

    if args.all:
        candidates = pins
    else:
        candidates = [p for p in pins if p.get("save_velocity") is None
                      or (has_age_days and p.get("age_days") is None)]

    print(f"{C}  {len(candidates)} pins to backfill{X}\n")

    updates = []
    skipped = 0
    stages  = {"emerging": 0, "growing": 0, "viral": 0, "stable": 0}

    for pin in candidates:
        result = _compute(pin, now)
        if result is None:
            skipped += 1
            continue

        # Strip columns that don't exist yet
        row = {k: v for k, v in result.items()
               if k not in ("age_days", "trend_stage")
               or (k == "age_days"    and has_age_days)
               or (k == "trend_stage" and has_trend_stage)}

        updates.append(row)
        stages[result["trend_stage"]] += 1

        if args.verbose:
            pin_id = (pin.get("pin_id") or pin.get("id") or "")[:12]
            print(f"  {pin_id}  vel={result['save_velocity']:>8.2f}  "
                  f"age={result['age_days']:>4}d  stage={result['trend_stage']}")

    print(f"  Computed: {len(updates)}   skipped (no timestamp): {skipped}")
    print(f"  Stages:  emerging={stages['emerging']}  growing={stages['growing']}  "
          f"viral={stages['viral']}  stable={stages['stable']}")

    if not updates:
        print(f"\n{Y}  Nothing to write.{X}")
        return

    if args.dry_run:
        print(f"\n{Y}  dry-run: skipping DB writes{X}")
        return

    written = 0
    BATCH   = 200
    for i in range(0, len(updates), BATCH):
        batch = updates[i : i + BATCH]
        try:
            result = upsert("pin_samples", batch, on_conflict="id")
            written += len(result) if result else 0
        except Exception as exc:
            print(f"{R}  upsert error (batch {i // BATCH + 1}): {exc}{X}", file=sys.stderr)

    print(f"\n{G}  ✓  {written} pin_samples updated{X}\n")
    if not has_age_days or not has_trend_stage:
        print(f"{Y}  Re-run after migrate_v8.sql to backfill age_days / trend_stage.{X}\n")


if __name__ == "__main__":
    main()
