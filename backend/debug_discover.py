"""Debug: capture all JSON API responses when navigating to electronics interest page."""
import asyncio, sys, json
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT        = Path(__file__).parent
PROFILE_DIR = Path.home() / "AppData/Local/PinterestScraper/profile"

async def main():
    sys.path.insert(0, str(ROOT))
    from chrome_cookies import get_cookies
    from playwright.async_api import async_playwright

    pw_cookies = get_cookies(PROFILE_DIR, domains=["pinterest.com"])
    print(f"[cookies] {len(pw_cookies)} extracted")

    async with async_playwright() as pw:
        ctx = await pw.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        ctx_page = await ctx.new_context(viewport={"width": 1280, "height": 900})
        await ctx_page.add_cookies(pw_cookies)
        page = await ctx_page.new_page()

        api_calls = []

        async def on_response(resp):
            ct = resp.headers.get("content-type", "")
            if "json" not in ct:
                return
            url = resp.url
            if "trends.pinterest.com" not in url:
                return
            try:
                body = await resp.json()
                api_calls.append({"url": url, "keys": list(body.keys()) if isinstance(body, dict) else type(body).__name__})
                print(f"  [api] {url[:120]}")
                print(f"        keys={list(body.keys()) if isinstance(body, dict) else type(body).__name__}")
                # Print more detail for any endpoint mentioning "interest"
                if "interest" in url.lower():
                    print(f"        BODY={json.dumps(body)[:500]}")
            except Exception as e:
                print(f"  [api-err] {url[:80]} — {e}")

        page.on("response", on_response)

        try:
            await page.goto(
                "https://trends.pinterest.com/search?country=US&l1InterestIds=960887632144",
                wait_until="networkidle", timeout=40_000
            )
        except Exception:
            pass
        await page.wait_for_timeout(4000)

        # Scroll to reveal sidebar
        for _ in range(4):
            await page.keyboard.press("End")
            await page.wait_for_timeout(600)
        await page.wait_for_timeout(2000)

        await page.screenshot(path=str(ROOT / "debug_electronics_page.png"), full_page=False)

        # Also try JavaScript to find React/Redux state
        try:
            state = await page.evaluate("() => { try { return JSON.stringify(window.__initialReduxState__ || window.__REDUX_STATE__ || window._INITIAL_DATA_ || {}); } catch(e) { return '{}'; } }")
            if state and state != "{}":
                print(f"\n[js-state] {state[:500]}")
        except Exception:
            pass

        # Look for any buttons with interest-like data
        buttons = await page.query_selector_all("button, [role='tab'], [role='button']")
        print(f"\n[dom] {len(buttons)} buttons/tabs total")
        for btn in buttons[:20]:
            text = (await btn.inner_text()).strip()[:60]
            attrs = {}
            for attr in ["data-interest-id", "data-id", "href", "aria-label", "class"]:
                v = await btn.get_attribute(attr)
                if v:
                    attrs[attr] = v[:40]
            if text or attrs:
                print(f"  btn: {text!r} | {attrs}")

        await ctx.close()

asyncio.run(main())
