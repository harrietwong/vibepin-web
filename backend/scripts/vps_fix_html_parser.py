#!/usr/bin/env python3
"""Diagnose PWS_DATA content and fix _extract_pins_from_html."""
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
        # 1. Inspect __PWS_DATA__ content for pins
        ("inspect __PWS_DATA__ structure for pins", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import asyncio, re, json, sys
sys.path.insert(0, '.')
from scraper_v2 import PinterestSession, find_pins

async def inspect():
    async with PinterestSession() as sess:
        resp = await sess._session.get(
            "https://www.pinterest.com/search/pins/?q=home+decor+ideas&rs=typed",
            headers={"Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                     "Referer": "https://www.pinterest.com/"},
        )
        html = resp.text
        print(f"HTML len: {len(html)}")

        # Try __PWS_DATA__
        m = re.search(r'<script[^>]+id=["\']__PWS_DATA__["\'][^>]*>(.*?)</script>', html, re.DOTALL)
        if m:
            try:
                pws = json.loads(m.group(1))
                top_keys = list(pws.keys())
                print(f"__PWS_DATA__ top keys: {top_keys}")
                # Look for initialReduxState
                redux = pws.get('initialReduxState') or pws.get('initial_redux_state')
                if redux:
                    rkeys = list(redux.keys())[:10]
                    print(f"  initialReduxState keys: {rkeys}")
                    pins = find_pins(redux)
                    print(f"  find_pins result: {len(pins)} pins")
                    if pins:
                        print(f"  first pin keys: {list(pins[0].keys())[:8]}")
                else:
                    # Try find_pins on full pws
                    pins = find_pins(pws)
                    print(f"  find_pins on full pws: {len(pins)} pins")
                    # Print first 200 chars of each top-level key value
                    for k in list(pws.keys())[:5]:
                        v = pws[k]
                        print(f"  {k}: {str(v)[:150]}")
            except json.JSONDecodeError as e:
                print(f"JSON parse error: {e}")
                print(f"Content start: {m.group(1)[:200]}")
        else:
            print("No __PWS_DATA__ script found!")

        # Try initialReduxState directly in HTML
        m2 = re.search(r'"initialReduxState"\s*:\s*(\{.{0,50})', html)
        if m2:
            print(f"initialReduxState in HTML: {m2.group(0)[:200]}")

        # Check for pins in script tags
        script_tags = re.findall(r'<script[^>]*>(.*?)</script>', html, re.DOTALL)
        print(f"Total script tags: {len(script_tags)}")
        for i, s in enumerate(script_tags[:5]):
            if 'pin' in s.lower() or 'search' in s.lower():
                print(f"  Script {i}: len={len(s)}, snippet={s[:150].replace(chr(10),' ')}")

asyncio.run(inspect())
PYEOF
"""),

        # 2. Check search API response structure
        ("BaseSearchResource API response structure", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import asyncio, json, sys, urllib.parse as up
sys.path.insert(0, '.')
from scraper_v2 import PinterestSession

async def check_api():
    async with PinterestSession() as sess:
        query = "home decor ideas"
        options = {"query": query, "scope": "pins", "page_size": 25, "no_fetch_context_on_resource": False}
        data_json = json.dumps({"options": options, "context": {}}, separators=(',',':'))
        params = {"source_url": f"/search/pins/?q={query.replace(' ','+')}&rs=typed",
                  "data": data_json, "_": "1234567890000"}
        api_url = "https://www.pinterest.com/resource/BaseSearchResource/get/?" + up.urlencode(params)
        resp = await sess._get_json(api_url,
            referer=f"https://www.pinterest.com/search/pins/?q={query.replace('','+')}&rs=typed",
            source_url=f"/search/pins/?q={query.replace(' ','+')}&rs=typed",
            pws_handler="www/search/[scope].js")
        top_keys = list(resp.keys()) if resp else []
        print(f"API response top keys: {top_keys}")
        rr = resp.get('resource_response', {})
        rr_keys = list(rr.keys()) if rr else []
        print(f"resource_response keys: {rr_keys}")
        d = rr.get('data', {})
        if isinstance(d, dict):
            print(f"data keys: {list(d.keys())[:10]}")
            results = d.get('results', [])
            print(f"results count: {len(results) if results else 0}")
            if results:
                print(f"first result: {str(results[0])[:300]}")
        elif isinstance(d, list):
            print(f"data is list, len={len(d)}")
            if d:
                print(f"first item: {str(d[0])[:300]}")

asyncio.run(check_api())
PYEOF
"""),
    ]

    for label, cmd in cmds:
        print(f"\n{'='*70}\n### {label}\n{'='*70}", flush=True)
        out, err = ssh_run(client, cmd, timeout=120)
        if out.strip():
            print(out[:6000], flush=True)
        if err.strip():
            print("[STDERR]", err[:800], flush=True)

    client.close()
    print("\ndone.", flush=True)

if __name__ == "__main__":
    run_all()
