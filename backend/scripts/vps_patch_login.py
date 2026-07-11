#!/usr/bin/env python3
"""
Patch scraper_v2.py to add Pinterest login support.
After bootstrap, if PINTEREST_EMAIL and PINTEREST_PASSWORD are in .env,
log in via UserLoginResource to get _auth=1 cookies.
"""
from __future__ import annotations
import re

LOGIN_CODE = '''
    async def _login(self) -> bool:
        """
        Authenticate via Pinterest UserLoginResource API.
        Requires PINTEREST_EMAIL and PINTEREST_PASSWORD in .env.
        Sets _auth=1 cookies so BaseSearchResource returns real results.
        """
        import os, re, json, time, urllib.parse as up
        from dotenv import load_dotenv
        load_dotenv()
        email    = os.getenv("PINTEREST_EMAIL", "").strip()
        password = os.getenv("PINTEREST_PASSWORD", "").strip()
        if not email or not password:
            return False

        # Step 1: visit login page to get CSRF + app-version
        try:
            r = await self._session.get(
                "https://www.pinterest.com/login/",
                headers={"Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                         "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"},
            )
        except Exception as e:
            print(f"  [login] login page GET failed: {e}")
            return False

        csrf = self._session.cookies.get("csrftoken", self._csrf or "")
        m = re.search(r'<script[^>]+id=["\']__PWS_DATA__["\'][^>]*>(.*?)</script>', r.text, re.DOTALL)
        app_version = self._app_version or ""
        if m:
            try:
                pws = json.loads(m.group(1))
                app_version = pws.get("appVersion", "") or app_version
            except Exception:
                pass
        self._csrf = csrf or self._csrf
        self._app_version = app_version or self._app_version

        # Step 2: POST to UserLoginResource
        await asyncio.sleep(0.8)
        data_json = json.dumps({
            "options": {
                "username_or_email": email,
                "password": password,
            },
            "context": {},
        }, separators=(",", ":"))
        params = {
            "source_url": "/login/",
            "data": data_json,
            "_": str(int(time.time() * 1000)),
        }
        api_url = ("https://www.pinterest.com/resource/UserLoginResource/create/?"
                   + up.urlencode(params))
        try:
            resp = await self._session.post(api_url, headers={
                "X-CSRFToken": csrf,
                "X-App-Version": app_version,
                "X-Pinterest-Source-Url": "/login/",
                "X-Pinterest-Pws-Handler": "www/login.js",
                "Referer": "https://www.pinterest.com/login/",
                "Accept": "application/json, text/javascript, */*, q=0.01",
                "X-Requested-With": "XMLHttpRequest",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                **self._b3_headers(),
            })
        except Exception as e:
            print(f"  [login] POST failed: {e}")
            return False

        auth_cookie = self._session.cookies.get("_auth", "0")
        if auth_cookie == "1":
            # Refresh CSRF after login
            new_csrf = self._session.cookies.get("csrftoken", csrf)
            self._csrf = new_csrf
            print(f"  [login] authenticated  _auth=1  csrf=ok")
            return True

        # Check response body for error
        try:
            body = resp.json()
            msg = body.get("resource_response", {}).get("message", "")
            print(f"  [login] failed  _auth={auth_cookie}  status={resp.status_code}  msg={msg[:80]}")
        except Exception:
            print(f"  [login] failed  _auth={auth_cookie}  status={resp.status_code}")
        return False

'''

