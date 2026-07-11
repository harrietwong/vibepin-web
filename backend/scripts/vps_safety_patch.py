#!/usr/bin/env python3
"""
Patch scraper_v2.py via SFTP:
- Remove bare _login(), replace with _restore_or_login() + _login_with_credentials()
- Add _save_session(), _load_session() (cookie file, not password-every-run)
- Gate everything behind PINTEREST_CRAWL_MODE and PINTEREST_AUTH_CRAWL_ENABLED flags
- Add auth state constants and __auth_state tracking on PinterestSession
- Add safety checks at top of search_pins
- Add module-level constants
"""
from __future__ import annotations

NEW_CONSTANTS = '''\
# ── Crawl-mode & auth-safety constants ─────────────────────────────────────
# Override via environment variables; authenticated crawl is OFF by default.
_CRAWL_MODE: str = ""          # resolved lazily from env in _restore_or_login
_AUTH_ANONYMOUS   = "anonymous"
_AUTH_AUTHED      = "authenticated"
_AUTH_BLOCKED     = "blocked"
_AUTH_CAPTCHA     = "captcha_required"
_AUTH_EXPIRED     = "session_expired"
_AUTH_DISABLED    = "disabled"

'''

# The new auth-related methods to insert into PinterestSession
# They replace the existing bare _login() that was previously patched in.
NEW_METHODS = '''\
    # ── Auth mode helpers ──────────────────────────────────────────────────

    async def _save_session(self, path: str) -> None:
        """Persist current session cookies to a JSON file (chmod 600)."""
        import time as _time
        cookies = dict(self._session.cookies)
        data = {
            "saved_at":  _time.time(),
            "cookies":   cookies,
            "csrf":      self._csrf or "",
            "app_version": self._app_version or "",
        }
        try:
            import stat
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2)
            try:
                import os as _os
                _os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
            except Exception:
                pass
            print(f"  [session] cookies saved ({len(cookies)} values) → {path}")
        except Exception as exc:
            print(f"  [session] save failed: {exc}")

    async def _load_session(self, path: str) -> bool:
        """
        Restore cookies from a saved session file.
        Returns True only if _auth cookie value is '1' and the file is ≤ 25 days old.
        """
        import os as _os, time as _time
        if not _os.path.exists(path):
            return False
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
            age_days = (_time.time() - data.get("saved_at", 0)) / 86400
            if age_days > 25:
                print(f"  [session] saved session expired ({age_days:.0f}d old) — deleting")
                try:
                    _os.remove(path)
                except Exception:
                    pass
                return False
            cookies = data.get("cookies", {})
            if cookies.get("_auth") != "1":
                print(f"  [session] saved session has _auth={cookies.get('_auth','?')} — anonymous only")
                return False
            for name, value in cookies.items():
                self._session.cookies.set(name, value, domain=".pinterest.com")
            self._csrf        = cookies.get("csrftoken", data.get("csrf", ""))
            self._app_version = data.get("app_version", self._app_version or "")
            self._auth_state  = _AUTH_AUTHED
            print(f"  [session] restored  _auth=1  (age {age_days:.1f}d)")
            return True
        except Exception as exc:
            print(f"  [session] load failed: {exc}")
            return False

    async def _restore_or_login(self) -> str:
        """
        Determine auth state based on PINTEREST_CRAWL_MODE env flag:
          disabled      → anonymous (no crawl attempted)
          anonymous     → anonymous (default, no login)
          authenticated → try load saved session, then optionally credentials

        PINTEREST_AUTH_CRAWL_ENABLED must also be 'true' to attempt login.
        Returns one of: disabled | anonymous | authenticated | blocked | captcha_required
        """
        import os as _os
        from dotenv import load_dotenv
        load_dotenv()

        mode    = _os.getenv("PINTEREST_CRAWL_MODE", "disabled").lower().strip()
        enabled = _os.getenv("PINTEREST_AUTH_CRAWL_ENABLED", "false").lower() == "true"
        session_path = _os.getenv(
            "PINTEREST_CRAWL_SESSION_FILE",
            _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), ".pinterest_session.json"),
        )

        if mode == "disabled":
            self._auth_state = _AUTH_DISABLED
            print(f"  [auth] mode=disabled  state={_AUTH_DISABLED}")
            return _AUTH_DISABLED

        if mode == "anonymous" or not enabled or mode != "authenticated":
            self._auth_state = _AUTH_ANONYMOUS
            print(f"  [auth] mode={mode}  auth_enabled={enabled}  state={_AUTH_ANONYMOUS}")
            return _AUTH_ANONYMOUS

        # mode == "authenticated" and enabled == True
        if await self._load_session(session_path):
            return _AUTH_AUTHED

        email    = _os.getenv("PINTEREST_EMAIL",    "").strip()
        password = _os.getenv("PINTEREST_PASSWORD", "").strip()
        if not email or not password:
            print("  [auth] no credentials configured  state=anonymous")
            self._auth_state = _AUTH_ANONYMOUS
            return _AUTH_ANONYMOUS

        return await self._login_with_credentials(email, password, session_path)

    async def _login_with_credentials(self, email: str, password: str, session_path: str) -> str:
        """
        Log in once via Pinterest UserLoginResource, save session cookies.
        ⚠ TEMPORARY SMOKE-TEST ONLY — use a DISPOSABLE test account.
        Not for production; does not retry aggressively; stops on captcha/403.
        """
        import time as _time, urllib.parse as up
        print(f"  [login] attempting  email={email[:3]}***  (test account, temporary)")

        try:
            r = await self._session.get(
                "https://www.pinterest.com/login/",
                headers={"Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                         "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"},
            )
        except Exception as exc:
            print(f"  [login] login page failed: {exc}")
            self._auth_state = _AUTH_ANONYMOUS
            return _AUTH_ANONYMOUS

        if r.status_code != 200:
            print(f"  [login] login page HTTP {r.status_code}  state={_AUTH_BLOCKED}")
            self._auth_state = _AUTH_BLOCKED
            return _AUTH_BLOCKED

        csrf = self._session.cookies.get("csrftoken", self._csrf or "")
        self._csrf = csrf
        # Humanised delay before POST
        await asyncio.sleep(random.uniform(2.0, 3.5))

        data_json = json.dumps(
            {"options": {"username_or_email": email, "password": password}, "context": {}},
            separators=(",", ":"),
        )
        params = {
            "source_url": "/login/",
            "data": data_json,
            "_": str(int(_time.time() * 1000)),
        }
        api_url = "https://www.pinterest.com/resource/UserLoginResource/create/?" + up.urlencode(params)
        try:
            resp = await self._session.post(api_url, headers={
                "X-CSRFToken":              csrf,
                "X-App-Version":            self._app_version or "",
                "X-Pinterest-Source-Url":   "/login/",
                "X-Pinterest-Pws-Handler":  "www/login.js",
                "Referer":                  "https://www.pinterest.com/login/",
                "Accept":                   "application/json, text/javascript, */*, q=0.01",
                "X-Requested-With":         "XMLHttpRequest",
                **self._b3_headers(),
            })
        except Exception as exc:
            print(f"  [login] POST failed: {exc}")
            self._auth_state = _AUTH_ANONYMOUS
            return _AUTH_ANONYMOUS

        # Detect captcha / checkpoint / hard block — stop, do not retry
        if resp.status_code == 403:
            print(f"  [login] HTTP 403  state={_AUTH_BLOCKED}")
            self._auth_state = _AUTH_BLOCKED
            return _AUTH_BLOCKED

        try:
            body = resp.json()
            msg = body.get("resource_response", {}).get("message", "")
            if any(kw in msg.lower() for kw in ("captcha", "challenge", "verify", "suspicious", "checkpoint")):
                print(f"  [login] captcha/checkpoint: {msg[:80]}  state={_AUTH_CAPTCHA}")
                self._auth_state = _AUTH_CAPTCHA
                return _AUTH_CAPTCHA
        except Exception:
            pass

        auth_val = self._session.cookies.get("_auth", "0")
        if auth_val == "1":
            self._csrf = self._session.cookies.get("csrftoken", csrf)
            print(f"  [login] success  _auth=1  saving session")
            await self._save_session(session_path)
            self._auth_state = _AUTH_AUTHED
            return _AUTH_AUTHED

        print(f"  [login] failed  _auth={auth_val}  HTTP {resp.status_code}")
        self._auth_state = _AUTH_ANONYMOUS
        return _AUTH_ANONYMOUS

'''

