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
print(f"AES key: {len(aes_key)} bytes")

# Try WITHOUT immutable — let SQLite apply the WAL
print("\nTrying direct SQLite connection (with WAL)...")
try:
    conn = sqlite3.connect(str(cookies_db), timeout=3)
    rows = conn.execute(
        "SELECT host_key, name, encrypted_value FROM cookies "
        "WHERE host_key LIKE '%pinterest%' AND name IN ('_auth','_pinterest_sess')"
    ).fetchall()
    conn.close()
    print(f"  Success! Got {len(rows)} rows")
    for host, name, ev in rows:
        if ev[:3] in (b'v10', b'v20'):
            nonce, ct = ev[3:15], ev[15:]
            try:
                plain = AESGCM(aes_key).decrypt(nonce, ct, None)
                # Try as string
                try:
                    s = plain.decode("utf-8")
                    printable = s[:60] if s.isprintable() else f"[non-printable len={len(s)}]"
                except:
                    printable = f"[binary len={len(plain)}]"
                print(f"  {name}: {printable}")
            except Exception as e:
                print(f"  {name}: decrypt failed: {e}")
except Exception as e:
    print(f"  Failed: {e}")
    # Try read-only mode (allows WAL to be applied by reader)
    print("\nTrying URI read-only mode (mode=ro)...")
    try:
        uri = f"file:{cookies_db}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=3)
        rows = conn.execute(
            "SELECT host_key, name, encrypted_value FROM cookies "
            "WHERE host_key LIKE '%pinterest%' AND name IN ('_auth','_pinterest_sess')"
        ).fetchall()
        conn.close()
        print(f"  Success! Got {len(rows)} rows")
        for host, name, ev in rows:
            if ev[:3] in (b'v10', b'v20'):
                nonce, ct = ev[3:15], ev[15:]
                try:
                    plain = AESGCM(aes_key).decrypt(nonce, ct, None)
                    try:
                        s = plain.decode("utf-8")
                        printable = s[:60] if s.isprintable() else f"[non-printable len={len(s)}]"
                    except:
                        printable = f"[binary len={len(plain)}]"
                    print(f"  {name}: {printable}")
                except Exception as de:
                    print(f"  {name}: decrypt failed: {de}")
    except Exception as e2:
        print(f"  Also failed: {e2}")
