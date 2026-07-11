import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent / 'db'))
from db import select_many
from collections import Counter

rows = select_many('trend_opportunities_view', limit=100)
conf_dist = Counter(r.get('data_confidence','') for r in rows)
score_none = sum(1 for r in rows if r.get('opportunity_score') is None)
score_med  = sum(1 for r in rows if r.get('opportunity_score') is not None and r.get('opportunity_score') >= 40)
score_low  = sum(1 for r in rows if r.get('opportunity_score') is not None and r.get('opportunity_score') < 40)

print('=== data_confidence distribution ===')
for k, v in conf_dist.most_common():
    print(f'  {k:<8}: {v}')

print(f'\n=== opportunity_score breakdown ===')
print(f'  score=None  : {score_none}  (no products linked yet)')
print(f'  score>=40   : {score_med}  (medium+)')
print(f'  score<40    : {score_low}  (low)')

print('\n=== Top 15 by total_source_saves ===')
top = sorted(rows, key=lambda r: r.get('total_source_saves',0) or 0, reverse=True)[:15]
for r in top:
    kw    = r.get('keyword','')[:32]
    saves = r.get('total_source_saves',0) or 0
    prods = r.get('linked_products_count',0) or 0
    conf  = r.get('data_confidence','')[:3]
    score = r.get('opportunity_score')
    tier  = r.get('score_tier','')
    print(f'  {kw:<33} {saves:>8} saves  {prods:>3} prods  {conf}  score={score}  {tier}')
