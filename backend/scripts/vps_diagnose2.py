#!/usr/bin/env python3
"""Deep diagnostic: db upsert logic, scraper upsert section, cron log, crawl_queue."""
from __future__ import annotations
import sys

def ssh_run(client, cmd, timeout=90):
    import paramiko
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
        ("DB upsert function", "grep -n 'def upsert\\|on_conflict\\|DO NOTHING\\|DO UPDATE\\|returning\\|conflict' /opt/vibepin/backend/db/db.py | head -50"),
        ("scraper_v2 upsert section (880-960)", "sed -n '880,960p' /opt/vibepin/backend/scraper_v2.py"),
        ("cron log (last 300, ascii only)", "tail -n 300 /opt/vibepin/backend/logs/cron_daily.log | strings | grep -E 'crawl|pin_samples|upsert|insert|skip|fetched|keyword|error|ERROR|fail|rows|pins|complete|start' | tail -100"),
        ("cron log raw tail 200", "tail -c 20000 /opt/vibepin/backend/logs/cron_daily.log | cat -v | tail -200"),
        ("crawl_queue counts", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import select_many, _get_http
http = _get_http()
for s in ['pending','completed','failed','done']:
    resp = http.head('crawl_queue', params={'select':'id','limit':'0','status':'eq.'+s}, headers={'Prefer':'count=exact'})
    cr = resp.headers.get('Content-Range','')
    n = cr.split('/')[-1] if '/' in cr else '?'
    print(s+': '+str(n))
PYEOF
"""),
        ("crawl_queue recent completed", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import select_many
rows = select_many('crawl_queue', filters={'status':'completed'}, order='updated_at.desc', limit=20)
for r in rows:
    kw = str(r.get('keyword','?'))[:35]
    pins = r.get('pins_found', r.get('pin_count', r.get('pins_upserted', '?')))
    upd = str(r.get('updated_at',''))[:16]
    print(kw.ljust(36) + ' pins='+str(pins)+' updated='+upd)
PYEOF
"""),
        ("trend_keywords recent", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import select_many
rows = select_many('trend_keywords', order='created_at.desc', limit=15)
for r in rows:
    print(str(r.get('keyword','?'))[:40].ljust(41), r.get('category','?'), str(r.get('created_at',''))[:16])
PYEOF
"""),
        ("pipeline_runs last 25", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import select_many
rows = select_many('pipeline_runs', order='started_at.desc', limit=25)
for r in rows:
    jt = str(r.get('job_type','?'))[:12].ljust(13)
    st = str(r.get('status','?'))[:10].ljust(11)
    sa = str(r.get('started_at',''))[:16]
    fa = str(r.get('finished_at',''))[:16]
    rp = r.get('rows_processed',0)
    kp = r.get('keywords_processed',0)
    print(jt+st+sa+' -> '+fa+'  rows='+str(rp)+'  kw='+str(kp))
PYEOF
"""),
        ("pin_samples per-day (last 14 days)", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import _get_http
from datetime import date, timedelta
http = _get_http()
for i in range(14):
    d = (date.today() - timedelta(days=i)).isoformat()
    d2 = (date.today() - timedelta(days=i-1)).isoformat()
    resp = http.head('pin_samples',
        params={'select':'id','limit':'0',
                'scraped_at':'gte.'+d+'T00:00:00Z',
                'scraped_at2':'lt.'+d2+'T00:00:00Z'},
        headers={'Prefer':'count=exact'})
    # PostgREST only allows one filter per column name via params
    # Use range filter instead
    import requests
    r2 = http.session.head(http.base_url+'/pin_samples',
        params={'select':'id','limit':'0'},
        headers={**http.headers, 'Prefer':'count=exact',
                 'Range-Unit':'items'},
        json=None) if hasattr(http, 'session') else None
    print(d+': (per-day query requires RPC - skipped)')
    break

# Instead get the scraped_at distribution from recent 5000 rows
rows = []
import json, os
url = os.environ.get('SUPABASE_URL','').rstrip('/')
key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY','')
import urllib.request, urllib.parse
for page in range(0, 5000, 1000):
    req = urllib.request.Request(
        url+'/rest/v1/pin_samples?select=scraped_at&order=scraped_at.desc&limit=1000&offset='+str(page),
        headers={'apikey': key, 'Authorization': 'Bearer '+key}
    )
    with urllib.request.urlopen(req, timeout=30) as resp2:
        data = json.loads(resp2.read())
    if not data: break
    rows.extend(data)
    if len(data) < 1000: break

from collections import Counter
counts = Counter(r['scraped_at'][:10] if r.get('scraped_at') else 'null' for r in rows)
for day in sorted(counts, reverse=True)[:14]:
    print(day+': '+str(counts[day]))
PYEOF
"""),
    ]

    for label, cmd in cmds:
        print(f"\n{'='*72}\n### {label}\n{'='*72}")
        out, err = ssh_run(client, cmd)
        if out.strip():
            print(out[:8000])
        if err.strip():
            print("[STDERR]", err[:1000])

    client.close()


if __name__ == "__main__":
    run_all()
