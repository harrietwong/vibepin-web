"""
search_trends_scraper.py — Scrape interest-filtered Search Trends via Playwright.

Requires Pinterest Business account login in the shared Playwright profile.
Navigates to trends.pinterest.com/search with each interest ID and captures
the top_trends_filtered API response (40 interest-specific keywords per interest).

Known interest IDs (l1InterestIds):
  960887632144  electronics
  Discovery of others: run with --discover to list available interests from the sidebar.

Usage:
  py -u search_trends_scraper.py --discover              # list available interests
  py -u search_trends_scraper.py                         # dry run, all known interests
  py -u search_trends_scraper.py --interest 960887632144 # single interest
  py -u search_trends_scraper.py --db                    # write to Supabase
"""
import asyncio, json, sys, argparse
from pathlib import Path
from playwright.async_api import async_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT        = Path(__file__).parent
PROFILE_DIR = Path.home() / "AppData/Local/PinterestScraper/profile"

# Known interest IDs (discovered 2026-05-23 from Pinterest Trends search filter dropdown)
KNOWN_INTERESTS = {
    "960887632144": "electronics",
    "925056443165": "animals",
    "903733943146": "kids-fashion",
    "903260720461": "wedding",
    "935249274030": "home-decor",
    "918105274631": "architecture",
    "898620064290": "health",
    "922134410098": "education",
    "913207199297": "finance",
    "908182459161": "travel",
    "935541271955": "beauty",
    "948192800438": "quotes",
    "924581335376": "mens-fashion",
    "948967005229": "womens-fashion",
    "918093243960": "automotive",
    "902065567321": "design",
    "918530398158": "food-and-drink",
    "941870572865": "event-planning",
    "961238559656": "art",
    "953061268473": "entertainment",
    "920236059316": "parenting",
    "909983286710": "gardening",
    "919812032692": "sports",
    "934876475639": "diy-crafts",
}


# ── DB ────────────────────────────────────────────────────────────────────────

def _save_keywords(keywords: list[dict], write_db: bool):
    if not write_db or not keywords:
        return
    sys.path.insert(0, str(ROOT / "db"))
    from db import upsert, select_one  # type: ignore

    tk_rows = [{
        "keyword":             k["keyword"],
        "category":            k.get("category", "general"),
        "source":              k.get("source", "search_trends"),
        "yearly_change":       k.get("yoy", 0),
        "monthly_change":      k.get("monthly", 0),
        "weekly_change":       k.get("weekly", 0),
        "search_volume_level": k.get("volume_level", "medium"),
        "status":              "active",
    } for k in keywords]

    saved = upsert("trend_keywords", tk_rows, on_conflict="keyword,category")
    print(f"  [db] {len(saved)} trend_keywords upserted")

    # Build crawl_queue rows — deduplicate by keyword (same keyword may appear in
    # multiple categories; crawl_queue uses keyword as the unique key)
    cq_rows: list[dict] = []
    seen_kws: set[str] = set()
    for row in saved:
        kw = row["keyword"]
        if kw in seen_kws:
            continue
        seen_kws.add(kw)
        if not select_one("crawl_queue", {"keyword": kw}):
            cq_rows.append({
                "keyword":         kw,
                "category":        row.get("category", "general"),
                "source_interest": row.get("source", "search_trends"),
                "status":          "pending",
                "priority_score":  min(int(abs(row.get("yearly_change", 0)) / 100), 10),
            })
    if cq_rows:
        # Split into chunks to avoid payload limits
        chunk_size = 200
        total = 0
        for i in range(0, len(cq_rows), chunk_size):
            upsert("crawl_queue", cq_rows[i:i+chunk_size], on_conflict="keyword")
            total += len(cq_rows[i:i+chunk_size])
        print(f"  [db] {total} crawl_queue entries added")


# ── Parsing ───────────────────────────────────────────────────────────────────

def _parse_trending(body: dict, interest_name: str) -> list[dict]:
    # top_trends_filtered uses "values"; partner_top_trends_v2 uses "results"
    items = body.get("values") or body.get("results") or []
    results = []
    for item in items:
        term = (item.get("term") or item.get("keyword") or "").lower().strip()
        if not term:
            continue
        wow = (item.get("wow_change") or {}).get("value", 0) or 0
        mom = (item.get("mom_change") or {}).get("value", 0) or 0
        yoy = (item.get("yoy_change") or {}).get("value", 0) or 0
        vol = item.get("normalizedCount") or item.get("normalized_count") or 0
        results.append({
            "keyword":      term,
            "category":     interest_name,
            "source":       f"search_trends:{interest_name}",
            "yoy":          round(yoy * 100, 1),
            "weekly":       round(wow * 100, 1),
            "monthly":      round(mom * 100, 1),
            "volume_level": "high" if vol >= 50 else "medium" if vol >= 10 else "low",
            "vol":          vol,
        })
    return results


