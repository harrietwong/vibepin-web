import sys
sys.path.insert(0, "C:/vibepinbackend/db")
from db import select_many
try:
    # Test with pipeline's exact order
    items = select_many("crawl_queue", filters={"status": "pending", "category": "digital-products"}, order="priority_score.desc,created_at.asc", limit=3)
    print(f"Got {len(items)} items")
    for i in items[:3]:
        print(f"  {i.get('keyword')}, priority={i.get('priority_score')}")
except Exception as e:
    print(f"Error: {e}")
