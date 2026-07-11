# Pin-Crawl Canary — Proposal (Phase 4B)

**Status: PROPOSAL ONLY.** Nothing run, nothing enabled, no files changed on the VPS.
Authored 2026-07-06. Swap section below **corrects** the Opus design pass, which was
briefed with "0 swap" from the handoff — I independently verified the VPS directly
(read-only SSH) after that brief was written and found this is stale.

## Correction: swap already exists — do not create it again

Direct read-only check on the VPS (`free -m`, `cat /proc/swaps`, `swapon --show`,
`/etc/fstab`, `/proc/sys/vm/swappiness`):

```
swap_total_mb: 2047        swap_used_mb: 0
/proc/swaps:  /swapfile  file  2097148  0  -2
fstab:        /swapfile none swap sw 0 0        (persistent across reboot)
file:         -rw------- 1 root root 2147483648 Jun 30 12:11 /swapfile
swappiness:   0
```

**A 2 GB swapfile already exists, is persistent, and is currently unused (0 MB).**
It was created **2026-06-30** — before this handoff was written — so the "0 swap"
premise in the handoff is simply out of date, not wrong at the time it was written.

**What this changes:** skip the swapfile-creation step entirely. The prerequisite
the earlier session flagged ("add 1-2GB swap before any Playwright canary") is
**already satisfied** — go straight to the canary.

**One optional tuning note, not a blocker:** the box is set to `vm.swappiness=0`
(kernel avoids swap until essentially forced), whereas a more cautious low-RAM
configuration commonly uses `swappiness=10` (lets the kernel lean on swap a little
sooner as a cushion). `swappiness=0` still swaps as a last resort in modern kernels
(it does not disable swap), so this is not unsafe — just more conservative than
necessary. If you want a softer landing during the canary:
```bash
sudo sysctl vm.swappiness=10
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-vibepin-swap.conf
```
Optional; the canary can proceed with the current `swappiness=0` as-is.

## Which "Pin Images daily" this targets

The handoff asked to clarify interpretation A (reprocess existing `pin_samples`) vs.
B (crawl new pins). The instruction to "target the Digital Products Pin:Product
ratio gap" only makes sense under **interpretation B** — reprocessing existing rows
cannot grow the Pin pool or change that ratio. This proposal is for **B: a scoped
Playwright crawl to grow fresh Digital-Products pins**, framed explicitly as a
one-off canary, not a schedule.

Ground truth (2026-07-05 audit, `web/src/lib/mvpTaxonomy.ts`): Digital Products has
the **largest absolute Pin pool** (3,425) but a Pin:Product ratio of **≈2.27:1**
(3,425 pins : 1,510 clean product rows), below the target 3:1 buffer — the only
category with real headroom concern despite already clearing the P0 pin-depth
threshold (≥180) many times over.

## Flag passthrough — re-verified end-to-end (2026-07-07)

Traced the full path `run_worker.py` argparse → `run_job` dispatch (line 623) →
`job_crawl` (line 96) → `pipeline.step_crawl` (line 422):

| CLI flag | Reaches step_crawl? | Effect |
|---|---|---|
| `--category digital-products` | ✅ (`category=`) | scopes `crawl_queue` selection; also sets `replenish=False` |
| `--concurrency 1` | ✅ (`concurrency=`) | **the real memory lever** — concurrent page navs in the ONE browser |
| `--limit-keywords 3` | ✅ (`limit_keywords=`) | bounds total run size |
| `--dry-run` | ✅ (`dry_run=`) | read-only preview (no DB writes) |
| `--first-crawl` | ✅ (`first_crawl=`) | selects not-yet-due digital-products seeds for this run only |
| `--top / --top-n` | passed but **inert when `--category` set** | only feeds trends *replenish*, which `category` disables |
| per-keyword pin cap (`max_pins=75`) | **NOT forwarded by `job_crawl`** → fixed default 75 | not CLI-exposed; caps pins/keyword |

`run_worker.py --job crawl` also acquires `pinterest_network.lock` and wraps in
`pipeline_job("crawl")` internally (verified, lines 607–613), so the canary is
mutually-exclusive with trends / product-supply / harvest by construction.

## What actually controls crawl volume/safety (verified by reading `pipeline.py`)

