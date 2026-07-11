import sys
sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent / 'db'))
from db import select_many
from collections import Counter

rows = select_many('crawl_queue', filters={'status': 'pending'}, limit=500)
cats = Counter(r.get('category','') for r in rows)
print('pending crawl_queue items:', len(rows))
for cat, n in cats.most_common():
    print(f'  {n:3d}  {cat}')
print()
for r in rows[:15]:
    kw = r.get('keyword', '')[:50]
    cat = r.get('category', '')
    score = r.get('priority_score', 0)
    print(f'  {kw:<50}  {cat:<12}  score={score}')
