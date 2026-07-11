import os, httpx
from dotenv import load_dotenv
load_dotenv()
url = os.environ["SUPABASE_URL"]; key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
h = httpx.Client(base_url=f"{url}/rest/v1/",
                 headers={"apikey": key, "Authorization": f"Bearer {key}", "Prefer": "count=exact"})

thresholds = [100000, 50000, 10000, 5000, 1000, 500, 100]
for t in thresholds:
    r = h.get("pin_samples", params={"save_count": f"gte.{t}", "select": "id", "limit": "1"})
    print(f"  save_count >= {t:>8,}:  {r.headers.get('content-range', '?')}")
