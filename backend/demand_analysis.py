"""
demand_analysis.py — Analyze demand signals across all categories.
Uses: yearly_change, weekly_change, search_volume_level, pin save_count, product save_count.
"""
import sys
sys.path.insert(0, 'db')
from db import _get_http, select_many

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

http = _get_http()

# ── Load data (paginated) ────────────────────────────────────────────────────
def fetch_all(table, params=None, page=1000):
    rows = []
    offset = 0
    while True:
        p = {'limit': str(page), 'offset': str(offset), **(params or {})}
        batch = http.get(table, params=p).json()
        rows.extend(batch)
        if len(batch) < page:
            break
        offset += page
    return rows

kws  = fetch_all('trend_keywords', {'select': 'id,keyword,category,yearly_change,weekly_change,search_volume_level'})
kw_map = {k['id']: k for k in kws}
kw_kw_map = {k['keyword']: k for k in kws}

print(f"Loaded {len(kws)} trend_keywords")

all_pins = fetch_all('pin_samples', {'select': 'trend_keyword_id,save_count'})
print(f"Loaded {len(all_pins)} pin_samples")

prods = fetch_all('pin_products', {'select': 'seed_keyword,save_count'})
print(f"Loaded {len(prods)} pin_products")

# ── Aggregate by keyword ────────────────────────────────────────────────────────
kw_pins  = {}   # keyword_id -> list of save_counts
for p in all_pins:
    tid = p.get('trend_keyword_id')
    if tid:
        if tid not in kw_pins:
            kw_pins[tid] = []
        kw_pins[tid].append(p.get('save_count') or 0)

kw_prods = {}  # keyword -> product count + max saves
for p in prods:
    kw = p.get('seed_keyword', '')
    if kw not in kw_prods:
        kw_prods[kw] = {'count': 0, 'max_saves': 0}
    kw_prods[kw]['count'] += 1
    kw_prods[kw]['max_saves'] = max(kw_prods[kw]['max_saves'], p.get('save_count') or 0)

# ── Score each keyword ──────────────────────────────────────────────────────────
VOL_SCORE = {'high': 3, 'medium': 2, 'low': 1}

scored = []
for k in kws:
    kid = k['id']
    kw  = k['keyword']
    cat = k['category']
    yoy = k.get('yearly_change') or 0
    wow = k.get('weekly_change') or 0
    vol = VOL_SCORE.get(k.get('search_volume_level') or 'low', 1)

    pin_saves = kw_pins.get(kid, [])
    avg_pin_saves = sum(pin_saves) / len(pin_saves) if pin_saves else 0
    max_pin_saves = max(pin_saves) if pin_saves else 0
    pin_count = len(pin_saves)

    prod_info = kw_prods.get(kw, {})
    prod_count = prod_info.get('count', 0)
    prod_saves = prod_info.get('max_saves', 0)

    # Demand score: weighted combination
    # - Search volume level  (Pinterest official): weight 40
    # - YoY growth (capped): weight 30
    # - Avg pin saves:        weight 20
    # - Has products:         weight 10
    yoy_norm  = min(abs(yoy), 500) / 500 * 100 if yoy > 0 else 0
    save_norm = min(avg_pin_saves, 50000) / 50000 * 100
    prod_norm = min(prod_count * 10, 100)

    demand_score = (vol / 3 * 40) + (yoy_norm / 100 * 30) + (save_norm / 100 * 20) + (prod_norm / 100 * 10)

    scored.append({
        'keyword':    kw,
        'category':   cat,
        'vol':        k.get('search_volume_level') or 'low',
        'yoy':        yoy,
        'wow':        wow,
        'pin_count':  pin_count,
        'avg_saves':  int(avg_pin_saves),
        'max_saves':  max_pin_saves,
        'products':   prod_count,
        'demand':     round(demand_score, 1),
    })

scored.sort(key=lambda x: -x['demand'])

# ── Print top keywords ─────────────────────────────────────────────────────────
print(f"\n{'='*85}")
print(f"  TOP 40 HIGH-DEMAND KEYWORDS (by demand score)")
print(f"{'='*85}")
print(f"  {'keyword':<35} {'cat':<12} {'vol':<7} {'yoy':>7} {'pins':>5} {'avg_sv':>7} {'prods':>6} {'score':>6}")
print(f"  {'-'*85}")
for r in scored[:40]:
    yoy_str = f"+{r['yoy']:.0f}%" if r['yoy'] >= 0 else f"{r['yoy']:.0f}%"
    print(f"  {r['keyword']:<35} {r['category']:<12} {r['vol']:<7} {yoy_str:>7} {r['pin_count']:>5} {r['avg_saves']:>7,} {r['products']:>6} {r['demand']:>6.1f}")

# ── Category summary ────────────────────────────────────────────────────────────
print(f"\n{'='*70}")
print(f"  DEMAND BY CATEGORY (avg score of top 5 keywords)")
print(f"{'='*70}")

cat_scores = {}
for r in scored:
    c = r['category']
    if c not in cat_scores:
        cat_scores[c] = []
    cat_scores[c].append(r['demand'])

cat_summary = []
for cat, scores in cat_scores.items():
    top5 = sorted(scores, reverse=True)[:5]
    cat_summary.append({
        'category': cat,
        'avg_top5': round(sum(top5) / len(top5), 1),
        'max':      round(max(scores), 1),
        'kw_count': len(scores),
        'high_vol': sum(1 for r in scored if r['category'] == cat and r['vol'] == 'high'),
    })

cat_summary.sort(key=lambda x: -x['avg_top5'])
print(f"  {'category':<18} {'avg_score':>9} {'max_score':>9} {'high_vol_kws':>12} {'keywords':>8}")
print(f"  {'-'*60}")
for c in cat_summary:
    print(f"  {c['category']:<18} {c['avg_top5']:>9.1f} {c['max']:>9.1f} {c['high_vol']:>12} {c['kw_count']:>8}")

# ── Gaps: categories with no products ─────────────────────────────────────────
print(f"\n{'='*70}")
print(f"  GAPS — categories with pins but no products (need Etsy/STL)")
print(f"{'='*70}")
gap_cats = {}
for r in scored:
    if r['products'] == 0 and r['pin_count'] > 0:
        c = r['category']
        if c not in gap_cats:
            gap_cats[c] = {'kws': 0, 'total_pins': 0, 'best': r}
        gap_cats[c]['kws'] += 1
        gap_cats[c]['total_pins'] += r['pin_count']
        if r['demand'] > gap_cats[c]['best']['demand']:
            gap_cats[c]['best'] = r

for cat, info in sorted(gap_cats.items(), key=lambda x: -x[1]['total_pins']):
    print(f"  {cat:<18}  {info['total_pins']:>5} pins  {info['kws']} kws  best: \"{info['best']['keyword']}\" ({info['best']['vol']} vol, yoy={info['best']['yoy']:+.0f}%)")
