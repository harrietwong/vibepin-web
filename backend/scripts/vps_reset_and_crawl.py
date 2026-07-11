#!/usr/bin/env python3
"""Reset crawl_queue to pending and run a smoke crawl to verify pin_samples updates."""
from __future__ import annotations
import sys

def ssh_run(client, cmd, timeout=240):
    try:
        stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode("ascii", errors="replace")
        err = stderr.read().decode("ascii", errors="replace")
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
        # 1. Check plan_crawl_queue_row staleness logic
        ("crawl_queue staleness config", r"""grep -n 'STALE_CRAWL_DAYS\|SUCCESS_INTERVAL\|next_crawl_at\|is_stale\|replenish\|plan_crawl' /opt/vibepin/backend/crawl_queue_ops.py | head -30"""),

        # 2. Check step_crawl replenish
        ("pipeline step_crawl replenish", r"""grep -A 30 'async def step_crawl\|def step_crawl' /opt/vibepin/backend/pipeline.py | head -40"""),

        # 3. Current crawl_queue status breakdown
        ("crawl_queue status counts", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import _get_http
http = _get_http()
for s in ['pending','completed','failed','done']:
    r = http.head('crawl_queue', params={'select':'id','limit':'0','status':'eq.'+s}, headers={'Prefer':'count=exact'})
    cr = r.headers.get('Content-Range','')
    print(s+':', cr.split('/')[-1] if '/' in cr else '?')
" 2>&1"""),

        # 4. Reset ALL completed items to pending (override 7-day interval)
        ("RESET: all completed -> pending", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import _get_http
http = _get_http()
resp = http.patch('crawl_queue',
    json={'status': 'pending', 'next_crawl_at': None, 'last_error': None},
    params={'status': 'eq.completed'},
    headers={'Prefer': 'return=representation', 'Content-Type': 'application/json'})
rows = resp.json() if resp.status_code == 200 else []
print('reset to pending:', len(rows), 'rows  status:', resp.status_code)
" 2>&1"""),

        # 5. Verify reset
        ("verify crawl_queue after reset", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import _get_http
http = _get_http()
for s in ['pending','completed','failed']:
    r = http.head('crawl_queue', params={'select':'id','limit':'0','status':'eq.'+s}, headers={'Prefer':'count=exact'})
    cr = r.headers.get('Content-Range','')
    print(s+':', cr.split('/')[-1] if '/' in cr else '?')
" 2>&1"""),

        # 6. Run smoke crawl with 5 keywords
        ("smoke crawl --limit-keywords 5", r"""cd /opt/vibepin/backend && timeout 180 .venv/bin/python3 run_worker.py --job crawl --limit-keywords 5 --region US 2>&1 | tr -d '\033' | grep -v '^\s*$' | tail -80"""),

        # 7. Check pin_samples after crawl
        ("pin_samples after crawl", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import select_many, _get_http
rows = select_many('pin_samples', order='scraped_at.desc', limit=5)
for r in rows:
    print(str(r.get('scraped_at',''))[:19], str(r.get('source_keyword','?'))[:30], 'saves='+str(r.get('save_count',0)))
http = _get_http()
resp = http.head('pin_samples', params={'select':'id','limit':'0'}, headers={'Prefer':'count=exact'})
cr = resp.headers.get('Content-Range','')
print('total:', cr.split('/')[-1] if '/' in cr else '?')
" 2>&1"""),

        # 8. pipeline_runs after crawl
        ("pipeline_runs after crawl", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import select_many
rows = select_many('pipeline_runs', order='started_at.desc', limit=5)
for r in rows:
    print(str(r.get('job_type'))[:12], str(r.get('status'))[:10],
          str(r.get('started_at',''))[:16], '->', str(r.get('finished_at',''))[:16],
          'rows='+str(r.get('rows_processed',0)), 'kw='+str(r.get('keywords_processed',0)))
" 2>&1"""),
    ]

    for label, cmd in cmds:
        print(f"\n{'='*70}\n### {label}\n{'='*70}")
        out, err = ssh_run(client, cmd, timeout=240)
        if out.strip():
            print(out[:8000])
        if err.strip():
            print("[STDERR]", err[:1000])

    client.close()
    print("\ndone.")

if __name__ == "__main__":
    run_all()
