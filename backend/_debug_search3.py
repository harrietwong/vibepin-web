import asyncio, json, time, sys
from urllib.parse import urlencode, quote
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from curl_cffi.requests import AsyncSession as CurlSession
from dotenv import load_dotenv
load_dotenv()

async def test():
    hdrs = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36", "Accept": "application/json, text/javascript, */*; q=0.01", "Accept-Language": "en-US,en;q=0.9", "X-Requested-With": "XMLHttpRequest"}
    async with CurlSession(impersonate="chrome146", headers=hdrs) as s:
        r = await s.get("https://www.pinterest.com/", headers={"Accept": "text/html,*/*", "Sec-Fetch-Mode": "navigate"})
        csrf = s.cookies.get("csrftoken", "")
        kw = "digital planner template"
        src = "/search/pins/?q=digital+planner+template&rs=typed"
        params = {"source_url": src, "data": json.dumps({"options": {"query": kw, "scope": "pins", "page_size": 10}, "context": {}}, separators=(",",":"))}
        params["_"] = str(int(time.time()*1000))
        url = "https://www.pinterest.com/resource/BaseSearchResource/get/?" + urlencode(params)
        extra = {"Referer": "https://www.pinterest.com/search/pins/?q=digital+planner+template", "X-Pinterest-Pws-Handler": "www/search/[scope].js"}
        if csrf: extra["X-CSRFToken"] = csrf
        r2 = await s.get(url, headers=extra)
        data = r2.json()
        resp = (data.get("resource_response") or {}).get("data") or {}
        results = resp.get("results", []) if isinstance(resp, dict) else []
        # look at objects field in each story
        for i, item in enumerate(results[:3]):
            print(f"--- story {i}, type={item.get('type')}, objects count={len(item.get('objects',[])) if isinstance(item.get('objects'), list) else 'N/A'}")
            objects = item.get("objects", [])
            if isinstance(objects, list) and objects:
                first_obj = objects[0]
                if isinstance(first_obj, dict):
                    print(f"  first_obj type={first_obj.get('type')}, keys={list(first_obj.keys())[:10]}")
                    print(f"  id={first_obj.get('id')}, save_count={first_obj.get('save_count')}, repin_count={first_obj.get('repin_count')}, created_at={first_obj.get('created_at')}")

asyncio.run(test())
