import os, json, urllib.request
from dotenv import load_dotenv
load_dotenv()
SUPA_URL = os.environ["SUPABASE_URL"]
SUPA_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

def get(table, params=""):
    req = urllib.request.Request(f"{SUPA_URL}/rest/v1/{table}?{params}&limit=2000", headers={"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

rows = get("pin_samples", "select=category")
from collections import Counter
c = Counter(r["category"] for r in rows if r["category"])
print(f"Total pins: {len(rows)}")
for cat, cnt in sorted(c.items(), key=lambda x: -x[1]):
    print(f"  {cat}: {cnt}")

# crawl queue status
q = get("crawl_queue", "select=status")
c2 = Counter(r["status"] for r in q)
print(f"\nCrawl queue: {dict(c2)}")
