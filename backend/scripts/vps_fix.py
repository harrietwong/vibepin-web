#!/usr/bin/env python3
"""
Read crawl_queue_ops.py and run_worker crawl section,
then reset stale crawl_queue items to pending and run smoke crawl.
"""
from __future__ import annotations

def ssh_run(client, cmd, timeout=180):
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
        ("crawl_queue_ops.py", "cat /opt/vibepin/backend/crawl_queue_ops.py 2>/dev/null || echo NOT FOUND"),
        ("run_worker crawl section", "sed -n '60,160p' /opt/vibepin/backend/run_worker.py"),
        ("pipeline.py crawl step", "grep -n 'crawl\\|queue\\|pending\\|step_crawl\\|crawl_queue' /opt/vibepin/backend/pipeline.py | head -40"),
        ("step_crawl implementation", "grep -n 'def step_crawl\\|async def.*crawl' /opt/vibepin/backend/pipeline.py; sed -n '$(grep -n \"def step_crawl\" /opt/vibepin/backend/pipeline.py | head -1 | cut -d: -f1)p' /opt/vibepin/backend/pipeline.py 2>/dev/null || grep -A 40 'def step_crawl' /opt/vibepin/backend/pipeline.py | head -50"),
        ("pipeline.py step_crawl full", "grep -A 60 'async def step_crawl\\|def step_crawl' /opt/vibepin/backend/pipeline.py | head -80"),

        # Now reset crawl_queue: set all completed items to pending where next_crawl_at <= now
        ("reset crawl_queue overdue items", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import _get_http
from datetime import datetime, timezone

http = _get_http()
now_iso = datetime.now(timezone.utc).isoformat()

# Count overdue items
resp = http.head('crawl_queue',
    params={'select':'id','limit':'0',
            'status':'eq.completed',
            'next_crawl_at':'lte.'+now_iso},
    headers={'Prefer':'count=exact'})
cr = resp.headers.get('Content-Range','')
overdue = cr.split('/')[-1] if '/' in cr else '?'
print('overdue (next_crawl_at <= now):', overdue)

# Count all completed
resp2 = http.head('crawl_queue',
    params={'select':'id','limit':'0','status':'eq.completed'},
    headers={'Prefer':'count=exact'})
cr2 = resp2.headers.get('Content-Range','')
total_completed = cr2.split('/')[-1] if '/' in cr2 else '?'
print('total completed:', total_completed)
PYEOF
"""),

        ("reset all completed to pending (home-decor, fashion, beauty, diy, wedding)", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import _get_http
from datetime import datetime, timezone

http = _get_http()
now_iso = datetime.now(timezone.utc).isoformat()

# Reset ALL completed items to pending (immediate fix - override next_crawl_at)
# We target home-decor relevant categories first, then all
resp = http.patch('crawl_queue',
    json={'status': 'pending', 'next_crawl_at': None, 'last_error': None},
    params={'status': 'eq.completed'},
    headers={'Prefer': 'return=representation', 'Content-Type': 'application/json'})
if resp.status_code in (200, 204):
    rows = resp.json() if resp.status_code == 200 else []
    print('reset to pending:', len(rows), 'rows')
else:
    print('FAILED:', resp.status_code, resp.text[:300])
PYEOF
"""),

        ("verify crawl_queue pending count", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import _get_http
http = _get_http()
for s in ['pending','completed','failed']:
    resp = http.head('crawl_queue',
        params={'select':'id','limit':'0','status':'eq.'+s},
        headers={'Prefer':'count=exact'})
    cr = resp.headers.get('Content-Range','')
    n = cr.split('/')[-1] if '/' in cr else '?'
    print(s+':', n)
PYEOF
"""),

        ("run smoke crawl --limit-keywords 5", "cd /opt/vibepin/backend && timeout 180 .venv/bin/python3 run_worker.py --job crawl --limit-keywords 5 --region US 2>&1 | tail -100"),

        ("post-fix pin_samples check", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import select_many, _get_http
http = _get_http()
# max scraped_at
rows = select_many('pin_samples', order='scraped_at.desc', limit=3)
for r in rows:
    print('scraped_at:', r.get('scraped_at'), '  kw:', r.get('source_keyword','?'), '  saves:', r.get('save_count','?'))
# total count
resp = http.head('pin_samples', params={'select':'id','limit':'0'}, headers={'Prefer':'count=exact'})
cr = resp.headers.get('Content-Range','')
print('total:', cr.split('/')[-1] if '/' in cr else '?')
PYEOF
"""),

        ("post-fix pipeline_runs", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import select_many
rows = select_many('pipeline_runs', order='started_at.desc', limit=5)
for r in rows:
    print(r.get('job_type'), r.get('status'), str(r.get('started_at',''))[:16], '->', str(r.get('finished_at',''))[:16], 'rows='+str(r.get('rows_processed',0)), 'kw='+str(r.get('keywords_processed',0)))
PYEOF
"""),
    ]

    for label, cmd in cmds:
        print(f"\n{'='*72}\n### {label}\n{'='*72}")
        out, err = ssh_run(client, cmd, timeout=240)
        if out.strip():
            print(out[:10000])
        if err.strip():
            print("[STDERR]", err[:2000])

    client.close()

if __name__ == "__main__":
    run_all()
