# VibePin unified daily pipeline (DISABLED design)

Three independent, preflight-gated, tree-kill-hardened jobs. All timers disabled
until explicitly enabled. No automatic retries. Each job fails closed.

## Job order, times (Asia/Shanghai), windows

> Times are **Asia/Shanghai (CST, UTC+8)** and pinned explicitly in each timer's
> `OnCalendar` line (`… Asia/Shanghai`), so the schedule is unambiguous regardless
> of the host timezone. The VPS is Asia/Shanghai; the old `0 9 * * * --job daily`
> cron is already disabled, so the 09:00 trends slot does not double-run.

| Order | Job | Timer (Asia/Shanghai) | Channel | Writes | Shared lock | Max runtime |
|------|-----|-------|---------|--------|-------------|-------------|
| 1 | keyword-trends | `09:00` (+300s) | Pinterest **Trends API** (token) | `trend_keywords`, `crawl_queue` | respects (refuse-on-live) | 1800s |
| 2 | pin-crawl | `10:30` (+600s) | Playwright, **residential IP** | `pin_samples`, `crawl_queue` | **acquires** `pinterest_network.lock` (via run_worker) | 5400s |
| 3 | product-supply | `23:00` (+900s) | Playwright, residential IP | `pin_products` | **acquires** `pinterest_network.lock` + `pin_products_writer.lock` (hardened runner) | 2400s |

## Why this order is safest
- **Dependency order:** trends replenishes `crawl_queue` → crawl consumes it → Product-Supply uses fresh `pin_samples` as source pins.
- **No overlapping Pinterest/Playwright windows:** crawl (10:30, ≤90 min → done ~12:00) and Product-Supply (23:00) are ~11 h apart. trends (09:00) is the API channel, separate from the residential-IP crawl.
- **Cooldown:** Product-Supply at 23:00 is ~11 h after the crawl finishes — far beyond the 120-min Pinterest cooldown. Cooldown is **never auto-waived** by the scheduler; the Product-Supply wrapper defaults to preflight and apply needs an explicit confirm token.
- **Defence in depth:** even if timings drift, every Pinterest-touching wrapper preflight-gates and **refuses** while the shared `pinterest_network.lock` is live or any Pinterest worker is active; each job also holds its own no-overlap lock.

## Lock strategy
- Per-job no-overlap lock: `cloud_run_<job>.lock` (flock) — prevents two of the same job.
- Shared residential-IP lock: `pinterest_network.lock` — acquired by crawl + Product-Supply (internally), respected (refuse-on-live) by trends.
- Product-Supply writer lock: `pin_products_writer.lock` — acquired by the hardened runner.
- `VIBEPIN_LOCK_DIR=/opt/vibepin/locks` (Linux-safe; the code default is a Windows path).

## Timeout / failure strategy
- crawl + trends: wrapper runs the job in its own process group (`setsid`) and SIGKILLs the **whole group** on timeout (no orphan); systemd `RuntimeMaxSec` + `KillMode=control-group` is the outer cgroup bound.
- Product-Supply: the hardened Python runner kills the full process tree and verifies death (exit 20 killed / 30 orphan-survived).
- `Restart=no`, no automatic retries. Any preflight/lock/env failure → nonzero exit, no run.

## Modes (all default to a safe no-op)
- `cloud_run_keyword_trends.sh` → `preflight` | `trends` (needs `VIBEPIN_TRENDS_CONFIRM=RUN_TRENDS`)
- `cloud_run_pin_crawl.sh` → `preflight` | `crawl` (needs `VIBEPIN_CRAWL_CONFIRM=RUN_CRAWL`)
- `cloud_run_product_supply.sh` → `preflight` | `dry-run` | `apply` (apply needs `VIBEPIN_APPLY_CONFIRM=APPLY_BOOTSTRAP_PRODUCTS`)

Enabling (later, only after manual validation, and after disabling the old
`0 9 * * * --job daily` cron to avoid a double crawl):
`systemctl enable --now vibepin-keyword-trends.timer vibepin-pin-crawl.timer vibepin-product-supply.timer`
