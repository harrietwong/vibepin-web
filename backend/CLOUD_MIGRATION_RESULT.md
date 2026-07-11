# Cloud Pipeline Migration Result

The VibePin backend data pipeline has been migrated from the Windows local scheduler to the Alibaba Cloud VPS.

## Environment

- VPS: Alibaba Cloud Virginia
- IP: `47.89.181.103`
- OS: Ubuntu 24.04
- Backend path: `/opt/vibepin/backend`

## Validated jobs

- smoke: passed
- trends: passed
- crawl: passed
- stl-score: passed
- daily cron: passed

## Final database checks

- pipeline_locks: 0 active locks
- pin_products: 2246 rows
- crawl_queue: 0 pending rows
- duplicate crawl keywords: 0
- L3 trend labels use `pinterest_typeahead_estimated` / `estimated` / `low`
- L3 `search_volume` is null as expected

## Operational result

The VPS worker can now maintain Product Ideas and Pin Ideas independently. The Windows local scheduled task can be disabled after confirming several successful daily cron runs.

## Verification

- Last verified: **2026-06-10** (Supabase `check_pipeline_status.py`)
- Last successful daily cron: 2026-06-10 01:00–03:53 UTC
- Last successful stl-score: 2026-06-09 18:58 UTC
- `pin_products.scraped_at`: 2026-06-10 05:46 UTC

## Related docs

- Full deploy log: [`VPS_DEPLOY_LOG.md`](VPS_DEPLOY_LOG.md)
- Deploy checklist: [`CLOUD_DEPLOY_CHECKLIST.md`](CLOUD_DEPLOY_CHECKLIST.md)
