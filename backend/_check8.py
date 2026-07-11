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
        cr = r.headers.get("Content-Range", "0-0/0")
        return int(cr.split("/")[-1])

categories = ["digital-products", "holidays-seasonal", "beauty", "home-decor", "fashion", "art", "animals"]
for cat in categories:
    n = count("pin_samples", f"category=eq.{cat}")
    print(f"  {cat}: {n} pins")