Correcting an assumption from the handoff: `--top`/`--top-n` only feeds *trends
replenish*, which is **disabled** whenever `--category` is set — so `--top` has
**no effect** on crawl volume when scoping to a category. The two flags that
actually matter:
- **`--concurrency`** — a semaphore over concurrent page navigations inside the
  **one** shared Chromium instance the crawl session opens (never multiple
  browsers). This is the real memory lever: `--concurrency 1` reproduces the exact
  single-page-at-a-time profile that survived at ~250 MB free RAM in the prior STL
  precedent. Raising it to 2-3 multiplies peak Chromium memory for no benefit at
  canary scale — **do not raise it for the canary.**
- **`--limit-keywords`** — bounds total run size (N keywords × up to 75 pins each,
  sequential). `3` keeps the canary to a few minutes and ≤~225 pins.

## Exact canary commands

```bash
cd /opt/vibepin/backend

# 1) Read-only safety gate (existing preflight; works cross-platform)
.venv/bin/python scripts/preflight_product_supply.py \
  | .venv/bin/python -c "import sys,json;d=json.load(sys.stdin);print(d['recommendation'],d.get('reasons'))"
# expect SAFE_FOR_DRY_RUN or SAFE_FOR_APPLY

# 2) Dry-run — see which digital-products keywords/queue rows would be crawled (no writes)
.venv/bin/python run_worker.py --job crawl \
  --category digital-products --limit-keywords 3 --concurrency 1 --dry-run --created-by canary
# if it reports 0 selected keywords, add --first-crawl to steps 2 and 4

# 3) In a second terminal: start live RAM monitoring (see below) BEFORE step 4

# 4) The real canary, under an outer hard timeout as a second safety net
timeout --signal=TERM --kill-after=30s 1200 \
  .venv/bin/python run_worker.py --job crawl \
    --category digital-products --limit-keywords 3 --concurrency 1 --created-by canary
```

`run_worker.py --job crawl` already acquires `pinterest_network.lock` and wraps in
`pipeline_job("crawl")` internally — the canary is automatically mutually-exclusive
with the trends/product-supply/harvest jobs via the existing lock discipline.

**Caveat (honestly flagged, not fully confirmed):** `--dry-run` is verified to set
`write_db=False` (no DB writes), but whether it also skips launching Chromium
entirely was not traced end-to-end. Treat the dry-run as writes-safe for certain,
but still watch RAM during it in case a browser opens.

## Monitoring during the run

```bash
# Combined RAM + top consumers, every 2s, in a second terminal:
watch -n 2 'free -m; echo "-- top RSS --"; ps -eo pid,rss,comm --sort=-rss | grep -iE "chrom|node|python" | head'

# Watch for OOM activity in a third terminal:
sudo dmesg -Tw | grep -iE "oom|killed process"
```

## Pass / fail criteria

**PASS — all of:**
- Process exits cleanly; the outer 1200s `timeout` never fires.
- `dmesg -T | grep -iE 'oom|killed process'` is empty for the run window.
- Available RAM never drops below ~150 MB, and swap usage stays modest (well under
  the 2 GB already provisioned) — i.e. swap is a cushion, not fully consumed.
- New `pin_samples` rows appear: `category='digital-products' AND scraped_at >=
  <canary_start_iso>` count is a meaningful positive (e.g. ≥40 for 3 keywords).
- No orphaned `chromium`/`chrome`/`run_worker` processes after exit.
- No stale `pinterest_network.lock` left behind.

**FAIL — any of:** an OOM-kill in `dmesg`; available RAM approaching 0; swap fully
exhausted; the outer timeout fires; orphaned processes after exit. On failure:
`pkill -f chromium; pkill -f run_worker`, confirm the lock clears, do **not**
schedule anything, and investigate before retrying at the same (not larger) scope.

## Explicit constraints

- **No nightly/scheduled crawler until this canary passes.** `vibepin-pin-crawl.timer`
  stays disabled regardless of outcome; a passing canary only clears the manual-run
  prerequisite, not automatic scheduling.
- Before any *future* scheduled Digital-Products crawl, note that
  `cloud_run_pin_crawl.sh` today hardcodes neither `--category` nor `--concurrency`
  and defaults `--concurrency` to **3** — exactly the OOM risk this canary avoids.
  That wrapper needs updating (a separate, later change) before any real schedule,
  even after a canary passes.
