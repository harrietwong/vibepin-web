#!/usr/bin/env python3
"""Try injecting Playwright cookies into curl_cffi session to bypass soft block."""
from __future__ import annotations

def ssh_run(client, cmd, timeout=240):
    try:
        stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        return out, err
    except Exception as e:
        return "", str(e)

def run_all():
    import paramiko
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect("47.89.181.103", port=22, username="root",
                   password="26mXvu2iEMwb!ab", timeout=20)

    cmds = [
        # Try: get cookies from Playwright, inject into curl_cffi, then call API
        ("inject playwright cookies into search API", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import asyncio, json, sys, urllib.parse as up
sys.path.insert(0,'.')
from scraper_v2 import PinterestSession

async def try_with_playwright_cookies():
    # Step 1: Get cookies from Playwright
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print("playwright not available")
        return

    pw_cookies = {}
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=['--no-sandbox'])
        ctx = await browser.new_context(user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36")
        page = await ctx.new_page()
        try:
            await page.goto("https://www.pinterest.com/search/pins/?q=home+decor+ideas&rs=typed",
                          timeout=30000, wait_until="domcontentloaded")
        except Exception as e:
            print(f"goto: {e}")

        cookies = await ctx.cookies("https://www.pinterest.com")
        for c in cookies:
            pw_cookies[c['name']] = c['value']
        await browser.close()
        print(f"Got {len(pw_cookies)} cookies from Playwright: {list(pw_cookies.keys())}")

    # Step 2: Use those cookies in curl_cffi session for search API
    async with PinterestSession() as sess:
        # Inject cookies into the session
        cookie_header = "; ".join(f"{k}={v}" for k, v in pw_cookies.items())
        csrf = pw_cookies.get('csrftoken', sess._csrf or '')

        query = "home decor ideas"
        options = {"query": query, "scope": "pins", "page_size": 25, "no_fetch_context_on_resource": False}
        data_json = json.dumps({"options": options, "context": {}}, separators=(',',':'))
        params = {
            "source_url": f"/search/pins/?q={query.replace(' ','+')}&rs=typed",
            "data": data_json,
            "_": "1234567890000",
        }
        api_url = "https://www.pinterest.com/resource/BaseSearchResource/get/?" + up.urlencode(params)

        resp = await sess._session.get(api_url, headers={
            "X-CSRFToken": csrf,
            "X-App-Version": sess._app_version or '',
            "X-Pinterest-Source-Url": f"/search/pins/?q={query.replace(' ','+')}&rs=typed",
            "X-Pinterest-Pws-Handler": "www/search/[scope].js",
            "Accept": "application/json, text/javascript, */*, q=0.01",
            "Referer": f"https://www.pinterest.com/search/pins/?q={query.replace(' ','+')}",
            "Cookie": cookie_header,
        })
        print(f"API with PW cookies: status={resp.status_code}")
        try:
            data = resp.json()
            rr = data.get('resource_response', {})
            results = rr.get('data', {}).get('results', []) if isinstance(rr.get('data'), dict) else []
            print(f"results count: {len(results)}")
            if results:
                print(f"FIRST RESULT: {str(results[0])[:300]}")
        except Exception as e:
            print(f"parse error: {e}")
            print(f"text: {resp.text[:300]}")

asyncio.run(try_with_playwright_cookies())
PYEOF
"""),

        # Alternative: Use Playwright itself to scrape search results
        ("playwright search pin extraction", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import asyncio, json, re, sys
sys.path.insert(0,'.')

async def playwright_search():
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print("playwright not available")
        return

    results = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=['--no-sandbox', '--disable-setuid-sandbox'])
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        )
        page = await ctx.new_page()

        # Intercept API responses to capture search data
        api_data = []
        async def handle_response(response):
            if 'BaseSearchResource' in response.url and response.status == 200:
                try:
                    body = await response.json()
                    res = body.get('resource_response', {}).get('data', {})
                    if isinstance(res, dict):
                        items = res.get('results', [])
                        if items:
                            api_data.append(items)
                            print(f"Intercepted search API: {len(items)} results")
                except:
                    pass

        page.on("response", handle_response)

        print("Loading Pinterest search...")
        try:
            await page.goto("https://www.pinterest.com/search/pins/?q=home+decor+ideas&rs=typed",
                          timeout=40000, wait_until="networkidle")
        except Exception as e:
            print(f"goto: {e}")

        print(f"API responses captured: {len(api_data)}")
        if api_data:
            first = api_data[0][0] if api_data[0] else {}
            print(f"First pin type: {first.get('type','?')}, id: {first.get('id','?')}, images: {'images' in first}")
            print(f"Total pins: {sum(len(d) for d in api_data)}")

        # Also try extracting from DOM
        pin_els = await page.locator('[data-test-id="pin"]').count()
        print(f"Pin DOM elements: {pin_els}")

        await browser.close()

asyncio.run(playwright_search())
PYEOF
"""),
    ]

    for label, cmd in cmds:
        print(f"\n{'='*70}\n### {label}\n{'='*70}", flush=True)
        out, err = ssh_run(client, cmd, timeout=120)
        if out.strip():
            print(out[:5000], flush=True)
        if err.strip():
            print("[STDERR]", err[:600], flush=True)

    client.close()
    print("\ndone.", flush=True)

if __name__ == "__main__":
    run_all()
