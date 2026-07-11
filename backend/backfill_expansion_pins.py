"""
Backfill trend_keyword_id for pins whose source_keyword is a typeahead expansion
(e.g. 'home decor ideas diy' → seed 'home decor ideas' in trend_keywords).
Uses longest-prefix matching.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent / 'db'))
from db import _get_http, select_many

http = _get_http()

kw_rows = select_many('trend_keywords', limit=500)
# sort by keyword length desc so longest match wins
kw_rows.sort(key=lambda r: len(r['keyword']), reverse=True)
print(f'Loaded {len(kw_rows)} trend_keywords')

params = {'trend_keyword_id': 'is.null', 'limit': '500', 'select': 'id,source_keyword,seed_keyword'}
resp = http.get('pin_samples', params=params)
pins = resp.json() if resp.status_code == 200 else []
print(f'Pins still without trend_keyword_id: {len(pins)}')

updated = 0
skipped = 0
for pin in pins:
    src_kw = (pin.get('source_keyword') or pin.get('seed_keyword') or '').lower().strip()
    if not src_kw:
        skipped += 1
        continue

    # Longest-prefix match: find trend_keyword that src_kw starts with
    match_id = None
    for row in kw_rows:
        candidate = row['keyword'].lower().strip()
        if src_kw.startswith(candidate) or candidate.startswith(src_kw):
            match_id = str(row['id'])
            break

    if not match_id:
        skipped += 1
        continue

    r = http.patch('pin_samples',
                   json={'trend_keyword_id': match_id},
                   params={'id': f'eq.{pin["id"]}'},
                   headers={'Prefer': 'return=minimal'})
    if r.status_code in (200, 204):
        updated += 1
    else:
        print(f'  ERROR {r.status_code}: {r.text[:100]}')

print(f'Done: {updated} updated, {skipped} skipped (no prefix match)')
