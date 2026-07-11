# VibePin — Manual Steps Only

Migrations **already applied** on your Supabase project. Skip migration steps unless a smoke check fails.

---

## 1. Choose a cloud host

| Option | Best for | Difficulty | Long crawls |
|--------|----------|------------|-------------|
| **VPS** (Hetzner, DigitalOcean, Linode) | Production reliability, full cron control | Medium | ✅ Yes |
| **Docker on VPS** | Same as VPS + reproducible image | Medium | ✅ Yes |
| **Render** cron job | Easiest UI, no server admin | Easy | ⚠️ Timeout limits |
| **Railway** cron | Simple deploy from GitHub | Easy | ⚠️ Usage billing |
| **Fly.io** machine + cron | Global edge, Docker-native | Medium | ✅ Yes |
| **GitHub Actions** schedule | Temporary / backup only | Easy | ❌ 6h job limit |

**Recommendation:** VPS or Docker on VPS for daily crawl + STL. Use Render/Railway only if you want the simplest UI and accept shorter crawl batches.

---

## 2. Add environment variables (platform secrets UI)

**Required**

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

**Optional**

- `DATABASE_URL` — direct Postgres (debugging / migrations)
- `OPENAI_API_KEY` or `LINAPI_KEY` — AI features only (not required for crawl pipeline)
- `PINTEREST_APP_ID` / `PINTEREST_APP_SECRET` — OAuth only
- `ENABLE_PINTEREST_TRENDS_L1=false` — if Trends L1 API returns 404
- `CRAWL_LIMIT_KEYWORDS=80` — override crawl batch size

Copy template: [`.env.example`](.env.example). **Never commit real values.**

---

## 3. Deploy backend code

**Windows → Alibaba VPS (one command)**

```powershell
cd backend
copy deploy.env.example deploy.env
# Edit deploy.env: set VPS_PASSWORD (VPS_HOST already 47.89.181.103)

cd scripts
.\deploy_from_windows.ps1
```

`deploy.env` holds VPS IP/user/password — **never commit**. Pipeline secrets stay in `backend/.env`.

**Docker (recommended)**

```bash
cd backend
./scripts/docker_build.sh
./scripts/docker_smoke.sh .env
```

**VPS without Docker**

```bash
cd /app/backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-cloud.txt
python run_worker.py --job smoke
```

---

## 4. Run smoke on the cloud host

```bash
python run_worker.py --job smoke
```

All lines must show ✅. If ❌, read **Suggested fix** in output.

---

## 5. Run small pipeline validation (cloud or local)

```bash
python run_worker.py --job trends
python run_worker.py --job crawl --limit-keywords 20
python run_worker.py --job stl-score
python scripts/check_pipeline_status.py
```

Confirm:

- `pipeline_runs` has `completed` rows for trends / crawl / stl-score
- `crawl_queue` pending + completed counts move
- `pin_products` and `pin_samples` counts > 0
- No job stuck in `running`; `pipeline_locks` empty after jobs finish

---

## 6. Verify app data

Open VibePin and check:

- Product Ideas page shows cards
- Create Pins → Product Ideas tab loads (no endless skeletons)
- Create Pins → Pin Ideas tab loads
- Freshness timestamp visible

---

## 7. Schedule cron (after steps 4–6 pass)

**Split (recommended)**

```cron
30 8  * * *  cd /app/backend && python run_worker.py --job trends
0  9  * * *  cd /app/backend && python run_worker.py --job crawl --limit-keywords 80
0  10 * * *  cd /app/backend && python run_worker.py --job crawl --limit-keywords 80
30 11 * * *  cd /app/backend && python run_worker.py --job stl-score
```

**Single daily (beginner)**

```cron
0 9 * * * cd /app/backend && python run_worker.py --job daily
```

---

## 8. Disable Windows tasks (only after cloud pipeline verified)

On your Windows PC, disable:

- 9:00 crawl task
- 10:00 crawl task
- 11:00 `vibepinrun.bat`
- Old Daily Pipeline task

Keep local `.ps1` scripts for manual dev runs only.

---

## Quick reference

| Task | Command |
|------|---------|
| Smoke test | `python run_worker.py --job smoke` |
| Status | `python scripts/check_pipeline_status.py` |
| Docker build | `./scripts/docker_build.sh` |
| Docker smoke | `./scripts/docker_smoke.sh .env` |
| Full guide | [`CLOUD_DEPLOY_CHECKLIST.md`](CLOUD_DEPLOY_CHECKLIST.md) |
