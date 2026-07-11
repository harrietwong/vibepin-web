# VibePin Cloud Deploy Checklist

Use this guide to move the data pipeline off your Windows PC onto a **cloud worker** — a remote computer that stays online and runs VibePin jobs on a schedule.

Your local PC can sleep or shut down; the cloud worker keeps refreshing Product Ideas and Pin Ideas.

---

## What is a cloud worker?

A **cloud worker** is simply a small Linux server (VPS) or managed platform (Railway, Render, Fly.io, etc.) that runs:

```bash
python run_worker.py --job trends
python run_worker.py --job crawl
python run_worker.py --job stl-score
```

You do **not** need to understand Linux deeply. Follow the steps below, run one smoke command, and verify the app.

Local Windows `.ps1` / `.bat` scripts are **development only** — not for production.

---

## Manual Step 1 — Supabase migrations

> **Already done on this project** (`migrate_v23.sql` + `migrate_v24.sql`).  
> Re-run only if smoke reports missing tables/columns.

If needed, run in [Supabase SQL Editor](https://supabase.com/dashboard):

1. [`db/migrate_v23.sql`](db/migrate_v23.sql)  
2. [`db/migrate_v24.sql`](db/migrate_v24.sql)  

---

## Manual Step 2 — Choose a cloud host

| Platform | Difficulty | Cost | Long crawls | Notes |
|----------|------------|------|-------------|-------|
| **VPS** (Hetzner ~€4/mo, DigitalOcean, Linode) | Medium | Low | ✅ Best | Full cron control; recommended for production |
| **Docker on VPS** | Medium | Low | ✅ Best | Use `scripts/docker_build.sh` + `docker_smoke.sh` |
| **Render** cron | Easy | Free tier limited | ⚠️ Job timeouts | Good UI; use `--limit-keywords 40` |
| **Railway** cron | Easy | Pay-as-you-go | ⚠️ Billing | Connect GitHub repo, add cron service |
| **Fly.io** Machines | Medium | Low | ✅ Good | `fly deploy` + `fly machine cron` |
| **GitHub Actions** | Easy | Free minutes | ❌ 6h max | Temporary scheduler only, not primary |

**Short manual checklist:** see [`DEPLOY_MANUAL_STEPS.md`](DEPLOY_MANUAL_STEPS.md).

Pick **one** option:

Minimum: 1 vCPU, 1–2 GB RAM, outbound internet, Python 3.12+ or Docker.

**Docker quick start (one-command scripts):**

```bash
cd backend
chmod +x scripts/docker_build.sh scripts/docker_smoke.sh
./scripts/docker_build.sh
./scripts/docker_smoke.sh .env
```

Equivalent manual commands:

```bash
docker build -t vibepin-worker .
docker run --rm --env-file .env vibepin-worker --job smoke
```

> **Local note:** Docker verification was skipped on the dev machine (Docker not installed). Run the commands above on a Docker-capable host.

**Bare metal / VPS quick start:**

```bash
cd /app/backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-cloud.txt
chmod +x scripts/*.sh
```

Copy the `backend/` folder to the server (git clone, rsync, or Docker image).

---

## Manual Step 3 — Add environment variables

Set these as **secrets** in your cloud platform. Never commit real values to git.

### Required

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Your Supabase project URL (`https://xxx.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (full DB access for pipeline writes) |

### Optional but useful

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Direct PostgreSQL URL (migrations, debugging) |
| `OPENAI_API_KEY` / `LINAPI_KEY` | AI metadata or image generation (not required for crawl pipeline) |
| `PINTEREST_APP_ID` / `PINTEREST_APP_SECRET` | Pinterest OAuth (not required for basic crawl) |
| `ENABLE_PINTEREST_TRENDS_L1` | Set `false` if official Trends API returns 404 |
| `ENABLE_PINTEREST_RESOURCE_L2` | Set `false` to skip L2 resource layer |
| `CRAWL_LIMIT_KEYWORDS` | Override default crawl batch size (80) |

Copy from [`.env.example`](.env.example) as a template — fill in your own values on the server.

---

## Manual Step 4 — Run the smoke test

One command verifies env, database, migrations, locks, and a **small** trends + crawl sample:

```bash
cd /app/backend
python run_worker.py --job smoke
```

Or with Docker:

```bash
docker run --rm --env-file .env vibepin-worker --job smoke
```

Or:

```bash
./scripts/run_worker.sh --job smoke
```

**Expected output (all ✅):**

```
VibePin Cloud Smoke Test
✅ Env vars loaded
✅ DB connected
✅ pipeline_runs exists
✅ crawl_queue exists
✅ trend_keywords exists
✅ crawl_queue migration columns — last_crawled_at, next_crawl_at
✅ trend_keywords migration columns — data_quality, confidence
✅ locks working — acquire/release OK
✅ trends step ran — N keywords
✅ pending crawl items: 24
✅ crawl smoke completed: 3 keywords
Done.
```

If anything shows ❌, read the **Suggested fix** line and re-run after fixing.

---

## Manual Step 5 — Run a real pipeline (after smoke passes)

Run each step once manually to confirm production-scale jobs work:

```bash
python run_worker.py --job trends
python run_worker.py --job crawl --limit-keywords 20
python run_worker.py --job stl-score
```

Check status anytime:

```bash
python scripts/check_pipeline_status.py
```

---

## Manual Step 6 — Verify in the app

Open VibePin and confirm:

- **Product Ideas** page shows products  
- **Create Pins → Product Ideas** shows items (not endless skeletons)  
- **Create Pins → Pin Ideas** shows pins  
- **Data freshness** timestamp appears (e.g. “Updated 2h ago”)  

---

## Manual Step 7 — Schedule cron (keep worker running daily)

### Option A — Split cron (better visibility)

Each job runs separately; easier to see which step failed in `pipeline_runs`:

```cron
30 8  * * *  cd /app/backend && python run_worker.py --job trends
0  9  * * *  cd /app/backend && python run_worker.py --job crawl --limit-keywords 80
0  10 * * *  cd /app/backend && python run_worker.py --job crawl --limit-keywords 80
30 11 * * *  cd /app/backend && python run_worker.py --job stl-score
```

Shell wrappers (same jobs):

```cron
30 8 * * * cd /app/backend && ./scripts/run_trends_daily.sh >> logs/cron.log 2>&1
```

### Option B — Single daily command (easier for beginners)

One cron entry runs trends → crawl → catch-up crawl → stl-score → view check:

```cron
0 9 * * * cd /app/backend && python run_worker.py --job daily
```

Or:

```cron
0 9 * * * cd /app/backend && ./scripts/run_daily_pipeline.sh >> logs/cron.log 2>&1
```

**Split cron** = easier debugging per step.  
**Daily single command** = fewer moving parts when starting out.

---

## Manual Step 8 — Disable old Windows tasks (only after cloud is verified)

After Steps 4–6 pass on the cloud worker, disable these on your Windows PC:

- 9:00 crawl task  
- 10:00 crawl task  
- 11:00 `vibepinrun.bat`  
- Old “Daily Pipeline” scheduled task  

Keep local `.ps1` scripts for **manual dev runs only**.

---

## Monitoring

| Command | What it shows |
|---------|----------------|
| `python scripts/check_pipeline_status.py` | Last runs, queue counts, product/pin counts, timestamps |
| Supabase → `pipeline_runs` table | Every job: status, duration, keywords processed |
| Supabase → `pipeline_locks` table | Active locks (auto-expire if worker crashes) |

---

## Files reference

| File | Purpose |
|------|---------|
| `run_worker.py` | Main entry: `--job trends\|crawl\|stl-score\|daily\|smoke` |
| `Dockerfile` | Container image for cloud deploy |
| `scripts/run_worker.sh` | Cron-friendly wrapper |
| `scripts/check_pipeline_status.py` | Human-readable pipeline health |
| `CLOUD_WORKER.md` | Technical architecture notes |
| `requirements-cloud.txt` | Minimal Python deps for worker |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Smoke: missing env vars | Add `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` to platform secrets |
| Smoke: `pipeline_runs` not found | Run `migrate_v24.sql` |
| Smoke: migration columns missing | Run `migrate_v23.sql` |
| Job skipped — lock held | Wait for lock expiry or delete stale row in `pipeline_locks` |
| Trends 404 | Set `ENABLE_PINTEREST_TRENDS_L1=false` |
| Empty Product/Pin Ideas | Run crawl + stl-score; check `check_pipeline_status.py` |

---

## Security

- Do **not** commit `.env` or real API keys.  
- Use platform secret managers for production.  
- Service role key has full DB access — server-only, never in frontend.
