import sys, os, httpx
sys.path.insert(0, "db")
from db import select_many
from dotenv import load_dotenv
load_dotenv()

rows = select_many("crawl_queue", limit=5)
print(f"First 5 crawl_queue rows:")
for r in rows:
    print(f"  {r['keyword']:<40} {r['status']}")

url = os.environ["SUPABASE_URL"]
key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
h = httpx.Client(base_url=f"{url}/rest/v1/",
                 headers={"apikey": key, "Authorization": f"Bearer {key}", "Prefer": "count=exact"})
r = h.get("crawl_queue", params={"select": "id", "limit": "1"})
print(f"\nTotal crawl_queue count: {r.headers.get('content-range', '?')}")

r2 = h.get("crawl_queue", params={"select": "id", "status": "eq.pending", "limit": "1"})
print(f"Pending count: {r2.headers.get('content-range', '?')}")

r3 = h.get("trend_keywords", params={"select": "id", "limit": "1"})
print(f"Total trend_keywords: {r3.headers.get('content-range', '?')}")
