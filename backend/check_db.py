import sys
sys.path.insert(0, "db")
from db import test_connection, select_many

ok, msg = test_connection()
print(f"Supabase: {ok} - {msg}")

# Check trend_keywords columns and row count
kws = select_many("trend_keywords", limit=3)
print(f"\ntrend_keywords rows (sample 3): {len(kws)}")
if kws:
    print(f"Columns: {list(kws[0].keys())}")
    for r in kws:
        print(f"  [{r.get('category')}] {r.get('keyword')}  status={r.get('status')}  score={r.get('priority_score')}")

# Check pin_samples columns
try:
    ps = select_many("pin_samples", limit=1)
    print(f"\npin_samples columns: {list(ps[0].keys()) if ps else '(empty table)'}")
except Exception as e:
    print(f"\npin_samples error: {e}")