def ssh_run(client, cmd, timeout=240):
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

    # 1. Read current scraper around _bootstrap and __aenter__
    out, err = ssh_run(client, "sed -n '390,425p' /opt/vibepin/backend/scraper_v2.py")
    print("### current __aenter__ area:\n", out)

    # 2. Backup the file
    out, err = ssh_run(client, "cp /opt/vibepin/backend/scraper_v2.py /opt/vibepin/backend/scraper_v2.py.bak")
    print("### backup:", out or "ok", err[:100] if err else "")

    # 3. Write the _login method just before _bootstrap using Python sed
    patch_cmd = r"""cd /opt/vibepin/backend && python3 << 'PYEOF'
import re

with open('scraper_v2.py', 'r', encoding='utf-8') as f:
    code = f.read()

# Find where _bootstrap starts
anchor = '    async def _bootstrap(self) -> None:'
pos = code.find(anchor)
if pos < 0:
    print("ERROR: could not find _bootstrap anchor")
    exit(1)

# Check if _login already exists
if '_login' in code:
    print("_login already present - skipping")
    exit(0)

login_method = '''
    async def _login(self) -> bool:
        """
        Authenticate via Pinterest UserLoginResource.
        Requires PINTEREST_EMAIL and PINTEREST_PASSWORD in .env.
        Without this, BaseSearchResource returns 0 results (anonymous soft-block).
        """
        import os, time, urllib.parse as up
        from dotenv import load_dotenv
        load_dotenv()
        email    = os.getenv("PINTEREST_EMAIL", "").strip()
        password = os.getenv("PINTEREST_PASSWORD", "").strip()
        if not email or not password:
            return False

        # Re-visit login page to get proper CSRF for login form
        try:
            r = await self._session.get(
                "https://www.pinterest.com/login/",
                headers={"Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                         "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"},
            )
        except Exception as e:
            print(f"  [login] login page failed: {e}")
            return False

        csrf = self._session.cookies.get("csrftoken", self._csrf or "")
        app_v = self._app_version or ""
        self._csrf = csrf
        await asyncio.sleep(0.8)

        data_json = json.dumps({
            "options": {"username_or_email": email, "password": password},
            "context": {},
        }, separators=(",", ":"))
        params = {
            "source_url": "/login/",
            "data": data_json,
            "_": str(int(time.time() * 1000)),
        }
        api_url = ("https://www.pinterest.com/resource/UserLoginResource/create/?"
                   + up.urlencode(params))
        try:
            await self._session.post(api_url, headers={
                "X-CSRFToken": csrf,
                "X-App-Version": app_v,
                "X-Pinterest-Source-Url": "/login/",
                "X-Pinterest-Pws-Handler": "www/login.js",
                "Referer": "https://www.pinterest.com/login/",
                "Accept": "application/json, text/javascript, */*, q=0.01",
                "X-Requested-With": "XMLHttpRequest",
                **self._b3_headers(),
            })
        except Exception as e:
            print(f"  [login] POST failed: {e}")
            return False

        auth_val = self._session.cookies.get("_auth", "0")
        if auth_val == "1":
            self._csrf = self._session.cookies.get("csrftoken", csrf)
            print("  [login] authenticated  _auth=1")
            return True
        print(f"  [login] failed  _auth={auth_val}")
        return False

'''

new_code = code[:pos] + login_method + code[pos:]
with open('scraper_v2.py', 'w', encoding='utf-8') as f:
    f.write(new_code)
print("_login method inserted before _bootstrap")
PYEOF
"""
    out, err = ssh_run(client, patch_cmd, timeout=30)
    print("### patch result:", out.strip(), err[:200] if err else "")

    # 4. Patch _bootstrap to call _login after visiting homepage
    patch2_cmd = r"""cd /opt/vibepin/backend && python3 << 'PYEOF'
with open('scraper_v2.py', 'r', encoding='utf-8') as f:
    code = f.read()

# After bootstrap prints the status line, add login call
old_tail = '''        print(f"[session] bootstrap  status={r.status_code}  "
              f"csrf={'ok' if self._csrf else 'missing'}  "
              f"app_version={app_version or 'n/a'}")
        await asyncio.sleep(random.uniform(0.8, 1.5))'''

new_tail = '''        print(f"[session] bootstrap  status={r.status_code}  "
              f"csrf={'ok' if self._csrf else 'missing'}  "
              f"app_version={app_version or 'n/a'}")
        await asyncio.sleep(random.uniform(0.8, 1.5))
        # Attempt login if credentials in .env (required for search API after mid-2025 soft-block)
        await self._login()'''

if old_tail in code:
    code = code.replace(old_tail, new_tail, 1)
    with open('scraper_v2.py', 'w', encoding='utf-8') as f:
        f.write(code)
    print("_login() call added to _bootstrap")
else:
    print("could not find bootstrap tail anchor - check manually")
PYEOF
"""
    out, err = ssh_run(client, patch2_cmd, timeout=30)
    print("### patch2 result:", out.strip(), err[:200] if err else "")

    # 5. Add PINTEREST_EMAIL and PINTEREST_PASSWORD to .env
    env_patch = r"""cd /opt/vibepin/backend && grep -q 'PINTEREST_EMAIL' .env || cat >> .env << 'EOF'

# Pinterest scraper login (required for search API since mid-2025)
PINTEREST_EMAIL=
PINTEREST_PASSWORD=
EOF
echo "env updated"
"""
    out, err = ssh_run(client, env_patch, timeout=15)
    print("### env update:", out.strip())

    # 6. Verify the patch
    out, err = ssh_run(client, "grep -n '_login\|await self._login\|PINTEREST_EMAIL\|PINTEREST_PASSWORD' /opt/vibepin/backend/scraper_v2.py | head -20")
    print("### patch verification:", out)

    # 7. Show the added .env lines
    out, err = ssh_run(client, "tail -5 /opt/vibepin/backend/.env")
    print("### .env tail:", out)

    client.close()

if __name__ == "__main__":
    run_all()
