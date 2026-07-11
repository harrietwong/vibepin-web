"""
expand_keywords.py — Pinterest autocomplete keyword expander.

Takes seed keywords for a category, calls Pinterest's AdvancedTypeaheadResource
to get real autocomplete suggestions, scores each one, and writes high-demand
long-tail keywords to trend_keywords + crawl_queue.

Usage:
  py expand_keywords.py --category digital-products
  py expand_keywords.py --category digital-products --min-growth 80 --top 5
  py expand_keywords.py --category holidays-seasonal --dry-run
"""

import argparse, asyncio, json, os, random, sys, time
from pathlib import Path
from typing import List, Optional
from urllib.parse import urlencode, quote

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT / "db"))

from curl_cffi.requests import AsyncSession as CurlSession

# ── Supabase REST helpers ──────────────────────────────────────────────────────

SUPA_URL = os.environ.get("SUPABASE_URL", "")
SUPA_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

def _supa_headers(extra: dict = {}) -> dict:
    return {"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}",
            "Content-Type": "application/json", "Prefer": "return=minimal", **extra}

def _supa_get(table: str, params: str = "") -> list:
    import urllib.request
    req = urllib.request.Request(
        f"{SUPA_URL}/rest/v1/{table}?{params}",
        headers={"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}"}
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def _supa_post(table: str, rows: list) -> int:
    import urllib.request
    data = json.dumps(rows).encode()
    req = urllib.request.Request(
        f"{SUPA_URL}/rest/v1/{table}",
        data=data, headers=_supa_headers(), method="POST"
    )
    with urllib.request.urlopen(req) as r:
        return r.status

# ── Pinterest session (reused from trend_fetcher) ─────────────────────────────

BASE_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/147.0.0.0 Safari/537.36"),
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    "X-Requested-With": "XMLHttpRequest",
}

