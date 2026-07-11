"""
interest_discovery.py — Discover and maintain Pinterest Trends interest categories.

Three-method discovery (tried in order; all results are merged):
  Method 1 — Scrape trends.pinterest.com homepage for interest category links/data
  Method 2 — Probe trends.pinterest.com/api/v3/ for each known slug to confirm liveness
  Method 3 — Seed from the 24 official slugs in Pinterest's public OpenAPI spec
              (L1InterestList enum; stable; only changes when Pinterest updates the spec)

All discovered interests are upserted to the trend_interests table.
The pipeline reads from that table — no hardcoded slug dicts anywhere else.

Usage:
  py interest_discovery.py                  # discover + upsert, default US
  py interest_discovery.py --country GB     # different region
  py interest_discovery.py --list           # print what's in DB, no fetch
  py interest_discovery.py --probe          # run probe to check which slugs are live
"""

import argparse
import asyncio
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from curl_cffi.requests import AsyncSession as CurlSession

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent

# ── Official Pinterest interest slugs ─────────────────────────────────────────
# Source: Pinterest public OpenAPI spec — enum L1InterestList
# https://github.com/pinterest/api-description/blob/main/v5/openapi.yaml
# This list is stable; Pinterest rarely adds new top-level interests.
# interest_discovery.py will try to detect additions automatically via Method 1.

OFFICIAL_INTEREST_SLUGS: list[str] = [
    "animals",
    "architecture",
    "art",
    "beauty",
    "childrens_fashion",
    "design",
    "diy_and_crafts",
    "education",
    "electronics",
    "entertainment",
    "event_planning",
    "finance",
    "food_and_drinks",
    "gardening",
    "health",
    "home_decor",
    "mens_fashion",
    "parenting",
    "quotes",
    "sport",
    "travel",
    "vehicles",
    "wedding",
    "womens_fashion",
]

# Human-readable labels for each slug (for display + DB interest_name field)
SLUG_LABELS: dict[str, str] = {
    "animals":           "Animals",
    "architecture":      "Architecture",
    "art":               "Art",
    "beauty":            "Beauty",
    "childrens_fashion": "Children's Fashion",
    "design":            "Design",
    "diy_and_crafts":    "DIY & Crafts",
    "education":         "Education",
    "electronics":       "Electronics",
    "entertainment":     "Entertainment",
    "event_planning":    "Event Planning",
    "finance":           "Finance",
    "food_and_drinks":   "Food & Drinks",
    "gardening":         "Gardening",
    "health":            "Health",
    "home_decor":        "Home Decor",
    "mens_fashion":      "Men's Fashion",
    "parenting":         "Parenting",
    "quotes":            "Quotes",
    "sport":             "Sport",
    "travel":            "Travel",
    "vehicles":          "Vehicles",
    "wedding":           "Wedding",
    "womens_fashion":    "Women's Fashion",
}

BASE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/147.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    "X-Requested-With": "XMLHttpRequest",
}


# ── Method 1: Scrape trends.pinterest.com homepage ────────────────────────────

