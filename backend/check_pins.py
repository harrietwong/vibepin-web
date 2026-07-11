import sys
sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent / 'db'))
from db import select_many

pins = select_many('pin_samples', limit=500)
print('total pin_samples:', len(pins))

with_link = [p for p in pins if p.get('trend_keyword_id')]
without   = [p for p in pins if not p.get('trend_keyword_id')]
print('with trend_keyword_id:', len(with_link))
print('without trend_keyword_id:', len(without))

if without[:3]:
    print('\nsample without link:')
    for p in without[:3]:
        print(f"  pin_id={p.get('pin_id')}  kw={p.get('source_keyword')}  saves={p.get('save_count')}")

# crawl_queue status breakdown
q = select_many('crawl_queue', limit=200)
from collections import Counter
statuses = Counter(r.get('status','') for r in q)
print('\ncrawl_queue status:')
for s, n in statuses.most_common():
    print(f'  {n:3d}  {s}')
