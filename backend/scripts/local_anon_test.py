#!/usr/bin/env python3
"""
Step 3: Local machine anonymous Pinterest request test.
Pure urllib — no pip installs needed. Compares against VPS results.
Tests BaseSearchResource API and HTML page for 3 keywords.
Does NOT store or print any auth tokens.
"""
from __future__ import annotations
import json, re, time, urllib.request, urllib.parse, urllib.error, ssl, http.cookiejar

KEYWORDS = ["home decor ideas", "summer outfit ideas", "aesthetic nails"]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Upgrade-Insecure-Requests": "1",
}

API_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/json, text/javascript, */*, q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    "X-Requested-With": "XMLHttpRequest",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
}

def sanitize(text: str, max_len: int = 300) -> str:
    text = re.sub(r'"_auth"\s*:\s*"[^"]*"', '"_auth":"[R]"', text)
    text = re.sub(r'"csrftoken"\s*:\s*"[^"]*"', '"csrftoken":"[R]"', text)
    text = re.sub(r'"_pinterest_sess"\s*:\s*"[^"]*"', '"_pinterest_sess":"[R]"', text)
    return text[:max_len].replace('\n', ' ')

def build_opener():
    ctx = ssl.create_default_context()
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ctx),
        urllib.request.HTTPCookieProcessor(jar),
    )
    return opener, jar

def get_csrf(opener, jar) -> str:
    req = urllib.request.Request("https://www.pinterest.com/", headers=HEADERS)
    try:
        with opener.open(req, timeout=15) as r:
            _ = r.read()
    except Exception as e:
        print(f"  bootstrap error: {e}")
        return ""
    for c in jar:
        if c.name == "csrftoken":
            return c.value
    return ""

def test_keyword(opener, jar, csrf: str, keyword: str) -> dict:
    result = {
        "keyword": keyword,
        "html_status": None, "html_size": 0, "html_pin_id_count": 0,
        "html_has_login_wall": False, "html_has_captcha": False,
        "html_has_pws_data": False, "html_snippet": "",
        "api_status": None, "api_size": 0, "api_results_count": 0,
        "api_snippet": "", "error": None,
    }

    search_url = f"https://www.pinterest.com/search/pins/?q={urllib.parse.quote(keyword)}&rs=typed"

    # HTML page
    time.sleep(1.0)
    try:
        req = urllib.request.Request(search_url, headers={**HEADERS, "Referer": "https://www.pinterest.com/"})
        with opener.open(req, timeout=20) as r:
            html = r.read().decode("utf-8", errors="replace")
        result["html_status"] = r.getcode()
        result["html_size"] = len(html)
        result["html_has_pws_data"] = "__PWS_DATA__" in html
        result["html_pin_id_count"] = len(re.findall(r'"pin_id"\s*:\s*"\d+', html))
        lo = html.lower()
        result["html_has_login_wall"] = any(m in lo for m in
            ("create an account", "sign up to see", "log in to see", "continue to pinterest"))
        result["html_has_captcha"] = any(m in lo for m in
            ("captcha", "i'm not a robot", "challenge"))
        result["html_snippet"] = sanitize(html, 300)
    except urllib.error.HTTPError as e:
        result["html_status"] = e.code
        result["error"] = f"HTML HTTP {e.code}"
    except Exception as e:
        result["error"] = f"HTML: {e}"

    # BaseSearchResource API
    time.sleep(1.0)
    try:
        opts = {"query": keyword, "scope": "pins", "page_size": 25,
                "no_fetch_context_on_resource": False}
        data_json = json.dumps({"options": opts, "context": {}}, separators=(',', ':'))
        params = {"source_url": f"/search/pins/?q={keyword.replace(' ','+')}",
                  "data": data_json, "_": str(int(time.time() * 1000))}
        api_url = ("https://www.pinterest.com/resource/BaseSearchResource/get/?"
                   + urllib.parse.urlencode(params))
        api_h = {
            **API_HEADERS,
            "Referer": search_url,
            "X-Pinterest-Source-Url": f"/search/pins/?q={keyword.replace(' ','+')}",
            "X-Pinterest-Pws-Handler": "www/search/[scope].js",
        }
        if csrf:
            api_h["X-CSRFToken"] = csrf
        req2 = urllib.request.Request(api_url, headers=api_h)
        with opener.open(req2, timeout=20) as r2:
            body_raw = r2.read().decode("utf-8", errors="replace")
        result["api_status"] = r2.getcode()
        result["api_size"] = len(body_raw)
        try:
            data = json.loads(body_raw)
            rr = data.get("resource_response", {})
            rd = rr.get("data", {})
            results = rd.get("results", []) if isinstance(rd, dict) else (rd or [])
            result["api_results_count"] = len(results) if results else 0
        except Exception:
            pass
        result["api_snippet"] = sanitize(body_raw, 400)
    except urllib.error.HTTPError as e:
        result["api_status"] = e.code
        result["error"] = (result.get("error") or "") + f" API HTTP {e.code}"
    except Exception as e:
        result["error"] = (result.get("error") or "") + f" API: {e}"

    return result

def main():
    print("=" * 70)
    print("LOCAL MACHINE ANONYMOUS REQUEST TEST")
    print("Platform: Windows local (no VPS, no auth)")
    print("=" * 70)

    opener, jar = build_opener()
    print("\nBootstrapping session (get CSRF)...")
    csrf = get_csrf(opener, jar)
    print(f"CSRF obtained: {'yes' if csrf else 'no'}")
    time.sleep(0.8)

    results = []
    for kw in KEYWORDS:
        print(f"\n--- Keyword: {kw!r} ---")
        r = test_keyword(opener, jar, csrf, kw)
        results.append(r)
        print(f"HTML:  status={r['html_status']}  size={r['html_size']}  "
              f"pws_data={r['html_has_pws_data']}  "
              f"pin_ids={r['html_pin_id_count']}  "
              f"login_wall={r['html_has_login_wall']}  captcha={r['html_has_captcha']}")
        print(f"       snippet: {r['html_snippet'][:200]}")
        print(f"API:   status={r['api_status']}  size={r['api_size']}  "
              f"results={r['api_results_count']}")
        print(f"       snippet: {r['api_snippet'][:250]}")
        if r["error"]:
            print(f"ERROR: {r['error']}")

    print("\n" + "=" * 70)
    print("SUMMARY — LOCAL MACHINE")
    print("=" * 70)
    for r in results:
        print(f"{r['keyword'][:30]:<32}  html_pin_ids={r['html_pin_id_count']}  "
              f"api_results={r['api_results_count']}  "
              f"login_wall={r['html_has_login_wall']}")

    return results

if __name__ == "__main__":
    main()
