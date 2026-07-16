# Admin Dashboard PRD v1.0

**Status:** In Production (v0+)  
**Date:** 2026-07-14  
**Audience:** Super Admin / Founder / Support / Data Ops

---

## Executive Summary

The Admin Dashboard is an **internal-only control plane** providing read-only system visibility into platform health, data freshness, user metrics, generation performance, and pipeline status. It runs independently from the customer-facing `/app` shell and is gated to super admin users.

**Key Features:**
- 📊 Real-time system overview (7 cards: Users, Generation, Inventory, Freshness, Visual Review, Pipeline, Errors)
- 📈 Data Freshness & Inventory tracking (pin_samples, pin_products, product_scores, visual_asset_reviews)
- 📋 Daily crawl activity log (last 7 days, UTC)
- 🎯 Pipeline job status (job_type, status, rows processed, failure metrics)
- 🚨 Top errors aggregation (generation, pipeline, integration failures)
- 📸 Latest crawled pins & products (visual evidence strips)
- 🛡️ Super admin gating (read-only; no mutation controls)

---

## Goals & User Needs

### Primary Users
1. **Founder/Leadership** → Assess platform health at a glance
2. **Support Team** → Investigate customer issues with data context
3. **Data Ops** → Monitor data pipeline freshness, inventory counts, and crawler activity
4. **Engineering** → Spot generation failures, pipeline errors, and data quality gaps

### Key Needs
- **Health Assessment:** Is the platform healthy today? (visual pill summary)
- **Blame Assignment:** Where did data/generation fail? (errors, timestamps, pipeline status)
- **Inventory Validation:** Do we have enough pin_samples, products, reviews?
- **Freshness Signals:** Is data stale? When was the last crawl/update?
- **Evidence Trail:** Show recent pins/products for manual spot-check

---

## Feature Set

### 1. Admin Home Page (`/admin`)

**Purpose:** Single dashboard view of system health and key metrics.

#### Components

##### 1.1 Health Pill (Top-Right)
- **Status Levels:**
  - 🟢 **HEALTHY** — No failures, no stale data
  - 🟡 **NEEDS ATTENTION** — Generation failures OR jobs failed OR recent errors
  - 🔴 **STALE DATA** — Any data source is past 48h threshold
  - ⚪ **UNKNOWN** — Metrics not available (new install, missing schema)
- **Triggers:** Stale data wins, then failures, then errors; only shows if super admin

##### 1.2 Global Warnings (Below Title)
- Degraded/unavailable sources listed (e.g., "pin_save_snapshots unavailable — v37 not applied")
- Warns when a table is missing (workspaces, product_ideas, visual_asset_reviews, pin_generations.status)

##### 1.3 Card 1: Users / Usage
- Total users (from Supabase auth)
- Active users today (workspace write activity)
- New users today
- Total workspaces (requires workspaces table)
- Active workspaces today
- **Degradation:** If Supabase service role unavailable, shows "n/a"

##### 1.4 Card 2: Generation (AI)
- Generations today (pin_generations count since midnight UTC)
- Successful today (count where status='success')
- Failed today (count where status='failed' or 'error')
- Failure rate % (failed / total)
- Latest generation (relative time)
- **Degradation:** If pin_generations missing or status column missing, show "n/a"

##### 1.5 Card 3: Data Inventory
- pin_samples count
- pin_products count
- product_scores count
- product_ideas count (if table exists)
- visual_asset_reviews count (if v31 applied)

##### 1.6 Card 4: Data Freshness
- **Status Badge** (Fresh / Warning / Stale / Unknown)
- **pin_samples:**
  - Last 24h, 48h, 5d (scraped_at)
  - Latest scraped_at timestamp
  - Latest created_at_source timestamp
  - Missing image_url count (danger tone if > 0)
- **pin_products:**
  - Last 24h, 48h, 5d (created_at)
  - Latest created_at, scraped_at timestamps
  - Missing image_url count
- **product_scores:**
  - Latest scored_at, updated_at (if column exists)
- **Status Logic:**
  - 🟢 FRESH = both samples & products updated in last 48h
  - 🟡 WARNING = one source is 48-96h old
  - 🔴 STALE = any source is >96h old
  - ⚪ UNKNOWN = missing timestamps or table

