import sys, sqlite3, base64, json, ctypes, ctypes.wintypes as wt
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

profile = Path.home() / "AppData/Local/PinterestScraper/profile"
local_state = profile / "Local State"

# Check all possible Cookies locations
for p in [
    profile / "Default" / "Network" / "Cookies",
    profile / "Default" / "Cookies",
]:
    print(f"\n{p}: {'EXISTS' if p.exists() else 'MISSING'}")

class _BLOB(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

def dpapi_decrypt(data):
    buf = ctypes.create_string_buffer(data, len(data))
    bi, bo = _BLOB(len(data), buf), _BLOB()
    ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(bi), None, None, None, None, 0, ctypes.byref(bo))
    r = ctypes.string_at(bo.pbData, bo.cbData)
    ctypes.windll.kernel32.LocalFree(bo.pbData)
    return r

ls      = json.loads(local_state.read_text(encoding="utf-8"))
aes_key = dpapi_decrypt(base64.b64decode(ls["os_crypt"]["encrypted_key"])[5:])

cookies_db = profile / "Default" / "Network" / "Cookies"
conn = sqlite3.connect(str(cookies_db), timeout=3)

# Get ALL cookies to see what's there
rows = conn.execute("SELECT host_key, name, length(encrypted_value), encrypted_value FROM cookies WHERE host_key LIKE '%pinterest%'").fetchall()
conn.close()

print(f"\n{len(rows)} pinterest cookies in DB:")
for host, name, ev_len, ev in rows:
    # Decrypt
    if ev[:3] in (b'v10', b'v20'):
        try:
            plain = AESGCM(aes_key).decrypt(ev[3:15], ev[15:], None)
            # Try latin-1 interpretation
            try:
                as_latin1 = plain.decode('latin-1')
                printable_chars = sum(1 for c in as_latin1 if 32 <= ord(c) <= 126)
                pct = printable_chars / len(as_latin1) * 100
                preview = ''.join(c if 32 <= ord(c) <= 126 else '?' for c in as_latin1[:60])
                print(f"  {host:<30} {name:<25} len={len(plain):>6} ascii%={pct:.0f}%  preview={preview!r}")
            except:
                print(f"  {host:<30} {name:<25} len={len(plain):>6} decode-err")
        except Exception as e:
            print(f"  {host:<30} {name:<25} decrypt-failed: {e}")
    else:
        print(f"  {host:<30} {name:<25} unencrypted: {ev[:40]}")
