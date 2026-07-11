# Product-Supply Scheduler Proposal (Phase 7)

**Status: PROPOSAL ONLY. Nothing is enabled. No timer is started by adopting this doc.**
Authored 2026-07-03. Grounded in the live VPS state, not assumptions.

## TL;DR
The scheduler is **already built and deployed on the VPS, but DISABLED**:
`vibepin-product-supply.service` (oneshot) + `vibepin-product-supply.timer`
(daily 23:00 Asia/Shanghai), installed 2026-06-27, both `disabled`. The hardened
wrapper `scripts/cloud_run_product_supply.sh` defaults to a safe no-op `preflight`
mode. Phase 7 is therefore **(a) tune a few env values and (b) enable the timer** —
both operator-gated actions that this proposal does NOT perform.

---

### 1. Where the scheduler should live
- **systemd on the Linux VPS** (`/opt/vibepin/backend`), NOT cron. Units already exist:
  - `/etc/systemd/system/vibepin-product-supply.service` — `Type=oneshot`, calls the wrapper only.
  - `/etc/systemd/system/vibepin-product-supply.timer` — `OnCalendar=*-*-* 23:00:00 Asia/Shanghai`.
- The legacy `# DISABLED` daily **cron** line (`run_worker.py --job daily`) is a separate,
  retired path and should stay disabled — do not revive it for product-supply.
- Repo source of truth for the runner: `backend/scripts/cloud_run_product_supply.sh`.

### 2. Exact command
Timer → service → `ExecStart=/opt/vibepin/backend/scripts/cloud_run_product_supply.sh`.
The wrapper's mode is chosen by `VIBEPIN_CLOUD_MODE`. For a writing scheduler set:
```
Environment=VIBEPIN_CLOUD_MODE=apply
Environment=VIBEPIN_APPLY_CONFIRM=APPLY_BOOTSTRAP_PRODUCTS
```
Under the hood the wrapper runs (fresh selection — NO `--source-report`):
```
.venv/bin/python scripts/run_bootstrap_product_supply.py \
  --limit "$VIBEPIN_SUPPLY_LIMIT" --category-mix "$VIBEPIN_CATEGORY_MIX" \
  --timeout-seconds 2400 --apply --confirm APPLY_BOOTSTRAP_PRODUCTS --waive-cooldown
```
A recurring apply does **not** need the manual dry-run→frozen-report two-step; fresh
selection + preflight + guards are the designed recurring path.

### 3. Frequency
- **Daily, 23:00 Asia/Shanghai**, `RandomizedDelaySec=900`, `Persistent=false`
  (no boot catch-up). Already configured. Keep daily to start; revisit to 2×/day only
  if the fresh-pin pool proves large enough (today it does not — see §5).

### 4. Batch size
- `VIBEPIN_SUPPLY_LIMIT=50` (wrapper default). Fresh recent pool is currently smaller
  (~36 eligible), so a run takes what exists. **Do not exceed ~50** (RAM + timeout, §14).

### 5. Category mix
- Wrapper default `fashion:18,womens-fashion:14,home-decor:18` (=50) but
  **womens-fashion yields 0 recent source pins** (no recent womens-fashion pins in
  `pin_samples`). Recommend `VIBEPIN_CATEGORY_MIX=fashion:25,home-decor:25` (=50) until
  womens-fashion source pins exist. Mix must sum to `--limit` or the run errors.

### 6. Lock name
- **Wrapper no-overlap:** `flock` on `/opt/vibepin/locks/cloud_run_product_supply.lock`.
- **Cross-job app locks** (held during the run): `pinterest_network.lock` +
  `pin_products_writer.lock`, under `VIBEPIN_LOCK_DIR=/opt/vibepin/locks`.
- These prevent overlap with crawl / trends / another supply run.

### 7. Max runtime
- Runner tree-kill: `--timeout-seconds 2400` (dry-run/apply measured ~1180–1260s for
  36–50 pins, so 2400s is safe headroom; the default 1200s is too tight).
- systemd outer bound: `TimeoutStartSec=3000`, `TimeoutStopSec=60`, `KillMode=control-group`
  (SIGKILLs the whole cgroup — runner + run_worker + Playwright/chromium — no orphans).

### 8. Retry behavior
- Current: `Restart=no` (fail-closed) + `StartLimitIntervalSec=300`/`StartLimitBurst=3`.
- **Recommend keep no auto-retry initially**; the next day's run is the natural retry.
  Optionally later: a one-shot same-day retry ~3h after a non-zero exit, kept OFF until proven.

### 9. Failure alert behavior
- Current: journal only (`SyslogIdentifier=vibepin-product-supply`).
- **Propose:** add `OnFailure=vibepin-alert@%n.service` (small oneshot) that on non-zero
  exit (a) records a `pipeline_runs` failure row and (b) POSTs to an optional
  `VIBEPIN_ALERT_WEBHOOK` (Slack/Discord). Minimal viable: rely on the `pipeline_runs`
  row (already written for apply, §10) + surface failures in `/admin/pipeline`.

