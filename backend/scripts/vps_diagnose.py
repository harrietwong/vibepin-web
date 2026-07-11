#!/usr/bin/env python3
"""Run diagnostic commands on the VPS via SSH and print results."""
from __future__ import annotations
import sys
import time

def run(host, port, user, password, commands: list[str], timeout=60):
    try:
        import paramiko
    except ImportError:
        print("pip install paramiko")
        return

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(host, port=port, username=user, password=password, timeout=20)
    except Exception as e:
        print(f"SSH connect failed: {e}")
        return

    for cmd in commands:
        print(f"\n{'='*70}")
        print(f"CMD: {cmd}")
        print('='*70)
        try:
            stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
            out = stdout.read().decode("utf-8", errors="replace")
            err = stderr.read().decode("utf-8", errors="replace")
            if out.strip():
                print(out)
            if err.strip():
                print("[STDERR]", err[:2000])
        except Exception as e:
            print(f"Command error: {e}")

    client.close()


COMMANDS = [
    # 1. Cron log tail
    "tail -n 300 /opt/vibepin/backend/logs/cron_daily.log 2>/dev/null || echo 'NO LOG FILE'",

    # 2. Check scraper_v2 upsert logic
    "grep -n 'ON CONFLICT\\|upsert\\|scraped_at\\|conflict\\|skip\\|insert\\|update' /opt/vibepin/backend/scraper_v2.py 2>/dev/null | head -60",

    # 3. Check upsert_pin_samples.py
    "cat /opt/vibepin/backend/db/upsert_pin_samples.py 2>/dev/null || echo 'NOT FOUND'",

    # 4. pipeline_runs recent 30
    """cd /opt/vibepin/backend && .venv/bin/python -c "
import os, sys, json
sys.path.insert(0, '.')
sys.path.insert(0, 'db')
from db import select_many
rows = select_many('pipeline_runs', order='started_at.desc', limit=30)
for r in rows:
    print(f\"{r.get('job_type','?'):12} {r.get('status','?'):10} {str(r.get('started_at',''))[:16]} -> {str(r.get('finished_at',''))[:16]}  rows={r.get('rows_processed',0)}  kw={r.get('keywords_processed',0)}\")
" 2>&1""",

    # 5. pin_samples freshness
    """cd /opt/vibepin/backend && .venv/bin/python -c "
import os, sys
sys.path.insert(0, '.')
sys.path.insert(0, 'db')
from db import select_many
# max scraped_at
rows = select_many('pin_samples', order='scraped_at.desc', limit=1)
print('max scraped_at:', rows[0].get('scraped_at') if rows else 'NONE')
# count
from db import _get_http
http = _get_http()
resp = http.head('pin_samples', params={'select':'id', 'limit':'0'}, headers={'Prefer':'count=exact'})
cr = resp.headers.get('Content-Range','')
print('total rows:', cr.split('/')[-1] if '/' in cr else '?')
" 2>&1""",

    # 6. crawl_queue recent
    """cd /opt/vibepin/backend && .venv/bin/python -c "
import os, sys
sys.path.insert(0, '.')
sys.path.insert(0, 'db')
from db import select_many, _get_http
# recent completed
rows = select_many('crawl_queue', filters={'status':'completed'}, order='updated_at.desc', limit=20)
for r in rows:
    print(f\"  {r.get('keyword','?')[:40]:40} pins={r.get('pins_found',r.get('pin_count',0))} updated={str(r.get('updated_at',''))[:16]}\")
# counts
http = _get_http()
for s in ['pending','completed','failed','done']:
    resp = http.head('crawl_queue', params={'select':'id','limit':'0','status':f'eq.{s}'}, headers={'Prefer':'count=exact'})
    cr = resp.headers.get('Content-Range','')
    n = cr.split('/')[-1] if '/' in cr else '?'
    print(f'{s}: {n}')
" 2>&1""",

    # 7. trend_keywords recent additions
    """cd /opt/vibepin/backend && .venv/bin/python -c "
import os, sys
sys.path.insert(0, '.')
sys.path.insert(0, 'db')
from db import select_many
rows = select_many('trend_keywords', order='created_at.desc', limit=10)
for r in rows:
    print(f\"  kw={r.get('keyword','?')[:40]:40}  cat={r.get('category','?')}  created={str(r.get('created_at',''))[:16]}\")
" 2>&1""",

    # 8. Check run_worker / crawl invocation
    "cat /opt/vibepin/backend/run_worker.py 2>/dev/null | head -60 || echo 'run_worker.py NOT FOUND'",

    # 9. Check scraper_v2 pin insertion/upsert section
    "grep -n 'def.*upsert\\|def.*insert\\|def.*save\\|pin_samples\\|on_conflict\\|returning' /opt/vibepin/backend/scraper_v2.py 2>/dev/null | head -40",
]

if __name__ == "__main__":
    run("47.89.181.103", 22, "root", "26mXvu2iEMwb!ab", COMMANDS, timeout=90)
