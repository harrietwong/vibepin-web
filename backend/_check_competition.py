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

# Check pin_samples for digital-products
pins = get("pin_samples", "select=id,category&category=eq.digital-products&limit=5")
print(f"digital-products pin_samples: {len(pins)}")

# Check crawl_queue status
import urllib.parse
q = get("crawl_queue", "select=status&category=eq.digital-products")
from collections import Counter
c = Counter(r["status"] for r in q)
print(f"crawl_queue digital-products: {dict(c)}")

# Check opportunities view - competition data
opps = get("keyword_opportunities", "select=keyword,linked_pins_count,linked_products_count&limit=10&order=linked_pins_count.desc")
print("Top opps by pins:")
for o in opps[:5]:
    print(f"  {o['keyword']}: pins={o['linked_pins_count']}, prods={o['linked_products_count']}")
