# Pinterest Trends API Integration

## Current state (VibePin pipeline)

| Layer | Source | Endpoint | Time series |
|-------|--------|----------|-------------|
| **L1** | `pinterest_trends_official` | `trends.pinterest.com/api/v3/...` (public Trends site API) | Real weekly series when L1 enabled + enrich |
| **L2** | `pinterest_resource` | `www.pinterest.com/resource/TrendingSearchResource` | No 12-month history |
| **L3** | `pinterest_typeahead_estimated` | Typeahead autocomplete | No history — volume_signal only |

**L1 is disabled by default** (`ENABLE_PINTEREST_TRENDS_L1=false`). Most production keywords are L3 estimated.

**Synthetic curves:** `enrich_trend_history.py` writes interpolated 52-week curves into `trend_history` from YoY/MoM/volume_level. These are tagged `trend_series_source = derived_growth_metrics` and must **not** render as “Past 12 months” in the UI.

## Official Pinterest Marketing API (v5)

Documented partner endpoint (requires Trends & Insights API access):

```
GET /v5/trends/keywords/{region}/top/{trend_type}
```

Related endpoints (Marketing API):

- Keyword metrics / time series (partner-only; exact paths vary by API version)
- Requires Pinterest Business account + approved **Trends & Insights** scope

### App credentials in this repo

| Env var | Purpose |
|---------|---------|
| `PINTEREST_APP_ID` | OAuth app (publish + potential Marketing API) |
| `PINTEREST_APP_SECRET` | OAuth secret |
| `ENABLE_PINTEREST_TRENDS_L1` | Layer 1 public Trends API (trends.pinterest.com v3) |

**Trends & Insights v5 access:** Not confirmed in deploy logs. The worker currently uses:

1. Public `trends.pinterest.com/api/v3` (session/cookie bootstrap via `TrendSession`)
2. Typeahead L3 estimates
3. Derived `enrich_trend_history` backfill

### Recommended integration path

1. Apply `migrate_v26.sql` (trend_series metadata columns).
2. When L1 `fetch_keyword_time_series()` succeeds, write:
   - `trend_series` = official points
   - `trend_series_source` = `pinterest_trends_api`
   - `trend_series_granularity` = `weekly`
   - `trend_series_updated_at` = now()
3. When partner v5 access is granted, add `pinterest_v5_trends.py` client:
   - Map `GET /v5/trends/keywords/{region}/top/{trend_type}` for discovery
   - Fetch per-keyword time series into `trend_series` with `trend_series_source = pinterest_v5_official`
4. Stop running `enrich_trend_history.py` on L3 rows (or only tag derived rows, never show chart).

### UI rules (implemented in `web/src/lib/keyword-data/trendSeriesDisplay.ts`)

- **L1 + official series** → “Search Trend · Past 12 months” line chart
- **L2** → limited insight panel, no full chart
- **L3 / derived** → “Estimated trend signal” panel, no chart
