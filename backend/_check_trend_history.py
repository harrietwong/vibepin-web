import sys
sys.path.insert(0, 'db')
from db import _get_http

http = _get_http()

# Keywords WITH trend_history
r = http.get('trend_keywords', params={
    'select': 'keyword,trend_history,search_volume_level',
    'trend_history': 'not.is.null',
    'limit': '5',
})
rows = r.json()
print(f'Keywords WITH trend_history: {len(rows)}')
for row in rows[:3]:
    h = row.get('trend_history')
    print(f'  keyword={row["keyword"]}')
    print(f'  type={type(h).__name__}  len={len(h) if isinstance(h, list) else "?"}')
    print(f'  sample={str(h)[:100]}')

# Keywords WITHOUT trend_history
r2 = http.get('trend_keywords', params={
    'select': 'id',
    'trend_history': 'is.null',
    'limit': '1',
}, headers={'Prefer': 'count=exact'})
print(f'\nKeywords WITHOUT trend_history: {r2.headers.get("content-range", "?")}')
print(f'Total trend_keywords: ', end='')
r3 = http.get('trend_keywords', params={'select':'id','limit':'1'}, headers={'Prefer':'count=exact'})
print(r3.headers.get('content-range','?'))