class Session:
    def __init__(self):
        self._session: Optional[CurlSession] = None
        self._csrf = ""
        self._app_ver = ""
        self._last = 0.0

    async def __aenter__(self):
        self._session = CurlSession(impersonate="chrome146", headers=BASE_HEADERS)
        await self._bootstrap()
        return self

    async def __aexit__(self, *_):
        if self._session:
            await self._session.close()

    async def _bootstrap(self):
        import re
        r = await self._session.get(
            "https://www.pinterest.com/",
            headers={"Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                     "Sec-Fetch-Mode": "navigate"},
        )
        self._csrf = self._session.cookies.get("csrftoken", "")
        m = re.search(r'id=["\']__PWS_DATA__["\'][^>]*>(.*?)</script>', r.text, re.DOTALL)
        if m:
            try:
                self._app_ver = json.loads(m.group(1)).get("appVersion", "")
            except Exception:
                pass
        print(f"[session] ready  csrf={'ok' if self._csrf else 'missing'}  ver={self._app_ver or 'n/a'}")
        await asyncio.sleep(random.uniform(0.8, 1.2))

    async def get(self, url: str, referer: str = "https://www.pinterest.com/",
                  source_url: str = "", pws_handler: str = "", delay: float = 1.2) -> dict:
        elapsed = time.monotonic() - self._last
        if elapsed < delay:
            await asyncio.sleep(delay - elapsed)
        self._last = time.monotonic()

        import secrets
        tid = secrets.token_hex(8)
        extra = {
            "Referer": referer,
            "X-B3-TraceId": tid, "X-B3-SpanId": secrets.token_hex(8),
            "X-B3-ParentSpanId": tid, "X-B3-Flags": "0",
        }
        if self._csrf:       extra["X-CSRFToken"] = self._csrf
        if self._app_ver:    extra["X-App-Version"] = self._app_ver
        if source_url:       extra["X-Pinterest-Source-Url"] = source_url
        if pws_handler:      extra["X-Pinterest-Pws-Handler"] = pws_handler

        try:
            r = await self._session.get(url, headers=extra)
            if r.status_code == 200:
                return r.json()
            print(f"  [HTTP {r.status_code}] {url[:80]}")
            return {}
        except Exception as e:
            print(f"  [error] {e}")
            return {}


# ── Autocomplete expansion ─────────────────────────────────────────────────────

async def get_suggestions(session: Session, seed: str, max_suggestions: int = 8) -> List[str]:
    """Call AdvancedTypeaheadResource and return up to max_suggestions terms."""
    src = f"/search/pins/?q={seed.replace(' ', '+')}"
    params = {
        "source_url": src,
        "data": json.dumps({
            "options": {"term": seed, "pin_scope": "pins",
                        "autocomplete_request_surface": 0},
            "context": {}
        }, separators=(',', ':')),
        "_": str(int(time.time() * 1000)),
    }
    url = "https://www.pinterest.com/resource/AdvancedTypeaheadResource/get/?" + urlencode(params)
    data = await session.get(url, referer=f"https://www.pinterest.com/search/pins/?q={quote(seed)}",
                             source_url=src, pws_handler="www/search/[scope].js", delay=1.2)

    items = ((data.get("resource_response") or {}).get("data") or {}).get("items") or []
    results = []
    for item in items[:max_suggestions]:
        term = (item.get("query") or item.get("label") or item.get("display")
                or (item.get("item") or {}).get("term") or "").strip()
        if term and term.lower() != seed.lower():
            results.append(term)
    return results


def _flatten_pins(obj, depth: int = 0) -> list:
    """Recursively extract pin dicts from a nested search result."""
    if depth > 6 or not isinstance(obj, (dict, list)):
        return []
    if isinstance(obj, list):
        out = []
        for item in obj:
            out.extend(_flatten_pins(item, depth + 1))
        return out
    if obj.get("type") == "pin" and obj.get("id"):
        return [obj]
    out = []
    for v in obj.values():
        if isinstance(v, (dict, list)):
            out.extend(_flatten_pins(v, depth + 1))
    return out


async def score_keyword(session: Session, kw: str) -> dict:
    """
    Fetch page 1 of search results, estimate volume + growth from pin metadata.
    Returns: {vol_score, vol_label, est_yoy, est_wow, avg_velocity}

    Unauth API doesn't return save_count; uses created_at recency as growth signal.
    vol_score is based on result count (10+ = medium, 20+ = high).
    est_yoy uses recency ratio (recent pins / total pins * 300) as proxy.
    """
    import datetime as _dt
    from email.utils import parsedate_to_datetime

    src = f"/search/pins/?q={kw.replace(' ', '+')}&rs=typed"
    params = {
        "source_url": src,
        "data": json.dumps({
            "options": {"query": kw, "scope": "pins", "page_size": 25},
            "context": {}
        }, separators=(',', ':')),
        "_": str(int(time.time() * 1000)),
    }
    url = "https://www.pinterest.com/resource/BaseSearchResource/get/?" + urlencode(params)
    data = await session.get(url, referer=f"https://www.pinterest.com/search/pins/?q={quote(kw)}",
                             source_url=src, pws_handler="www/search/[scope].js", delay=1.0)

    resp_data = (data.get("resource_response") or {}).get("data") or {}
    raw_results = resp_data.get("results") if isinstance(resp_data, dict) else []
    pins = _flatten_pins(raw_results or [])

    if not pins:
        return {"vol_score": 1, "vol_label": "low", "est_yoy": 0.0, "est_wow": 0.0, "avg_velocity": 0.0}

    now = _dt.datetime.now(_dt.timezone.utc)
    save_velocities, recent_30d, recent_7d = [], 0, 0
    dated_count = 0

    for p in pins[:25]:
        saves = int(p.get("save_count") or p.get("repin_count") or 0)
        created_str = p.get("created_at") or ""
        days = None
        if created_str:
            try:
                try:
                    dt = parsedate_to_datetime(created_str)
                except Exception:
                    dt = _dt.datetime.fromisoformat(created_str.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=_dt.timezone.utc)
                days = max(1, (now - dt).days)
                dated_count += 1
                if days <= 30:
                    recent_30d += 1
                if days <= 7:
                    recent_7d += 1
            except Exception:
                pass
        if days and saves:
            save_velocities.append(saves / days)

    avg_vel = round(sum(save_velocities) / max(1, len(save_velocities)), 1) if save_velocities else 0.0
    # Recency ratio: what fraction of results are fresh (last 30 days)
    recency_pct = round(100 * recent_30d / max(1, dated_count), 1) if dated_count else 0.0
    wow_pct     = round(100 * recent_7d  / max(1, dated_count), 1) if dated_count else 0.0

    # Volume score: use result count as primary signal (save_count not available unauth)
    n = len(pins)
    if save_velocities:
        # If save data is available, use velocity bins
        vol_score = 4 if avg_vel >= 100 else 3 if avg_vel >= 20 else 2 if avg_vel >= 3 else 1
    else:
        # Fall back to result count bins
        vol_score = 4 if n >= 22 else 3 if n >= 18 else 2 if n >= 10 else 1
    vol_label = {4: "very_high", 3: "high", 2: "medium", 1: "low"}[vol_score]

    # YoY estimate: blend recency signal with velocity
    est_yoy = min(500.0, round(recency_pct * 3.0 + avg_vel * 1.5, 1)) if (recency_pct or avg_vel) else 0.0

    return {"vol_score": vol_score, "vol_label": vol_label,
            "est_yoy": est_yoy, "est_wow": wow_pct, "avg_velocity": avg_vel}


# ── Main expansion loop ────────────────────────────────────────────────────────

async def expand(
    category: str,
    seeds: List[str],
    min_growth: float = 50.0,
    top_per_seed: int = 5,
    dry_run: bool = False,
) -> List[dict]:
    """
    For each seed, get autocomplete suggestions, score them, filter by min_growth,
    return top results.
    """
    # Load already-known keywords to avoid duplicates
    existing_rows = _supa_get("trend_keywords", f"select=keyword&category=eq.{category}")
    existing_kws = {r["keyword"].lower() for r in existing_rows}
    print(f"[expand] {len(existing_kws)} existing keywords in '{category}'")
    print(f"[expand] processing {len(seeds)} seeds, top_per_seed={top_per_seed}, min_growth={min_growth}%")
    print()

    all_results = []
    seen = set(existing_kws)

    async with Session() as session:
        for i, seed in enumerate(seeds):
            print(f"[{i+1}/{len(seeds)}] seed: '{seed}'")

            suggestions = await get_suggestions(session, seed, max_suggestions=8)
            if not suggestions:
                print(f"  → no suggestions returned")
                continue

            print(f"  → {len(suggestions)} suggestions: {suggestions[:5]}")

            scored = []
            for kw in suggestions:
                if kw.lower() in seen:
                    print(f"     skip (exists): {kw}")
                    continue
                # Skip website names / brand titles (contain | or multiple uppercase words)
                if "|" in kw or len(kw) > 80:
                    print(f"     skip (brand/url): {kw[:60]}")
                    continue
                score = await score_keyword(session, kw)
                scored.append({"keyword": kw, **score})
                seen.add(kw.lower())
                print(f"     {kw:<45} vel={score['avg_velocity']:6.1f}  vol={score['vol_label']:<9}  est_yoy={score['est_yoy']:.0f}%")
                await asyncio.sleep(random.uniform(0.4, 0.8))

            # Keep top_per_seed by vol_score then est_yoy (use yoy as tiebreaker when vel=0)
            scored.sort(key=lambda x: (x["vol_score"], x["est_yoy"], x["avg_velocity"]), reverse=True)
            kept = [s for s in scored[:top_per_seed] if s["est_yoy"] >= min_growth]
            print(f"  → kept {len(kept)} / {len(scored)} after min_growth filter")
            all_results.extend(kept)

            await asyncio.sleep(random.uniform(1.0, 2.0))

    print(f"\n[expand] total new keywords: {len(all_results)}")

    if not all_results:
        return []

    # Sort by velocity descending
    all_results.sort(key=lambda x: x["avg_velocity"], reverse=True)

    # Print summary table
    print(f"\n{'KEYWORD':<48} {'YOY':>7}  {'VOL':<10}  {'VEL':>7}")
    print("─" * 78)
    for r in all_results:
        print(f"  {r['keyword']:<46} {r['est_yoy']:>6.0f}%  {r['vol_label']:<10}  {r['avg_velocity']:>6.1f}/d")

    if dry_run:
        print("\n[dry-run] skipping DB writes")
        return all_results

    # Write to trend_keywords
    rows_kw = [{
        "keyword":            r["keyword"],
        "category":           category,
        "subcategory":        None,
        "status":             "active",
        "priority_score":     min(99, int(50 + r["vol_score"] * 10 + r["avg_velocity"] / 20)),
        "weekly_change":      round(r["est_wow"], 1),
        "monthly_change":     round(r["est_wow"] * 4, 1),
        "yearly_change":      round(r["est_yoy"], 1),
        "search_volume_level": r["vol_label"],
    } for r in all_results]

    status = _supa_post("trend_keywords", rows_kw)
    print(f"\n[db] trend_keywords insert: HTTP {status} ({len(rows_kw)} rows)")

    # Add to crawl_queue
    rows_cq = [{"keyword": r["keyword"], "category": category, "status": "pending"}
               for r in all_results]
    status2 = _supa_post("crawl_queue", rows_cq)
    print(f"[db] crawl_queue insert: HTTP {status2} ({len(rows_cq)} rows)")

    return all_results


# ── Seed lists per category ────────────────────────────────────────────────────

SEEDS: dict = {
    "digital-products": [
        "digital planner",
        "notion template",
        "goodnotes template",
        "canva template",
        "printable wall art",
        "svg cut files",
        "digital download",
        "procreate brushes",
        "lightroom preset",
        "digital stickers",
        "etsy printable",
        "sublimation design",
    ],
    "holidays-seasonal": [
        "christmas decor",
        "halloween decor",
        "thanksgiving ideas",
        "valentines day",
        "fall aesthetic",
        "winter aesthetic",
        "summer party ideas",
        "easter decor",
    ],
    "beauty": [
        "skincare routine",
        "nail art ideas",
        "makeup aesthetic",
        "hair ideas",
    ],
    "home-decor": [
        "living room ideas",
        "bedroom aesthetic",
        "kitchen decor",
        "bathroom ideas",
    ],
}


# ── CLI ────────────────────────────────────────────────────────────────────────

async def main():
    parser = argparse.ArgumentParser(description="Pinterest keyword expander")
    parser.add_argument("--category", required=True, help="Category to expand (e.g. digital-products)")
    parser.add_argument("--seeds", nargs="*", help="Override seed keywords")
    parser.add_argument("--min-growth", type=float, default=50.0, help="Min est. YoY%% to keep (default 50)")
    parser.add_argument("--top", type=int, default=5, help="Max results per seed (default 5)")
    parser.add_argument("--dry-run", action="store_true", help="Print results without writing to DB")
    args = parser.parse_args()

    seeds = args.seeds or SEEDS.get(args.category)
    if not seeds:
        print(f"No seeds defined for '{args.category}'. Use --seeds kw1 kw2 ...")
        sys.exit(1)

    await expand(
        category=args.category,
        seeds=seeds,
        min_growth=args.min_growth,
        top_per_seed=args.top,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    asyncio.run(main())