##### 1.7 Card 5: Visual Review
- Reviewed count
- Unreviewed count (candidate images minus reviewed, estimate)
- PASS count
- REVIEW count
- REJECT count (danger tone if > 0)
- Latest reviewed timestamp
- **Degradation:** If visual_asset_reviews missing, show "n/a" with v31 migration note

##### 1.8 Card 6: Pipeline / Jobs
- Table: job_type | status | latest run | rows processed | failed rows | last success | latest error
- Status badges (failed/error = red, completed = green, running = gray)
- From pipeline_runs table
- **Degradation:** If table missing, show "Job status unavailable"

##### 1.9 Card 7: Top Errors
- Recent generation, pipeline, integration failures
- Columns: kind (tag: generation/pipeline/other), source, message, timestamp
- Max 8 errors, sorted newest first
- **Degradation:** If no error sources, show "No recent failures"

---

### 2. Data Freshness & Inventory Page (`/admin/data`)

**Purpose:** Detailed data pipeline and inventory view.

#### Components

##### 2.1 Daily Crawl Activity (Last 7 Days)
- Table: Date | Trend Keywords Updated | Pins Scraped | Products Added | Save Snapshots
- **Date** = UTC date
- **Trend Keywords Updated** = count of trend_keywords.last_updated_at since midnight
- **Pins Scraped** = count of pin_samples.scraped_at since midnight
- **Products Added** = count of pin_products.created_at since midnight
- **Save Snapshots** = count of pin_save_snapshots.captured_on since midnight (requires v37)
- Idle rows (all zeros) are dimmed to 55% opacity
- Footnote explains each metric

##### 2.2 Latest Crawled Pins (Image Strip)
- Last 10 pin_samples with images, sorted by scraped_at DESC
- Each: thumbnail (100x150), title (pin_title or seed_keyword), saves + keyword + timestamp
- Lazy-load images
- Hover reveals full title/keyword if truncated

##### 2.3 Latest New Products (Image Strip)
- Last 10 pin_products with images, sorted by created_at DESC
- Each: thumbnail (100x150), product name (or keyword), saves + keyword + timestamp
- Footnote: "Newest pin_products by created_at (with image)"

##### 2.4 Inventory Card
- pin_samples count
- pin_products count
- product_scores count
- product_ideas count (if exists, else "n/a")
- visual_asset_reviews count (if v31 applied, else "n/a")

##### 2.5 pin_samples Freshness
- Status badge (Fresh / Warning / Stale / Unknown)
- Grid: Last 24h, Last 48h, Last 5d, Missing image_url (danger if > 0), Total
- Definition grid:
  - Latest pin_samples.scraped_at
  - Latest pin_samples.created_at_source
- Footnote: Explains that pin_samples has no created_at; scraped_at is ingestion clock

##### 2.6 pin_products Freshness
- Status badge
- Grid: Last 24h, Last 48h, Last 5d, Missing image_url (danger if > 0), Total
- Definition grid:
  - Latest pin_products.created_at
  - Latest pin_products.scraped_at
- **Important Note (green):** "This is the Product Opportunity v1 readiness signal — Product Opportunity reads pin_products directly, not product_scores."

##### 2.7 Product Opportunity Coverage
- With product URL count
- Missing product URL count (danger if > 0)
- With product saves count
- With source-pin saves count
- Without category count (muted if > 0)
- Footnote: Explains readiness criteria (image, product URL, save evidence)

##### 2.8 product_scores Freshness (Optional)
- Status badge
- Explanatory note: "Product scoring is currently not required for Product Opportunity v1. A STALE status here does not block Product Opportunity."
- Definition grid:
  - Total product_scores rows
  - Latest product_scores.scored_at
  - Latest product_scores.updated_at (if column exists, else "n/a")
  - Fresh threshold (48 hours)

##### 2.9 Visual Review Counters
- Reviewed count
- Unreviewed count
- PASS, REVIEW, REJECT counts
- Latest reviewed timestamp (if available)
- Footnote: "unreviewed = candidate images minus reviewed (estimate)"
- **Degradation:** If visual_asset_reviews missing, link to v31 migration

