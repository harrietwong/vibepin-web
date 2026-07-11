import os, json, urllib.request
from dotenv import load_dotenv
load_dotenv()
SUPA_URL = os.environ["SUPABASE_URL"]
SUPA_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

# Count total pin_samples with header
req = urllib.request.Request(
    f"{SUPA_URL}/rest/v1/pin_samples?select=id",
    headers={"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}", "Prefer": "count=exact", "Range": "0-0"}
)
with urllib.request.urlopen(req) as r:
    content_range = r.headers.get("Content-Range", "unknown")
    print(f"Total pin_samples count: {content_range}")

# Count by fetching with higher range header
req2 = urllib.request.Request(
    f"{SUPA_URL}/rest/v1/pin_samples?select=category",
    headers={"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}", "Range": "0-4999"}
)
with urllib.request.urlopen(req2) as r:
    data = json.loads(r.read())
    from collections import Counter
    c = Counter(row["category"] for row in data if row.get("category"))
    print(f"\nFetched {len(data)} rows")
    for cat, cnt in sorted(c.items(), key=lambda x: -x[1]):
        print(f"  {cat}: {cnt}")