# ── Scrape one interest ────────────────────────────────────────────────────────

async def scrape_interest(page, interest_id: str, interest_name: str,
                           country: str) -> list[dict]:
    captured = []

    async def on_response(resp):
        url = resp.url
        ct  = resp.headers.get("content-type", "")
        if "json" not in ct:
            return
        # Capture both the regular filtered endpoint and the business partner endpoint
        if "top_trends_filtered" not in url and "partner_top_trends" not in url:
            return
        try:
            body = await resp.json()
            print(f"    [api-hit] {url[:80]}")
            kws = _parse_trending(body, interest_name)
            if kws:
                captured.extend(kws)
                print(f"    [api] {len(kws)} terms captured from {url.split('/')[-1].split('?')[0]}")
        except Exception:
            pass

    page.on("response", on_response)
    url = f"https://trends.pinterest.com/search?country={country}&l1InterestIds={interest_id}"
    print(f"  → {url}")
    try:
        await page.goto(url, wait_until="networkidle", timeout=40_000)
    except Exception:
        pass
    await page.wait_for_timeout(3000)

    # Scroll to trigger lazy loads
    for _ in range(3):
        await page.keyboard.press("End")
        await page.wait_for_timeout(800)

    page.remove_listener("response", on_response)
    return captured


# ── Discover available interests ───────────────────────────────────────────────

async def discover_interests(page, country: str) -> dict[str, str]:
    """Navigate to /search and extract interest IDs from partner_available_interests_v2 API."""
    discovered = {}

    async def on_response(resp):
        url = resp.url
        ct  = resp.headers.get("content-type", "")
        if "json" not in ct:
            return
        if "partner_available_interests" not in url:
            return
        try:
            body = await resp.json()
            print(f"  [interests-api] {url[:100]}")
            print(f"  [interests-api] top-level keys: {list(body.keys())}")
            # Check insufficientDataResponse structure
            idr = body.get("insufficientDataResponse") or {}
            idr_items: list = []
            if idr:
                print(f"  [interests-api] insufficientDataResponse keys: {list(idr.keys())}")
                idr_items = idr.get("results") or idr.get("interests") or idr.get("values") or []
                if idr_items:
                    print(f"  [interests-api] idr first item keys: {list(idr_items[0].keys())}")
            results = body.get("results") or []
            print(f"  [interests-api] results count: {len(results)}")
            if results:
                print(f"  [interests-api] first item keys: {list(results[0].keys())}")
                print(f"  [interests-api] first item: {results[0]}")
            # Walk all possible containers
            for container in [results, idr_items]:
                for item in container:
                    # Try many possible field name patterns
                    iid = str(
                        item.get("interest_id") or item.get("interestId") or
                        item.get("id") or item.get("entityId") or ""
                    )
                    name = (
                        item.get("display_name") or item.get("displayName") or
                        item.get("name") or item.get("title") or ""
                    )
                    if iid and name:
                        discovered[iid] = name
                        print(f"  [interest] {name} → {iid}")
                    for sub in (item.get("sub_interests") or item.get("subInterests") or []):
                        sid = str(
                            sub.get("interest_id") or sub.get("interestId") or
                            sub.get("id") or ""
                        )
                        sname = (
                            sub.get("display_name") or sub.get("displayName") or
                            sub.get("name") or ""
                        )
                        if sid and sname:
                            discovered[sid] = sname
                            print(f"    [sub] {sname} → {sid}")
        except Exception as exc:
            print(f"  [interests-api] parse error: {exc}")

    page.on("response", on_response)

    # Navigate to electronics interest URL — this reveals the interest sidebar tabs
    seed_url = f"https://trends.pinterest.com/search?country={country}&l1InterestIds=960887632144"
    try:
        await page.goto(seed_url, wait_until="networkidle", timeout=40_000)
    except Exception:
        pass
    await page.wait_for_timeout(3000)

    page.remove_listener("response", on_response)

    # Scroll to trigger any lazy-loaded sidebar content
    for _ in range(3):
        await page.keyboard.press("End")
        await page.wait_for_timeout(600)

    # DOM fallback 1: links with l1InterestIds
    links = await page.query_selector_all("a[href*='l1InterestIds']")
    print(f"  [dom] {len(links)} <a> links with l1InterestIds")
    for link in links:
        href  = await link.get_attribute("href") or ""
        label = (await link.inner_text()).strip()
        if "l1InterestIds=" in href:
            iid = href.split("l1InterestIds=")[-1].split("&")[0]
            discovered[iid] = label or iid
            print(f"  [dom-link] {label!r} → {iid}")

    # DOM fallback 2: buttons / li with data attributes containing interest IDs
    import re as _re
    html = await page.content()
    # Look for interest_id patterns in page source
    id_matches   = _re.findall(r'"interest_id"\s*:\s*"?(\d{10,})"?', html)
    name_matches = _re.findall(r'"display_name"\s*:\s*"([^"]{2,40})"', html)
    for i, iid in enumerate(id_matches):
        name = name_matches[i] if i < len(name_matches) else iid
        discovered[iid] = name
        print(f"  [html] {name} → {iid}")

    # DOM fallback 3: look for sidebar nav items that have onClick/data attributes
    items = await page.query_selector_all("[data-interest-id], [data-id]")
    print(f"  [dom] {len(items)} data-interest-id/data-id elements")
    for el in items:
        iid  = await el.get_attribute("data-interest-id") or await el.get_attribute("data-id") or ""
        name = (await el.inner_text()).strip()[:40]
        if iid and iid.isdigit():
            discovered[iid] = name or iid
            print(f"  [dom-data] {name!r} → {iid}")

    await page.screenshot(path=str(ROOT / "search_interests_debug.png"))
    return discovered


