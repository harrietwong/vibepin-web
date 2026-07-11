import urllib.request, json, os
from dotenv import load_dotenv
load_dotenv()
SUPA_URL = os.environ["SUPABASE_URL"]
SUPA_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
req = urllib.request.Request(
    SUPA_URL + "/rest/v1/crawl_queue?keyword=like.*%7C*",
    headers={"apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY, "Prefer": "return=minimal"},
    method="DELETE"
)
with urllib.request.urlopen(req) as r:
    print("crawl_queue cleanup HTTP", r.status)
