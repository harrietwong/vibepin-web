"""
probe_stl3.py — use scraper's browser session to try shopping API endpoints via fetch()
"""
import asyncio, json, time
from pathlib import Path
from playwright.async_api import async_playwright

PROFILE_DIR = Path.home() / "AppData/Local/PinterestScraper/profile"
PIN_IDS = ["1618549865130113", "1337074889491732"]

# Candidate resource endpoints to probe
RESOURCES = [
    "ShoppingRecommendationsResource",
    "ShopTheLookResource",
    "VisualProductSearchResource",
    "ProductResource",
    "RelatedShoppingResource",
    "ProductPinResource",
    "ShoppingResource",
    "BoardFeedResource",         # sometimes used for shopping boards
]


async def try_resource(page, resource: str, pin_id: str) -> dict | None:
    ts = int(time.time() * 1000)
    for options in [
        {"pin_id": pin_id},
        {"id": pin_id},
        {"pin_id": pin_id, "field_set_key": "shopping"},
        {"pin_id": pin_id, "source": "shop_the_look"},
    ]:
        payload = json.dumps({"options": options, "context": {}})
        src_url = f"/pin/{pin_id}/"
        url = (f"https://www.pinterest.com/resource/{resource}/get/"
               f"?source_url={src_url}&data={payload}&_={ts}")
        result = await page.evaluate("""
            async (url) => {
                try {
                    const r = await fetch(url, {
                        headers: {
                            "accept": "application/json, text/javascript, */*, q=0.01",
                            "x-requested-with": "XMLHttpRequest",
                            "x-pinterest-pws-handler": "www/pin/[pin_id].js",
                        },
                        credentials: "include"
                    });
                    if (!r.ok) return {status: r.status};
                    return await r.json();
                } catch(e) { return {error: String(e)}; }
            }
        """, url)
        if result and isinstance(result, dict):
            status = result.get("status")
            rr = result.get("resource_response", {})
            data = rr.get("data") if isinstance(rr, dict) else None
            err = result.get("error") or (rr.get("error") if isinstance(rr, dict) else None)
            if data and not err:
                print(f"  HIT: {resource}  options={options}")
                print(f"       data type={type(data).__name__}  "
                      f"len={len(data) if isinstance(data,(list,dict)) else '?'}")
                if isinstance(data, list) and data:
                    print(f"       first item keys: {list(data[0].keys())[:12]}")
                elif isinstance(data, dict):
                    print(f"       keys: {list(data.keys())[:12]}")
                return {"resource": resource, "options": options, "data": data}
            elif status and status != 200:
                pass  # silently skip 404/400
    return None


async def main():
    async with async_playwright() as pw:
        ctx = await pw.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            headless=False,
            viewport={"width": 1280, "height": 900},
            locale="en-US",
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()

        # warm up — go to Pinterest home
        print("Warming up browser...")
        await page.goto("https://www.pinterest.com", wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(3)

        # Dismiss modal
        await page.evaluate("""() => {
            ['[data-test-id="fullPageSignupModal"]','[class*="SignupModal"]']
            .forEach(s => document.querySelectorAll(s).forEach(e => e.remove()));
            document.body.style.overflow='';
        }""")

        results = []
        for pin_id in PIN_IDS:
            print(f"\n=== Pin {pin_id} ===")
            # navigate to pin page first so cookies are set
            await page.goto(f"https://www.pinterest.com/pin/{pin_id}/",
                            wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(2)

            for resource in RESOURCES:
                r = await try_resource(page, resource, pin_id)
                if r:
                    results.append({"pin_id": pin_id, **r})

        await ctx.close()

    out = Path("d:/代码/Pinterest scrapter/stl_probe_results.json")
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2, default=str),
                   encoding="utf-8")
    print(f"\nSaved {len(results)} hits -> {out}")
    if not results:
        print("No shopping endpoints found — Pinterest may require auth for these APIs.")


asyncio.run(main())