##### 2.10 Quality Counters
- Missing image (pin_samples)
- Missing image (pin_products)
- Broken image (n/a in v0)
- Duplicate clusters (n/a in v0)
- Reviewed / unreviewed ratio

---

### 3. Navigation & Layout

#### Admin Nav (Left Sidebar)
- **Overview** → `/admin` (admin home)
- **Data** → `/admin/data` (freshness & inventory)
- **Pipeline** → `/admin/pipeline` (job status deep-dive)
- **Customers** → `/admin/users` (user list & 360 view)
- **Support** → `/admin/support` (support tickets)
- **Generation Logs** → `/admin/generation-logs` (full generation prompt audit)
- **Visual Review** → `/admin/visual-review` (image review scoring tool)
- **Creative Intelligence** → `/admin/creative-intelligence` (calibration tool)

#### Admin Top Bar
- Logo + "管理后台 / 内部"
- Language toggle (EN / 中文)
- Theme toggle (light/dark)
- Super admin badge footer: "仅限超级管理员 · 内部"

---

### 4. Data Freshness Status Logic

```
FRESH:  both pin_samples & pin_products updated in last 48h
WARNING: one source is 48-96h old
STALE:   any source is >96h old
UNKNOWN: missing timestamps or table
```

**Applied at:**
- Overall freshness status (all sources)
- Pin_samples card (scraped_at)
- Pin_products card (created_at)
- Product_scores card (scored_at)

---

### 5. Permissions & Access Control

- **Gated:** Super admin only (checked via getCurrentSuperAdmin())
- **Redirect:** Non-admin → `/app?admin=forbidden`
- **Actions:** Read-only (no mutations allowed)
- **Schema:** All tables optional — graceful degradation for missing tables/columns

---

## Schema Requirements

### Required Tables
- `pin_generations` (timestamp, status column recommended)
- `pin_samples` (scraped_at, image_url)
- `pin_products` (created_at, scraped_at, image_url)
- `product_scores` (scored_at, updated_at optional)
- `pipeline_runs` (job_type, status, rows_processed, failed_rows, started_at, last_success_at, error_message)

### Optional Tables (Graceful Degradation)
- `workspaces` (for workspace metrics)
- `product_ideas` (for product ideas count)
- `visual_asset_reviews` (v31; for review counts)
- `pin_save_snapshots` (v37; for daily snapshot counts)

### Error Event Sources (if available)
- Generation failures (pin_generations.status='failed'/'error')
- Pipeline failures (pipeline_runs.status='failed'/'error')
- Integration errors (from logs/integration_errors table if exists)

---

## Accessibility & Internationalization

### i18n Keys
All user-visible strings use message keys:
- Navigation labels: `nav.overview`, `nav.data`, `nav.pipeline`, `nav.customers`, `nav.support`, `nav.generationLogs`, `nav.visualReview`, `nav.creativeIntelligence`
- Card titles: `data.title`, `data.inventory.title`, `data.visualReview.title`, `data.quality.title`
- Status badges: `status.fresh`, `status.stale`, `status.unknown`
- Stat labels: `stat.created24h`, `stat.created48h`, `stat.created5d`, `stat.total`
- UI chrome: `shell.title`, `shell.internal`, `shell.superAdminGated`, `data.badge`, `data.subtitle`, `data.footer`

### Supported Languages
- English (en) — source
- Chinese (zh, zh-CN)
- Spanish, French, German, Italian, Portuguese, Russian, Japanese, Korean, Arabic, Hindi, Vietnamese, Thai, Indonesian, Filipino, Turkish, Polish, Dutch (18 locales total)

### Theme Support
- Light mode (default light gray/white UI)
- Dark mode (dark blue/slate UI with light text)
- Uses CSS custom properties: `--admin-bg`, `--admin-surface`, `--admin-text`, `--admin-danger`, etc.

---

## Performance & UX Considerations

