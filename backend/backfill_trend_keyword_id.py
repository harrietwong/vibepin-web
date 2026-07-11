"""
Backfill pin_samples.trend_keyword_id for existing rows that don't have it set.
Matches on pin_samples.source_keyword == trend_keywords.keyword.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent / 'db'))
from db import _get_http, select_many

http = _get_http()

# Fetch all trend_keywords (id + keyword)
kw_rows = select_many('trend_keywords', limit=500)
kw_map = {r['keyword'].lower(): str(r['id']) for r in kw_rows}
print(f'Loaded {len(kw_map)} trend_keywords')

# Fetch pins without trend_keyword_id
params = {'trend_keyword_id': 'is.null', 'limit': '500', 'select': 'id,source_keyword,seed_keyword'}
resp = http.get('pin_samples', params=params)
pins = resp.json() if resp.status_code == 200 else []
print(f'Pins without trend_keyword_id: {len(pins)}')

updated = 0
skipped = 0
for pin in pins:
    kw = (pin.get('source_keyword') or pin.get('seed_keyword') or '').lower().strip()
    tid = kw_map.get(kw)
    if not tid:
        skipped += 1
        continue

    patch_params = {'id': f'eq.{pin["id"]}'}
    r = http.patch('pin_samples', json={'trend_keyword_id': tid}, params=patch_params,
                   headers={'Prefer': 'return=minimal'})
    if r.status_code in (200, 204):
        updated += 1
    else:
        print(f'  ERROR patching id={pin["id"]}: {r.status_code} {r.text[:100]}')

print(f'\nDone: {updated} updated, {skipped} skipped (no matching keyword)')
