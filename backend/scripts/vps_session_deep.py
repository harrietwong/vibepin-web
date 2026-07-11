#!/usr/bin/env python3
"""Deep session diagnosis: check initialReduxState, test with cookies, test v3 API."""
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
        # 1. Check initialReduxState structure for pins key
        ("initialReduxState structure", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import asyncio, re, json, sys
sys.path.insert(0, '.')
from scraper_v2 import PinterestSession, find_pins

async def check():
    async with PinterestSession() as sess:
        resp = await sess._session.get(
            "https://www.pinterest.com/search/pins/?q=home+decor+ideas&rs=typed",
            headers={"Accept": "text/html,application/xhtml+xml,*/*;q=0.8"},
        )
        html = resp.text

        # Extract initialReduxState from HTML script
        # Try different patterns
        for pat_name, pat in [
            ("camelCase key in script", r'"initialReduxState"\s*:\s*(\{(?:[^{}]|(?:\{[^{}]*\}))*\})'),
            ("window.__STATE__", r'window\.__STATE__\s*=\s*(\{.*?\})\s*;'),
            ("data-relay", r'data-relay-store="([^"]+)"'),
        ]:
            m = re.search(pat, html, re.DOTALL)
            if m:
                snippet = m.group(1)[:300]
                print(f"{pat_name}: FOUND, snippet={snippet[:200]}")
            else:
                print(f"{pat_name}: not found")

        # Check what script tags are around 'initialReduxState'
        pos = html.find('"initialReduxState"')
        if pos >= 0:
            ctx = html[max(0,pos-50):pos+500]
            print(f"\ninitialReduxState context:\n{ctx[:600]}")

asyncio.run(check())
PYEOF
"""),

        # 2. Try calling Pinterest v3 API (which requires auth)
        ("Pinterest v3 search API test", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import asyncio, json, sys, urllib.parse as up
sys.path.insert(0, '.')
from scraper_v2 import PinterestSession

async def try_v3():
    async with PinterestSession() as sess:
        # Try v3 boards search endpoint
        url = "https://www.pinterest.com/resource/SearchResource/get/"
        params = {
            "source_url": "/search/pins/?q=home+decor+ideas&rs=typed",
            "data": json.dumps({"options": {"query": "home decor ideas", "scope": "pins"}, "context": {}}, separators=(',',':')),
            "_": "1234567890000",
        }
        resp = await sess._session.get(url + "?" + up.urlencode(params),
            headers={
                "X-CSRFToken": sess._csrf or "",
                "X-App-Version": sess._app_version or "",
                "X-Pinterest-Source-Url": "/search/pins/?q=home+decor+ideas",
                "X-Pinterest-Pws-Handler": "www/search/[scope].js",
                "Accept": "application/json, text/javascript, */*, q=0.01",
                "Referer": "https://www.pinterest.com/search/pins/?q=home+decor+ideas",
                "X-Requested-With": "XMLHttpRequest",
            })
        print(f"SearchResource status: {resp.status_code}")
        if resp.status_code == 200:
            try:
                data = resp.json()
                rr = data.get('resource_response', {})
                rd = rr.get('data', {})
                print(f"  results type: {type(rd).__name__}")
                if isinstance(rd, list):
                    print(f"  results count: {len(rd)}")
                elif isinstance(rd, dict):
                    results = rd.get('results', [])
                    print(f"  results count: {len(results)}")
                    if results:
                        print(f"  first: {str(results[0])[:200]}")
            except:
                print(f"  text: {resp.text[:300]}")
        else:
            print(f"  text: {resp.text[:300]}")

asyncio.run(try_v3())
PYEOF
"""),

        # 3. Check chrome_cookies.py approach
        ("chrome_cookies.py content", r"""cat /opt/vibepin/backend/chrome_cookies.py 2>/dev/null | head -60"""),

        # 4. Check .env for Pinterest credentials
        ("env Pinterest credentials", r"""grep -i 'pinterest\|pin_\|cookie\|credential' /opt/vibepin/backend/.env 2>/dev/null | grep -v KEY | head -10"""),

        # 5. Test with a mobile/different user agent
        ("test with mobile user agent", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import asyncio, json, sys, urllib.parse as up, re
sys.path.insert(0, '.')
from scraper_v2 import PinterestSession

async def test_mobile():
    async with PinterestSession() as sess:
        # Try mobile API endpoint
        url = "https://www.pinterest.com/resource/BaseSearchResource/get/"
        options = {"query": "home decor ideas", "scope": "pins", "page_size": 10}
        params = {
            "source_url": "/search/pins/?q=home+decor+ideas&rs=typed",
            "data": json.dumps({"options": options, "context": {}}, separators=(',',':')),
            "_": "1234567890000",
        }
        resp = await sess._session.get(url + "?" + up.urlencode(params),
            headers={
                "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
                "X-CSRFToken": sess._csrf or "",
                "Accept": "application/json",
                "Referer": "https://www.pinterest.com/search/pins/?q=home+decor+ideas",
            })
        print(f"Mobile API status: {resp.status_code}")
        try:
            data = resp.json()
            rr = data.get('resource_response', {})
            results = rr.get('data', {}).get('results', [])
            print(f"results: {len(results)}")
            if results:
                pin = results[0]
                print(f"first pin keys: {list(pin.keys())[:8]}")
        except:
            print(f"text: {resp.text[:300]}")

asyncio.run(test_mobile())
PYEOF
"""),

        # 6. Check when the scraper last worked by looking at crawl logs
        ("cron log search-related lines", r"""grep -n 'pin.*saved\|pins.*saved\|kw.*pins\|pins.*kw\|keyword.*0\|0 pins\|rows_processed\|crawl complete\|keywords.*processed' /opt/vibepin/backend/logs/cron_daily.log | tail -30"""),

        # 7. Check scraper version / last modified date
        ("scraper_v2.py last modified", r"""ls -la /opt/vibepin/backend/scraper_v2.py; head -20 /opt/vibepin/backend/scraper_v2.py"""),
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