1. **Read-Only Load:** All queries are SELECT-only; no transaction overhead
2. **Caching:** Pages use `export const dynamic = 'force-dynamic'` for live metrics
3. **Lazy Loading:** Image strips use loading="lazy" for pin/product thumbnails
4. **Truncation & Tooltips:** Long text (error messages, titles) truncate with hover tooltip
5. **Relative Time:** Timestamps shown as "just now", "2h ago", "3d ago" for quick scanning
6. **Responsive Grid:** Cards stack on mobile (md/lg breakpoints); 5-column grid collapses to 2-3 columns
7. **Table Scroll:** Pipeline table scrolls horizontally on narrow screens

---

## Known Limitations & Future Work

### Current Limitations (v0)
1. **No search/filter** — All data shown, no way to drill into specific jobs/errors by name
2. **No historical graphs** — Snapshot metrics only; no trend lines (total users over time, failure rate over 7 days)
3. **No mutations** — Read-only; can't requeue jobs, restart crawlers, or apply migrations from UI
4. **No time-based drill-down** — Daily crawl table is last 7 days only; no way to view specific job logs
5. **Broken-image detection** — Visual quality counters not instrumented (marked "n/a")
6. **Duplicate cluster detection** — Not instrumented (marked "n/a")
7. **Product_ideas derivation** — Counted as inventory, but not tied to source pin_products

### Future Enhancements (Post-v0)
- **Search & Filter:** Drill into specific error types, job runs, users
- **Historical Dashboards:** Failure rate over time, user growth curve, data volume trends
- **Mutation Controls:** Requeue failed jobs, re-run crawlers, trigger scoring runs, apply migrations
- **Job Deep-Dive:** Click job → see full run history, error stack, retry logic
- **Image Quality Scanner:** Auto-detect broken images, duplicates (via embeddings)
- **Custom Alerts:** Email/Slack when freshness goes stale, failure rate spikes
- **Role-Based Dashboards:** Support-only view (exclude generation logs), data-ops-only view (focus on pipeline)

---

## Migration & Rollout

### Applied Migrations
- **v31** — visual_asset_reviews table (Visual Review feature)
- **v37** — pin_save_snapshots table (Daily snapshot counts)

### Recommended Before Launch
- Ensure pin_generations.status column exists (or set field as optional in UI)
- Ensure workspaces table exists (or show workspace metrics as "n/a")
- Test schema graceful degradation (turn off each table, verify UI shows "n/a" or warning)

---

## Testing Checklist

- [ ] Super admin can access `/admin` and `/admin/data`
- [ ] Non-admin redirects to `/app?admin=forbidden`
- [ ] Health pill updates (HEALTHY → NEEDS ATTENTION when generation error inserted)
- [ ] Card degradation: Hide optional stat if table missing (e.g., product_ideas)
- [ ] Timestamps: All times shown in UTC; relative format (2h ago) + absolute format (Jul 14, 3:45 PM) on hover
- [ ] Image strips: Lazy load; hover shows full title; click does nothing (not clickable in v0)
- [ ] Responsive: Grid collapses to 2/3 columns on tablet/mobile; table scrolls horizontally
- [ ] i18n: Switch language; all labels update (no hard-coded text)
- [ ] Dark mode: All colors use CSS vars; no hard-coded hex in layout

---

## Success Metrics

1. **System Health Visibility** — Founder/ops can see overall platform health in <5 seconds (Health Pill)
2. **Issue Investigation** — Support can identify which data source is stale and when (Freshness card)
3. **Error Tracking** — Top 8 errors visible; no need to dig into logs for quick assessment
4. **Data Quality Confidence** — Pin sample / product counts growing; visual review progress visible
5. **Pipeline Transparency** — Daily crawl activity shows whether crawler ran (no silent failures)

---

## References

- **Admin Navigation:** web/src/app/admin/AdminNav.tsx
- **Admin Home:** web/src/app/admin/page.tsx
- **Data Freshness Page:** web/src/app/admin/data/page.tsx
- **Server APIs:** web/src/lib/server/adminOverview.ts, dataFreshness.ts, dailyCrawlActivity.ts
- **Admin Messages:** web/src/lib/admin/adminMessages.ts
- **Permissions:** web/src/lib/server/superAdmin.ts

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| v1.0 | 2026-07-14 | Fable 5 | Initial PRD based on v0 implementation; 9 cards (Overview: 7 + Data page: 2 additional) |
