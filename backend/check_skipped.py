import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent / 'db'))
from db import _get_http, select_many
from collections import Counter

http = _get_http()
kw_rows = select_many('trend_keywords', limit=500)
kw_set = {r['keyword'].lower() for r in kw_rows}

params = {'trend_keyword_id': 'is.null', 'limit': '500', 'select': 'source_keyword,seed_keyword,category'}
resp = http.get('pin_samples', params=params)
pins = resp.json() if resp.status_code == 200 else []

kwcnt = Counter((p.get('source_keyword') or p.get('seed_keyword') or '').lower() for p in pins)
print('Remaining unlinked pins by source_keyword:')
for kw, n in kwcnt.most_common():
    match = 'Y' if kw in kw_set else 'N'
    print(f'  {match}  {n:3d}  {kw}')
