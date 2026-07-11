"""Find the Search Trends page and capture the interest-filtered API call."""
import asyncio, json, sys
from pathlib import Path
from playwright.async_api import async_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PROFILE_DIR = Path.home() / "AppData/Local/PinterestScraper/profile"
ROOT = Path(__file__).parent

async def main():
    async with async_playwright() as pw:
        ctx = await pw.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=False,
            args=["--disable-blink-features=AutomationControlled"],
            viewport={"width": 1280, "height": 900},
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()

        captured = []
        async def on_response(resp):
            url = resp.url
            if "top_trends_filtered" in url or ("trends.pinterest.com" in url and "json" in resp.headers.get("content-type","")) :
                try:
                    body = await resp.json()
                    captured.append({"url": url, "body": body})
                    print(f"  [capture] {url[:100]}")
                except Exception:
                    pass

        page.on("response", on_response)

        # Try the search trends URL
        for url in [
            "https://trends.pinterest.com/search/?country=US",
            "https://trends.pinterest.com/trending/?country=US",
            "https://trends.pinterest.com/?tab=search&country=US",
        ]:
            print(f"\nTrying: {url}")
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=15_000)
                await page.wait_for_timeout(2000)
                title = await page.title()
                print(f"  title: {title} | url: {page.url}")

                # Check for table
                rows = await page.query_selector_all("table tbody tr")
                print(f"  table rows: {len(rows)}")

                # Check for nav/tab links that say "搜索趋势" or "Search Trends"
                links = await page.query_selector_all("a, [role=tab], nav a")
                for link in links[:20]:
                    txt = (await link.inner_text()).strip()
                    href = await link.get_attribute("href") or ""
                    if txt and len(txt) < 30:
                        print(f"  link: '{txt}' → {href}")
                break
            except Exception as e:
                print(f"  error: {e}")

        # Also check for any nav items
        print("\n--- Looking for Search Trends nav item ---")
        nav_selectors = ["nav", "[role=navigation]", ".sidebar", "[data-test-id]"]
        for sel in nav_selectors:
            els = await page.query_selector_all(sel)
            if els:
                txt = (await els[0].inner_text()).strip()[:200]
                print(f"  {sel}: {txt!r}")

        # Screenshot
        await page.screenshot(path=str(ROOT / "trends_debug2.png"))
        print(f"\nScreenshot: trends_debug2.png")

        with open(ROOT / "trends_debug2_log.json", "w", encoding="utf-8") as f:
            json.dump(captured, f, ensure_ascii=False, indent=2, default=str)
        print(f"Captured {len(captured)} API responses")

        input("Press Enter to close browser...")
        await ctx.close()

asyncio.run(main())
