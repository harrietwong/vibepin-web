import sys, sqlite3, base64, json, ctypes, ctypes.wintypes as wt
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

profile = Path.home() / "AppData/Local/PinterestScraper/profile"
cookies_db  = profile / "Default" / "Network" / "Cookies"
local_state = profile / "Local State"

# ── DPAPI decrypt ──────────────────────────────────────────────────────────────
class _BLOB(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

def dpapi_decrypt(data: bytes) -> bytes:
    buf = ctypes.create_string_buffer(data, len(data))
    blob_in  = _BLOB(len(data), buf)
    blob_out = _BLOB()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out))
    if not ok:
        raise RuntimeError(f"DPAPI failed, last error: {ctypes.get_last_error()}")
    result = ctypes.string_at(blob_out.pbData, blob_out.cbData)
    ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    return result

ls = json.loads(local_state.read_text(encoding="utf-8"))
enc_key_b64 = ls["os_crypt"]["encrypted_key"]
enc_key_raw = base64.b64decode(enc_key_b64)
print(f"Raw encrypted key len: {len(enc_key_raw)}, prefix: {enc_key_raw[:5]}")

aes_key = dpapi_decrypt(enc_key_raw[5:])
print(f"AES key len after DPAPI: {len(aes_key)} (should be 32)")
print(f"AES key hex[:16]: {aes_key[:16].hex()}")

# ── Try decrypting one cookie ──────────────────────────────────────────────────
uri = f"file:{cookies_db}?immutable=1"
conn = sqlite3.connect(uri, uri=True)
row = conn.execute(
    "SELECT host_key, name, encrypted_value FROM cookies "
    "WHERE host_key LIKE '%pinterest%' AND name='_pinterest_sess' LIMIT 1"
).fetchone()
conn.close()

if row:
    host, name, ev = row
    print(f"\nDecrypting {name} from {host}")
    print(f"  encrypted_value len: {len(ev)}")
    print(f"  prefix bytes: {ev[:3]}")
    print(f"  nonce (bytes 3-15): {ev[3:15].hex()}")

    nonce      = ev[3:15]
    ciphertext = ev[15:]
    print(f"  ciphertext len: {len(ciphertext)}")

    try:
        plaintext = AESGCM(aes_key).decrypt(nonce, ciphertext, None)
        print(f"  decrypted len: {len(plaintext)}")
        # Try to show as string
        try:
            s = plaintext.decode("utf-8")
            print(f"  value (first 80 chars): {s[:80]}")
        except UnicodeDecodeError:
            print(f"  value is binary (not utf-8), hex[:32]: {plaintext[:16].hex()}")
    except Exception as e:
        print(f"  AES-GCM failed: {e}")
