"""
enrich_competition.py — Enrich trend_keywords with competition index and interest score.

Fields written:
  interest_index_estimate      numeric     — 0-100 normalised interest score derived from
                                             search_volume_level + trend_history.
                                             NOT a real search count; do not display to users.
  competition_sample_count     integer     — Number of pins observed in a sampled Pinterest
                                             search result. This is a sample, not an official total.
  competition_index            numeric     — 0-100 internal ranking index (from sample count).
  competition_level            text        — Low / Medium / High  (from competition_index).
  competition_source           text        — "pinterest_search_sample" or "visual_count_estimate"
  competition_confidence       text        — High / Medium / Low (based on method used)
  last_competition_enriched_at timestamptz — timestamp of this enrichment pass

IMPORTANT: these values are for internal band derivation only. The frontend
shows only competition_level (Low/Medium/High) — never the raw sample count.

Prerequisites:
  pip install playwright httpx python-dotenv
  playwright install chromium
  .env must have SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY

Usage:
  py enrich_competition.py              # process all keywords without competition data
  py enrich_competition.py 100          # first 100 only (smoke test)
  py enrich_competition.py --dry-run    # compute but do not write to DB
"""

import argparse
import asyncio
import json
import os
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    from dotenv import load_dotenv; load_dotenv()
except ImportError:
    pass

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT        = Path(__file__).parent
PROFILE_DIR = Path.home() / "AppData/Local/PinterestScraper/profile"

G = "\033[92m"; Y = "\033[93m"; C = "\033[96m"; R = "\033[91m"; X = "\033[0m"
def _ok(m):   print(f"{G}  ✓  {m}{X}")
def _info(m): print(f"{C}  ·  {m}{X}")
def _warn(m): print(f"{Y}  !  {m}{X}")
def _err(m):  print(f"{R}  ✗  {m}{X}")


# ── DB access ─────────────────────────────────────────────────────────────────

import httpx

_http: httpx.Client | None = None

