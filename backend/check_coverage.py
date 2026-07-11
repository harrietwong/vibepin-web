import sys; sys.path.insert(0, 'db')
from db import _get_http, select_many

http = _get_http()

# All keywords by category
kws = select_many('trend_keywords', {}, limit=300)
cats = {}
for k in kws:
    c = k['category']
    if c not in cats:
        cats[c] = {'kws': 0, 'high_vol': 0}
    cats[c]['kws'] += 1
    if k.get('search_volume_level') == 'high':
        cats[c]['high_vol'] += 1

kw_map = {k['id']: k['category'] for k in kws}

# Get all pins (2 pages)
pins1 = http.get('pin_samples', params={'select': 'trend_keyword_id', 'limit': '1000'}).json()
pins2 = http.get('pin_samples', params={'select': 'trend_keyword_id', 'limit': '1000', 'offset': '1000'}).json()
all_pins = pins1 + pins2
print(f'Total pins: {len(all_pins)}')

cat_pins = {}
for p in all_pins:
    cat = kw_map.get(p.get('trend_keyword_id'), 'unknown')
    cat_pins[cat] = cat_pins.get(cat, 0) + 1

# Products by seed keyword → map to category
prods = select_many('pin_products', {}, limit=600)
kw_to_cat = {k['keyword']: k['category'] for k in kws}
cat_prods = {}
for p in prods:
    kw = p.get('seed_keyword', '')
    cat = kw_to_cat.get(kw, 'unknown')
    cat_prods[cat] = cat_prods.get(cat, 0) + 1

print(f'\n{"category":<20} {"keywords":>8} {"high_vol":>8} {"pins":>8} {"products":>9}')
print("-" * 60)
all_cats = sorted(cats.keys())
for cat in all_cats:
    kw_cnt   = cats[cat]['kws']
    hv_cnt   = cats[cat]['high_vol']
    pin_cnt  = cat_pins.get(cat, 0)
    prod_cnt = cat_prods.get(cat, 0)
    flag = "OK" if pin_cnt > 0 else "NO"
    print(f'{flag} {cat:<18} {kw_cnt:>8} {hv_cnt:>8} {pin_cnt:>8} {prod_cnt:>9}')

print(f'\nTotal products: {len(prods)}')
print(f'Total pins: {len(all_pins)}')
print(f'Total keywords: {len(kws)}')
