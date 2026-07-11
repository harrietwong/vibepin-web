"""
probe_stl4.py — navigate to visual-shop URL, dump product cards from DOM
Run this ONCE interactively (it will open a browser window).
"""
import asyncio, json
from pathlib import Path
from urllib.parse import quote
from playwright.async_api import async_playwright

PROFILE_DIR = Path.home() / "AppData/Local/PinterestScraper/profile"

# Decoded from user's visual-shop URL
VISUAL_SHOP_URLS = [
    ("1618549865130113",
     "https://www.pinterest.com/pin/1618549865130113/visual-shop/"
     "?entry_source=shopping&is_shopping=true&crop_source=5"
     "&entry_point=shop_the_look_module&fromImageSearch=False"
     "&request_params=%7B%227%22%3A%20%225496850383965994204%22%2C%20%221%22%3A%20%2245%22%2C%20%228%22%3A%20%221618549865130113%22%2C%20%2236%22%3A%20%221618549865130113%22%2C%20%2230%22%3A%20%22Shop%20the%20look%22%2C%20%222%22%3A%20%22Shop%20the%20look%22%2C%20%2237%22%3A%20%22Shop%20the%20look%22%2C%20%2233%22%3A%20%22%5B%5C%224591701373878410240%5C%22%2C%5C%22972636850767461102%5C%22%2C%5C%224593601378216222464%5C%22%2C%5C%224608097348633694464%5C%22%2C%5C%224604719631104963712%5C%22%2C%5C%221000010292275386235%5C%22%2C%5C%224604086297531826816%5C%22%2C%5C%224593742087423053952%5C%22%2C%5C%221090926709792523245%5C%22%2C%5C%224604367771905122944%5C%22%2C%5C%224599441994318391424%5C%22%2C%5C%221103522714931653660%5C%22%5D%22%7D"),
]

# Also probe pin 1337074889491732 direct visual-shop
DIRECT_PIN_IDS = ["1337074889491732", "351912466435148", "70437490700483",
                  "1055599909099616", "140806234830779"]

API_HITS = []


async def main():
    async with async_playwright() as pw:
        ctx = await pw.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            headless=False,
            viewport={"width": 1440, "height": 900},
            locale="en-US",
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()

        # Intercept ALL resource API calls
        async def on_resp(resp):
            url = resp.url
            if "pinterest.com" in url and any(k in url for k in [
                "/resource/", "shopping", "product", "catalog", "shop"
            ]):
                try:
                    body = await resp.json()
                    API_HITS.append({"url": url, "body": body})
                except Exception:
                    pass

        page.on("response", on_resp)

        # 1. Go to the known visual-shop URL
        for pin_id, vs_url in VISUAL_SHOP_URLS:
            print(f"\n--- Visual-shop for pin {pin_id} ---")
            try:
                await page.goto(vs_url, wait_until="load", timeout=45000)
            except Exception:
                await page.goto(vs_url, wait_until="commit", timeout=20000)
            await asyncio.sleep(5)

            # Dismiss modal
            await page.evaluate("""() => {
                ['[data-test-id="fullPageSignupModal"]','[class*="SignupModal"]',
                 '[data-test-id="login-modal"]']
                .forEach(s => document.querySelectorAll(s).forEach(e => e.remove()));
                document.body.style.overflow='';
            }""")

            # Scroll to trigger lazy load
            for _ in range(8):
                await page.mouse.wheel(0, 400)
                await asyncio.sleep(0.8)
            await asyncio.sleep(2)

            # Dump all links from page
            links = await page.evaluate("""() => {
                return [...document.querySelectorAll('a[href]')]
                    .map(a => ({href: a.href, text: a.innerText.trim().slice(0,80)}))
                    .filter(a => a.href.includes('pinterest') || a.href.includes('http'));
            }""")
            print(f"  Links found: {len(links)}")
            for lk in links[:20]:
                print(f"    {lk['text'][:40]:40}  {lk['href'][:80]}")

        # 2. For other home pins, try visual-shop URL without request_params
        for pin_id in DIRECT_PIN_IDS:
            print(f"\n--- Pin {pin_id} ---")
            vs_url = (f"https://www.pinterest.com/pin/{pin_id}/visual-shop/"
                      f"?entry_source=shopping&is_shopping=true")
            try:
                await page.goto(vs_url, wait_until="load", timeout=30000)
            except Exception:
                print(f"  goto timed out, using commit")
                await page.goto(vs_url, wait_until="commit", timeout=15000)
            await asyncio.sleep(4)
            await page.evaluate("""() => {
                ['[data-test-id="fullPageSignupModal"]','[class*="SignupModal"]']
                .forEach(s => document.querySelectorAll(s).forEach(e => e.remove()));
                document.body.style.overflow='';
            }""")
            for _ in range(5):
                await page.mouse.wheel(0, 400)
                await asyncio.sleep(0.7)
            await asyncio.sleep(2)

            page_text = await page.evaluate("""() => document.body.innerText""")
            has_shop = any(kw in page_text.lower() for kw in
                          ["shop", "price", "$", "€", "£", "add to cart", "buy"])
            print(f"  Shopping content visible: {has_shop}")
            if has_shop:
                print(f"  Sample: {page_text[:300]}")

        await ctx.close()

    # Save API hits
    out = Path("d:/代码/Pinterest scrapter/stl_api_hits.json")
    out.write_text(json.dumps(API_HITS[:50], ensure_ascii=False, indent=2, default=str),
                   encoding="utf-8")
    print(f"\nSaved {len(API_HITS)} API hits -> {out}")
    # Unique resource types
    resources = set()
    for h in API_HITS:
        u = h["url"]
        if "/resource/" in u:
            resources.add(u.split("/resource/")[1].split("/")[0])
    print("Resource types:", sorted(resources))


asyncio.run(main())