def _db() -> httpx.Client:
    global _http
    if _http is None:
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        if not url or not key:
            raise RuntimeError(".env must set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
        _http = httpx.Client(
            base_url=f"{url}/rest/v1/",
            headers={
                "apikey":        key,
                "Authorization": f"Bearer {key}",
                "Content-Type":  "application/json",
                "Accept":        "application/json",
                "Prefer":        "return=minimal",
            },
            timeout=30,
        )
    return _http


def _load_keywords(limit: int) -> list[dict]:
    """
    Load keywords that still lack competition data.
    Excludes rows that already have competition_level to avoid overwriting good data.
    """
    params = (
        "select=id,keyword,search_volume_level,trend_history"
        "&competition_level=is.null"
        "&status=eq.active"
        f"&limit={limit if limit else 2000}"
    )
    r = _db().get("trend_keywords", params=params)
    r.raise_for_status()
    return r.json()


def _patch_keyword(kid: str, payload: dict, retries: int = 2) -> bool:
    """Patch a row. Returns True on success. Never raises — logs and returns False."""
    for attempt in range(retries + 1):
        try:
            r = _db().patch(f"trend_keywords?id=eq.{kid}", json=payload)
            r.raise_for_status()
            return True
        except Exception as e:
            if attempt < retries:
                time.sleep(2 ** attempt)
            else:
                _err(f"DB write failed for {kid}: {e}")
                return False
    return False


# ── Column-presence detection ──────────────────────────────────────────────────

_PRESENT_COLS: set[str] | None = None

def _available_cols() -> set[str]:
    """
    Detect which enrichment columns actually exist in the DB by probing each
    one via a lightweight SELECT.  Results are cached for the lifetime of the
    process so we only pay the probe cost once.

    Gracefully handles the case where the migration hasn't been run yet:
    the script will still write to whichever columns exist.
    """
    global _PRESENT_COLS
    if _PRESENT_COLS is not None:
        return _PRESENT_COLS

    _PRESENT_COLS = set()
    candidates = [
        "interest_index_estimate",
        "competition_sample_count",
        "competition_index",
        "competition_level",
        "competition_source",
        "competition_confidence",
        "last_competition_enriched_at",
    ]
    for col in candidates:
        try:
            r = _db().get("trend_keywords", params=f"select={col}&limit=1")
            if r.status_code == 200:
                _PRESENT_COLS.add(col)
        except Exception:
            pass

    _info(f"Available enrichment columns ({len(_PRESENT_COLS)}/7): "
          + ", ".join(sorted(_PRESENT_COLS)) or "(none)")
    missing = [c for c in candidates if c not in _PRESENT_COLS]
    if missing:
        _warn(f"Missing columns (run add_competition_columns.sql): {', '.join(missing)}")
    return _PRESENT_COLS


def _filter_payload(payload: dict) -> dict:
    """Remove keys for columns that don't exist in the DB yet."""
    available = _available_cols()
    return {k: v for k, v in payload.items() if k in available}


# ── Interest-index estimate ────────────────────────────────────────────────────
# This is a 0-100 score for internal ranking only.
# It is NOT presented as an absolute search volume to users.

_VOL_RANGES: dict[str, tuple[int, int]] = {
    "very_high": (75, 100),
    "high":      (50,  75),
    "medium":    (25,  50),
    "low":       ( 5,  25),
}

def estimate_interest_index(level: str | None, trend_history: list | None) -> float:
    lo, hi = _VOL_RANGES.get((level or "").lower(), (5, 25))
    if trend_history:
        latest = trend_history[-1].get("value", 50) if trend_history else 50
        ratio  = max(0.0, min(1.0, latest / 100.0))
        return round(lo + (hi - lo) * ratio, 1)
    return round((lo + hi) / 2, 1)


# ── Competition-index banding ──────────────────────────────────────────────────

# Maps a sampled pin count to a 0-100 index (log scale, capped at 1M pins = 100).
# Used internally for ranking only — not displayed to users.
def sample_to_index(count: int) -> float:
    import math
    if count <= 0:
        return 0.0
    # log10(1) = 0 → 0,  log10(1_000_000) = 6 → 100
    return round(min(100, max(0, math.log10(max(count, 1)) / 6 * 100)), 1)

# Band derived directly from count, not from the index.
# Thresholds: < 10k → Low, 10k-100k → Medium, ≥ 100k → High.
def competition_level_from_count(count: int) -> str:
    if count < 10_000:   return "Low"
    if count < 100_000:  return "Medium"
    return "High"

# Keep old name as alias so existing call-sites work during migration.
competition_level_from_index = competition_level_from_count  # deprecated alias


# ── Playwright scraper ────────────────────────────────────────────────────────

_TIMEOUT = 22_000  # ms

async def scrape_competition_sample(page, keyword: str) -> dict:
    """
    Visit Pinterest search and attempt to capture a pin count from the API.

    Returns a dict with:
      sample_count   int | None
      source         "pinterest_search_sample" | "visual_count_estimate"
      confidence     "High" | "Medium" | "Low"
    """
    captured: list[int | None] = [None]
    is_api_intercept = [False]

    async def handle_response(response):
        if captured[0] is not None:
            return
        url = response.url
        if ("BaseSearchResource" in url or "/v3/search/" in url or "search/pins" in url):
            try:
                data = await response.json()
                for path in [
                    lambda d: d["resource_response"]["data"]["results_total"],
                    lambda d: d["total"],
                    lambda d: d["count"],
                    lambda d: d["resource_response"]["data"]["total_items"],
                ]:
                    try:
                        val = path(data)
                        if isinstance(val, (int, float)) and val > 0:
                            captured[0] = int(val)
                            is_api_intercept[0] = True
                            return
                    except (KeyError, TypeError, ValueError):
                        pass
            except Exception:
                pass

    page.on("response", handle_response)
    try:
        url = f"https://www.pinterest.com/search/pins/?q={keyword.replace(' ', '+')}"
        await page.goto(url, timeout=_TIMEOUT, wait_until="domcontentloaded")
        await asyncio.sleep(random.uniform(3.0, 5.0))  # allow API responses after domcontentloaded

        # Fallback: count visible pin cards and scale
        if captured[0] is None:
            pins = await page.query_selector_all('[data-test-id="pin"]')
            if pins:
                captured[0] = len(pins) * 1_500  # heuristic: first screen ≈ 25 pins
                is_api_intercept[0] = False

    except Exception as e:
        _warn(f"Playwright error [{keyword}]: {e}")
    finally:
        page.remove_listener("response", handle_response)

    count = captured[0]
    if count is None:
        return {"sample_count": None, "source": None, "confidence": "Low"}

    if is_api_intercept[0]:
        return {"sample_count": count, "source": "pinterest_search_sample", "confidence": "Medium"}
    else:
        # Visual count is rough — mark lower confidence
        return {"sample_count": count, "source": "visual_count_estimate", "confidence": "Low"}


# ── Main loop ─────────────────────────────────────────────────────────────────

DELAY_MIN = 2.5
DELAY_MAX = 4.5
MAX_RETRIES = 2


async def run(limit: int = 0, dry_run: bool = False) -> None:
    print(f"\n{'='*60}")
    print(f"  enrich_competition.py  {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC")
    print(f"  limit={limit or 'all'}  dry_run={dry_run}")
    print(f"{'='*60}\n")

    keywords = _load_keywords(limit)
    total    = len(keywords)
    _info(f"Keywords pending enrichment: {total}")

    if total == 0:
        _ok("All active keywords already have competition data — nothing to do.")
        return

    from playwright.async_api import async_playwright  # type: ignore

    success = 0
    failures = 0

    async with async_playwright() as pw:
        browser = await pw.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox"],
        )
        page = browser.pages[0] if browser.pages else await browser.new_page()

        # Warm-up: visit Pinterest so session cookies activate
        try:
            await page.goto("https://www.pinterest.com/", timeout=15_000, wait_until="domcontentloaded")
            await asyncio.sleep(2)
        except Exception:
            pass

        for i, row in enumerate(keywords):
            kw  = row["keyword"]
            kid = row["id"]

            th = row.get("trend_history") or []
            if isinstance(th, str):
                try: th = json.loads(th)
                except Exception: th = []

            # 1. Interest index estimate (internal score, NOT shown as search volume)
            interest_idx = estimate_interest_index(row.get("search_volume_level"), th)

            # 2. Competition sample
            result = await scrape_competition_sample(page, kw)
            sample_count = result["sample_count"]
            comp_source  = result["source"]
            comp_conf    = result["confidence"]

            if sample_count is not None:
                comp_index = sample_to_index(sample_count)
                comp_level = competition_level_from_count(sample_count)  # level from count, not index
            else:
                comp_index = None
                comp_level = None

            # Console output
            sample_str = f"sample={sample_count:,}" if sample_count else "sample=None"
            print(
                f"  [{i+1}/{total}]  {kw:<42}  {sample_str:<18}"
                f"  idx={comp_index or '—':<6}  level={comp_level or '—':<8}"
                f"  conf={comp_conf or '—'}"
            )

            payload: dict = {
                "interest_index_estimate":      interest_idx,
                "last_competition_enriched_at": datetime.now(timezone.utc).isoformat(),
            }
            if sample_count is not None:
                payload["competition_sample_count"] = sample_count
                payload["competition_index"]        = comp_index
                payload["competition_level"]        = comp_level
                payload["competition_source"]       = comp_source
                payload["competition_confidence"]   = comp_conf
            # If sample_count is None, we intentionally do NOT write competition_level
            # so the row remains eligible for the next run.

            if not dry_run:
                # Strip any columns that don't exist in the DB yet
                safe_payload = _filter_payload(payload)
                if not safe_payload:
                    _warn(f"  No writable columns for {kw} — run add_competition_columns.sql first")
                    failures += 1
                else:
                    ok = _patch_keyword(kid, safe_payload)
                    if ok:
                        success += 1
                    else:
                        failures += 1
            else:
                success += 1

            await asyncio.sleep(random.uniform(DELAY_MIN, DELAY_MAX))

        await browser.close()

    print()
    _ok(f"Done — {success}/{total} updated" + (" (dry-run)" if dry_run else ""))
    if failures:
        _warn(f"{failures} DB writes failed — re-run to retry (rows left without competition_level)")


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description="Enrich trend_keywords with competition data")
    ap.add_argument("limit", nargs="?", type=int, default=0,
                    help="Max keywords to process (0 = all pending)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Compute values but skip DB writes")
    args = ap.parse_args()
    asyncio.run(run(limit=args.limit, dry_run=args.dry_run))


if __name__ == "__main__":
    main()
