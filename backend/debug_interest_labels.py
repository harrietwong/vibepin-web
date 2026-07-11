"""Extract interest ID → label mapping from the dropdown."""
import asyncio, sys
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

        try:
            await page.goto(
                "https://trends.pinterest.com/search?country=US&l1InterestIds=960887632144",
                wait_until="networkidle", timeout=40_000
            )
        except Exception:
            pass
        await page.wait_for_timeout(2000)

        # Click interests dropdown
        btn = page.locator("button:has-text('兴趣')").first
        await btn.click()
        await page.wait_for_timeout(1500)

        # Get checkboxes and their labels
        # Each checkbox input is typically followed by a label or sibling span
        checkboxes = await page.query_selector_all("input[type='checkbox'], [role='checkbox']")
        print(f"Found {len(checkboxes)} checkboxes\n")

        interests = {}
        for cb in checkboxes:
            iid = await cb.get_attribute("name") or await cb.get_attribute("value") or ""
            checked = await cb.get_attribute("checked")
            is_checked = checked is not None or await cb.is_checked()

            # Try to get the label text via various methods
            label_text = ""

            # Method 1: associated <label> by 'for' attribute matching cb 'id'
            cb_id = await cb.get_attribute("id") or ""
            if cb_id:
                label_el = await page.query_selector(f"label[for='{cb_id}']")
                if label_el:
                    label_text = (await label_el.inner_text()).strip()

            # Method 2: parent container's text
            if not label_text:
                parent = await cb.evaluate_handle("el => el.parentElement")
                if parent:
                    label_text = (await parent.as_element().inner_text()).strip() if parent.as_element() else ""

            # Method 3: grandparent container's text
            if not label_text:
                gp = await cb.evaluate_handle("el => el.parentElement?.parentElement")
                if gp and gp.as_element():
                    label_text = (await gp.as_element().inner_text()).strip()

            # Method 4: next sibling text
            if not label_text:
                sib = await cb.evaluate_handle("el => el.nextElementSibling")
                if sib and sib.as_element():
                    label_text = (await sib.as_element().inner_text()).strip()

            if iid:
                interests[iid] = label_text or iid
                marker = "✓" if is_checked else " "
                print(f"  [{marker}] {iid}  →  {label_text!r}")

        print(f"\n\nFull mapping dict:")
        print("KNOWN_INTERESTS = {")
        for iid, name in interests.items():
            print(f'    "{iid}": "{name}",')
        print("}")

        await ctx.close()

asyncio.run(main())
