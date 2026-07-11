# VPS Deployment Log

Cloud worker deployment completed **2026-06-10**. Pipeline fully verified on VPS.

> Executive summary: [`CLOUD_MIGRATION_RESULT.md`](CLOUD_MIGRATION_RESULT.md)

| Field | Value |
|-------|-------|
| Server IP | `47.89.181.103` (Alibaba Cloud, Ubuntu 24.04, Virginia) |
| SSH user | `root` |
| Deploy path | `/opt/vibepin/backend` |
| Python venv | `/opt/vibepin/backend/.venv` |
| Migrations | Already applied (v23 + v24) |
| Deploy config | `backend/deploy.env` (copy from `deploy.env.example`, gitignored) |
| Deploy script (primary) | `backend/scripts/deploy_vps_paramiko.py` |
| Deploy script (alt) | `backend/scripts/deploy_from_windows.ps1` (Posh-SSH; paramiko preferred) |

## Environment variables (names only)

Required:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Recommended:

- `ENABLE_PINTEREST_TRENDS_L1=false`
- `ENABLE_PINTEREST_RESOURCE_L2=false`

Optional (not blocking worker):

- `DATABASE_URL`
- `LINAPI_KEY` / `OPENAI_API_KEY`
- `PINTEREST_APP_ID` / `PINTEREST_APP_SECRET`

---

## What was done (cloud integration summary)

### 1. Deploy prep & config

- Confirmed Supabase migrations v23 + v24 already applied (no re-run).
- Created `deploy.env.example` / `deploy.env` (VPS IP, SSH creds; gitignored).
- Synced local `backend/.env` (Supabase secrets) to VPS `/opt/vibepin/backend/.env`.
- Wrote deploy docs: `CLOUD_DEPLOY_CHECKLIST.md`, `DEPLOY_MANUAL_STEPS.md`.
- Added `playwright` to `requirements-cloud.txt`; prepared `Dockerfile` (not verified locally — no Docker).

### 2. Code deploy to VPS

- **Primary:** `deploy_vps_paramiko.py` — zip bundle from Windows, SSH upload, unzip to `/opt/vibepin/backend`.
  - Excludes `pinterest_profile`, `vibe_library` (avoids 100MB+ zip from browser cache).
- **Bootstrap:** `deploy_vps.sh` — venv, `pip install -r requirements-cloud.txt`, smoke.
- Fixed Windows CRLF in `.sh` scripts (`sed -i 's/\r$//'` on VPS).
- Fixed missing `unzip` on VPS; fixed `load_dotenv` path in bootstrap.

### 3. Remote ops scripts (Windows → VPS)

| Script | Purpose |
|--------|---------|
| `remote_bootstrap.py` | VPS init |
| `remote_verify.py` / `remote_cloud_verify.py` | Full cloud pipeline verify |
| `remote_status.py` | Remote pipeline status |
| `remote_run_stl.py` / `remote_fix_stl.py` | Run / fix stl-score |
| `remote_clear_and_stl.py` | Clear locks + background stl (`nohup`) |
| `remote_poll_stl.py` | Poll until stl finishes |
| `remote_install_cron.py` | Install cron |
| `clear_stale_runs.py` | Clear expired locks + stale `running` runs |
| `verify_db_labels.py` | trend labels + crawl_queue checks |
| `check_pipeline_status.py` | Local Supabase pipeline status (most used) |

### 4. Pipeline validation

**Local baseline (pre-deploy):**

- smoke ✅, trends ✅, crawl (20 keywords) ✅ → 423 pins
- Backend tests 54/54 passing

**VPS step-by-step:**

| Step | Status | Timestamp (UTC) | Notes |
|------|--------|-----------------|-------|
| smoke | ✅ | 2026-06-08 | All checks OK |
| trends | ✅ | 2026-06-09 ~02:30 | 96 L3 keywords |
| crawl | ✅ | 2026-06-09 ~02:34 | Queue empty → 0 keywords, status completed |
| stl-score | ✅ | 2026-06-09 03:40 → 18:58 | ~15 hours; Playwright Shop the Look |
| daily (cron) | ✅ | 2026-06-10 01:00 → 03:53 | First automatic daily run |

### 5. Issues encountered & fixes

| Issue | Fix |
|-------|-----|
| `deploy.env` password read empty | User hadn't saved file; parse with `utf-8-sig` |
| Posh-SSH install hung | Switched to paramiko (`deploy_vps_paramiko.py`) |
| Zip too large (~123MB) | Exclude `pinterest_profile`, `vibe_library` |
| VPS missing `unzip` | `apt-get install unzip` in deploy script |
| `.sh` CRLF line endings | `sed -i 's/\r$//'` on VPS |
| stl: `ModuleNotFoundError: playwright` | Added to `requirements-cloud.txt`, pip install on VPS |
| stl: missing `libatk-1.0.so.0` etc. | `playwright install-deps chromium` |
| stl skipped — lock held | Fixed `clear_stale_runs.py` (PostgREST: delete per `lock_name`, not whole table) |
| SSH timeout on long stl | Run via `nohup` → `logs/stl_manual.log` |
| `verify_db_labels.py` wrong column | `updated_at` → `last_updated_at` |
| SSH intermittent banner timeout | Query Supabase from local `check_pipeline_status.py` when SSH fails |

