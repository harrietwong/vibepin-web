"""
trends_scraper.py — Scrape Pinterest Trends via Playwright (response interception).

Captures two data sources from trends.pinterest.com:
  1. top_trends_filtered  — global trending keywords with real yoy/wow/mom %
  2. editorial/content    — Pinterest Spotlight curated trend themes + keywords

Both use response listeners (not page.evaluate) since that's what the site loads.

Usage:
  py -u trends_scraper.py --headed          # show browser, dry run
  py -u trends_scraper.py --db              # write to Supabase
  py -u trends_scraper.py --country US --db
"""
import asyncio, json, sys, argparse
from pathlib import Path
from playwright.async_api import async_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT        = Path(__file__).parent
PROFILE_DIR = Path.home() / "AppData/Local/PinterestScraper/profile"


# ── DB ────────────────────────────────────────────────────────────────────────

def _save_keywords(keywords: list[dict], write_db: bool):
    if not write_db or not keywords:
        return
    sys.path.insert(0, str(ROOT / "db"))
    from db import upsert, select_one  # type: ignore

    tk_rows = [{
        "keyword":             k["keyword"],
        "category":            k.get("category", "general"),
        "source":              k.get("source", "trends_scraper"),
        "yearly_change":       k.get("yoy", 0),
        "monthly_change":      k.get("monthly", 0),
        "weekly_change":       k.get("weekly", 0),
        "search_volume_level": k.get("volume_level", "medium"),
        "status":              "active",
    } for k in keywords]

    saved = upsert("trend_keywords", tk_rows, on_conflict="keyword,category")
    print(f"  [db] {len(saved)} trend_keywords upserted")

    cq_rows = []
    for row in saved:
        if not select_one("crawl_queue", {"keyword": row["keyword"]}):
            cq_rows.append({
                "keyword":         row["keyword"],
                "category":        row.get("category", "general"),
                "source_interest": row.get("source", "trends_scraper"),
                "status":          "pending",
                "priority_score":  min(int(abs(row.get("yearly_change", 0)) / 100), 10),
            })
    if cq_rows:
        upsert("crawl_queue", cq_rows, on_conflict="keyword")
        print(f"  [db] {len(cq_rows)} crawl_queue entries added")


# ── Parsing ───────────────────────────────────────────────────────────────────

def _parse_trending(body: dict, country: str) -> list[dict]:
    """Parse top_trends_filtered API response."""
    results = []
    for item in body.get("values", []):
        term = item.get("term", "").lower().strip()
        if not term:
            continue
        wow = (item.get("wow_change") or {}).get("value", 0) or 0
        mom = (item.get("mom_change") or {}).get("value", 0) or 0
        yoy = (item.get("yoy_change") or {}).get("value", 0) or 0
        vol = item.get("normalizedCount", 0) or 0
        results.append({
            "keyword":      term,
            "category":     "trending",
            "source":       "top_trends_filtered",
            "yoy":          round(yoy * 100, 1),
            "weekly":       round(wow * 100, 1),
            "monthly":      round(mom * 100, 1),
            "volume_level": "high" if vol >= 50 else "medium" if vol >= 10 else "low",
            "vol":          vol,
        })
    return results


def _parse_editorial(body: dict, country: str) -> list[dict]:
    """Parse editorial/content API response."""
    data = body.get("resource_response", {}).get("data", [])
    results = []
    for theme in data:
        if not isinstance(theme, dict):
            continue
        title = theme.get("title", "")
        kws_by_region = theme.get("keywords", {})
        kws = kws_by_region.get(country, kws_by_region.get("US", []))
        for kw in kws:
            kw = kw.lower().strip()
            if kw:
                results.append({
                    "keyword":      kw,
                    "category":     "editorial",
                    "source":       f"editorial:{title}",
                    "yoy":          0,
                    "weekly":       0,
                    "monthly":      0,
                    "volume_level": "high",
                    "theme":        title,
                })
    return results


