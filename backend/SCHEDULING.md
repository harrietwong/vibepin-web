# VibePin Daily Pipeline Scheduling

**Production:** use cloud worker + cron 鈥?see [CLOUD_WORKER.md](CLOUD_WORKER.md).

**Development:** local Windows `.ps1` scripts below (manual testing only).

## Cloud cron (production)

```cron
30 8 * * *  ./scripts/run_trends_daily.sh
0  9 * * *  ./scripts/run_crawl_daily.sh
0 10 * * *  ./scripts/run_crawl_daily.sh
30 11 * * * ./scripts/run_stl_score_daily.sh
0 12 * * *  ./scripts/run_classify_daily.sh
```

Or: `python run_worker.py --job daily` — **note:** `--job daily` does NOT include
`classify` / `opportunities`, so Pin Ideas / Product Ideas won't refresh under the
single-job cron unless you also schedule `run_classify_daily.sh` (above).

## Dev-only Windows Task Scheduler times

| Time  | Script | Purpose |
|-------|--------|---------|
| 08:30 | `run_trends_daily.ps1` | Trends replenish 鈫?`trend_keywords` + `crawl_queue` |
| 09:00 | `run_crawl_daily.ps1` | Main crawl (`--limit-keywords 80`, auto-replenish if queue low) |
| 10:00 | `run_crawl_daily.ps1` | Catch-up crawl |
| 11:30 | `run_stl_score_daily.ps1` | Shop the Look + product scoring only |
| 12:00 | `run_classify_daily.ps1` | Classify product signals + reference pins, then regenerate opportunities (**Pin Ideas + Product Ideas**) — task `VibePin-Classify-Daily` |

## Deprecated (do not schedule)

- `run_pipeline_daily.bat` 鈥?full monolithic pipeline
- `daily_pipeline.ps1` 鈥?legacy populate + crawl + STL at 11:00
- `C:\Users\44740\vibepinrun.bat` 鈥?old 11:00 STL+crawl; replace with `run_stl_score_daily.ps1` at **11:30**
- `run_pipeline_daily.ps1` / `run_stl_score.ps1` 鈥?thin wrappers kept for old task entries
- `populate_crawl_queue.py` - deprecated manual backfill for old `source LIKE 'search_trends:%'` rows; not part of daily/cloud pipeline

## Crawl guard

`pipeline.py --step crawl` runs trends replenish automatically when pending queue count &lt; 20.
If still empty after replenish, crawl exits cleanly (exit 0).

## Environment flags (optional)

```
ENABLE_PINTEREST_TRENDS_L1=false   # skip official Trends API (404)
ENABLE_PINTEREST_RESOURCE_L2=false # skip internal resource API
ENABLE_TYPEAHEAD_L3=true           # typeahead estimate fallback
```
