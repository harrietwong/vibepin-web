import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent / 'db'))
from db import select_many

rows = select_many('trend_opportunities_view',
                   order='total_source_saves.desc',
                   limit=20)

print(f'{"keyword":<35} {"category":<10} {"saves":>8} {"pins":>5} {"direct":>6} {"conf":<8} {"vol":<10} {"score"}')
print('-' * 100)
for r in rows:
    kw      = r.get('keyword', '')[:34]
    cat     = r.get('category', '')[:9]
    saves   = r.get('total_source_saves', 0) or 0
    pins    = r.get('linked_pins_count', 0) or 0
    direct  = r.get('direct_pin_count', 0) or 0
    conf    = r.get('data_confidence', '') or ''
    vol     = r.get('search_volume_level', '') or ''
    score   = r.get('opportunity_score', None)
    print(f'{kw:<35} {cat:<10} {saves:>8} {pins:>5} {direct:>6} {conf:<8} {vol:<10} {score}')
