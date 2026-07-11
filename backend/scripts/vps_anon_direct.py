#!/usr/bin/env python3
"""
Step 2: Direct anonymous request diagnostic for 3 keywords on VPS.
Tests multiple endpoints and strategies. No auth, no cookies stored.
Saves one sanitized HTML sample for parser check.
"""
from __future__ import annotations

DIAGNOSTIC_CODE = r'''
import asyncio, json, re, sys, os, time, urllib.parse as up
sys.path.insert(0, '.')
from scraper_v2 import PinterestSession

KEYWORDS = ["home decor ideas", "summer outfit ideas", "aesthetic nails"]

def sanitize(text: str, max_len: int = 300) -> str:
    """Remove potential tokens/cookies from output, truncate."""
    text = re.sub(r'"_auth"\s*:\s*"[^"]*"', '"_auth":"[REDACTED]"', text)
    text = re.sub(r'"csrftoken"\s*:\s*"[^"]*"', '"csrftoken":"[REDACTED]"', text)
    text = re.sub(r'"_pinterest_sess"\s*:\s*"[^"]*"', '"_pinterest_sess":"[REDACTED]"', text)
    return text[:max_len].replace('\n', ' ')

async def test_keyword(sess: PinterestSession, keyword: str) -> dict:
    result = {
        "keyword": keyword,
        "html_status": None,
        "html_size": 0,
        "html_content_type": None,
        "html_has_pws_data": False,
        "html_pin_id_count": 0,
        "html_has_login_wall": False,
        "html_has_captcha": False,
        "html_snippet": "",
        "api_status": None,
        "api_size": 0,
        "api_results_count": 0,
        "api_has_bookmark": False,
        "api_snippet": "",
        "error": None,
    }

    search_url = f"https://www.pinterest.com/search/pins/?q={up.quote(keyword)}&rs=typed"

    # ── HTML page ────────────────────────────────────────────────────────────
    try:
        await asyncio.sleep(1.2)
        r = await sess._session.get(search_url,
            headers={"Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                     "Referer": "https://www.pinterest.com/"})
        result["html_status"] = r.status_code
        html = r.text
        result["html_size"] = len(html)
        result["html_content_type"] = r.headers.get("content-type", "")[:60]
        result["html_has_pws_data"] = "__PWS_DATA__" in html
        result["html_pin_id_count"] = len(re.findall(r'"pin_id"\s*:\s*"\d+', html))
        lower = html.lower()
        result["html_has_login_wall"] = any(m in lower for m in
            ("create an account", "sign up to see", "log in to see", "continue to pinterest"))
        result["html_has_captcha"] = any(m in lower for m in
            ("captcha", "i'm not a robot", "challenge", "verify you are human"))
        result["html_snippet"] = sanitize(html, 300)
    except Exception as e:
        result["error"] = f"HTML: {e}"

    # ── BaseSearchResource API ────────────────────────────────────────────────
    try:
        await asyncio.sleep(1.2)
        opts = {"query": keyword, "scope": "pins", "page_size": 25,
                "no_fetch_context_on_resource": False}
        data_json = json.dumps({"options": opts, "context": {}}, separators=(',', ':'))
        params = {"source_url": f"/search/pins/?q={keyword.replace(' ','+')}",
                  "data": data_json, "_": str(int(time.time() * 1000))}
        api_url = ("https://www.pinterest.com/resource/BaseSearchResource/get/?"
                   + up.urlencode(params))
        resp = await sess._get_json(api_url,
            referer=search_url,
            source_url=f"/search/pins/?q={keyword.replace(' ','+')}",
            pws_handler="www/search/[scope].js")
        result["api_status"] = "200_json"
        body_str = json.dumps(resp)
        result["api_size"] = len(body_str)
        rr = resp.get("resource_response", {})
        data = rr.get("data", {})
        results = data.get("results", []) if isinstance(data, dict) else (data or [])
        result["api_results_count"] = len(results) if results else 0
        result["api_has_bookmark"] = bool(rr.get("bookmark"))
        result["api_snippet"] = sanitize(body_str, 400)
    except Exception as e:
        result["error"] = (result.get("error") or "") + f" API: {e}"

    return result

async def main():
    print("=" * 70)
    print("ANONYMOUS DIRECT REQUEST DIAGNOSTIC")
    print(f"auth mode: {os.getenv('PINTEREST_CRAWL_MODE', 'disabled')}")
    print("=" * 70)

    async with PinterestSession() as sess:
        print(f"Session auth state: {sess._auth_state}")
        print()

        all_results = []
        for kw in KEYWORDS:
            print(f"\n--- Keyword: {kw!r} ---")
            r = await test_keyword(sess, kw)
            all_results.append(r)

            print(f"HTML:  status={r['html_status']}  size={r['html_size']}  "
                  f"ct={r['html_content_type'][:40]}")
            print(f"       has_pws_data={r['html_has_pws_data']}  "
                  f"pin_id_count={r['html_pin_id_count']}  "
                  f"login_wall={r['html_has_login_wall']}  "
                  f"captcha={r['html_has_captcha']}")
            print(f"       snippet: {r['html_snippet'][:200]}")
            print(f"API:   status={r['api_status']}  size={r['api_size']}  "
                  f"results={r['api_results_count']}  bookmark={r['api_has_bookmark']}")
            print(f"       snippet: {r['api_snippet'][:250]}")
            if r["error"]:
                print(f"ERROR: {r['error']}")

        # Summary
        print("\n" + "=" * 70)
        print("SUMMARY")
        print("=" * 70)
        for r in all_results:
            print(f"{r['keyword'][:30]:<32}  html={r['html_pin_id_count']} pin_ids  "
                  f"api={r['api_results_count']} results  "
                  f"login_wall={r['html_has_login_wall']}")

        # Save a sanitized HTML sample for parser analysis
        sample_html_path = "/tmp/pinterest_search_sample.html"
        try:
            r_sample = await sess._session.get(
                "https://www.pinterest.com/search/pins/?q=home+decor+ideas&rs=typed",
                headers={"Accept": "text/html,application/xhtml+xml,*/*;q=0.8"})
            with open(sample_html_path, "w", encoding="utf-8") as f:
                # Strip potential auth tokens from saved HTML
                safe_html = re.sub(r'"_auth"\s*:\s*"[^"]*"', '"_auth":"0"',
                            re.sub(r'"csrftoken"\s*:\s*"[^"]*"', '"csrftoken":"[REDACTED]"',
                            r.text))
                f.write(safe_html)
            print(f"\nSaved sanitized HTML sample: {sample_html_path} ({len(r_sample.text)} chars)")
        except Exception as e:
            print(f"Could not save sample: {e}")

asyncio.run(main())
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
    with sftp.open("/tmp/anon_direct_diag.py", "w") as f:
        f.write(DIAGNOSTIC_CODE.encode("utf-8"))
    sftp.close()

    print("### VPS DIRECT ANONYMOUS REQUEST DIAGNOSTIC:")
    cmd = (
        "cd /opt/vibepin/backend && "
        "PINTEREST_CRAWL_MODE=anonymous "
        "PINTEREST_AUTH_CRAWL_ENABLED=false "
        "timeout 180 .venv/bin/python3 /tmp/anon_direct_diag.py 2>&1"
    )
    out, err = ssh_run(client, cmd, timeout=200)
    print(out[:10000])
    if err.strip():
        print("[STDERR]", err[:400])

    client.close()

if __name__ == "__main__":
    run_all()
