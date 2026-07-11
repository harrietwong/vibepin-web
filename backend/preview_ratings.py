"""Preview what ratings the frontend will assign based on current view data."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent / 'db'))
from db import select_many

def get_demand(saves, weekly_change):
    if saves >= 50000 or weekly_change >= 100: return 'high'
    if saves >= 5000  or weekly_change >= 10:  return 'medium'
    return 'low'

def get_competition(pin_count, linked_products):
    if pin_count == 0 and linked_products == 0: return 'unknown'
    density = linked_products / pin_count if pin_count > 0 else 0
    if pin_count < 30 and linked_products < 8:      return 'low'
    if pin_count < 30 and density < 0.4:             return 'low'
    if pin_count < 100 or density < 0.5:             return 'medium'
    return 'high'

def get_momentum(yoy, weekly):
    if yoy >= 100 or weekly >= 50: return 'surging'
    if yoy <= -20 and weekly <= -10: return 'declining'
    return 'steady'

def get_rating(demand, comp, momentum):
    c = 'medium' if comp == 'unknown' else comp
    if momentum == 'declining' and demand != 'high': return 'avoid'
    if demand == 'high' and c == 'low':              return 'blue_ocean'
    if demand == 'medium' and c == 'low' and momentum == 'surging': return 'blue_ocean'
    if demand == 'high':                             return 'hot_red_sea'
    if momentum == 'surging':                        return 'early_trend'
    if demand == 'medium' and c != 'low':            return 'hot_red_sea'
    if demand == 'medium' and c == 'low':            return 'early_trend'   # new rule
    if demand == 'low' and c == 'low':               return 'early_trend'
    return 'avoid'

rows = select_many('trend_opportunities_view', order='total_source_saves.desc', limit=30)
kw_rows = select_many('trend_keywords', filters={'status': 'active'}, limit=200)
kw_map = {r['keyword']: r for r in kw_rows}

print(f'{"keyword":<35} {"saves":>8} {"demand":<8} {"comp":<8} {"mom":<8} {"rating"}')
print('-' * 85)
for r in rows:
    kw      = r.get('keyword', '')
    saves   = r.get('total_source_saves', 0) or 0
    pins    = r.get('linked_pins_count', 0) or 0
    prods   = r.get('linked_products_count', 0) or 0
    yoy     = r.get('pct_growth_yoy', 0) or 0
    kw_rec  = kw_map.get(kw, {})
    weekly  = kw_rec.get('weekly_change', 0) or 0
    demand  = get_demand(saves, weekly)
    comp    = get_competition(pins, prods)
    mom     = get_momentum(yoy, weekly)
    rating  = get_rating(demand, comp, mom)
    print(f'{kw[:34]:<35} {saves:>8} {demand:<8} {comp:<8} {mom:<8} {rating}')
