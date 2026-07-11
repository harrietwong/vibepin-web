"""Expand the sidebar and look for interest category tabs/links."""
import asyncio, sys, json, re
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT        = Path(__file__).parent
PROFILE_DIR = Path.home() / "AppData/Local/PinterestScraper/profile"

async def main():
    sys.path.insert(0, str(ROOT))
    from chrome_cookies import get_cookies
    from playwright.async_api import async_playwright

    pw_cookies = get_cookies(PROFILE_DIR, domains=["pinterest.com"])

    async with async_playwright() as pw:
        ctx = await pw.chromium.launch(headless=True,
                                       args=["--disable-blink-features=AutomationControlled"])
        ctx_page = await ctx.new_context(viewport={"width": 1440, "height": 900})
        await ctx_page.add_cookies(pw_cookies)
        page = await ctx_page.new_page()

        interests_from_api = {}

        async def on_response(resp):
            ct = resp.headers.get("content-type", "")
            if "json" not in ct:
                return
            url = resp.url
            if "trends.pinterest.com" not in url:
                return
            try:
                body = await resp.json()
                # Capture any interests or categories from API
                if "interest" in url.lower() or "categor" in url.lower():
                    print(f"  [api-interest] {url[:120]}")
                    print(f"  [api-interest] body: {json.dumps(body)[:300]}")
            except Exception:
                pass

        page.on("response", on_response)

        try:
            await page.goto(
                "https://trends.pinterest.com/search?country=US&l1InterestIds=960887632144",
                wait_until="networkidle", timeout=40_000
            )
        except Exception:
            pass
        await page.wait_for_timeout(3000)

        # Try to expand sidebar
        expand_btn = page.locator("[aria-label*='展开侧边'], [aria-label*='expand'], [aria-label*='sidebar']").first
        try:
            await expand_btn.click(timeout=3000)
            await page.wait_for_timeout(2000)
            print("[sidebar] Clicked expand button")
        except Exception as e:
            print(f"[sidebar] Could not click expand: {e}")

        await page.screenshot(path=str(ROOT / "debug_sidebar_expanded.png"), full_page=False)

        # Look for any anchor elements
        all_links = await page.query_selector_all("a")
        print(f"\n[dom] {len(all_links)} total <a> tags")
        for link in all_links:
            href  = await link.get_attribute("href") or ""
            text  = (await link.inner_text()).strip()[:60]
            if href and ("interest" in href.lower() or "l1" in href.lower()):
                print(f"  [link] {text!r} → {href}")

        # Also dump the full HTML looking for interest IDs
        html = await page.content()

        # Look for large number IDs that could be interest IDs
        interest_ids = re.findall(r'"(?:interest_id|interestId|l1InterestId)"\s*:\s*"?(\d{10,15})"?', html)
        if interest_ids:
            print(f"\n[html-ids] Found interest IDs: {interest_ids}")

        # Look for any JSON blobs with interest data in page source
        redux_matches = re.findall(r'"interests"\s*:\s*(\[(?:[^\[\]]|\[(?:[^\[\]]|\[[^\[\]]*\])*\])*\])', html[:200000])
        for m in redux_matches[:3]:
            print(f"\n[html-interests] {m[:400]}")

        # Try to read the Redux state from the window
        try:
            state_str = await page.evaluate("""() => {
                try {
                    // Try common state locations
                    const keys = Object.keys(window);
                    const stateKey = keys.find(k => k.includes('Redux') || k.includes('State') || k.includes('Initial'));
                    if (stateKey) return JSON.stringify({found: stateKey, sample: String(window[stateKey]).slice(0, 500)});
                    // Try to find interest IDs in all global vars
                    for (const k of keys) {
                        try {
                            const v = JSON.stringify(window[k]);
                            if (v && v.includes('interest_id') || (v && v.includes('960887632144'))) {
                                return JSON.stringify({key: k, value: v.slice(0, 500)});
                            }
                        } catch(e) {}
                    }
                    return '{}';
                } catch(e) { return String(e); }
            }""")
            if state_str and state_str != '{}':
                print(f"\n[js-state] {state_str[:500]}")
        except Exception as e:
            print(f"[js-state] error: {e}")

        await ctx.close()

asyncio.run(main())
