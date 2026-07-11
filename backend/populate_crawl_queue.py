"""
DEPRECATED manual backfill only.

The main daily/cloud pipeline must use trend_fetcher.py -> crawl_queue_ops.py.
This legacy script only reads old source LIKE 'search_trends:%' rows and is not
part of production scheduling. Run with --run-deprecated-backfill if you really
need a one-off historical queue fill.
"""
import sys, os, httpx, argparse
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT / "db"))
from db import upsert, select_many
from dotenv import load_dotenv
load_dotenv()

ap = argparse.ArgumentParser(description="Deprecated manual crawl_queue backfill")
ap.add_argument("--run-deprecated-backfill", action="store_true")
args = ap.parse_args()
if not args.run_deprecated_backfill:
    print(
        "populate_crawl_queue.py is deprecated/manual backfill only. "
        "Use trend_fetcher.py or pipeline.py --step trends for the main pipeline. "
        "Pass --run-deprecated-backfill to run this legacy search_trends path."
    )
    raise SystemExit(0)

url = os.environ["SUPABASE_URL"]
key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
http = httpx.Client(
    base_url=f"{url}/rest/v1/",
    headers={"apikey": key, "Authorization": f"Bearer {key}",
             "Content-Type": "application/json", "Accept": "application/json"},
    timeout=30,
)

# 1. Get all trend_keywords with source = search_trends:* (paginate past 1000-row limit)
print("Fetching search_trends keywords from trend_keywords...")
tk_rows = []
PAGE = 1000
offset = 0
while True:
    resp = http.get("trend_keywords", params={
        "source": "like.search_trends:%",
        "select": "keyword,category,source,yearly_change",
        "limit": str(PAGE),
        "offset": str(offset),
    })
    batch = resp.json()
    tk_rows.extend(batch)
    if len(batch) < PAGE:
        break
    offset += PAGE
print(f"  Found {len(tk_rows)} rows")

# Deduplicate by keyword, keeping highest yearly_change
best: dict[str, dict] = {}
for row in tk_rows:
    kw = row["keyword"]
    if kw not in best or abs(row.get("yearly_change", 0)) > abs(best[kw].get("yearly_change", 0)):
        best[kw] = row
print(f"  {len(best)} unique keywords after dedup")

# 2. Get existing crawl_queue keywords in bulk
print("Fetching existing crawl_queue keywords...")
existing_resp = http.get("crawl_queue", params={"select": "keyword", "limit": "2000"})
existing_kws = {r["keyword"] for r in existing_resp.json()}
print(f"  {len(existing_kws)} already in crawl_queue")

# 3. Find new keywords
new_kws = {kw: row for kw, row in best.items() if kw not in existing_kws}
print(f"  {len(new_kws)} new keywords to add")

# 4. Build and insert crawl_queue rows
if new_kws:
    cq_rows = [{
        "keyword":         kw,
        "category":        row.get("category", "general"),
        "source_interest": row.get("source", "search_trends"),
        "status":          "pending",
        "priority_score":  min(int(abs(row.get("yearly_change", 0)) / 100), 10),
    } for kw, row in new_kws.items()]

    # Insert in chunks of 200
    CHUNK = 200
    total = 0
    for i in range(0, len(cq_rows), CHUNK):
        chunk = cq_rows[i:i+CHUNK]
        upsert("crawl_queue", chunk, on_conflict="keyword")
        total += len(chunk)
        print(f"  [db] inserted chunk {i//CHUNK + 1}: {total}/{len(cq_rows)}")
    print(f"\n[db] {total} crawl_queue entries added")
else:
    print("  Nothing new to add.")

print("\nDone.")
