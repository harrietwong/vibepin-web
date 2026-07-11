import sys; sys.path.insert(0, 'db')
from db import _get_http
from collections import Counter

http = _get_http()

name_col = 'normalized_product_name'

for label, param in [
    ('digital', f'ilike.*digital*'),
    ('printable', f'ilike.*printable*'),
    ('template', f'ilike.*template*'),
    ('instant download', f'ilike.*instant*download*'),
    ('svg', f'ilike.*\\.svg*'),
    ('preset', f'ilike.*preset*'),
    ('ebook', f'ilike.*ebook*'),
]:
    r = http.get('pin_products', params={
        'select': f'{name_col},domain,save_count,source_pin_save_count',
        name_col: param,
        'limit': '20',
        'order': 'save_count.desc'
    }).json()
    if isinstance(r, list):
        print(f'\n=== {label} ({len(r)}) ===')
        for p in r:
            print(f'  pin_saves={p.get("source_pin_save_count",0):>6}  prod_saves={p.get("save_count",0):>5}  [{p.get("domain","")}]  {str(p.get(name_col,""))[:50]}')
    else:
        print(f'\n=== {label}: {r}')

# Domain breakdown
r5 = http.get('pin_products', params={'select': 'domain,save_count', 'limit': '400'}).json()
domains = Counter()
if isinstance(r5, list):
    for p in r5:
        domains[p.get('domain', '')] += 1
print('\n=== Top 15 domains ===')
for d, c in domains.most_common(15):
    print(f'  {c:>4}  {d}')
