import os, json, urllib.request
from dotenv import load_dotenv
load_dotenv()
SUPA_URL = os.environ["SUPABASE_URL"]
SUPA_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

def get(url):
    req = urllib.request.Request(url, headers={"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

# Full category counts from pin_samples
rows = get(f"{SUPA_URL}/rest/v1/pin_samples?select=category&limit=5000")
from collections import Counter
c = Counter(r["category"] for r in rows if r["category"])
print(f"pin_samples total fetched: {len(rows)}")
print("By category:")
for cat, cnt in sorted(c.items(), key=lambda x: -x[1]):
    print(f"  {cat}: {cnt}")

# Check trend_opportunities_view - which keywords have pins
view_rows = get(f"{SUPA_URL}/rest/v1/trend_opportunities_view?select=keyword,linked_pins_count&linked_pins_count=gt.0&limit=5")
print(f"\nSample keywords with pins in view: {[r['keyword'] for r in view_rows]}")

# Check how many trend_keywords exist per category
kws = get(f"{SUPA_URL}/rest/v1/trend_keywords?select=category&status=eq.active&limit=1000")
kc = Counter(r["category"] for r in kws)
print(f"\ntrend_keywords by category (top 10):")
for cat, cnt in kc.most_common(10):
    print(f"  {cat}: {cnt} keywords")
