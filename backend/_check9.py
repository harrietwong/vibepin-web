import os, json, urllib.request
from dotenv import load_dotenv
load_dotenv()
SUPA_URL = os.environ["SUPABASE_URL"]
SUPA_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

# Mark all digital-products and holidays-seasonal pending items as priority
# by patching them to have a specific status we can filter on
# Actually just check what keywords are pending for these categories
req = urllib.request.Request(
    f"{SUPA_URL}/rest/v1/crawl_queue?select=id,keyword,category&status=eq.pending&category=in.(digital-products,holidays-seasonal)&limit=20",
    headers={"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}"}
)
with urllib.request.urlopen(req) as r:
    data = json.loads(r.read())
    print(f"Pending digital-products + holidays-seasonal: {len(data)}")
    for item in data[:10]:
        print(f"  [{item['category']}] {item['keyword']}")
