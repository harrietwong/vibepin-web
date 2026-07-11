#!/usr/bin/env python3
"""Check queue category distribution and test crawl on a physical product keyword."""
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

    cmds = [
        # 1. Queue breakdown by category
        ("queue category distribution", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import _get_http
from collections import Counter
# Get all pending items
http = _get_http()
rows = []
for offset in range(0, 1400, 200):
    r = http.get('crawl_queue',
        params={'select':'category,priority_score','status':'eq.pending','limit':'200','offset':str(offset)})
    data = r.json() if r.status_code == 200 else []
    if not data: break
    rows.extend(data)
cats = Counter(r.get('category','?') for r in rows)
for cat, cnt in sorted(cats.items(), key=lambda x: -x[1]):
    print(f'  {cat:<30} {cnt:>4}')
print(f'Total: {len(rows)}')
# Priority distribution
from collections import Counter
prios = Counter(r.get('priority_score',0) for r in rows)
print('Priority scores:', dict(sorted(prios.items())))
" 2>&1"""),

        # 2. Show physical product keywords (non digital-product) top 20
        ("physical product keywords in queue", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import _get_http
http = _get_http()
# Get non-digital pending items
rows = []
for offset in range(0, 1400, 200):
    r = http.get('crawl_queue',
        params={'select':'keyword,category,priority_score',
                'status':'eq.pending',
                'category':'neq.digital-product',
                'limit':'200','offset':str(offset)})
    data = r.json() if r.status_code == 200 else []
    if not data: break
    rows.extend(data)
rows.sort(key=lambda x: -(x.get('priority_score') or 0))
print(f'Non-digital pending: {len(rows)}')
for r in rows[:20]:
    print(str(r.get('priority_score','?'))[:5].ljust(6), str(r.get('category','?'))[:20].ljust(21), r.get('keyword','?'))
" 2>&1"""),

        # 3. Read scraper's class structure to find the right crawl function
        ("scraper class/function names", r"""grep -n 'class\|def ' /opt/vibepin/backend/scraper_v2.py | head -40"""),

        # 4. Try crawl on a physical product keyword by temporarily elevating its priority
        # First check: what's the crawl ordering in select_due_crawl_items
        ("crawl ordering logic", r"""grep -n 'select_due_crawl\|order_by\|priority\|order.*priority\|ORDER BY' /opt/vibepin/backend/crawl_queue_ops.py | head -20"""),

        # 5. Force-prioritize physical product keywords above digital
        ("boost physical keywords priority to 100", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import _get_http
http = _get_http()
resp = http.patch('crawl_queue',
    json={'priority_score': 100},
    params={'status': 'eq.pending', 'category': 'neq.digital-product'},
    headers={'Prefer': 'return=minimal'})
print('boost status:', resp.status_code)
# Verify
r = http.head('crawl_queue',
    params={'select':'id','limit':'0','status':'eq.pending','priority_score':'eq.100'},
    headers={'Prefer':'count=exact'})
print('boosted count:', r.headers.get('Content-Range','?').split('/')[-1])
" 2>&1"""),

        # 6. Now run a targeted crawl — should pick up physical keywords first
        ("CRAWL: 5 physical product keywords", r"""cd /opt/vibepin/backend && timeout 180 .venv/bin/python3 run_worker.py --job crawl --limit-keywords 5 --region US 2>&1 | grep -v '^\s*$' | tail -80"""),

        # 7. Verify pin_samples updated
        ("pin_samples after physical crawl", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import select_many, _get_http
rows = select_many('pin_samples', order='scraped_at.desc', limit=10)
for r in rows:
    print(str(r.get('scraped_at',''))[:19],
          str(r.get('source_keyword','?'))[:30].ljust(31),
          'saves='+str(r.get('save_count',0)))
http = _get_http()
resp = http.head('pin_samples', params={'select':'id','limit':'0'}, headers={'Prefer':'count=exact'})
print('TOTAL:', resp.headers.get('Content-Range','?').split('/')[-1])
" 2>&1"""),
    ]

    for label, cmd in cmds:
        print(f"\n{'='*70}\n### {label}\n{'='*70}", flush=True)
        out, err = ssh_run(client, cmd, timeout=220)
        if out.strip():
            print(out[:5000], flush=True)
        if err.strip():
            print("[STDERR]", err[:400], flush=True)

    client.close()
    print("\ndone.", flush=True)

if __name__ == "__main__":
    run_all()
