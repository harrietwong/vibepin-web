import os, httpx
from dotenv import load_dotenv
load_dotenv()
url = os.environ["SUPABASE_URL"]; key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
h = httpx.Client(base_url=f"{url}/rest/v1/",
                 headers={"apikey": key, "Authorization": f"Bearer {key}", "Prefer": "count=exact"})

for status in ["pending", "processing", "completed", "failed"]:
    r = h.get("crawl_queue", params={"status": f"eq.{status}", "select": "id", "limit": "1"})
    print(f"  {status:<12} {r.headers.get('content-range', '?')}")

# Show failed items
r2 = httpx.Client(base_url=f"{url}/rest/v1/",
                  headers={"apikey": key, "Authorization": f"Bearer {key}"}).get(
    "crawl_queue", params={"status": "eq.failed", "select": "keyword,category,last_error", "limit": "10"}
)
if r2.json():
    print("\nFailed items:")
    for row in r2.json():
        print(f"  {row['category']:<20} {row['keyword']:<40} {str(row.get('last_error',''))[:60]}")
