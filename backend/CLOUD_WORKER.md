# VibePin Cloud Worker

Production data refresh runs on a **cloud VM / VPS / worker** — not your local PC.

Local Windows `.ps1` scripts are **development-only** (manual testing).

**New to cloud deploy?**

- **[DEPLOY_MANUAL_STEPS.md](DEPLOY_MANUAL_STEPS.md)** — concise manual-only checklist  
- **[CLOUD_DEPLOY_CHECKLIST.md](CLOUD_DEPLOY_CHECKLIST.md)** — full guide + troubleshooting  

**Docker one-liners:** `./scripts/docker_build.sh` then `./scripts/docker_smoke.sh .env`

## Quick start (Linux VPS)

```bash
cd /app/backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-cloud.txt   # or pip install httpx curl_cffi python-dotenv

cp .env.example .env   # set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
psql $DATABASE_URL -f db/migrate_v24.sql   # pipeline_runs + pipeline_locks

chmod +x scripts/*.sh
```

## Entry point

```bash
python run_worker.py --job trends
python run_worker.py --job crawl --limit-keywords 80
python run_worker.py --job stl-score
python run_worker.py --job daily
python run_worker.py --job smoke
python scripts/check_pipeline_status.py
```

Shell wrappers (cron-friendly):

| Script | Job |
|--------|-----|
| `scripts/run_trends_daily.sh` | trends |
| `scripts/run_crawl_daily.sh` | crawl |
| `scripts/run_stl_score_daily.sh` | stl-score |
| `scripts/run_daily_pipeline.sh` | daily (all steps) |

## Recommended cron (Option A — VPS)

```cron
30 8 * * *  cd /app/backend && ./scripts/run_trends_daily.sh >> logs/cron.log 2>&1
0  9 * * *  cd /app/backend && ./scripts/run_crawl_daily.sh >> logs/cron.log 2>&1
0 10 * * *  cd /app/backend && ./scripts/run_crawl_daily.sh >> logs/cron.log 2>&1
30 11 * * * cd /app/backend && ./scripts/run_stl_score_daily.sh >> logs/cron.log 2>&1
```

Or single daily job:

```cron
0 8 * * * cd /app/backend && ./scripts/run_daily_pipeline.sh >> logs/cron.log 2>&1
```

## Option B — GitHub Actions

Suitable for **trends** or short **stl-score** only. Long crawls may hit job timeouts.

```yaml
on:
  schedule:
    - cron: '30 8 * * *'
jobs:
  trends:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pip install httpx curl_cffi python-dotenv
      - run: cd backend && python run_worker.py --job trends
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
```

## Option C — Managed worker

Use the same `run_worker.py` commands on Railway, Fly.io, Render cron, etc.

## Reliability features

- **`pipeline_runs`** — every job logged (status, duration, keywords processed)
- **`pipeline_locks`** — prevents overlapping trends/crawl/stl/daily runs; stale locks expire automatically
- **Incremental crawl** — `next_crawl_at`, priority ordering, retry backoff
- **Concurrency** — default 3, max 5; one failed keyword does not crash the job

## Environment variables

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | PostgREST base |
| `SUPABASE_SERVICE_ROLE_KEY` | DB writes |
| `ENABLE_PINTEREST_TRENDS_L1` | `false` to skip 404-prone L1 API |
| `ENABLE_PINTEREST_RESOURCE_L2` | `false` to skip L2 |
| `CRAWL_LIMIT_KEYWORDS` | Override crawl batch size (default 80) |

## Frontend data

The web app reads **prepared API responses** (`/api/products/top`, `/api/viral-pins`), not live crawler output.
Responses include `lastUpdatedAt`, `source`, `itemCount` for freshness indicators.
