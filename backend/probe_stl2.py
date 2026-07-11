"""
probe_stl2.py — Capture all API calls on pin pages, save to file for inspection.
"""
import asyncio, json
from pathlib import Path
from playwright.async_api import async_playwright

PROFILE_DIR = Path.home() / "AppData/Local/PinterestScraper/profile"
OUT = Path("d:/代码/Pinterest scrapter/stl_urls.txt")

TEST_PINS = ["1618549865130113", "1337074889491732"]


async def main():
    captured_urls = []

    async with async_playwright() as pw:
        ctx = await pw.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            headless=False,
            viewport={"width": 1280, "height": 900},
            locale="en-US",
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()

        async def on_resp(resp):
            url = resp.url
            if "pinterest.com" in url and "/resource/" in url:
                captured_urls.append(url)

        page.on("response", on_resp)

        for pin_id in TEST_PINS:
            print(f"Pin {pin_id}")

            # First go to pin detail
            await page.goto(f"https://www.pinterest.com/pin/{pin_id}/",
                            wait_until="domcontentloaded", timeout=30000)
            # dismiss modal
            await page.evaluate("""() => {
                ['[data-test-id="fullPageSignupModal"]','[class*="SignupModal"]']
                .forEach(s => document.querySelectorAll(s).forEach(e => e.remove()));
                document.body.style.overflow='';
            }""")
            await asyncio.sleep(3)
            # scroll
            for _ in range(10):
                await page.mouse.wheel(0, 500)
                await asyncio.sleep(0.8)
            await asyncio.sleep(2)

            # Then navigate to visual-shop
            vs_url = (f"https://www.pinterest.com/pin/{pin_id}/visual-shop/"
                      f"?entry_source=shopping&is_shopping=true")
            await page.goto(vs_url, wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(3)
            for _ in range(6):
                await page.mouse.wheel(0, 500)
                await asyncio.sleep(0.8)
            await asyncio.sleep(2)

            print(f"  Captured so far: {len(captured_urls)} API calls")

        await ctx.close()

    OUT.write_text("\n".join(captured_urls), encoding="utf-8")
    print(f"\nSaved {len(captured_urls)} API URLs -> {OUT}")
    # Print unique resource names
    resources = set()
    for u in captured_urls:
        if "/resource/" in u:
            part = u.split("/resource/")[1].split("/")[0]
            resources.add(part)
    print("Unique resource types:", sorted(resources))


asyncio.run(main())
