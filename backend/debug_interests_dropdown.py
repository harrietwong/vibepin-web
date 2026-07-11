"""Click the 兴趣 (Interests) dropdown and extract all available interest categories."""
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
    print(f"[cookies] {len(pw_cookies)} extracted")

    async with async_playwright() as pw:
        ctx = await pw.chromium.launch(headless=True,
                                       args=["--disable-blink-features=AutomationControlled"])
        ctx_page = await ctx.new_context(viewport={"width": 1440, "height": 900})
        await ctx_page.add_cookies(pw_cookies)
        page = await ctx_page.new_page()

        captured_interests = {}

        async def on_response(resp):
            ct = resp.headers.get("content-type", "")
            if "json" not in ct:
                return
            url = resp.url
            if "trends.pinterest.com" not in url:
                return
            try:
                body = await resp.json()
                # Capture any top_trends_filtered calls that expose l1interests
                if "top_trends_filtered" in url or "partner_top_trends" in url or "available_interests" in url:
                    print(f"  [api] {url[:100]}")
                    if "available_interests" in url:
                        print(f"  [api] body: {json.dumps(body)[:300]}")
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
        await page.wait_for_timeout(2000)

        await page.screenshot(path=str(ROOT / "before_click.png"))

        # Find and click the 兴趣 filter dropdown
        # Try different selectors
        selectors = [
            "button:has-text('兴趣')",
            "[aria-label*='兴趣']",
            "button:has-text('Interest')",
            "[data-test-id*='interest']",
        ]

        clicked = False
        for sel in selectors:
            try:
                btn = page.locator(sel).first
                count = await btn.count()
                if count > 0:
                    print(f"[click] Found button with selector: {sel}")
                    await btn.click()
                    await page.wait_for_timeout(2000)
                    clicked = True
                    break
            except Exception as e:
                print(f"[click] Selector {sel} failed: {e}")

        if not clicked:
            print("[click] Trying to find any button with 兴趣 in text...")
            all_btns = await page.query_selector_all("button")
            for btn in all_btns:
                text = (await btn.inner_text()).strip()
                if "兴趣" in text or "Interest" in text.lower():
                    print(f"[click] Clicking button with text: {text!r}")
                    await btn.click()
                    await page.wait_for_timeout(2000)
                    clicked = True
                    break

        await page.screenshot(path=str(ROOT / "after_click_dropdown.png"))
        print(f"\n[click] dropdown clicked: {clicked}")

        # Now look for interest options in the dropdown
        # They might appear as checkboxes, list items, or buttons
        dropdown_items = await page.query_selector_all("[role='option'], [role='menuitem'], [role='listitem'], .interest-item, [class*='Interest'], [class*='interest']")
        print(f"\n[dom] {len(dropdown_items)} dropdown items")
        for item in dropdown_items[:30]:
            text = (await item.inner_text()).strip()[:60]
            cls  = await item.get_attribute("class") or ""
            dattr = await item.get_attribute("data-interest-id") or ""
            href  = await item.get_attribute("href") or ""
            print(f"  item: {text!r} | class={cls[:40]} | data-id={dattr} | href={href}")

        # Get all checkboxes (interest dropdown uses checkboxes)
        checkboxes = await page.query_selector_all("[type='checkbox'], [role='checkbox']")
        print(f"\n[dom] {len(checkboxes)} checkboxes")
        for cb in checkboxes:
            label = await cb.get_attribute("aria-label") or ""
            val   = await cb.get_attribute("value") or ""
            name  = await cb.get_attribute("name") or ""
            # Get parent text
            parent = await cb.query_selector("xpath=..")
            parent_text = (await parent.inner_text()).strip()[:60] if parent else ""
            print(f"  cb: label={label!r} val={val!r} name={name!r} parent={parent_text!r}")

        # Full HTML of dropdown area
        html = await page.content()

        # Look for interest IDs in the updated HTML
        interest_ids = re.findall(r'"(?:interest_id|interestId|id)"\s*:\s*"?(\d{10,15})"?', html)
        interest_names = re.findall(r'"(?:display_name|displayName|name|label)"\s*:\s*"([^"]{2,50})"', html)
        if interest_ids:
            print(f"\n[html] Found interest IDs: {interest_ids[:20]}")
            for i, iid in enumerate(interest_ids[:20]):
                name = interest_names[i] if i < len(interest_names) else iid
                print(f"  {iid} → {name}")

        # Also look for any new API calls by monitoring responses
        await page.wait_for_timeout(2000)

        # Dump all links after dropdown open
        all_links = await page.query_selector_all("a[href]")
        interest_links = []
        for link in all_links:
            href = await link.get_attribute("href") or ""
            if "l1Interest" in href or "interest" in href.lower():
                text = (await link.inner_text()).strip()
                interest_links.append((iid, text, href))
                print(f"  [link] {text!r} → {href[:80]}")

        await ctx.close()

asyncio.run(main())
