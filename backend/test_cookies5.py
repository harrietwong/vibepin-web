import sys, sqlite3, base64, json, ctypes, ctypes.wintypes as wt
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

profile = Path.home() / "AppData/Local/PinterestScraper/profile"
cookies_db  = profile / "Default" / "Network" / "Cookies"
local_state = profile / "Local State"

class _BLOB(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

def dpapi_decrypt(data: bytes) -> bytes:
    buf = ctypes.create_string_buffer(data, len(data))
    blob_in  = _BLOB(len(data), buf)
    blob_out = _BLOB()
    ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out))
    result = ctypes.string_at(blob_out.pbData, blob_out.cbData)
    ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    return result

ls      = json.loads(local_state.read_text(encoding="utf-8"))
aes_key = dpapi_decrypt(base64.b64decode(ls["os_crypt"]["encrypted_key"])[5:])

conn = sqlite3.connect(str(cookies_db), timeout=3)
rows = conn.execute(
    "SELECT host_key, name, encrypted_value FROM cookies "
    "WHERE host_key LIKE '%pinterest%' AND name IN ('_auth','_pinterest_sess','csrftoken')"
).fetchall()
conn.close()

for host, name, ev in rows[:3]:
    print(f"\n{name} @ {host}")
    print(f"  raw len={len(ev)}  prefix={ev[:3]}")
    nonce, ct = ev[3:15], ev[15:]
    # Try with None AAD
    try:
        plain_none = AESGCM(aes_key).decrypt(nonce, ct, None)
        print(f"  [AAD=None]  hex[:32]: {plain_none[:16].hex()}")
        print(f"  [AAD=None]  repr[:40]: {repr(plain_none[:40])}")
    except Exception as e:
        print(f"  [AAD=None]  failed: {e}")
    # Try with b"" AAD
    try:
        plain_empty = AESGCM(aes_key).decrypt(nonce, ct, b"")
        print(f"  [AAD=b'']   hex[:32]: {plain_empty[:16].hex()}")
        print(f"  [AAD=b'']   repr[:40]: {repr(plain_empty[:40])}")
    except Exception as e:
        print(f"  [AAD=b'']   failed: {e}")
