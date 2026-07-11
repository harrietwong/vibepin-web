#!/usr/bin/env python3
"""Check Playwright browser state, test cookie-based search."""
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
        # Find Playwright browser state files
        ("playwright state files", r"""find /opt/vibepin /root /home -name '*.json' -newer /opt/vibepin/backend/scraper_v2.py -size +10k 2>/dev/null | grep -v 'node_modules\|.venv\|trends_debug\|stl_api\|stl_probe\|trends_network' | head -20"""),

        ("playwright state in common dirs", r"""ls -la /root/.config/playwright/ /tmp/playwright* /opt/vibepin/backend/playwright* /opt/vibepin/backend/browser_state* /opt/vibepin/backend/pinterest_state* 2>/dev/null | head -20"""),

        # Check STL scraper file
        ("stl scraper file", r"""ls -la /opt/vibepin/backend/stl*.py /opt/vibepin/backend/*stl* 2>/dev/null | head -10"""),

        ("stl scraper first 50 lines", r"""head -60 /opt/vibepin/backend/stl_scraper.py 2>/dev/null || head -60 /opt/vibepin/backend/stl*.py 2>/dev/null | head -60"""),

        ("stl scraper playwright storage", r"""grep -n 'storage_state\|user_data_dir\|cookies\|auth\|login\|state_path\|PLAYWRIGHT' /opt/vibepin/backend/stl_scraper.py 2>/dev/null | head -20 || grep -rn 'storage_state\|user_data_dir' /opt/vibepin/backend/ 2>/dev/null | grep -v '.venv' | head -20"""),

        # Check what test_cookies files do
        ("test_cookies5.py content", r"""cat /opt/vibepin/backend/test_cookies5.py 2>/dev/null"""),

        # Check env for Pinterest login
        ("env file Pinterest section", r"""cat /opt/vibepin/backend/.env | grep -v 'KEY\|SECRET\|PASSWORD\|TOKEN' | head -30"""),

        # Try extracting cookies from a fresh Playwright Pinterest session
        ("playwright extract pinterest cookies", r"""cd /opt/vibepin/backend && timeout 60 .venv/bin/python3 << 'PYEOF'
import asyncio, json, sys
sys.path.insert(0,'.')

async def extract_cookies():
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print("playwright not available")
        return

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True,
            args=['--no-sandbox', '--disable-setuid-sandbox'])
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        )
        page = await ctx.new_page()
        print("navigating to Pinterest search...")
        try:
            await page.goto("https://www.pinterest.com/search/pins/?q=home+decor+ideas&rs=typed",
                           timeout=30000, wait_until="networkidle")
        except Exception as e:
            print(f"goto error: {e}")
            await page.goto("https://www.pinterest.com/search/pins/?q=home+decor+ideas",
                           timeout=30000)

        # Check for pins
        pin_count = await page.locator('[data-test-id="pin"]').count()
        print(f"Pin elements on page: {pin_count}")

        # Get page content hints
        title = await page.title()
        print(f"Page title: {title}")

        # Get cookies
        cookies = await ctx.cookies("https://www.pinterest.com")
        important_cookies = [c for c in cookies if c['name'] in ['_pinterest_sess', 'csrftoken', '_auth', 'sessionFunnelEventLogged', 'pinterest_browser_id']]
        print(f"Total cookies: {len(cookies)}, important: {len(important_cookies)}")
        for c in important_cookies:
            print(f"  {c['name']}: {c['value'][:40]}...")

        # Try the BaseSearchResource API with these cookies
        cookie_str = "; ".join(f"{c['name']}={c['value']}" for c in cookies)
        print(f"Cookie string len: {len(cookie_str)}")

        await browser.close()

asyncio.run(extract_cookies())
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
