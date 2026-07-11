#!/usr/bin/env python3
"""Read db.py upsert, scraper ingest function, run smoke crawl."""
from __future__ import annotations

def ssh_run(client, cmd, timeout=120):
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
        ("db.py full upsert function", "sed -n '1,200p' /opt/vibepin/backend/db/db.py"),
        ("crawl ingest_to_db full fn", "sed -n '880,960p' /opt/vibepin/backend/scraper_v2.py"),
        ("crawl_queue pins column check", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import select_many
rows = select_many('crawl_queue', filters={'status':'completed'}, order='updated_at.desc', limit=3)
if rows:
    print("crawl_queue columns:", list(rows[0].keys()))
    for r in rows:
        print(r)
PYEOF
"""),
        ("pin_samples total & date dist via REST", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import sys, json, urllib.request, os
sys.path.insert(0, '.')
from dotenv import load_dotenv; load_dotenv()
url = os.environ['SUPABASE_URL'].rstrip('/')
key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
hdrs = {'apikey': key, 'Authorization': 'Bearer ' + key}

# total count
req = urllib.request.Request(url+'/rest/v1/pin_samples?select=id&limit=0',
    headers={**hdrs, 'Prefer': 'count=exact'})
with urllib.request.urlopen(req) as r:
    print('Content-Range:', r.headers.get('Content-Range','?'))

# per-day distribution via last 5000
all_rows = []
for off in range(0, 13000, 1000):
    req = urllib.request.Request(
        url+f'/rest/v1/pin_samples?select=scraped_at&order=scraped_at.desc&limit=1000&offset={off}',
        headers=hdrs)
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    if not data: break
    all_rows.extend(data)
    if len(data) < 1000: break

from collections import Counter
counts = Counter(x['scraped_at'][:10] if x.get('scraped_at') else 'null' for x in all_rows)
print('scraped_at distribution (all rows):')
for day in sorted(counts, reverse=True)[:20]:
    print(f'  {day}: {counts[day]}')
PYEOF
"""),
        ("smoke crawl: 2 keywords", r"""cd /opt/vibepin/backend && timeout 120 .venv/bin/python3 run_worker.py --job crawl --limit-keywords 2 --region US 2>&1 | tail -80"""),
        ("post-smoke pin_samples check", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import sys, json, urllib.request, os
sys.path.insert(0,'.')
from dotenv import load_dotenv; load_dotenv()
url = os.environ['SUPABASE_URL'].rstrip('/')
key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
hdrs = {'apikey': key, 'Authorization': 'Bearer ' + key}
req = urllib.request.Request(
    url+'/rest/v1/pin_samples?select=scraped_at&order=scraped_at.desc&limit=1',
    headers=hdrs)
with urllib.request.urlopen(req) as r:
    data = json.loads(r.read())
print('max scraped_at after smoke:', data[0]['scraped_at'] if data else 'NONE')
req2 = urllib.request.Request(url+'/rest/v1/pin_samples?select=id&limit=0',
    headers={**hdrs, 'Prefer': 'count=exact'})
with urllib.request.urlopen(req2) as r:
    print('total rows after smoke:', r.headers.get('Content-Range','?'))
PYEOF
"""),
        ("post-smoke pipeline_runs", r"""cd /opt/vibepin/backend && .venv/bin/python3 << 'PYEOF'
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import select_many
rows = select_many('pipeline_runs', order='started_at.desc', limit=5)
for r in rows:
    jt = str(r.get('job_type','?'))
    st = str(r.get('status','?'))
    sa = str(r.get('started_at',''))[:16]
    fa = str(r.get('finished_at',''))[:16]
    rp = r.get('rows_processed',0)
    kp = r.get('keywords_processed',0)
    print(jt, st, sa, '->', fa, 'rows='+str(rp), 'kw='+str(kp))
PYEOF
"""),
    ]

    for label, cmd in cmds:
        print(f"\n{'='*72}\n### {label}\n{'='*72}")
        out, err = ssh_run(client, cmd, timeout=180)
        if out.strip():
            print(out[:10000])
        if err.strip():
            print("[STDERR]", err[:2000])

    client.close()

if __name__ == "__main__":
    run_all()
