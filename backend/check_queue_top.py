import os, httpx
from dotenv import load_dotenv
load_dotenv()
url = os.environ["SUPABASE_URL"]; key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
h = httpx.Client(base_url=f"{url}/rest/v1/",
                 headers={"apikey": key, "Authorization": f"Bearer {key}",
                          "Prefer": "count=exact"})
r = h.get("crawl_queue", params={"status": "eq.pending", "select": "id", "limit": "1"})
print(f"Pending: {r.headers.get('content-range', '?')}")

h2 = httpx.Client(base_url=f"{url}/rest/v1/",
                  headers={"apikey": key, "Authorization": f"Bearer {key}"})
r2 = h2.get("crawl_queue", params={
    "status": "eq.pending", "order": "priority_score.desc",
    "select": "keyword,priority_score,category", "limit": "20"
})
print("\nTop 20 by priority:")
for row in r2.json():
    print(f"  {row['priority_score']:>3}  {row['category']:<20}  {row['keyword']}")