# ── Main ──────────────────────────────────────────────────────────────────────

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db",      action="store_true")
    ap.add_argument("--headed",  action="store_true")
    ap.add_argument("--country", default="US")
    ap.add_argument("--pages",   type=int, default=3,
                    help="How many trend page loads to capture (each adds ~40 terms)")
    args = ap.parse_args()

    country = args.country
    trending_kws  = []
    editorial_kws = []

    async with async_playwright() as pw:
        ctx = await pw.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=not args.headed,
            args=["--disable-blink-features=AutomationControlled"],
            viewport={"width": 1280, "height": 900},
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()

        async def on_response(resp):
            url = resp.url
            ct  = resp.headers.get("content-type", "")
            if "json" not in ct:
                return
            try:
                body = await resp.json()
            except Exception:
                return

            if "top_trends_filtered" in url:
                kws = _parse_trending(body, country)
                if kws:
                    trending_kws.extend(kws)
                    print(f"  [trending] captured {len(kws)} terms (total {len(trending_kws)})")

            elif "editorial/content" in url:
                kws = _parse_editorial(body, country)
                if kws:
                    editorial_kws.extend(kws)
                    themes = list({k["theme"] for k in kws})
                    print(f"  [editorial] captured {len(kws)} keywords across {len(themes)} themes")
                    for t in themes:
                        print(f"    - {t}")

        page.on("response", on_response)

        # Load the base trends page — captures default 40 trending terms + editorial
        print(f"Loading trends.pinterest.com (country={country})…")
        try:
            await page.goto(f"https://trends.pinterest.com/?country={country}",
                            wait_until="networkidle", timeout=40_000)
        except Exception:
            pass  # networkidle may time out; data already captured via response listener
        await page.wait_for_timeout(3000)

        # Scroll to trigger lazy-loaded content (editorial section may need scroll)
        for _ in range(3):
            await page.keyboard.press("End")
            await page.wait_for_timeout(1000)

        await ctx.close()

    # ── Print results ────────────────────────────────────────────────────────
    # Dedup
    def dedup(kws):
        seen, out = set(), []
        for k in kws:
            if k["keyword"] not in seen:
                seen.add(k["keyword"])
                out.append(k)
        return out

    trending_kws  = dedup(trending_kws)
    editorial_kws = dedup(editorial_kws)

    print(f"\n{'='*65}")
    print(f"  GLOBAL TRENDING ({len(trending_kws)} keywords)")
    print(f"{'='*65}")
    if trending_kws:
        print(f"  {'keyword':<42} {'yoy':>8}  {'wow':>6}  {'vol':>4}")
        print(f"  {'-'*65}")
        for k in sorted(trending_kws, key=lambda x: abs(x.get("yoy",0)), reverse=True)[:30]:
            print(f"  {k['keyword']:<42} {k.get('yoy',0):>7.0f}%  "
                  f"{k.get('weekly',0):>5.0f}%  {k.get('vol',0):>4}")

    print(f"\n{'='*65}")
    print(f"  EDITORIAL SPOTLIGHT ({len(editorial_kws)} keywords)")
    print(f"{'='*65}")
    if editorial_kws:
        last_theme = None
        for k in editorial_kws:
            if k.get("theme") != last_theme:
                print(f"\n  [{k.get('theme','')}]")
                last_theme = k.get("theme")
            print(f"    {k['keyword']}")

    # Save to DB
    if args.db:
        print(f"\n{'='*65}")
        print("  Saving to DB…")
        print(f"{'='*65}")
        if trending_kws:
            print(f"\n  → Trending:")
            _save_keywords(trending_kws, True)
        if editorial_kws:
            print(f"\n  → Editorial:")
            _save_keywords(editorial_kws, True)

    print(f"\nDone: {len(trending_kws)} trending + {len(editorial_kws)} editorial keywords")


if __name__ == "__main__":
    asyncio.run(main())
