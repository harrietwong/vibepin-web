import os, json, urllib.request
from dotenv import load_dotenv
load_dotenv()
SUPA_URL = os.environ["SUPABASE_URL"]
SUPA_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

def get(table, params=""):
    req = urllib.request.Request(f"{SUPA_URL}/rest/v1/{table}?{params}", headers={"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

# Check crawl_queue pending by category (sample)
rows = get("crawl_queue", "select=keyword,category,status&status=eq.pending&limit=200")
from collections import Counter
c = Counter(r.get("category","") for r in rows)
print("Pending crawl_queue by category:")
for cat, cnt in c.most_common(15):
    print(f"  {cat or 'NULL'}: {cnt}")
print(f"Total pending: {len(rows)}")
