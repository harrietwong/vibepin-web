import os, httpx
from dotenv import load_dotenv
load_dotenv()
url = os.environ["SUPABASE_URL"]; key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
h = httpx.Client(base_url=f"{url}/rest/v1/",
                 headers={"apikey": key, "Authorization": f"Bearer {key}", "Prefer": "count=exact"})

checks = [
    ("pin_samples", {}),
    ("crawl_queue", {"status": "eq.pending"}),
    ("crawl_queue", {"status": "eq.completed"}),
    ("pin_products", {}),
]
for table, filters in checks:
    params = {"select": "id", "limit": "1", **filters}
    r = h.get(table, params=params)
    label = f"{table} {filters}" if filters else table
    print(f"{label:<45} {r.headers.get('content-range', '?')}")
