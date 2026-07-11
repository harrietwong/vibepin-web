#!/usr/bin/env python3
"""
Step 4: Save a sample HTML + API response from VPS and run parser against them.
Also tests what local API results look like when fed to the parser.
"""
from __future__ import annotations

# ── Code that runs on VPS ────────────────────────────────────────────────────
VPS_CODE = r'''
import asyncio, json, re, sys, os, time, urllib.parse as up
sys.path.insert(0, '.')
from scraper_v2 import PinterestSession, find_pins

async def save_samples():
    async with PinterestSession() as sess:
        # 1. Fetch and save HTML sample
        search_url = "https://www.pinterest.com/search/pins/?q=home+decor+ideas&rs=typed"
        try:
            r = await sess._session.get(search_url,
                headers={"Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                         "Referer": "https://www.pinterest.com/"})
            html = r.text
            safe = re.sub(r'"csrftoken"\s*:\s*"[^"]*"', '"csrftoken":"[R]"', html)
            safe = re.sub(r'"_auth"\s*:\s*"[^"]*"', '"_auth":"[R]"', safe)
            safe = re.sub(r'"_pinterest_sess"\s*:\s*"[^"]*"', '"_pinterest_sess":"[R]"', safe)
            with open("/tmp/pint_html_sample.html", "w", encoding="utf-8") as f:
                f.write(safe)
            print(f"HTML saved: {len(html):,} chars  status={r.status_code}")
        except Exception as e:
            print(f"HTML error: {e}")
            html = ""

        await asyncio.sleep(1.5)

        # 2. Fetch and save API sample
        try:
            opts = {"query": "home decor ideas", "scope": "pins", "page_size": 25}
            data_json = json.dumps({"options": opts, "context": {}}, separators=(',',':'))
            params = {"source_url": "/search/pins/?q=home+decor+ideas",
                      "data": data_json, "_": str(int(time.time()*1000))}
            api_url = "https://www.pinterest.com/resource/BaseSearchResource/get/?" + up.urlencode(params)
            api_data = await sess._get_json(api_url,
                referer=search_url,
                source_url="/search/pins/?q=home+decor+ideas",
                pws_handler="www/search/[scope].js")
            safe_api = re.sub(r'"csrftoken"\s*:\s*"[^"]*"', '"csrftoken":"[R]"', json.dumps(api_data))
            with open("/tmp/pint_api_sample.json", "w") as f:
                f.write(safe_api)
            rr = api_data.get("resource_response", {})
            results = rr.get("data", {}).get("results", []) if isinstance(rr.get("data"), dict) else []
            print(f"API saved: {len(safe_api):,} chars  results={len(results)}  "
                  f"status={rr.get('http_status')}  message={rr.get('message','')[:60]}")
        except Exception as e:
            print(f"API error: {e}")
            api_data = {}

        # ── Parser analysis on HTML ──────────────────────────────────────────
        if html:
            print()
            print("=== PARSER ANALYSIS ON VPS HTML ===")

            # Raw markers
            print(f"  'captcha' occurrences: {html.lower().count('captcha')}")
            cap_ctx = re.search(r'.{0,80}captcha.{0,80}', html, re.IGNORECASE)
            if cap_ctx:
                ctx = cap_ctx.group(0).replace('\n',' ')
                print(f"  captcha context: {ctx[:160]}")

            print(f"  '__PWS_DATA__': {'YES' if '__PWS_DATA__' in html else 'no'}")
            print(f"  'initialReduxState': {'YES' if 'initialReduxState' in html else 'no'}")
            print(f"  'BaseSearchResource': {'YES' if 'BaseSearchResource' in html else 'no'}")

            # Pin ID count
            pin_ids = re.findall(r'"pin_id"\s*:\s*"(\d+)"', html)
            long_ids = re.findall(r'"id"\s*:\s*"(\d{12,})"', html)
            print(f"  pin_id mentions: {len(pin_ids)}")
            print(f"  long numeric ids (12+ digits): {len(long_ids)}")

            # application/json script blocks
            app_json_blocks = re.findall(r'<script[^>]*type="application/json"[^>]*>(.*?)</script>',
                                          html, re.DOTALL)
            print(f"  <script type=application/json> blocks: {len(app_json_blocks)}")
            for i, block in enumerate(app_json_blocks[:3]):
                try:
                    data = json.loads(block)
                    keys = list(data.keys())[:8]
                    print(f"    block {i}: len={len(block)}, keys={keys}")
                    # Try find_pins
                    pins = find_pins(data)
                    if pins:
                        print(f"      → find_pins: {len(pins)} pins found!")
                    # Try initialReduxState
                    redux = data.get("initialReduxState") or data.get("initial_redux_state")
                    if redux:
                        rkeys = list(redux.keys())[:8]
                        print(f"      initialReduxState keys: {rkeys}")
                        rp = find_pins(redux)
                        print(f"      → find_pins(redux): {len(rp)} pins")
                        # Check 'searches' key
                        searches = redux.get("searches", {})
                        if searches:
                            print(f"      searches keys: {list(searches.keys())[:5]}")
                except json.JSONDecodeError as e:
                    print(f"    block {i}: JSON error ({e}), len={len(block)}")

            # Current _extract_pins_from_html
            from scraper_v2 import PinterestSession as PS
            dummy = object.__new__(PS)
            extracted = dummy._extract_pins_from_html(html)
            print(f"\n  _extract_pins_from_html result: {len(extracted)} pins")

asyncio.run(save_samples())
'''