# ── Main ──────────────────────────────────────────────────────────────────────

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db",       action="store_true")
    ap.add_argument("--headed",   action="store_true")
    ap.add_argument("--country",  default="US")
    ap.add_argument("--discover", action="store_true",
                    help="List available interests and their IDs then exit")
    ap.add_argument("--interest", action="append", dest="interests",
                    metavar="ID", help="Interest ID to scrape (repeat for multiple)")
    args = ap.parse_args()

    country = args.country

    # Extract cookies from running Chrome profile (works without closing the browser)
    sys.path.insert(0, str(ROOT))
    from chrome_cookies import get_cookies  # type: ignore
    try:
        pw_cookies = get_cookies(PROFILE_DIR, domains=["pinterest.com"])
        print(f"  [cookies] Extracted {len(pw_cookies)} Pinterest cookies from Chrome profile")
    except Exception as e:
        print(f"  [cookies] Failed to extract cookies: {e}")
        pw_cookies = []

    async with async_playwright() as pw:
        # Launch a fresh browser (no profile needed — we inject cookies)
        ctx = await pw.chromium.launch(
            headless=not args.headed,
            args=["--disable-blink-features=AutomationControlled"],
        )
        ctx_page = await ctx.new_context(viewport={"width": 1280, "height": 900})
        if pw_cookies:
            await ctx_page.add_cookies(pw_cookies)
            print(f"  [cookies] Injected {len(pw_cookies)} cookies into Playwright context")
        page = await ctx_page.new_page()

        if args.discover:
            print(f"Discovering interests on trends.pinterest.com/search…")
            found = await discover_interests(page, country)
            print(f"\nFound {len(found)} interests:")
            for iid, name in found.items():
                print(f"  {iid}  {name}")
            await ctx_page.close(); await ctx.close()
            return

        # Determine which interests to scrape
        if args.interests:
            interests = {iid: KNOWN_INTERESTS.get(iid, iid) for iid in args.interests}
        else:
            interests = KNOWN_INTERESTS

        all_keywords: list[dict] = []

        for iid, iname in interests.items():
            print(f"\n{'='*60}")
            print(f"  Interest: {iname} ({iid})")
            print(f"{'='*60}")
            kws = await scrape_interest(page, iid, iname, country)
            if kws:
                all_keywords.extend(kws)
                print(f"\n  keyword{'':37} {'yoy':>8}  {'wow':>6}  {'vol':>4}")
                print(f"  {'-'*60}")
                for k in sorted(kws, key=lambda x: abs(x.get("yoy", 0)), reverse=True)[:30]:
                    print(f"  {k['keyword']:<42} {k.get('yoy',0):>7.0f}%  "
                          f"{k.get('weekly',0):>5.0f}%  {k.get('vol',0):>4}")
                print(f"\n  → {len(kws)} keywords")
            else:
                print(f"  (no keywords captured — check business login)")

        await ctx.close()

    # Dedup
    seen, deduped = set(), []
    for k in all_keywords:
        key = (k["keyword"], k["category"])
        if key not in seen:
            seen.add(key)
            deduped.append(k)

    print(f"\n{'='*60}")
    print(f"  TOTAL: {len(deduped)} interest-specific keywords")
    print(f"{'='*60}")

    if args.db and deduped:
        print(f"\nSaving to DB…")
        _save_keywords(deduped, True)

    print(f"\nDone.")


if __name__ == "__main__":
    asyncio.run(main())
