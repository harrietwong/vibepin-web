#!/usr/bin/env python3
"""Verify Tests B-E for local crawl setup."""
import os, sys
sys.path.insert(0, r'd:\代码\Pinterest flow\backend')
from dotenv import load_dotenv
load_dotenv(r'd:\代码\Pinterest flow\backend\.env')
from supabase import create_client

sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])

# Test A: pin_samples freshness (already confirmed, re-verify)
r = sb.table('pin_samples').select('scraped_at', count='exact') \
    .order('scraped_at', desc=True).limit(1).execute()
print("=== Test A: pin_samples freshness ===")
print(f"  max(scraped_at): {r.data[0]['scraped_at'] if r.data else 'NULL'}")
print(f"  total rows:      {r.count}")
print()

# Test B: No VPS crawl jobs (check pipeline_runs, look for recent crawl from cloud)
r = sb.table('pipeline_runs').select('id,job_type,status,started_at,created_by') \
    .order('started_at', desc=True).limit(20).execute()
print("=== Test B: Recent pipeline_runs ===")
for row in r.data:
    ts    = (row.get('started_at') or '')[:19]
    jtype = row.get('job_type', '?')
    stat  = row.get('status', '?')
    by    = row.get('created_by', '?')
    flag  = " <-- VPS CRAWL" if (jtype == 'crawl' and by == 'cloud') else ""
    print(f"  {ts}  {jtype:<15} {stat:<12} by={by}{flag}")
print()

# Test C: lastUpdatedAt via viral-pins API response field (check pin_samples max scraped_at)
# The /api/viral-pins endpoint returns pins filtered by scraped_at, so check that
# recent scraped_at rows exist
r = sb.table('pin_samples').select('scraped_at').order('scraped_at', desc=True).limit(5).execute()
print("=== Test C: Recent pin_samples scraped_at (feeds viral-pins lastUpdatedAt) ===")
for row in r.data:
    print(f"  {row['scraped_at']}")
print()

# Test D: STL-score has run recently (check pipeline_runs for stl job)
r = sb.table('pipeline_runs').select('job_type,status,started_at,created_by') \
    .eq('job_type', 'stl-score') \
    .order('started_at', desc=True).limit(5).execute()
print("=== Test D: Recent stl-score runs ===")
if r.data:
    for row in r.data:
        print(f"  {(row.get('started_at') or '')[:19]}  {row['status']}  by={row.get('created_by','?')}")
else:
    print("  No stl-score runs found (check VPS cron)")
print()

# Test E: No authenticated crawl used (check env and pipeline_runs)
crawl_mode = os.getenv('PINTEREST_CRAWL_MODE', 'not set')
auth_enabled = os.getenv('PINTEREST_AUTH_CRAWL_ENABLED', 'not set')
print("=== Test E: Auth crawl disabled ===")
print(f"  PINTEREST_CRAWL_MODE={crawl_mode}")
print(f"  PINTEREST_AUTH_CRAWL_ENABLED={auth_enabled}")
print(f"  Auth used in smoke crawl: {'YES - PROBLEM' if crawl_mode == 'authenticated' else 'NO (anonymous)'}")