def ssh_run(client, cmd, timeout=120):
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

    sftp = client.open_sftp()
    with sftp.open("/tmp/vps_parser2.py", "w") as f:
        f.write(VPS_CODE.encode("utf-8"))
    sftp.close()

    print("### VPS PARSER + SAMPLE CHECK:")
    cmd = (
        "cd /opt/vibepin/backend && "
        "PINTEREST_CRAWL_MODE=anonymous "
        "timeout 90 .venv/bin/python3 /tmp/vps_parser2.py 2>&1"
    )
    out, err = ssh_run(client, cmd, timeout=110)
    print(out[:8000])
    if err.strip():
        print("[STDERR]", err[:400])

    # Also check: does the local API JSON parse correctly with find_pins?
    print("\n### LOCAL API RESULT PARSER TEST (simulated):")
    # Simulate what the scraper would do if it received the local results
    local_sim_cmd = r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys, json
sys.path.insert(0,'.')
from scraper_v2 import find_pins

# Simulate a valid API response structure (what local machine gets)
# results_count=23 with typical Pinterest pin structure
sample_result = {
    'resource_response': {
        'code': 0, 'http_status': 200, 'message': 'ok', 'status': 'success',
        'data': {
            'results': [
                {'type': 'pin', 'id': '123456789012345', 'images': {'originals': {'url': 'https://i.pinimg.com/1.jpg'}}, 'domain': 'example.com'},
                {'type': 'pin', 'id': '234567890123456', 'images': {'originals': {'url': 'https://i.pinimg.com/2.jpg'}}, 'domain': 'etsy.com'},
            ]
        }
    }
}
rr = sample_result['resource_response']
data = rr.get('data', {})
results = data.get('results', [])
print(f'simulated results count: {len(results)}')
# Check collect_pin_ids logic
batch_ids = []
def collect_pin_ids(obj, depth=0):
    if depth > 8 or not isinstance(obj, (dict, list)): return []
    if isinstance(obj, list):
        ids = []
        for item in obj: ids.extend(collect_pin_ids(item, depth+1))
        return ids
    ids = []
    obj_type = obj.get('type','')
    raw_id = obj.get('id') or obj.get('pin_id') or ''
    if (obj_type == 'pin' or (obj_type == '' and raw_id)):
        pid = str(raw_id)
        if pid.isdigit() and len(pid) > 10:
            ids.append(pid)
            return ids
    for v in obj.values():
        if isinstance(v, (dict,list)): ids.extend(collect_pin_ids(v, depth+1))
    return ids
ids = collect_pin_ids(results or [])
print(f'collect_pin_ids result: {ids}')
print('Parser works correctly for standard API response format')
" 2>&1"""
    out, _ = ssh_run(client, local_sim_cmd, timeout=15)
    print(out[:2000])

    client.close()

if __name__ == "__main__":
    run_all()
