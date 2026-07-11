#!/usr/bin/env python3
"""
Step 4: Run scraper parser against the saved HTML sample.
Reports what each extraction pattern finds (or doesn't find).
"""
from __future__ import annotations

PARSER_CODE = r'''
import json, re, sys, os
sys.path.insert(0, '.')
from scraper_v2 import find_pins

SAMPLE_PATH = "/tmp/pinterest_search_sample.html"
if not os.path.exists(SAMPLE_PATH):
    print("ERROR: no sample file found — run vps_anon_direct.py first")
    sys.exit(1)

with open(SAMPLE_PATH, encoding="utf-8") as f:
    html = f.read()

print(f"Sample HTML size: {len(html):,} chars")
print()

# ── Pattern checks ────────────────────────────────────────────────────────────

checks = {}

# 1. Current _extract_pins_from_html patterns
# Pattern 1: <script id="initial-state">
m1 = re.search(r'<script[^>]+id=["\']initial-state["\'][^>]*>(.*?)</script>', html, re.DOTALL)
checks["script#initial-state"] = f"{'FOUND' if m1 else 'not found'}" + (f"  len={len(m1.group(1))}" if m1 else "")

# Pattern 2a: window.__INITIAL_STATE__
m2a = re.search(r'window\.__INITIAL_STATE__\s*=\s*(\{.*?\})(?:;|\s*</script>)', html, re.DOTALL)
checks["window.__INITIAL_STATE__"] = "FOUND" if m2a else "not found"

# Pattern 2b: window.__INITIAL_DATA__
m2b = re.search(r'window\.__INITIAL_DATA__\s*=\s*(\{.*?\})(?:;|\s*</script>)', html, re.DOTALL)
checks["window.__INITIAL_DATA__"] = "FOUND" if m2b else "not found"

# Pattern 2c: "initial_redux_state" (snake_case — current code)
m2c = re.search(r'"initial_redux_state"\s*:\s*(\{.*\})', html, re.DOTALL)
checks['"initial_redux_state" (snake)'] = "FOUND" if m2c else "not found"

# NEW: "initialReduxState" (camelCase — actual HTML key)
m2d = re.search(r'"initialReduxState"\s*:\s*(\{.{200})', html)
checks['"initialReduxState" (camel)'] = f"FOUND: {m2d.group(0)[:100]}" if m2d else "not found"

# Pattern 3: <script type="application/json">
app_json = re.findall(r'<script[^>]*type="application/json"[^>]*>(.*?)</script>', html, re.DOTALL)
checks["<script type=application/json>"] = f"{len(app_json)} blocks"

# Pattern __PWS_DATA__
m_pws = re.search(r'<script[^>]+id=["\']__PWS_DATA__["\'][^>]*>(.*?)</script>', html, re.DOTALL)
checks["<script id=__PWS_DATA__>"] = f"FOUND  keys={list(json.loads(m_pws.group(1)).keys())[:6]}" if m_pws else "not found"

# Raw pin_id occurrences
pin_id_re = re.findall(r'"pin_id"\s*:\s*"(\d+)"', html)
checks["raw pin_id in HTML"] = f"{len(pin_id_re)} matches"

# "id" with long numeric value (Pinterest-style)
long_ids = re.findall(r'"id"\s*:\s*"(\d{12,})"', html)
checks["long numeric id (12+d)"] = f"{len(long_ids)} matches" + (f"  examples={long_ids[:3]}" if long_ids else "")

# Check for BaseSearchResource in HTML (embedded XHR call)
checks["BaseSearchResource in HTML"] = "FOUND" if "BaseSearchResource" in html else "not found"

# Look for any JSON blobs with "results" arrays
results_blobs = re.findall(r'"results"\s*:\s*\[([^\]]*)\]', html)
checks['"results":[] blobs'] = f"{len(results_blobs)} found"

print("PATTERN CHECKS:")
for pat, val in checks.items():
    print(f"  {pat:<45} → {val}")

print()

# ── Run actual _extract_pins_from_html ────────────────────────────────────────
from scraper_v2 import PinterestSession
# Create a throwaway instance to call the method
import types
dummy = object.__new__(PinterestSession)
pins = dummy._extract_pins_from_html(html)
print(f"_extract_pins_from_html result: {len(pins)} pins")

# ── Try fixing the pattern: parse initialReduxState via application/json block ──
print()
print("PARSER FIX ATTEMPT:")
fixed_pins = []
for block in app_json:
    try:
        data = json.loads(block)
        # Try 'initialReduxState' (camelCase)
        redux = data.get("initialReduxState") or data.get("initial_redux_state")
        if redux:
            found = find_pins(redux)
            if found:
                fixed_pins.extend(found)
                print(f"  application/json block → initialReduxState → find_pins: {len(found)} pins")
        # Also try find_pins on full data
        all_found = find_pins(data)
        if all_found and not redux:
            fixed_pins.extend(all_found)
            print(f"  application/json block → find_pins direct: {len(all_found)} pins")
    except Exception as e:
        print(f"  application/json parse error: {e.__class__.__name__}")

print(f"Fixed parser total: {len(fixed_pins)} pins")
if fixed_pins:
    p = fixed_pins[0]
    print(f"  first pin keys: {list(p.keys())[:8]}")

# ── Check BaseSearchResource sample ──────────────────────────────────────────
api_sample = "/tmp/pinterest_api_sample.json"
if os.path.exists(api_sample):
    print()
    print("API RESPONSE PARSER CHECK:")
    with open(api_sample) as f:
        api_data = json.load(f)
    rr = api_data.get("resource_response", {})
    data = rr.get("data", {})
    results = data.get("results", []) if isinstance(data, dict) else (data or [])
    print(f"  results count: {len(results)}")
    if results:
        print(f"  first result keys: {list(results[0].keys())[:8]}")
    else:
        status = rr.get("status")
        msg = rr.get("message", "")
        print(f"  status={status}  message={msg[:100]}")
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
    with sftp.open("/tmp/parser_check.py", "w") as f:
        f.write(PARSER_CODE.encode("utf-8"))
    sftp.close()

    print("### VPS PARSER CHECK:")
    cmd = (
        "cd /opt/vibepin/backend && "
        "PINTEREST_CRAWL_MODE=anonymous "
        "timeout 60 .venv/bin/python3 /tmp/parser_check.py 2>&1"
    )
    out, err = ssh_run(client, cmd, timeout=80)
    print(out[:8000])
    if err.strip():
        print("[STDERR]", err[:500])

    client.close()

if __name__ == "__main__":
    run_all()