### 6. Cron

- Installed: `0 9 * * *` UTC → `run_worker.py --job daily`
- ≈ Beijing 17:00 (16:00 depending on DST)
- Verified automatic run on 2026-06-10.
- ⚠️ **Gap (2026-06-16):** `--job daily` does NOT run `classify` / `opportunities`, so Pin Ideas / Product Ideas don't refresh on the VPS. See the 2026-06-16 entry under [Windows tasks](#2026-06-16--pin-ideas--product-ideas-were-not-refreshing-classify--opportunities-never-scheduled). Add `0 12 * * * → bash scripts/run_classify_daily.sh` or extend `job_daily`.

---

## Commands run

```bash
# bootstrap (on VPS)
bash scripts/deploy_vps.sh

# manual validation (VPS)
.venv/bin/python run_worker.py --job smoke
.venv/bin/python run_worker.py --job trends
.venv/bin/python run_worker.py --job crawl --limit-keywords 20
.venv/bin/python run_worker.py --job stl-score   # or nohup for long runs

# Playwright (stl-score dependency)
pip install playwright
playwright install chromium
playwright install-deps chromium

# status / verify (local or VPS)
python scripts/check_pipeline_status.py
python scripts/verify_db_labels.py

# cron
bash scripts/install_cron_daily.sh
```

---

## Final verification (2026-06-10)

| Check | Result |
|-------|--------|
| VPS smoke / trends / crawl / stl | All ✅ |
| daily cron auto-run | ✅ 2026-06-10 01:00–03:53 UTC |
| `pipeline_locks` active | 0 |
| `pin_products` count | 2246 |
| `pin_products.scraped_at` | 2026-06-10 05:46 UTC |
| `pin_samples` | 12461 |
| `crawl_queue` | pending 0, completed 1365, failed 0, no duplicate keywords |
| L3 labels | 62 rows `pinterest_typeahead_estimated` / L3 / estimated / low, `search_volume=null` ✅ |

**One-liner:** VibePin data pipeline moved from Windows PC to Alibaba Cloud VPS; full pipeline verified including 15h stl-score; daily cron confirmed. Cloud worker is production-ready.

---

## Windows tasks (pre-cloud → disable after VPS verified)

After **2026-06-10**, the Alibaba Cloud VPS cron replaces these. **Disable** (do not delete scripts) once cloud `daily` cron is stable for 2–3 days.

Full dev scheduling reference: [`SCHEDULING.md`](SCHEDULING.md)

### Intended split schedule (last production layout on Windows)

| Local time | Script | Pipeline step | Notes |
|------------|--------|---------------|-------|
| **02:00** | [`scripts/local_crawl_nightly.ps1`](scripts/local_crawl_nightly.ps1) | `run_worker.py --job crawl` (50 kw) | Residential IP crawl; logs `logs/local_crawl_*.log`; 90 min timeout |
| **08:30** | [`run_trends_daily.ps1`](run_trends_daily.ps1) | `pipeline.py --step trends --top 30` | Replenish `trend_keywords` + `crawl_queue` |
| **09:00** | [`run_crawl_daily.ps1`](run_crawl_daily.ps1) | `pipeline.py --step crawl --limit-keywords 80` | Main crawl |
| **10:00** | [`run_crawl_daily.ps1`](run_crawl_daily.ps1) | same as 09:00 | Catch-up crawl |
| **11:30** | [`run_stl_score_daily.ps1`](run_stl_score_daily.ps1) | `pipeline.py --step stl` + `--step score` | Shop the Look + product scoring (**no crawl**) |

Logs for 08:30–11:30 jobs: `backend/logs/daily/pipeline_YYYYMMDD_HHMM_*.log`

Python used by split scripts: `C:\Users\44740\AppData\Local\Python\pythoncore-3.14-64\python.exe`

### 2026-06-16 — Pin Ideas / Product Ideas were not refreshing (classify + opportunities never scheduled)

**Symptom:** Pin Idea and Product Idea data stopped updating.

**Root cause:** The steps that turn raw crawl/product data into those features were **not part of any scheduled job** — not the Windows tasks, not the VPS `--job daily` cron:

| Feature | Pipeline step | Writes | Was scheduled? |
|---------|---------------|--------|----------------|
| Product Ideas | Step 7 `classify_product_signals` (`--step classify`) | `pin_products.product_type` / `source_platform` | ❌ no |
| Pin Ideas | Step 8 `classify_reference_pins` (`--step classify`) | `pin_samples.is_reference_eligible` | ❌ no |
| Product Ideas / Opportunities | Step 9 `generate_opportunities` (`--step opportunities`) | `opportunities` + relation tables | ❌ no |

