import json, sys
sys.path.insert(0, r'd:\代码\Pinterest flow\backend')
from report_utils import fetch_all

opps = fetch_all('opportunities', columns='canonical_keyword,category,primary_label,trend_state,internal_reason_codes,is_seed', filters={'is_seed': 'is.false'})

launch = []
needs = []
insight = []
for o in opps:
    irc = o.get('internal_reason_codes')
    if isinstance(irc, str):
        try: irc = json.loads(irc)
        except: continue
    rd = irc.get('readiness', {}) if isinstance(irc, dict) else {}
    status = rd.get('readinessStatus', '')
    if status == 'launch_ready' and len(launch) < 2:
        launch.append({'keyword': o['canonical_keyword'], 'category': o['category'],
                       'primary_label': o.get('primary_label'), 'trend_state': o.get('trend_state'), 'readiness': rd})
    if status in ('needs_products',) and rd.get('linkedProductsCount', 0) == 0 and len(needs) < 1:
        needs.append({'keyword': o['canonical_keyword'], 'category': o['category'],
                      'primary_label': o.get('primary_label'), 'trend_state': o.get('trend_state'), 'readiness': rd})
    if status == 'insight_only' and len(insight) < 1:
        insight.append({'keyword': o['canonical_keyword'], 'category': o['category'],
                        'primary_label': o.get('primary_label'), 'trend_state': o.get('trend_state'), 'readiness': rd})

print('=== LAUNCH READY ===')
for x in launch:
    print(json.dumps(x, indent=2, ensure_ascii=False))
print()
print('=== NEEDS PRODUCTS (0 supply) ===')
for x in needs:
    print(json.dumps(x, indent=2, ensure_ascii=False))
print()
print('=== INSIGHT ONLY ===')
for x in insight:
    print(json.dumps(x, indent=2, ensure_ascii=False))
