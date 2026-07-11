#!/usr/bin/env python3
"""Patch scraper_v2.py with Pinterest login support, via SSH file upload."""
from __future__ import annotations
import io

LOGIN_METHOD = '''\n    async def _login(self) -> bool:\n        """\n        Authenticate via Pinterest UserLoginResource.\n        Requires PINTEREST_EMAIL and PINTEREST_PASSWORD in .env.\n        Without this, BaseSearchResource returns 0 results (anonymous soft-block).\n        """\n        import os, time, urllib.parse as up\n        from dotenv import load_dotenv\n        load_dotenv()\n        email    = os.getenv("PINTEREST_EMAIL", "").strip()\n        password = os.getenv("PINTEREST_PASSWORD", "").strip()\n        if not email or not password:\n            return False\n        try:\n            r = await self._session.get(\n                "https://www.pinterest.com/login/",\n                headers={"Accept": "text/html,application/xhtml+xml,*/*;q=0.8",\n                         "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"},\n            )\n        except Exception as e:\n            print(f"  [login] login page failed: {e}")\n            return False\n        csrf = self._session.cookies.get("csrftoken", self._csrf or "")\n        self._csrf = csrf\n        await asyncio.sleep(0.8)\n        data_json = json.dumps({\n            "options": {"username_or_email": email, "password": password},\n            "context": {},\n        }, separators=(",", ":"))\n        params = {\n            "source_url": "/login/",\n            "data": data_json,\n            "_": str(int(time.time() * 1000)),\n        }\n        api_url = ("https://www.pinterest.com/resource/UserLoginResource/create/?"\n                   + up.urlencode(params))\n        try:\n            await self._session.post(api_url, headers={\n                "X-CSRFToken": csrf,\n                "X-App-Version": self._app_version or "",\n                "X-Pinterest-Source-Url": "/login/",\n                "X-Pinterest-Pws-Handler": "www/login.js",\n                "Referer": "https://www.pinterest.com/login/",\n                "Accept": "application/json, text/javascript, */*, q=0.01",\n                "X-Requested-With": "XMLHttpRequest",\n                **self._b3_headers(),\n            })\n        except Exception as e:\n            print(f"  [login] POST failed: {e}")\n            return False\n        auth_val = self._session.cookies.get("_auth", "0")\n        if auth_val == "1":\n            self._csrf = self._session.cookies.get("csrftoken", csrf)\n            print("  [login] authenticated  _auth=1")\n            return True\n        print(f"  [login] failed  _auth={auth_val}")\n        return False\n\n'''

BOOTSTRAP_CALL = '        # Attempt login if credentials available (required after mid-2025 Pinterest soft-block)\n        await self._login()\n'

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

    # Read the full scraper_v2.py
    print("Reading scraper_v2.py via SFTP...")
    sftp = client.open_sftp()
    with sftp.open("/opt/vibepin/backend/scraper_v2.py", "r") as f:
        code = f.read().decode("utf-8")
    print(f"  read {len(code)} chars")

    # Backup
    with sftp.open("/opt/vibepin/backend/scraper_v2.py.bak", "w") as f:
        f.write(code.encode("utf-8"))
    print("  backup created")

    # Check if _login already exists
    if "async def _login" in code:
        print("  _login already present — skipping insert")
    else:
        # Find anchor: _bootstrap definition
        anchor = "    async def _bootstrap(self) -> None:"
        pos = code.find(anchor)
        if pos < 0:
            print("ERROR: _bootstrap anchor not found!")
            sftp.close()
            client.close()
            return
        # Insert login method before _bootstrap
        code = code[:pos] + LOGIN_METHOD + code[pos:]
        print(f"  _login method inserted at pos {pos}")

    # Check if login call already in _bootstrap
    if "await self._login()" in code:
        print("  _login() call already in bootstrap — skipping")
    else:
        # Find the end of _bootstrap where we want to add the call
        # After: await asyncio.sleep(random.uniform(0.8, 1.5))
        # which is the last line of _bootstrap
        bootstrap_end = '        await asyncio.sleep(random.uniform(0.8, 1.5))\n'
        idx = code.find(bootstrap_end)
        if idx < 0:
            print("ERROR: bootstrap end anchor not found!")
        else:
            insert_pos = idx + len(bootstrap_end)
            code = code[:insert_pos] + BOOTSTRAP_CALL + code[insert_pos:]
            print("  _login() call added to _bootstrap")

    # Write patched file back
    with sftp.open("/opt/vibepin/backend/scraper_v2.py", "w") as f:
        f.write(code.encode("utf-8"))
    print(f"  wrote {len(code)} chars back")

    # Add PINTEREST_EMAIL/PASSWORD to .env if not present
    with sftp.open("/opt/vibepin/backend/.env", "r") as f:
        env_content = f.read().decode("utf-8")

    if "PINTEREST_EMAIL" not in env_content:
        new_env = env_content.rstrip() + "\n\n# Pinterest scraper login (required for search API since mid-2025)\nPINTEREST_EMAIL=\nPINTEREST_PASSWORD=\n"
        with sftp.open("/opt/vibepin/backend/.env", "w") as f:
            f.write(new_env.encode("utf-8"))
        print("  PINTEREST_EMAIL/PASSWORD added to .env")
    else:
        print("  PINTEREST_EMAIL already in .env")

    sftp.close()

    # Verify patch
    out, _ = ssh_run(client, "grep -n '_login\\|PINTEREST_EMAIL\\|PINTEREST_PASSWORD' /opt/vibepin/backend/scraper_v2.py | head -15")
    print("\n### verification (scraper):", out)
    out, _ = ssh_run(client, "tail -5 /opt/vibepin/backend/.env")
    print("\n### .env tail:", out)

    # Quick syntax check
    out, err = ssh_run(client, "cd /opt/vibepin/backend && .venv/bin/python3 -c 'import scraper_v2; print(\"syntax OK\")' 2>&1 | tail -5")
    print("\n### syntax check:", out, err[:200] if err else "")

    client.close()
    print("\ndone.")

if __name__ == "__main__":
    run_all()
