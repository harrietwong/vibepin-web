#!/usr/bin/env python3
"""Force-release orphaned crawl lock and trigger a real crawl."""
from __future__ import annotations
import time

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

    cmds = [
        # Verify process is dead
        ("verify crawl process is dead", r"""ps aux | grep -E 'run_worker|crawl' | grep -v grep"""),

        # Force-delete pipeline_locks row
        ("DELETE pipeline_locks crawl", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import _get_http
http = _get_http()
resp = http.delete('pipeline_locks', params={'lock_name': 'eq.crawl'})
print('delete status:', resp.status_code, resp.text[:100])
" 2>&1"""),

        # Mark the running pipeline_runs as failed
        ("mark pipeline_runs failed (orphaned run)", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import _get_http
from datetime import datetime, timezone
http = _get_http()
now = datetime.now(timezone.utc).isoformat()
resp = http.patch('pipeline_runs',
    json={'status': 'failed', 'finished_at': now, 'error_message': 'process exited without releasing lock'},
    params={'id': 'eq.df118e01-f79c-46a2-beb0-ffe43a7f7c13'},
    headers={'Prefer': 'return=minimal'})
print('patch status:', resp.status_code)
" 2>&1"""),

        # Verify lock is gone
        ("verify pipeline_locks empty", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import _get_http
http = _get_http()
resp = http.get('pipeline_locks', params={'limit': '10'})
rows = resp.json()
print('locks remaining:', len(rows), rows)
" 2>&1"""),

        # Confirm queue still has pending items
        ("crawl_queue pending count before crawl", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import _get_http
http = _get_http()
for s in ['pending', 'completed', 'failed']:
    r = http.head('crawl_queue', params={'select':'id','limit':'0','status':'eq.'+s}, headers={'Prefer':'count=exact'})
    print(s+':', r.headers.get('Content-Range','?').split('/')[-1])
" 2>&1"""),

        # Run fresh crawl blocking (10 keywords, capture output)
        ("CRAWL: run_worker 10 keywords (blocking, 3 min timeout)", r"""cd /opt/vibepin/backend && timeout 180 .venv/bin/python3 run_worker.py --job crawl --limit-keywords 10 --region US 2>&1 | grep -v '^\s*$' | tail -100"""),
    ]

    for label, cmd in cmds:
        print(f"\n{'='*70}\n### {label}\n{'='*70}", flush=True)
        out, err = ssh_run(client, cmd, timeout=220)
        if out.strip():
            print(out[:6000], flush=True)
        if err.strip():
            print("[STDERR]", err[:400], flush=True)

    # Verify after crawl
    print("\n... verifying pin_samples after crawl ...", flush=True)

    verify_cmds = [
        ("pin_samples top 10 by scraped_at", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import select_many, _get_http
rows = select_many('pin_samples', order='scraped_at.desc', limit=10)
for r in rows:
    print(str(r.get('scraped_at',''))[:19], str(r.get('source_keyword','?'))[:30].ljust(31), 'saves='+str(r.get('save_count',0)))
http = _get_http()
resp = http.head('pin_samples', params={'select':'id','limit':'0'}, headers={'Prefer':'count=exact'})
print('TOTAL rows:', resp.headers.get('Content-Range','?').split('/')[-1])
" 2>&1"""),

        ("pipeline_runs latest 5", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import select_many
rows = select_many('pipeline_runs', order='started_at.desc', limit=5)
for r in rows:
    print(str(r.get('job_type'))[:10].ljust(11), str(r.get('status'))[:10].ljust(11),
          str(r.get('started_at',''))[:16], '->', str(r.get('finished_at',''))[:16],
          ' rows='+str(r.get('rows_processed',0)), ' kw='+str(r.get('keywords_processed',0)))
" 2>&1"""),

        ("crawl_queue status after crawl", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import _get_http
http = _get_http()
for s in ['pending', 'completed', 'failed']:
    r = http.head('crawl_queue', params={'select':'id','limit':'0','status':'eq.'+s}, headers={'Prefer':'count=exact'})
    print(s+':', r.headers.get('Content-Range','?').split('/')[-1])
" 2>&1"""),
    ]

    for label, cmd in verify_cmds:
        print(f"\n{'='*70}\n### {label}\n{'='*70}", flush=True)
        out, err = ssh_run(client, cmd, timeout=60)
        if out.strip():
            print(out[:6000], flush=True)
        if err.strip():
            print("[STDERR]", err[:400], flush=True)

    client.close()
    print("\ndone.", flush=True)

if __name__ == "__main__":
    run_all()
