import os, json, urllib.request
from dotenv import load_dotenv
load_dotenv()
SUPA_URL = os.environ["SUPABASE_URL"]
SUPA_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

def get(table, params=""):
    req = urllib.request.Request(
        f"{SUPA_URL}/rest/v1/{table}?{params}",
        headers={"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}"}
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

# Check trend_opportunities_view
try:
    rows = get("trend_opportunities_view", "select=keyword,linked_pins_count,linked_products_count,total_source_saves&limit=5")
    print("trend_opportunities_view sample:")
    for r in rows:
        print(f"  {r['keyword']}: pins={r['linked_pins_count']}, prods={r['linked_products_count']}, saves={r['total_source_saves']}")
except Exception as e:
    print("trend_opportunities_view error:", e)

# Check pin_samples total
try:
    rows = get("pin_samples", "select=category&limit=1000")
    from collections import Counter
    c = Counter(r["category"] for r in rows)
    print("\npin_samples by category (top 10):")
    for cat, cnt in c.most_common(10):
        print(f"  {cat}: {cnt}")
    print(f"  total: {len(rows)}")
except Exception as e:
    print("pin_samples error:", e)

# Check crawl_queue overall status
try:
    rows = get("crawl_queue", "select=status&limit=500")
    from collections import Counter
    c = Counter(r["status"] for r in rows)
    print(f"\ncrawl_queue status: {dict(c)}")
except Exception as e:
    print("crawl_queue error:", e)
