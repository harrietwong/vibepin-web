import sys, sqlite3, base64, json
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path

profile = Path.home() / "AppData/Local/PinterestScraper/profile"
cookies_db  = profile / "Default" / "Network" / "Cookies"
local_state = profile / "Local State"

# Show what key type we have
ls = json.loads(local_state.read_text(encoding="utf-8"))
enc_key_b64 = ls["os_crypt"]["encrypted_key"]
enc_key = base64.b64decode(enc_key_b64)
print(f"Local State key prefix: {enc_key[:5]}")  # should be b"DPAPI"

# Check app-bound key (Chrome 127+ feature)
app_bound = ls.get("os_crypt", {}).get("app_bound_encrypted_key")
print(f"app_bound_encrypted_key present: {app_bound is not None}")

# Read raw encrypted values
uri = f"file:{cookies_db}?immutable=1"
conn = sqlite3.connect(uri, uri=True)
rows = conn.execute(
    "SELECT host_key, name, encrypted_value FROM cookies "
    "WHERE host_key LIKE '%pinterest%' LIMIT 5"
).fetchall()
conn.close()

print(f"\nFirst 5 Pinterest cookies (raw encrypted_value prefix):")
for host, name, ev in rows:
    prefix = ev[:3] if ev else b""
    print(f"  {host:<30} {name:<25} prefix={prefix}  total_len={len(ev)}")
