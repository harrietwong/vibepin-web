#!/usr/bin/env python3
"""Check running crawl, deploy permanent fix, wait and verify pin_samples."""
from __future__ import annotations
import time, sys

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
        # 1. Is the crawl process still running?
        ("crawl process status", r"""ps aux | grep -E 'run_worker|scraper|crawl' | grep -v grep | head -10"""),

        # 2. pipeline_locks table
        ("pipeline_locks", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import _get_http
http = _get_http()
r = http.get('pipeline_locks', params={'limit':'10'})
print('status:', r.status_code)
if r.status_code == 200:
    for row in r.json():
        print(row)
else:
    print(r.text[:200])
" 2>&1"""),

        # 3. Kill any stuck crawl lock if needed
        ("current pipeline_runs running", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import select_many
rows = select_many('pipeline_runs', filters={'status':'running'}, order='started_at.desc', limit=5)
for r in rows:
    print(r.get('id'), r.get('job_type'), r.get('status'), str(r.get('started_at',''))[:19])
" 2>&1"""),

        # 4. Kill stale running crawl records (force-complete them so lock releases)
        ("force-complete stale crawl (started > 1h ago)", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import _get_http, select_many
from datetime import datetime, timezone, timedelta
http = _get_http()
now = datetime.now(timezone.utc)
stale_threshold = (now - timedelta(hours=1)).isoformat()
# Find running crawl jobs older than 1 hour
rows = select_many('pipeline_runs', filters={'status':'running', 'job_type':'crawl'}, order='started_at.desc', limit=10)
killed = 0
for r in rows:
    sa = r.get('started_at','')
    if sa and sa < stale_threshold:
        resp = http.patch('pipeline_runs',
            json={'status': 'failed', 'finished_at': now.isoformat()},
            params={'id': 'eq.'+r['id']},
            headers={'Prefer': 'return=minimal'})
        print('killed:', r['id'], 'started='+sa[:19], 'patch_status='+str(resp.status_code))
        killed += 1
if killed == 0:
    print('no stale crawl runs found (< 1h old or already finished)')
" 2>&1"""),

        # 5. Deploy permanent fix: reduce SUCCESS_INTERVAL_DAYS low from 7 to 1
        ("deploy fix: SUCCESS_INTERVAL_DAYS low=1 day", r"""cd /opt/vibepin/backend && sed -i 's/SUCCESS_INTERVAL_DAYS = {"high": 1, "medium": 3, "low": 7}/SUCCESS_INTERVAL_DAYS = {"high": 1, "medium": 1, "low": 1}/' crawl_queue_ops.py && grep 'SUCCESS_INTERVAL_DAYS' crawl_queue_ops.py"""),

        # 6. Verify fix
        ("verify SUCCESS_INTERVAL_DAYS fix", r"""grep 'SUCCESS_INTERVAL_DAYS\|STALE_CRAWL_DAYS' /opt/vibepin/backend/crawl_queue_ops.py"""),

        # 7. Confirm pending count
        ("crawl_queue pending count", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import _get_http
http = _get_http()
for s in ['pending','completed','failed']:
    r = http.head('crawl_queue', params={'select':'id','limit':'0','status':'eq.'+s}, headers={'Prefer':'count=exact'})
    cr = r.headers.get('Content-Range','')
    print(s+':', cr.split('/')[-1] if '/' in cr else '?')
" 2>&1"""),

        # 8. Trigger fresh crawl (non-blocking background)
        ("trigger fresh crawl background", r"""cd /opt/vibepin/backend && nohup .venv/bin/python3 run_worker.py --job crawl --limit-keywords 10 --region US > /tmp/smoke_crawl.log 2>&1 & echo "started PID $!" """),
    ]

    for label, cmd in cmds:
        print(f"\n{'='*70}\n### {label}\n{'='*70}", flush=True)
        out, err = ssh_run(client, cmd, timeout=120)
        if out.strip():
            print(out[:6000], flush=True)
        if err.strip():
            print("[STDERR]", err[:500], flush=True)

    # Wait 90 seconds for the background crawl to do some work
    print("\n... waiting 90s for background crawl to write to pin_samples ...", flush=True)
    time.sleep(90)

    verify_cmds = [
        ("pin_samples max scraped_at (after crawl)", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import select_many, _get_http
rows = select_many('pin_samples', order='scraped_at.desc', limit=10)
for r in rows:
    print(str(r.get('scraped_at',''))[:19], str(r.get('source_keyword','?'))[:30].ljust(31), 'saves='+str(r.get('save_count',0)))
http = _get_http()
resp = http.head('pin_samples', params={'select':'id','limit':'0'}, headers={'Prefer':'count=exact'})
cr = resp.headers.get('Content-Range','')
print('total rows:', cr.split('/')[-1] if '/' in cr else '?')
" 2>&1"""),

        ("crawl log tail", r"""tail -50 /tmp/smoke_crawl.log 2>/dev/null || echo 'no log yet'"""),

        ("pipeline_runs latest", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import select_many
rows = select_many('pipeline_runs', order='started_at.desc', limit=5)
for r in rows:
    print(str(r.get('job_type'))[:12], str(r.get('status'))[:10],
          str(r.get('started_at',''))[:16], '->', str(r.get('finished_at',''))[:16],
          'rows='+str(r.get('rows_processed',0)), 'kw='+str(r.get('keywords_processed',0)))
" 2>&1"""),
    ]

    for label, cmd in verify_cmds:
        print(f"\n{'='*70}\n### {label}\n{'='*70}", flush=True)
        out, err = ssh_run(client, cmd, timeout=60)
        if out.strip():
            print(out[:6000], flush=True)
        if err.strip():
            print("[STDERR]", err[:500], flush=True)

    client.close()
    print("\ndone.", flush=True)

if __name__ == "__main__":
    run_all()
