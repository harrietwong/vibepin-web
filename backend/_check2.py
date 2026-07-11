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

# What views/tables exist that have opportunity data?
# Check the opportunities API endpoint
import urllib.request as ur
req = ur.Request(
    "http://localhost:3000/api/opportunities?limit=5",
    headers={"Accept": "application/json"}
)
try:
    with ur.urlopen(req, timeout=5) as r:
        data = json.loads(r.read())
        print("API response keys:", list(data.keys()) if isinstance(data, dict) else type(data))
        if isinstance(data, dict) and "data" in data:
            for o in (data["data"] or [])[:3]:
                print(f"  {o.get('keyword')}: pins={o.get('linked_pins_count')}, prods={o.get('linked_products_count')}")
except Exception as e:
    print("API error:", e)
