"""
chrome_cookies.py — Extract decrypted cookies from a running Chrome profile (Windows).

Uses:
  - ctypes CryptUnprotectData (DPAPI) to decrypt the AES key from Local State
  - AES-256-GCM (cryptography lib) to decrypt individual cookie values
  - sqlite3 with immutable=1 URI to read the locked Cookies database

Returns cookies as a list of dicts compatible with Playwright's context.add_cookies().
"""
import json, base64, sqlite3, ctypes, ctypes.wintypes as wt
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


# ── DPAPI ─────────────────────────────────────────────────────────────────────

class _BLOB(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

def _dpapi_decrypt(data: bytes) -> bytes:
    buf = ctypes.create_string_buffer(data, len(data))
    blob_in  = _BLOB(len(data), buf)
    blob_out = _BLOB()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out))
    if not ok:
        raise RuntimeError("DPAPI CryptUnprotectData failed")
    result = ctypes.string_at(blob_out.pbData, blob_out.cbData)
    ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    return result


# ── AES-GCM cookie decryption ────────────────────────────────────────────────

def _get_aes_key(local_state_path: Path) -> bytes:
    local_state = json.loads(local_state_path.read_text(encoding="utf-8"))
    enc_key_b64 = local_state["os_crypt"]["encrypted_key"]
    enc_key = base64.b64decode(enc_key_b64)
    # First 5 bytes are ASCII "DPAPI" prefix
    return _dpapi_decrypt(enc_key[5:])


_CHROME_DOMAIN_PREFIX_LEN = 32  # Chrome prepends a 32-byte domain-binding context

def _decrypt_cookie_value(aes_key: bytes, encrypted_value: bytes) -> str:
    if encrypted_value[:3] in (b"v10", b"v20"):
        nonce      = encrypted_value[3:15]   # 12 bytes
        ciphertext = encrypted_value[15:]    # includes 16-byte GCM tag at end
        try:
            plaintext = AESGCM(aes_key).decrypt(nonce, ciphertext, None)
            # Chrome prepends a 32-byte domain-binding prefix before the actual value
            actual = plaintext[_CHROME_DOMAIN_PREFIX_LEN:]
            return actual.decode("utf-8", errors="replace")
        except Exception:
            return ""
    # Old-style unencrypted (rare)
    return encrypted_value.decode("utf-8", errors="replace")


# ── Public API ────────────────────────────────────────────────────────────────

def get_cookies(profile_dir: Path, domains: list[str] | None = None) -> list[dict]:
    """
    Extract decrypted cookies from a Chrome profile.
    Works even while Chrome is running (uses immutable=1 SQLite URI).

    profile_dir: Chrome user data dir (contains Default/ and Local State)
    domains:     optional list of domain suffixes to filter (e.g. ["pinterest.com"])
    Returns list of Playwright-compatible cookie dicts.
    """
    local_state = profile_dir / "Local State"
    cookies_db  = profile_dir / "Default" / "Network" / "Cookies"

    if not cookies_db.exists():
        # Older Chrome path
        cookies_db = profile_dir / "Default" / "Cookies"

    if not local_state.exists() or not cookies_db.exists():
        raise FileNotFoundError(f"Chrome profile files not found in {profile_dir}")

    aes_key = _get_aes_key(local_state)

    # Direct connection (WAL mode) lets us read the current state even when Chrome is open
    conn = sqlite3.connect(str(cookies_db), timeout=5)
    conn.row_factory = sqlite3.Row

    try:
        rows = conn.execute(
            "SELECT host_key, name, path, encrypted_value, expires_utc, "
            "       is_secure, is_httponly, samesite "
            "FROM cookies"
        ).fetchall()
    finally:
        conn.close()

    result = []
    for row in rows:
        host = row["host_key"]
        if domains and not any(d in host for d in domains):
            continue

        value = _decrypt_cookie_value(aes_key, row["encrypted_value"])
        if not value:
            continue

        # Chrome epoch: microseconds since 1601-01-01
        # Convert to Unix timestamp (seconds since 1970-01-01)
        expires_us = row["expires_utc"]
        expires    = (expires_us / 1_000_000) - 11_644_473_600 if expires_us else 0

        cookie: dict = {
            "name":     row["name"],
            "value":    value,
            "domain":   host if host.startswith(".") else host,
            "path":     row["path"] or "/",
            "secure":   bool(row["is_secure"]),
            "httpOnly": bool(row["is_httponly"]),
            "sameSite": {-1: "None", 0: "None", 1: "Lax", 2: "Strict"}.get(row["samesite"], "None"),
        }
        if expires > 0:
            cookie["expires"] = int(expires)

        result.append(cookie)

    return result


if __name__ == "__main__":
    import sys
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    profile = Path.home() / "AppData/Local/PinterestScraper/profile"
    cookies = get_cookies(profile, domains=["pinterest.com"])
    print(f"Found {len(cookies)} pinterest.com cookies:")
    for c in cookies[:10]:
        print(f"  {c['domain']:<30} {c['name']:<30} = {c['value'][:30]}...")
