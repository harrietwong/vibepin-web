#!/usr/bin/env python3
"""Debug Pinterest HTML response to diagnose 0-pin extraction."""
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
        # Minimal scraper diagnostic — use PinterestSession to fetch 1 search page and dump HTML hints
        ("pinterest search HTML diagnostic", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import asyncio, re, sys
sys.path.insert(0, '.')
from scraper_v2 import PinterestSession

async def diagnose():
    async with PinterestSession() as sess:
        url = "https://www.pinterest.com/search/pins/?q=home+decor+ideas"
        resp = await sess._get_json(url, params={})
        # _get_json might return the JSON directly if content-type is JSON
        print("type(resp):", type(resp).__name__)
        if isinstance(resp, dict):
            keys = list(resp.keys())[:10]
            print("top keys:", keys)
            # Check for resource_response
            if 'resource_response' in resp:
                data = resp.get('resource_response', {}).get('data', {})
                results = data.get('results', [])
                print("results count:", len(results))
                if results:
                    print("first result keys:", list(results[0].keys())[:8])
            # Check for relay
            relay = resp.get('resourceDataCache', resp.get('relay', None))
            if relay:
                print("relay present, type:", type(relay).__name__)
        elif isinstance(resp, list):
            print("list length:", len(resp))
        elif isinstance(resp, str):
            print("string response, len:", len(resp))
            # Check for __PWS_DATA__
            has_pws = '__PWS_DATA__' in resp
            print("has __PWS_DATA__:", has_pws)
            # Check for relay data
            has_relay = 'relay_id' in resp or 'relayId' in resp
            print("has relay_id:", has_relay)
            # check for login wall
            has_login = 'Log in' in resp and 'password' in resp.lower()
            print("looks like login wall:", has_login)
            # check for pin_id
            pin_count = len(re.findall(r'"pin_id"', resp))
            relay_count = len(re.findall(r'"relay_id"', resp))
            print("pin_id mentions:", pin_count)
            print("relay_id mentions:", relay_count)
            print("HTML snippet:", resp[:500].replace('\n', ' '))

asyncio.run(diagnose())
PYEOF
"""),

        # Also check what _bootstrap does
        ("bootstrap session detail", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import asyncio, re, sys
sys.path.insert(0, '.')
from scraper_v2 import PinterestSession

async def check_bootstrap():
    sess = PinterestSession()
    await sess.__aenter__()
    # Try getting a search page directly with session
    import curl_cffi.requests as cr
    # Make a raw GET via the session
    try:
        resp = await sess._session.get(
            "https://www.pinterest.com/search/pins/?q=home+decor+ideas&rs=typed",
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
            },
            timeout=20,
        )
        html = resp.text
        print("status:", resp.status_code)
        print("len:", len(html))
        has_pws = '__PWS_DATA__' in html
        print("has __PWS_DATA__:", has_pws)
        pin_ids = re.findall(r'"pin_id"\s*:\s*"(\d+)"', html)
        print("pin_ids found:", len(pin_ids), pin_ids[:3] if pin_ids else [])
        # Check for login wall
        if 'continue to Pinterest' in html or 'Log in' in html:
            print("WARNING: Login wall detected")
        # Check for data markers
        markers = ['resourceDataCache', 'initialReduxState', '__PWS_DATA__', 'relay_id', 'searchData']
        for m in markers:
            print(f"  {m}: {'YES' if m in html else 'no'}")
        if not has_pws and not pin_ids:
            print("SNIPPET:", html[:800].replace('\n',' '))
    except Exception as e:
        print("ERROR:", e)
    await sess.__aexit__(None, None, None)

asyncio.run(check_bootstrap())
PYEOF
"""),

        # Check the full _extract_pins_from_html logic
        ("extract_pins_from_html function body", r"""sed -n '681,800p' /opt/vibepin/backend/scraper_v2.py"""),

        # Check _get_json function
        ("_get_json function body", r"""sed -n '474,530p' /opt/vibepin/backend/scraper_v2.py"""),

        # Check search_pins function
        ("search_pins function body", r"""sed -n '522,640p' /opt/vibepin/backend/scraper_v2.py"""),

        # Check if there's a cookie file or credentials
        ("check for stored cookies/credentials", r"""ls -la /opt/vibepin/backend/*.json /opt/vibepin/backend/*.pkl /opt/vibepin/backend/cookies* 2>/dev/null | head -20"""),

        # Check logs for any errors about authentication
        ("cron log auth errors", r"""grep -i 'auth\|login\|cookie\|session\|blocked\|rate.limit\|403\|captcha\|anti.bot\|429' /opt/vibepin/backend/logs/cron_daily.log 2>/dev/null | tail -20"""),
    ]

    for label, cmd in cmds:
        print(f"\n{'='*70}\n### {label}\n{'='*70}", flush=True)
        out, err = ssh_run(client, cmd, timeout=120)
        if out.strip():
            print(out[:6000], flush=True)
        if err.strip():
            print("[STDERR]", err[:400], flush=True)

    client.close()
    print("\ndone.", flush=True)

if __name__ == "__main__":
    run_all()