async def method1_scrape_homepage(
    session: CurlSession,
    country: str = "US",
) -> list[dict]:
    """
    Fetch trends.pinterest.com and extract any interest slugs/names from:
    - Navigation links (e.g. /trends/?interest=home_decor)
    - Embedded JSON in script tags
    - React initial state blobs

    Returns list of {slug, name} dicts. Empty list on failure.
    """
    url = f"https://trends.pinterest.com/?country_code={country}"
    try:
        r = await session.get(
            url,
            headers={"Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                     "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"},
        )
        if r.status_code != 200:
            print(f"  [M1] homepage status={r.status_code}")
            return []
    except Exception as exc:
        print(f"  [M1] homepage error: {exc}")
        return []

    html = r.text
    found: dict[str, str] = {}

    # Pattern A: href="/trends/?interest=some_slug" or ?category=some_slug
    for m in re.finditer(
        r'href=["\'][^"\']*[?&](?:interest|category)=([a-z_]+)["\']', html
    ):
        slug = m.group(1)
        if slug and slug not in ("all", "trending", "popular"):
            found.setdefault(slug, SLUG_LABELS.get(slug, slug.replace("_", " ").title()))

    # Pattern B: "interest":"some_slug" or "interestId":"some_slug" in JS blobs
    for m in re.finditer(r'"interest(?:Id)?"\s*:\s*"([a-z_]+)"', html):
        slug = m.group(1)
        if slug:
            found.setdefault(slug, SLUG_LABELS.get(slug, slug.replace("_", " ").title()))

    # Pattern C: embedded JSON arrays with interest objects
    for m in re.finditer(r'\{[^{}]*"slug"\s*:\s*"([a-z_]+)"[^{}]*\}', html):
        slug = m.group(1)
        if slug:
            found.setdefault(slug, SLUG_LABELS.get(slug, slug.replace("_", " ").title()))

    result = [{"slug": s, "name": n} for s, n in found.items()]
    print(f"  [M1] homepage scraped {len(result)} interest slugs")
    return result


# ── Method 2: Probe API endpoint for each known slug ─────────────────────────

async def method2_probe_api(
    session: CurlSession,
    slugs: list[str],
    country: str = "US",
    delay: float = 0.8,
) -> list[dict]:
    """
    Call trends.pinterest.com/api/v3/trends/keywords/suggested/ for a sample
    of slugs to confirm which ones return data. Marks non-responsive slugs
    so we don't waste queue slots on dead interests.

    Returns list of {slug, name, live} dicts.
    """
    results: list[dict] = []
    last = 0.0

    for slug in slugs:
        elapsed = time.monotonic() - last
        if elapsed < delay:
            await asyncio.sleep(delay - elapsed)
        last = time.monotonic()

        try:
            r = await session.get(
                "https://trends.pinterest.com/api/v3/trends/keywords/suggested/",
                params={
                    "country_code": country,
                    "locale": "en-US",
                    "interests[]": slug,
                    "limit": 5,
                },
                headers={"Referer": "https://trends.pinterest.com/"},
            )
            data = r.json() if r.status_code == 200 else {}
        except Exception:
            data = {}

        # Check if the response contains any keyword data
        kws = (
            (data.get("data") or {}).get("keywords")
            or (data.get("data") if isinstance(data.get("data"), list) else None)
            or data.get("keywords")
            or []
        )
        live = bool(kws)
        results.append({
            "slug": slug,
            "name": SLUG_LABELS.get(slug, slug.replace("_", " ").title()),
            "live": live,
        })
        status = "✓" if live else "✗"
        print(f"  [M2] {status} {slug} → {len(kws)} kws")

    live_count = sum(1 for r in results if r.get("live"))
    print(f"  [M2] probe complete: {live_count}/{len(slugs)} slugs returned data")
    return results


# ── Method 3: Seed from official spec ────────────────────────────────────────

def method3_official_seed() -> list[dict]:
    """Return the 24 official slugs from Pinterest's OpenAPI spec."""
    result = [
        {"slug": s, "name": SLUG_LABELS[s]}
        for s in OFFICIAL_INTEREST_SLUGS
    ]
    print(f"  [M3] official spec seed: {len(result)} slugs")
    return result


# ── Merge results ─────────────────────────────────────────────────────────────

def merge_interests(
    m1: list[dict],
    m2: list[dict],
    m3: list[dict],
) -> list[dict]:
    """
    Merge results from all three methods into a deduplicated list.
    M2 probe data enriches liveness; unknown slugs from M1 are included
    as active (benefit of the doubt — Pinterest may have added new ones).
    """
    live_slugs: set[str] = {r["slug"] for r in m2 if r.get("live")}
    dead_slugs: set[str] = {r["slug"] for r in m2 if not r.get("live")}

    seen: dict[str, dict] = {}
    for item in m3 + m1:  # M3 as base, M1 may add new ones
        slug = item["slug"]
        if slug not in seen:
            seen[slug] = {
                "slug":  slug,
                "name":  item.get("name") or SLUG_LABELS.get(slug, slug),
                # if M2 confirmed dead → inactive; if M2 confirmed live → active; else assume active
                "is_active": slug not in dead_slugs,
            }

    return list(seen.values())


# ── DB upsert ─────────────────────────────────────────────────────────────────

def upsert_interests(interests: list[dict], country: str) -> int:
    """Upsert discovered interests to trend_interests table. Returns rows written."""
    sys.path.insert(0, str(ROOT / "db"))
    try:
        from db import upsert  # type: ignore
    except ImportError as exc:
        print(f"[db] cannot import db module: {exc}")
        return 0

    now_iso = datetime.now(tz=timezone.utc).isoformat()
    rows = [
        {
            "interest_slug":    i["slug"],
            "interest_name":    i.get("name") or i["slug"].replace("_", " ").title(),
            "country":          country,
            "is_active":        i.get("is_active", True),
            "last_seen_at":     now_iso,
            "last_fetched_at":  now_iso,
        }
        for i in interests
    ]

    try:
        result = upsert("trend_interests", rows, on_conflict="interest_slug,country")
        return len(result)
    except Exception as exc:
        print(f"[db] upsert error: {exc}")
        return 0


def load_interests_from_db(country: str = "US", active_only: bool = True) -> list[dict]:
    """
    Load interest records from trend_interests table.
    Returns list of dicts with keys: id, interest_slug, interest_name, is_active.
    Falls back to official seed list if DB is empty or unavailable.
    """
    sys.path.insert(0, str(ROOT / "db"))
    try:
        from db import select_many  # type: ignore
    except ImportError:
        return _official_seed_as_dicts()

    filters = {"country": country}
    if active_only:
        filters["is_active"] = "true"

    try:
        rows = select_many(
            "trend_interests",
            filters=filters,
            order="last_fetched_at.asc.nullsfirst,interest_slug.asc",
        )
        if rows:
            return rows
    except Exception as exc:
        print(f"[db] load_interests error: {exc}")

    print("[interests] DB empty — using official seed list")
    return _official_seed_as_dicts()


def _official_seed_as_dicts() -> list[dict]:
    return [
        {"interest_slug": s, "interest_name": SLUG_LABELS[s], "is_active": True}
        for s in OFFICIAL_INTEREST_SLUGS
    ]


# ── Map interest slug → internal category label ───────────────────────────────
# Used by trend_fetcher and scraper to categorise pins and keywords.
# One slug can map to one category; unmapped slugs default to their slug.

INTEREST_TO_CATEGORY: dict[str, str] = {
    "home_decor":        "home",
    "architecture":      "home",
    "design":            "home",
    "womens_fashion":    "fashion",
    "mens_fashion":      "fashion",
    "childrens_fashion": "fashion",
    "beauty":            "beauty",
    "health":            "beauty",
    "food_and_drinks":   "food",
    "gardening":         "gardening",
    "diy_and_crafts":    "diy",
    "art":               "art",
    "travel":            "travel",
    "wedding":           "wedding",
    "event_planning":    "wedding",
    "animals":           "animals",
    "education":         "education",
    "parenting":         "parenting",
    "quotes":            "quotes",
    "sport":             "sport",
    "electronics":       "electronics",
    "vehicles":          "vehicles",
    "entertainment":     "entertainment",
    "finance":           "finance",
}


def slug_to_category(slug: str) -> str:
    return INTEREST_TO_CATEGORY.get(slug, slug)


# ── Main ──────────────────────────────────────────────────────────────────────

async def discover_and_upsert(
    country: str = "US",
    run_probe: bool = False,
    probe_delay: float = 0.8,
) -> list[dict]:
    """
    Full discovery run. Returns final merged interest list.
    run_probe=True calls Method 2 which makes N HTTP requests (one per slug).
    """
    print(f"\n[interests] Starting discovery for country={country}")

    async with CurlSession(
        impersonate="chrome146",
        headers=BASE_HEADERS,
    ) as session:
        # Warm up session with homepage visit
        try:
            await session.get(
                "https://www.pinterest.com/",
                headers={"Accept": "text/html,application/xhtml+xml,*/*;q=0.8"},
            )
            await asyncio.sleep(0.5)
        except Exception:
            pass

        m1 = await method1_scrape_homepage(session, country)

        m2: list[dict] = []
        if run_probe:
            slugs_to_probe = list({
                item["slug"] for item in m1
            } | set(OFFICIAL_INTEREST_SLUGS))
            m2 = await method2_probe_api(session, slugs_to_probe, country, probe_delay)

    m3 = method3_official_seed()
    merged = merge_interests(m1, m2, m3)

    active = sum(1 for i in merged if i.get("is_active", True))
    print(f"\n[interests] Merged: {len(merged)} total, {active} active")
    return merged


async def main() -> None:
    ap = argparse.ArgumentParser(
        description="Discover and maintain Pinterest Trends interest categories"
    )
    ap.add_argument("--country",  default="US",
                    help="Country code (default: US)")
    ap.add_argument("--probe",    action="store_true",
                    help="Run API probe to check which slugs are live (slower)")
    ap.add_argument("--list",     action="store_true",
                    help="List interests currently in DB, then exit")
    ap.add_argument("--no-db",    action="store_true",
                    help="Dry-run: discover but do not write to DB")
    ap.add_argument("--probe-delay", type=float, default=0.8,
                    help="Seconds between probe requests (default: 0.8)")
    args = ap.parse_args()

    if args.list:
        rows = load_interests_from_db(args.country, active_only=False)
        print(f"\n{'slug':<25}  {'name':<28}  active")
        print("-" * 65)
        for r in rows:
            active = "✓" if r.get("is_active", True) else "✗"
            print(f"  {r['interest_slug']:<23}  {r.get('interest_name',''):<28}  {active}")
        print(f"\nTotal: {len(rows)}")
        return

    interests = await discover_and_upsert(
        country=args.country,
        run_probe=args.probe,
        probe_delay=args.probe_delay,
    )

    if args.no_db:
        print("\n[interests] --no-db: skipping upsert")
        for i in interests:
            status = "active" if i.get("is_active", True) else "inactive"
            print(f"  {i['slug']:<25}  {i.get('name',''):<28}  {status}")
        return

    written = upsert_interests(interests, args.country)
    print(f"[interests] {written} rows upserted to trend_interests")


if __name__ == "__main__":
    asyncio.run(main())
