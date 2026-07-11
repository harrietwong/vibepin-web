"""
probe_stl.py — 探测 Pinterest pin 页面的 shop-the-look API 调用
用法: py probe_stl.py
"""
import asyncio, json, re
from pathlib import Path
from playwright.async_api import async_playwright

PROFILE_DIR = Path.home() / "AppData/Local/PinterestScraper/profile"

# 两个已知有 shop-the-look 的 pin
TEST_PINS = ["1618549865130113", "1337074889491732"]


async def probe(pin_id: str):
    print(f"\n=== Probing pin {pin_id} ===")
    found = []

    async with async_playwright() as pw:
        ctx = await pw.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            headless=False,
            viewport={"width": 1280, "height": 900},
            locale="en-US",
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()

        async def on_response(resp):
            url = resp.url
            # look for anything shopping/product related
            if any(kw in url for kw in [
                "shopping", "product", "shop_the_look", "ShoppingResource",
                "ProductResource", "VisualProduct", "visual_search",
                "recomm", "catalog",
            ]):
                try:
                    body = await resp.json()
                    print(f"  [API] {url[:120]}")
                    # print first level keys
                    if isinstance(body, dict):
                        print(f"        keys={list(body.keys())[:8]}")
                        # look for resource_response
                        rr = body.get("resource_response") or body.get("response") or {}
                        data = rr.get("data") if isinstance(rr, dict) else None
                        if data:
                            print(f"        data type={type(data).__name__}  "
                                  f"len={len(data) if isinstance(data, list) else 'dict'}")
                            if isinstance(data, list) and data:
                                print(f"        first item keys={list(data[0].keys())[:10]}")
                    found.append({"url": url, "body": body})
                except Exception:
                    pass

        page.on("response", on_response)

        url = f"https://www.pinterest.com/pin/{pin_id}/"
        print(f"  Navigating to {url}")
        await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
        await asyncio.sleep(5)

        # Dismiss modal
        await page.evaluate("""() => {
            const sels = ['[data-test-id="fullPageSignupModal"]',
                          '[class*="SignupModal"]','[class*="signup"]',
                          '[data-test-id="login-modal"]'];
            for (const s of sels)
                document.querySelectorAll(s).forEach(e => e.remove());
            document.body.style.overflow = '';
        }""")

        # Scroll down to trigger lazy load
        print("  Scrolling to trigger shop-the-look...")
        for _ in range(8):
            await page.mouse.wheel(0, 600)
            await asyncio.sleep(1.2)

        # Check if shop-the-look section is in DOM
        stl_visible = await page.evaluate("""() => {
            const texts = [...document.querySelectorAll('*')]
                .filter(el => el.children.length === 0)
                .map(el => el.textContent.trim().toLowerCase());
            return texts.some(t => t.includes('shop the look') || t.includes('shop this look'));
        }""")
        print(f"  'Shop the look' visible in DOM: {stl_visible}")

        # Try clicking it
        if stl_visible:
            try:
                await page.click("text=Shop the look", timeout=5000)
                print("  Clicked 'Shop the look'")
                await asyncio.sleep(4)
            except Exception:
                try:
                    await page.click("text=Shop this look", timeout=3000)
                    print("  Clicked 'Shop this look'")
                    await asyncio.sleep(4)
                except Exception:
                    print("  Could not click shop-the-look button")

        # Also try navigating to visual-shop directly
        vurl = f"https://www.pinterest.com/pin/{pin_id}/visual-shop/?entry_source=shopping&is_shopping=true"
        print(f"  Navigating to visual-shop URL...")
        await page.goto(vurl, wait_until="domcontentloaded", timeout=30_000)
        await asyncio.sleep(5)
        for _ in range(5):
            await page.mouse.wheel(0, 600)
            await asyncio.sleep(1)

        await ctx.close()

    if found:
        out = Path(f"stl_probe_{pin_id}.json")
        out.write_text(json.dumps(found, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        print(f"  Saved {len(found)} API responses -> {out}")
    else:
        print("  No shopping API responses captured")

    return found


async def main():
    for pin_id in TEST_PINS:
        await probe(pin_id)


if __name__ == "__main__":
    asyncio.run(main())
