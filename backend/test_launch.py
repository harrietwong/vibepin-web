import asyncio, tempfile
from playwright.async_api import async_playwright

async def main():
    # Try fresh temp profile first
    with tempfile.TemporaryDirectory() as tmp:
        async with async_playwright() as pw:
            print("Launching with fresh profile...")
            ctx = await pw.chromium.launch_persistent_context(
                tmp,
                headless=True,
                args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
            )
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            await page.goto("https://www.google.com", timeout=15000)
            print(f"Title: {await page.title()}")
            await ctx.close()
            print("Fresh profile: OK")

asyncio.run(main())
