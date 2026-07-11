#!/usr/bin/env python3
"""Read _bootstrap() and add Pinterest login support to scraper_v2.py."""
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
        # Read the _bootstrap function to understand current flow
        ("_bootstrap function (lines 429-475)", r"""sed -n '429,475p' /opt/vibepin/backend/scraper_v2.py"""),

        # Read __aenter__ / session creation
        ("session __aenter__ + _make_session (407-430)", r"""sed -n '401,430p' /opt/vibepin/backend/scraper_v2.py"""),

        # Check if PINTEREST_EMAIL/PASSWORD already in .env
        ("check env for pinterest credentials", r"""grep -i 'pinterest_email\|pinterest_password\|pinterest_user\|PINTEREST_LOGIN' /opt/vibepin/backend/.env 2>/dev/null || echo 'no credentials found'"""),

        # Read dotenv loading in scraper
        ("dotenv loading in scraper", r"""grep -n 'dotenv\|load_dotenv\|os.environ\|os.getenv' /opt/vibepin/backend/scraper_v2.py | head -15"""),

        # Test: can we log into Pinterest via Playwright? (proof of concept)
        ("test pinterest login via playwright (NO CREDS - just structure test)", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import asyncio, sys
sys.path.insert(0, '.')

async def test_login_flow():
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print("playwright not available")
        return

    # Check if credentials exist
    import os
    from dotenv import load_dotenv
    load_dotenv()
    email = os.getenv('PINTEREST_EMAIL', '')
    password = os.getenv('PINTEREST_PASSWORD', '')
    if not email or not password:
        print("PINTEREST_EMAIL/PASSWORD not in .env - cannot test login")
        print("Add these to /opt/vibepin/backend/.env to enable authenticated scraping")
        return

    print(f"Credentials found: {email[:3]}***@***")
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=['--no-sandbox'])
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36",
        )
        page = await ctx.new_page()

        # Navigate to login page
        await page.goto("https://www.pinterest.com/login/", timeout=30000)
        await page.fill('#email', email)
        await page.fill('#password', password)
        await page.click('[data-test-id="login-button"]')
        await page.wait_for_timeout(3000)

        cookies = await ctx.cookies("https://www.pinterest.com")
        auth_cookie = next((c for c in cookies if c['name'] == '_auth'), None)
        print(f"_auth after login: {auth_cookie['value'] if auth_cookie else 'NOT FOUND'}")

        # Test search
        results_api = []
        async def capture(r):
            if 'BaseSearchResource' in r.url and r.status == 200:
                try:
                    body = await r.json()
                    items = body.get('resource_response',{}).get('data',{}).get('results',[])
                    results_api.extend(items)
                except: pass
        page.on("response", capture)
        await page.goto("https://www.pinterest.com/search/pins/?q=home+decor+ideas", timeout=30000)
        await page.wait_for_timeout(3000)
        print(f"Search results captured: {len(results_api)} pins")
        await browser.close()

asyncio.run(test_login_flow())
PYEOF
"""),
    ]

    for label, cmd in cmds:
        print(f"\n{'='*70}\n### {label}\n{'='*70}", flush=True)
        out, err = ssh_run(client, cmd, timeout=90)
        if out.strip():
            print(out[:5000], flush=True)
        if err.strip():
            print("[STDERR]", err[:600], flush=True)

    client.close()
    print("\ndone.", flush=True)

if __name__ == "__main__":
    run_all()
