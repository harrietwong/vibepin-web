#!/usr/bin/env python3
"""Test crawl with specific physical product keywords + diagnose 0-pin issue."""
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
        # 1. Show first 20 pending keywords by priority
        ("pending queue keywords (top 20)", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from db import select_many
rows = select_many('crawl_queue', filters={'status':'pending'}, order='priority_score.desc', limit=20)
for r in rows:
    print(str(r.get('priority_score','?'))[:5].ljust(6),
          str(r.get('category','?'))[:15].ljust(16),
          str(r.get('keyword','?'))[:50])
" 2>&1"""),

        # 2. Check scraper HTML extraction logic
        ("scraper_v2 html extraction lines", r"""grep -n 'extracted.*pins\|parse_html\|extract.*pin\|0 pins\|pin_ids\|initial_data\|__PWS_DATA__\|relay_id\|uniqueness_token' /opt/vibepin/backend/scraper_v2.py | head -30"""),

        # 3. Test single physical product keyword manually
        ("test crawl: home decor diy (manual keyword inject)", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys, asyncio; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from scraper_v2 import scrape_keyword
result = asyncio.run(scrape_keyword('boho home decor', region='US', max_pages=2))
print('pins_found:', len(result) if result else 0)
if result:
    print('first pin:', result[0])
else:
    print('NO PINS RETURNED')
" 2>&1 | tail -20"""),

        # 4. Show raw HTTP response from Pinterest search (first 3000 chars)
        ("pinterest search raw HTML check", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys, asyncio, re; sys.path.insert(0,'.')
from scraper_v2 import _create_session

async def check():
    session = await _create_session('US')
    url = 'https://www.pinterest.com/search/pins/?q=boho+home+decor'
    async with session.get(url, timeout=20) as resp:
        print('status:', resp.status)
        text = await resp.text()
        print('len:', len(text))
        # Check if it has pin data
        has_data = '__PWS_DATA__' in text or 'relay_id' in text or 'pin_id' in text
        print('has pin data markers:', has_data)
        # Find pin count hints
        pin_mentions = re.findall(r'\"pin_id\"', text)
        print('pin_id mentions:', len(pin_mentions))
        if not has_data:
            print('HTML snippet (300 chars):', text[:300])
    await session.close()

asyncio.run(check())
" 2>&1"""),

        # 5. Check if Pinterest session cookies are valid
        ("pinterest session/auth status", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.insert(0,'db')
# Check if there's a cookie/session file
import os
cookie_files = []
for root, dirs, files in os.walk('.'):
    for f in files:
        if 'cookie' in f.lower() or 'session' in f.lower() or '.pkl' in f or '.json' in f:
            p = os.path.join(root, f)
            try:
                sz = os.path.getsize(p)
                mtime = os.path.getmtime(p)
                import datetime
                cookie_files.append((p, sz, datetime.datetime.fromtimestamp(mtime).isoformat()[:16]))
            except: pass
for f in cookie_files[:15]:
    print(f)
" 2>&1"""),

        # 6. Look at what the ACTUAL scraper does after get 0 pins
        ("scraper_v2 zero-pin handling", r"""grep -n 'extracted 0\|0 new pin\|0 pins\|api.*page.*0\|pin_count.*0\|no pins\|empty' /opt/vibepin/backend/scraper_v2.py | head -20"""),

        # 7. Check Pinterest response for a keyword that historically worked
        ("test crawl: designer party wear dresses (was working Jun 8)", r"""cd /opt/vibepin/backend && .venv/bin/python3 -c "
import sys, asyncio; sys.path.insert(0,'.'); sys.path.insert(0,'db')
from scraper_v2 import scrape_keyword
result = asyncio.run(scrape_keyword('designer party wear dresses', region='US', max_pages=1))
print('pins_found:', len(result) if result else 0)
if result:
    p = result[0]
    print('sample pin keys:', list(p.keys()))
    print('pin_id:', p.get('pin_id'), 'saves:', p.get('save_count'))
else:
    print('NO PINS')
" 2>&1 | tail -10"""),
    ]

    for label, cmd in cmds:
        print(f"\n{'='*70}\n### {label}\n{'='*70}", flush=True)
        out, err = ssh_run(client, cmd, timeout=180)
        if out.strip():
            print(out[:5000], flush=True)
        if err.strip():
            print("[STDERR]", err[:400], flush=True)

    client.close()
    print("\ndone.", flush=True)

if __name__ == "__main__":
    run_all()