def ssh_run(client, cmd, timeout=60):
    try:
        stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        return out, err
    except Exception as e:
        return "", str(e)

def run_all():
    import paramiko
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect("47.89.181.103", port=22, username="root",
                   password="26mXvu2iEMwb!ab", timeout=20)

    sftp = client.open_sftp()
    with sftp.open("/opt/vibepin/backend/scraper_v2.py", "r") as fh:
        code = fh.read().decode("utf-8")
    print(f"Read {len(code)} chars")

    # ── 1. Add module-level constants after the last top-level import block ──
    # Insert after the first `from __future__` / import block, just before first class/def
    # Safe anchor: after the BASE_HEADERS block or after `load_dotenv()`
    const_anchor = "# ── Crawl-mode & auth-safety constants"
    if const_anchor in code:
        print("Constants already present — skipping")
    else:
        # Insert before the first class definition
        class_pos = code.find("\nclass PinterestSession")
        if class_pos < 0:
            class_pos = code.find("\nclass ")
        if class_pos < 0:
            print("ERROR: cannot find class anchor for constants")
        else:
            code = code[:class_pos] + "\n" + NEW_CONSTANTS + code[class_pos:]
            print(f"Constants inserted at pos {class_pos}")

    # ── 2. Remove old bare _login method ─────────────────────────────────────
    # It starts with: `    async def _login(self) -> bool:`
    # and ends before `    async def _bootstrap`
    old_login_start = "    async def _login(self) -> bool:\n"
    old_login_end   = "    async def _bootstrap(self) -> None:"
    if old_login_start in code:
        s = code.find(old_login_start)
        e = code.find(old_login_end, s)
        if e < 0:
            print("ERROR: could not find end of old _login")
        else:
            code = code[:s] + code[e:]
            print(f"Removed old _login() (was at {s}-{e})")
    else:
        print("Old _login not found — may have already been replaced")

    # ── 3. Insert new auth methods before _bootstrap ─────────────────────────
    anchor = "    async def _bootstrap(self) -> None:"
    if "async def _restore_or_login" in code:
        print("New auth methods already present — skipping insert")
    else:
        pos = code.find(anchor)
        if pos < 0:
            print("ERROR: _bootstrap anchor not found")
        else:
            code = code[:pos] + NEW_METHODS + code[pos:]
            print(f"New auth methods inserted at pos {pos}")

    # ── 4. Update the _bootstrap call from _login to _restore_or_login ───────
    old_call = "        # Attempt login if credentials available (required after mid-2025 Pinterest soft-block)\n        await self._login()\n"
    new_call = "        # Restore saved session or optionally log in (guarded by PINTEREST_CRAWL_MODE + PINTEREST_AUTH_CRAWL_ENABLED)\n        await self._restore_or_login()\n"
    if old_call in code:
        code = code.replace(old_call, new_call, 1)
        print("Updated _bootstrap to call _restore_or_login()")
    elif "await self._restore_or_login()" in code:
        print("_restore_or_login() call already present")
    elif "await self._login()" in code:
        code = code.replace("        await self._login()\n", new_call, 1)
        print("Updated bare _login() call to _restore_or_login()")
    else:
        print("WARNING: could not find login call in _bootstrap")

    # ── 5. Add _auth_state = _AUTH_ANONYMOUS initializer to __init__ ─────────
    init_anchor = "    def __init__(self, proxy: Optional[str] = None, delay: float = 1.2):"
    if "_auth_state" not in code:
        # Find the __init__ body and add after the last self._ assignment
        idx = code.find(init_anchor)
        if idx >= 0:
            # Find the end of __init__ (next def at same indentation)
            end_init = code.find("\n    def ", idx + 1)
            if end_init < 0:
                end_init = code.find("\n    async def ", idx + 1)
            # Insert before the end_init
            insert_line = "        self._auth_state:    str  = _AUTH_ANONYMOUS  # set by _restore_or_login\n"
            # find last self._ line in __init__
            block = code[idx:end_init]
            last_self = block.rfind("        self._")
            if last_self >= 0:
                insert_pos = idx + last_self + len(block[last_self:block.find("\n", last_self) + 1])
                code = code[:insert_pos] + insert_line + code[insert_pos:]
                print("Added _auth_state to __init__")
            else:
                print("WARNING: could not find __init__ body to add _auth_state")
        else:
            print("WARNING: __init__ not found")
    else:
        print("_auth_state already in __init__")

    # ── 6. Add safety check at top of search_pins ────────────────────────────
    search_anchor = "    async def search_pins(\n        self,\n        query: str,\n        max_pins: int = 100,"
    safety_block  = '        # Safety: refuse if this session is known-blocked or captcha-locked\n        if self._auth_state in (_AUTH_BLOCKED, _AUTH_CAPTCHA):\n            print(f"  [search] skipped — auth_state={self._auth_state}")\n            return []\n\n'
    if "_AUTH_BLOCKED, _AUTH_CAPTCHA" in code:
        print("Safety check already in search_pins")
    else:
        sp = code.find(search_anchor)
        if sp >= 0:
            # Find the start of the method body (after the docstring or first line)
            body_start = code.find('        """', sp)
            if body_start >= 0:
                # after closing """
                body_start = code.find('"""', body_start + 3) + 3
                next_line = code.find("\n", body_start) + 1
            else:
                next_line = code.find("\n", sp) + 1
                # skip past parameters to body
                while code[next_line:next_line+8] == "        " and code[next_line+8] != " ":
                    next_line = code.find("\n", next_line) + 1
            code = code[:next_line] + safety_block + code[next_line:]
            print(f"Safety check added to search_pins")
        else:
            print("WARNING: search_pins anchor not found")

    # ── 7. Write back ─────────────────────────────────────────────────────────
    with sftp.open("/opt/vibepin/backend/scraper_v2.py", "w") as fh:
        fh.write(code.encode("utf-8"))
    print(f"Wrote {len(code)} chars back")
    sftp.close()

    # ── 8. Syntax check ──────────────────────────────────────────────────────
    out, err = ssh_run(client, "cd /opt/vibepin/backend && .venv/bin/python3 -c 'import scraper_v2; print(\"syntax OK\")' 2>&1")
    print("Syntax check:", out.strip(), err[:200] if err else "")

    # ── 9. Verify key symbols ─────────────────────────────────────────────────
    out, _ = ssh_run(client, "grep -n '_AUTH_DISABLED\\|_restore_or_login\\|_login_with_credentials\\|_save_session\\|_load_session\\|_AUTH_BLOCKED\\|PINTEREST_CRAWL_MODE\\|_auth_state.*=.*_AUTH' /opt/vibepin/backend/scraper_v2.py | head -25")
    print("Key symbols:\n", out)

    client.close()
    print("done.")

if __name__ == "__main__":
    run_all()