`pipeline.py` only runs these when `--step` is `all`, `classify`, or `opportunities` ([pipeline.py:600-645](pipeline.py)). The Windows tasks run only `crawl`/`stl`/`score`; `run_worker.py --job daily` runs `trends → crawl → stl-score → views` ([run_worker.py:104](run_worker.py)) — neither calls classify or opportunities.

**Fix — new daily step:**

| Local time | Script | Pipeline step | Notes |
|------------|--------|---------------|-------|
| **12:00** | [`run_classify_daily.ps1`](run_classify_daily.ps1) | `pipeline.py --step classify` + `--step opportunities` | Pin Ideas + Product Ideas; runs after stl/score |

- Windows Task Scheduler entry registered 2026-06-16: **`VibePin-Classify-Daily`** (daily 12:00, `State=Ready`). Writes to the **same Supabase** (`jaxteelkecvlozdrdoog`) as the VPS, so it refreshes live data when the PC is on at 12:00.
- Cloud parity script: [`scripts/run_classify_daily.sh`](scripts/run_classify_daily.sh).
- Logs: `backend/logs/daily/pipeline_YYYYMMDD_HHMM_classify.log` + `_opportunities.log`.

**One-time backfill run 2026-06-16 (~10:48 local):**
- `--step classify`: product signals `physical=437 digital=563` (top platforms etsy=242, amazon=38, tpt=19…) ✅; reference pins `0` processed — all eligible pins (419 `is_reference_eligible=true`) were already classified, `is_reference_eligible IS NULL = 0`.
- `--step opportunities`: regenerated the `opportunities` table.

**Still needed for *new* Pin Ideas:** newest `pin_samples.scraped_at` = **2026-06-11**. Classify only labels *unclassified* pins, so without fresh crawl there are no new references to add. Keep the crawl (`run_crawl_daily` / VPS `--job daily`) running so new high-save pins flow in, then this 12:00 classify step turns them into Pin Ideas.

> **Production TODO (VPS):** the `0 9 * * *` `--job daily` cron does **not** run classify/opportunities. Either add a cron line `0 12 * * * → bash scripts/run_classify_daily.sh`, or extend `run_worker.py job_daily` to append classify + opportunities. Until then, the Windows 12:00 task is the only thing refreshing Pin/Product Ideas.

### Deprecated / do not schedule (may still exist as old Task Scheduler entries)

| Item | Was | Replaced by |
|------|-----|-------------|
| `C:\Users\44740\vibepinrun.bat` | ~**11:00** STL + crawl monolith | `run_stl_score_daily.ps1` at **11:30** |
| [`daily_pipeline.ps1`](daily_pipeline.ps1) | ~**11:00** reset + crawl + STL + score | Split scripts above |
| [`run_pipeline_daily.bat`](run_pipeline_daily.bat) | Single bat: trends → crawl → stl → score → digital | Split scripts above |
| [`run_pipeline_daily.ps1`](run_pipeline_daily.ps1) | Thin wrapper → `run_crawl_daily.ps1` | `run_crawl_daily.ps1` directly |
| [`run_stl_score.ps1`](run_stl_score.ps1) | Thin wrapper → `run_stl_score_daily.ps1` | `run_stl_score_daily.ps1` directly |
| [`DEPRECATED_vibepinrun.bat`](DEPRECATED_vibepinrun.bat) | Stub; exits 1 | Disable any task still pointing here |

Docs also mention disabling: **9:00 crawl**, **10:00 crawl**, **11:00 vibepinrun.bat**, **Old Daily Pipeline** task ([`DEPLOY_MANUAL_STEPS.md`](DEPLOY_MANUAL_STEPS.md) §8).

Typical Task Scheduler name seen in repo: **"VibePin Daily Pipeline"** (exact names vary per machine — verify locally).

### Verify what is still enabled on the Windows PC

```powershell
# List tasks that mention VibePin / pipeline / crawl
Get-ScheduledTask | Where-Object {
  $_.TaskName -match 'VibePin|vibepin|pipeline|crawl|trend|stl'
} | Format-Table TaskName, State, TaskPath -AutoSize

# Or classic CLI
schtasks /query /fo LIST /v | findstr /i "vibepin pipeline crawl trend stl"
```

Disable (example — use the actual `TaskName` from query):

```powershell
Disable-ScheduledTask -TaskName "VibePin Daily Pipeline"
# schtasks /change /tn "Task Name Here" /disable
```

### Cloud replacement (VPS `47.89.181.103`)

| Windows (old) | VPS (current) |
|---------------|---------------|
| 08:30 trends + 09:00/10:00 crawl + 11:30 stl/score + optional 02:00 local crawl | **Single cron:** `0 9 * * *` UTC → `run_worker.py --job daily` |
| Local `.ps1` / `.bat` | `/opt/vibepin/backend/.venv/bin/python run_worker.py --job daily` |
| Manual dev runs | Keep `.ps1` scripts; run by hand only |

VPS cron ≈ **Beijing 17:00** (UTC 9:00). First verified auto-run: **2026-06-10 01:00–03:53 UTC**.

### Local status check (after disabling Windows tasks)

```powershell
cd backend
python scripts/check_pipeline_status.py
```

---
