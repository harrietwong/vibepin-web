"""Debug script: dump all network requests on Pinterest Trends and take screenshot."""
import asyncio, json, sys
from pathlib import Path
from playwright.async_api import async_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PROFILE_DIR = Path.home() / "AppData/Local/PinterestScraper/profile"
ROOT = Path(__file__).parent

async def main():
    network_log = []

    async with async_playwright() as pw:
        ctx = await pw.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=False,
            args=["--disable-blink-features=AutomationControlled"],
            viewport={"width": 1280, "height": 900},
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()

        async def log_response(resp):
            url = resp.url
            ct = resp.headers.get("content-type", "")
            if "json" in ct or "trends" in url or "pinterest.com/resource" in url:
                try:
                    body = await resp.json()
                    network_log.append({"url": url, "status": resp.status, "body": body})
                    print(f"  [json] {resp.status} {url[:100]}")
                except Exception:
                    network_log.append({"url": url, "status": resp.status, "body": None})
                    print(f"  [resp] {resp.status} {url[:100]}")

        page.on("response", log_response)

        print("Navigating to Pinterest Trends (electronics)…")
        await page.goto("https://trends.pinterest.com/?country=US&interests=electronics",
                        wait_until="networkidle", timeout=45_000)
        await page.wait_for_timeout(4000)

        # Screenshot
        shot = ROOT / "trends_debug.png"
        await page.screenshot(path=str(shot), full_page=False)
        print(f"\nScreenshot saved: {shot}")

        # Also get page title and URL
        print(f"Page title: {await page.title()}")
        print(f"Page URL:   {page.url}")

        # Try to find any table or keyword row
        rows = await page.query_selector_all("table tbody tr")
        print(f"\nTable rows found: {len(rows)}")
        if rows:
            for i, r in enumerate(rows[:3]):
                txt = (await r.inner_text()).replace("\n", " | ")[:120]
                print(f"  row {i}: {txt}")

        # Dump network log to file
        log_path = ROOT / "trends_network_log.json"
        with open(log_path, "w", encoding="utf-8") as f:
            json.dump(network_log, f, ensure_ascii=False, indent=2, default=str)
        print(f"\nNetwork log: {len(network_log)} JSON responses → {log_path}")

        await ctx.close()

asyncio.run(main())
