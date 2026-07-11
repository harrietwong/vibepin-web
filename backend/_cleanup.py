import urllib.request, json, os
from dotenv import load_dotenv
load_dotenv()
SUPA_URL = os.environ["SUPABASE_URL"]
SUPA_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
req = urllib.request.Request(
    SUPA_URL + "/rest/v1/trend_keywords?category=eq.digital-products&keyword=like.*%7C*",
    headers={"apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY, "Prefer": "return=representation"},
    method="DELETE"
)
with urllib.request.urlopen(req) as r:
    body = r.read()
    print("deleted HTTP", r.status, body[:300])
