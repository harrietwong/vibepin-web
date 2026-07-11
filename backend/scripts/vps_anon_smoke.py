#!/usr/bin/env python3
"""
Step 1: Confirm env flags, temporarily set mode=anonymous, run smoke crawl, restore to disabled.
Captures verbose output without touching .env permanently.
No login, no credentials, no session cookies loaded.
"""
from __future__ import annotations

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

    # ── 1. Confirm current env flags ─────────────────────────────────────────
    out, _ = ssh_run(client,
        "grep -E 'PINTEREST_CRAWL_MODE|PINTEREST_AUTH_CRAWL_ENABLED|PINTEREST_EMAIL|PINTEREST_PASSWORD' "
        "/opt/vibepin/backend/.env")
    print("### CURRENT .env flags:\n" + out)

    # ── 2. Run the anonymous smoke crawl via env override (no .env edit) ─────
    # Pass env vars inline so .env is never changed
    print("\n### ANONYMOUS SMOKE CRAWL (3 keywords, concurrency=1):")
    crawl_cmd = (
        "cd /opt/vibepin/backend && "
        "PINTEREST_CRAWL_MODE=anonymous "
        "PINTEREST_AUTH_CRAWL_ENABLED=false "
        "timeout 240 .venv/bin/python3 run_worker.py "
        "--job crawl --limit-keywords 3 --concurrency 1 --region US "
        "2>&1 | grep -v '^$' | tail -120"
    )
    out, err = ssh_run(client, crawl_cmd, timeout=270)
    print(out[:8000])
    if err.strip():
        print("[STDERR]", err[:400])

    # ── 3. Pin_samples check after crawl ────────────────────────────────────
    check_cmd = r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import select_many, _get_http
rows = select_many('pin_samples', order='scraped_at.desc', limit=5)
for r in rows:
    print(str(r.get('scraped_at',''))[:19],
          str(r.get('source_keyword','?'))[:30].ljust(31),
          'saves='+str(r.get('save_count',0)))
http = _get_http()
resp = http.head('pin_samples', params={'select':'id','limit':'0'}, headers={'Prefer':'count=exact'})
print('TOTAL rows:', resp.headers.get('Content-Range','?').split('/')[-1])
" 2>&1"""
    print("\n### pin_samples after crawl:")
    out, _ = ssh_run(client, check_cmd, timeout=30)
    print(out[:2000])

    client.close()

if __name__ == "__main__":
    run_all()
