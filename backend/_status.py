import os, json, urllib.request
from dotenv import load_dotenv
load_dotenv()
SUPA_URL = os.environ["SUPABASE_URL"]
SUPA_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

def count(table, params=""):
    req = urllib.request.Request(
        f"{SUPA_URL}/rest/v1/{table}?{params}&select=id",
        headers={"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}", "Prefer": "count=exact", "Range": "0-0"}
    )
    with urllib.request.urlopen(req) as r:
        return int(r.headers.get("Content-Range","0/0").split("/")[-1])

for cat in ["digital-products", "holidays-seasonal", "beauty", "home-decor"]:
    n = count("pin_samples", f"category=eq.{cat}")
    print(f"  {cat}: {n} pins")

# crawl queue status
req = urllib.request.Request(
    f"{SUPA_URL}/rest/v1/crawl_queue?select=status,category",
    headers={"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}", "Range": "0-999"}
)
with urllib.request.urlopen(req) as r:
    rows = json.loads(r.read())
from collections import Counter
status_counts = Counter(r["status"] for r in rows)
pending_by_cat = Counter(r["category"] for r in rows if r["status"] == "pending")
print(f"\nOverall queue: {dict(status_counts)}")
print("Pending by category:", dict(pending_by_cat.most_common(5)))
