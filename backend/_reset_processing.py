import os, json, urllib.request
from dotenv import load_dotenv
load_dotenv()
SUPA_URL = os.environ["SUPABASE_URL"]
SUPA_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

# Check what the pipeline _db_select would return for pending digital-products
req = urllib.request.Request(
    f"{SUPA_URL}/rest/v1/crawl_queue?status=eq.pending&category=eq.digital-products&order=created_at.asc",
    headers={"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}", "Prefer": "count=exact", "Range": "0-0"}
)
with urllib.request.urlopen(req) as r:
    cr = r.headers.get("Content-Range", "?")
    print(f"pending digital-products: {cr}")

req2 = urllib.request.Request(
    f"{SUPA_URL}/rest/v1/crawl_queue?status=eq.pending&category=eq.holidays-seasonal&order=created_at.asc",
    headers={"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}", "Prefer": "count=exact", "Range": "0-0"}
)
with urllib.request.urlopen(req2) as r:
    cr = r.headers.get("Content-Range", "?")
    print(f"pending holidays-seasonal: {cr}")

# Reset stuck processing items
req3 = urllib.request.Request(
    f"{SUPA_URL}/rest/v1/crawl_queue?status=eq.processing",
    data=json.dumps({"status": "pending"}).encode(),
    headers={"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}", "Content-Type": "application/json", "Prefer": "return=minimal"},
    method="PATCH"
)
with urllib.request.urlopen(req3) as r:
    print(f"Reset processing->pending: HTTP {r.status}")
