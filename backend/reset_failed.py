"""Reset failed and stuck-processing crawl_queue items back to pending."""
import os, httpx
from dotenv import load_dotenv
load_dotenv()
url = os.environ["SUPABASE_URL"]; key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
h = httpx.Client(base_url=f"{url}/rest/v1/",
                 headers={"apikey": key, "Authorization": f"Bearer {key}",
                          "Content-Type": "application/json"})

for status in ["failed", "processing"]:
    r = h.patch("crawl_queue",
                params={"status": f"eq.{status}"},
                json={"status": "pending", "last_error": None, "attempts": 0})
    print(f"Reset {status}: HTTP {r.status_code}")

# Verify
r2 = httpx.Client(base_url=f"{url}/rest/v1/",
                  headers={"apikey": key, "Authorization": f"Bearer {key}",
                           "Prefer": "count=exact"}).get(
    "crawl_queue", params={"status": "eq.pending", "select": "id", "limit": "1"})
print(f"Pending now: {r2.headers.get('content-range', '?')}")
