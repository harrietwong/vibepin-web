import asyncio, json, time, sys
from urllib.parse import urlencode, quote
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from curl_cffi.requests import AsyncSession as CurlSession
from dotenv import load_dotenv
load_dotenv()

async def test():
    hdrs = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "en-US,en;q=0.9",
        "X-Requested-With": "XMLHttpRequest",
    }
    async with CurlSession(impersonate="chrome146", headers=hdrs) as s:
        r = await s.get("https://www.pinterest.com/", headers={"Accept": "text/html,*/*", "Sec-Fetch-Mode": "navigate"})
        csrf = s.cookies.get("csrftoken", "")
        kw = "digital planner template"
        src = "/search/pins/?q=digital+planner+template&rs=typed"
        params = {
            "source_url": src,
            "data": json.dumps({"options": {"query": kw, "scope": "pins", "page_size": 10}, "context": {}}, separators=(",",":")),
            "_": str(int(time.time()*1000))
        }
        url = "https://www.pinterest.com/resource/BaseSearchResource/get/?" + urlencode(params)
        extra = {"Referer": "https://www.pinterest.com/search/pins/?q=digital+planner+template", "X-Pinterest-Pws-Handler": "www/search/[scope].js"}
        if csrf:
            extra["X-CSRFToken"] = csrf
        r2 = await s.get(url, headers=extra)
        print("status:", r2.status_code)
        data = r2.json()
        resp = (data.get("resource_response") or {}).get("data") or {}
        results = resp.get("results", []) if isinstance(resp, dict) else []
        print("results count:", len(results) if isinstance(results, list) else "N/A")
        if isinstance(results, list) and results:
            first = results[0]
            if isinstance(first, dict):
                print("keys:", list(first.keys())[:15])
                print("type:", first.get("type"))
                print("save_count:", first.get("save_count"))
                print("repin_count:", first.get("repin_count"))
                print("created_at:", first.get("created_at"))
            else:
                print("first type:", type(first))
        else:
            print("resp keys:", list(resp.keys()) if isinstance(resp, dict) else "not dict")

asyncio.run(test())