### 10. Metadata to write for admin visibility
The apply path already runs inside `pipeline_job("product-supply-expand", created_by=…)`,
which writes a `pipeline_runs` row. Ensure it carries: `job_type='product-supply-expand'`,
`status`, `started_at`/`finished_at`, and stats — `mode`, `inserted` (writes.pin_products),
`uniqueAcceptedProducts`, `rejected`, `sourcePinsScanned`, `categoryMix`, `reportPath`,
`exitCode`. Set `created_by='scheduler:vibepin-product-supply'`. The JSON report in
`logs/product_supply_expand_shop_the_look_*.json` remains the detailed audit trail.

### 11. How /admin/data and /admin/pipeline show the latest run
- **/admin/pipeline** reads `pipeline_runs` → the `product-supply-expand` row appears
  automatically (verify the page's `job_type` filter/labels include it).
- **/admin/data** — add a "Product supply — last run" line (latest
  `pipeline_runs(job_type='product-supply-expand').finished_at` + inserted count) beside
  the existing `pin_products` freshness + `productCoverage` cards (already reflect new rows).
- **Freshness API note:** `web/src/app/api/products/top/route.ts` currently derives
  `lastPipelineAt` from `job_type in ('stl-score','daily')` — **add `'product-supply-expand'`**
  so product freshness reflects supply runs.

### 12. Rollback plan
- **Instant, no data change:** `systemctl disable --now vibepin-product-supply.timer`
  (and/or set `VIBEPIN_CLOUD_MODE=preflight` → service becomes a no-op).
- **No schema migration** is involved.
- **Data rollback (rarely needed):** inserts are new rows with
  `discovery_method_detail='pinterest_product_card_bootstrap'` in a known `created_at`
  window → a bad batch can be deleted by that window. Insert-only + idempotent makes this low-risk.

### 13. How to avoid duplicate inserts
- `INSERT … ON CONFLICT (normalized_product_url_hash) DO NOTHING` (v28 unique index),
  plus the read-only `_preflight_existing()` hash pre-filter. Idempotent across reruns.
- Fresh selection also avoids reusing prior "spike" source pins
  (`avoid_pin_ids` from `logs/shop_the_look_spike.json`).

### 14. How to avoid OOM on the VPS
- VPS is **1.6 GiB RAM / 0 swap**; a 50-pin run drives one Chromium instance
  (sequential navigation, not 50 browsers), peak available dipped to ~250 MB — OK but tight.
- Keep `--limit ≤ 50`; `Nice=10` + `IOSchedulingClass=idle` so it never starves other work;
  wrapper flock prevents a second concurrent supply run.
- **Recommended ops safety net (optional):** add a 1–2 GB swapfile on the VPS (currently 0 swap).
- Schedule at 23:00 (off-peak, after crawl/trends) to avoid memory contention.

### 15. Should it run after crawl/classify?
- **Yes.** 23:00 sits ~12.5h after crawl (10:30) and trends (09:00) → fresh categorized
  source pins and a satisfied 120-min Pinterest cooldown. When the full daily pipeline is
  eventually re-enabled, order should be **crawl → classify → product-supply**.
- It is decoupled (own timer), so it still runs standalone; with the crawler off it simply
  reuses the existing `pin_samples` pool (lower/limited fresh yield).

### 16. Is classify still needed for product supply?
- **Not as a hard dependency, and product *scoring*/classification is NOT needed at all.**
- Product-supply reads `pin_samples` fields `category`, `image_url`, `save_count`,
  `scraped_at`, `source_interest`. `classify` (of *pins*) is what populates
  `pin_samples.category`, which the category-mix source selection filters on.
- So: classify-of-pins is a **soft upstream input** (needed to have categorized, fresh
  source pins); if pins are already categorized, no fresh classify is required per run.
  There is **no** dependency on `product_scores` / `calculate_product_scores`.

### 17. Exact files that would change
- **VPS unit (not yet in repo):** `/etc/systemd/system/vibepin-product-supply.service` —
  change `Environment=` lines (`VIBEPIN_CLOUD_MODE=apply`, add `VIBEPIN_APPLY_CONFIRM`,
  optionally `VIBEPIN_SUPPLY_LIMIT`, `VIBEPIN_CATEGORY_MIX`), then `systemctl daemon-reload`.
- **Repo (recommended, for version control):** add `backend/deploy/systemd/vibepin-product-supply.{service,timer}`
  (currently only on the VPS); optionally adjust default `CATEGORY_MIX` in
  `backend/scripts/cloud_run_product_supply.sh`.
- **Web (optional, for §11):** `web/src/app/api/products/top/route.ts` (add
  `product-supply-expand` to the `pipeline_runs` job_type filter);
  `web/src/lib/server/dataFreshness.ts` + `web/src/app/admin/data/page.tsx` +
  `/admin/pipeline` to surface "last product-supply run".
- **Enabling command (operator-run, NOT part of any file change):**
  `systemctl enable --now vibepin-product-supply.timer`.

### 18. Confirmation: no timer enabled without approval
- The timer is **DISABLED** and this proposal enables nothing.
- Enabling requires an explicit operator command
  (`systemctl enable --now vibepin-product-supply.timer`) **plus** switching
  `VIBEPIN_CLOUD_MODE` to `apply` and setting `VIBEPIN_APPLY_CONFIRM`.
- Even a manual `systemctl start` today writes nothing — the service defaults to the
  `preflight` no-op. No timer/mode change will be made without explicit approval.
