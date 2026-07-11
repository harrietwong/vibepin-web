# Outbound-Link Harvester — Scheduler Proposal (Phase 3)

**Status: PROPOSAL ONLY.** Nothing enabled, nothing run, no files created on the VPS,
no code changed. Authored 2026-07-06, grounded in a full read of the actual code
(`product_harvest.py`, `run_worker.py`, `joblock.py`, `pipeline_tracking.py`,
`cloud_lib.sh`, the three existing wrappers, `migrate_v5`/`migrate_v27`, a real
`logs/harvest_apply.log`, and the web taxonomy/API route that defines "clean row").

## Headline finding: writer-lock gap — NOW FIXED IN CODE (2026-07-07)

**Original finding (2026-07-06):** the harvester's `--apply` path took no file lock —
only a DB `pipeline_locks` row — while the STL `product-supply-expand` apply holds
both `pinterest_network.lock` and `pin_products_writer.lock`. So a harvest apply was
not mutually-excluded from a concurrent STL apply via the file-lock mechanism.

**RESOLVED (Task B, 2026-07-07):** `run_worker.py`'s harvest-apply branch now
acquires `pin_products_writer.lock` (non-blocking skip if held) around the write,
mirroring the `product-supply-expand` path. Two unit tests in
`tests/test_run_worker.py` prove a second apply skips while the lock is held and runs
(and releases) when it's free. **The gap is closed at the job level — any caller of
`--job harvest-outbound-products --apply` is now write-symmetric with STL.**

**IMPORTANT design consequence for this proposal:** because `run_worker.py` now takes
the writer lock itself, the wrapper's runner **must NOT also acquire
`pin_products_writer.lock`** before invoking `run_worker.py` as a subprocess — the
subprocess runs under a *different live PID* and would find the lock held by its own
parent and **skip its own write**. The runner design below is updated accordingly:
the runner does its read-only before/after counts, snapshot, and coverage gate, but
lets the `run_worker.py` subprocess own the writer lock for the actual write window.

## Artifacts (all new; none created yet)

| File | Role |
|---|---|
| `backend/scripts/cloud_run_harvest_outbound.sh` | Thin bash wrapper, sources `cloud_lib.sh`. Modes: preflight (default, safe no-op) / dry-run / apply. flock, preflight-gate, confirm-token gate, halt-sentinel check. |
| `backend/scripts/run_harvest_outbound.py` | Hardened runner: before/after counts, optional snapshot, invokes `run_worker.py --job harvest-outbound-products` (which now owns `pin_products_writer.lock` for the write — see Headline), parses its JSON report, runs the 95% coverage gate, writes the run's JSON log. Runner does NOT take the writer lock itself (would self-skip the subprocess). |
| `backend/deploy/systemd/vibepin-harvest-outbound.service` | `Type=oneshot`, default mode `preflight` (no-op even if manually started). |
| `backend/deploy/systemd/vibepin-harvest-outbound.timer` | Daily `13:00 Asia/Shanghai`, `RandomizedDelaySec=600`. **Disabled by default.** |

Separate service/timer/lock/log names from the existing (also-disabled)
`vibepin-product-supply.*` — no shared state with the Playwright STL job.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `VIBEPIN_HARVEST_MODE` | `preflight` | `preflight` \| `dry-run` \| `apply` |
| `VIBEPIN_HARVEST_SINCE_HOURS` | `48` | forwarded `--since-hours` |
| `VIBEPIN_HARVEST_LIMIT` | `800` | forwarded `--limit` |
| `VIBEPIN_HARVEST_APPLY_CONFIRM` | *(unset)* | must equal `APPLY_OUTBOUND_HARVEST` to write |
| `VIBEPIN_HARVEST_MIN_COVERAGE` | `0.95` | clean-coverage hard-stop floor |
| `VIBEPIN_HARVEST_COVERAGE_MIN_DENOM` | `20` | only *halt* (vs. warn) once this many rows were inserted this run |
| `VIBEPIN_HARVEST_SNAPSHOT` | `1` | take a pre-apply `pin_products` snapshot (see Rollback) |
| `VIBEPIN_HARVEST_AUTO_ROLLBACK` | `0` | `1` = on a halting breach, also auto-delete+restore |
| `VIBEPIN_HARVEST_TIMEOUT_SECONDS` | `600` | outer tree-timeout (job itself runs in ~5s) |

## Wrapper logic (bash, mirrors `cloud_run_product_supply.sh`'s house style)

```bash
#!/usr/bin/env bash
# cloud_run_harvest_outbound.sh — pure-DB job. NO Playwright, NO Pinterest
# navigation, NO scraping. Separate from vibepin-product-supply.*.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cloud_lib.sh"
cloud_init "harvest_outbound"     # logs/cloud_run_harvest_outbound_<stamp>.log
                                  # -> matches IGNORED_LOG_GLOBS, no preflight self-trip

MODE="${1:-${VIBEPIN_HARVEST_MODE:-preflight}}"
SINCE_HOURS="${VIBEPIN_HARVEST_SINCE_HOURS:-48}"
LIMIT="${VIBEPIN_HARVEST_LIMIT:-800}"
TIMEOUT_SECONDS="${VIBEPIN_HARVEST_TIMEOUT_SECONDS:-600}"
MIN_COVERAGE="${VIBEPIN_HARVEST_MIN_COVERAGE:-0.95}"
MIN_DENOM="${VIBEPIN_HARVEST_COVERAGE_MIN_DENOM:-20}"
SNAPSHOT="${VIBEPIN_HARVEST_SNAPSHOT:-1}"
AUTO_ROLLBACK="${VIBEPIN_HARVEST_AUTO_ROLLBACK:-0}"
APPLY_CONFIRM_TOKEN="APPLY_OUTBOUND_HARVEST"
HALT_SENTINEL="$LOCK_DIR/harvest_outbound.halt"

cloud_flock                       # cloud_run_harvest_outbound.lock, exit 9 if held
cloud_log "mode=$MODE since=${SINCE_HOURS}h limit=$LIMIT timeout=${TIMEOUT_SECONDS}s"
cloud_preflight_gate              # reuse preflight_product_supply.py

case "$MODE" in
  preflight) cloud_log "preflight-only: safe, nothing written."; exit 0 ;;
  dry-run)
    cloud_run_with_tree_timeout "$TIMEOUT_SECONDS" \
      "$PY" scripts/run_harvest_outbound.py --since-hours "$SINCE_HOURS" --limit "$LIMIT"
    exit $? ;;
  apply)
    [[ -f "$HALT_SENTINEL" ]] && { cloud_log "REFUSE: halt sentinel present, needs operator review"; exit 12; }
    [[ "${VIBEPIN_HARVEST_APPLY_CONFIRM:-}" == "$APPLY_CONFIRM_TOKEN" ]] || \
      { cloud_log "REFUSE: set VIBEPIN_HARVEST_APPLY_CONFIRM=$APPLY_CONFIRM_TOKEN"; exit 5; }
    args=( --since-hours "$SINCE_HOURS" --limit "$LIMIT" --apply --confirm "$APPLY_CONFIRM_TOKEN"
           --min-coverage "$MIN_COVERAGE" --min-denom "$MIN_DENOM" --halt-sentinel "$HALT_SENTINEL" )
    [[ "$SNAPSHOT" == "1" ]] && args+=( --snapshot )
    [[ "$AUTO_ROLLBACK" == "1" ]] && args+=( --auto-rollback )
    cloud_run_with_tree_timeout "$TIMEOUT_SECONDS" "$PY" scripts/run_harvest_outbound.py "${args[@]}"
    exit $? ;;
  *) cloud_log "REFUSE: unknown mode '$MODE'"; exit 2 ;;
esac
```

## Runner logic (`run_harvest_outbound.py`, pseudocode — invokes `run_worker.py` as a subprocess, never re-implements harvest logic)

```
before_total   = head_count(pin_products, {})
before_harvest = head_count(pin_products, {discovery_method: eq.outbound_link_bootstrap})
run_start_iso  = now_utc_iso()                       # captured BEFORE any write

if apply:
    # NOTE (Task B): do NOT acquire pin_products_writer.lock here. run_worker.py's
    # harvest-apply branch now takes it itself; acquiring it in this parent process
    # would make the subprocess find it held (by a live PID) and skip its own write.
    if snapshot: snapshot_pin_products(run_start_iso)     # see Rollback below
    report = run_worker_subprocess(apply=True)            # subprocess owns the writer lock
    # If the subprocess logged "apply skipped — pin_products_writer.lock held by ...",
    # treat as a WAIT (another writer active) and exit without the coverage gate.
else:
    report = run_worker_subprocess(apply=False)

emit_summary(accepted=report.ecommerceProductLinksAccepted,
             inserted=report.projectedInserts, updated=report.projectedUpdates,
             written=report.writes.pin_products, duplicates=report.duplicatesByNormalizedUrl,
             rejected=report.linksRejected, reject_reasons=report.rejectReasonDistribution,
             category_dist=report.categoryDistribution, platform_dist=report.platformDistribution)

after_total = head_count(pin_products, {}); after_harvest = head_count(..., {discovery_method: eq...})
log(f"pin_products {before_total} -> {after_total}; harvested {before_harvest} -> {after_harvest}")

if apply:
    denom = head_count(pin_products, {discovery_method: eq.outbound_link_bootstrap, created_at: gte.<run_start_iso>})
    numer = head_count(..., {..., image_url: not.is.null, source_url: not.is.null})
    coverage = 1.0 if denom == 0 else numer/denom
    if denom > 0 and coverage < MIN_COVERAGE:
        write_json(breach_report)
        if denom >= MIN_DENOM:
            write_file(HALT_SENTINEL, breach_report)      # future applies refuse until an operator clears it
            if AUTO_ROLLBACK: execute(ROLLBACK_SQL); restore_from_snapshot()
            return 12
        else:
            log("below floor but denom < MIN_DENOM -> WARN only, no halt")
```

Before/after counts use the same PostgREST head-count method already proven this
session (`GET pin_products?<filter>&limit=1` with `Prefer: count=exact`, `Range: 0-0`
→ parse `Content-Range: 0-0/<N>`).

## "Clean coverage" — exact definition and hard-stop

**Clean = `image_url` present AND `source_url` present AND `parent_pin_id` present**
(matching the actual predicate in `web/src/app/api/products/top/route.ts`;
`parent_pin_id` is `NOT NULL` by schema so it's always true). Measured only over
**this run's** new inserts (`discovery_method='outbound_link_bootstrap' AND
created_at >= run_start_iso`) — not the whole table.

- **Floor: 0.95.** Below it **and** ≥20 new rows this run → write a breach report,
  create a **halt sentinel** file, and **refuse all future `apply` runs** until an
  operator inspects and removes it. No silent auto-delete by default.
- Below 20 new rows: **warn only**, don't halt (one bad row on a quiet day shouldn't
  wedge the pipeline).
- Opt-in `VIBEPIN_HARVEST_AUTO_ROLLBACK=1`: on a halting breach, also execute the
  rollback SQL and restore overwritten rows from the snapshot before halting.
- Coverage has been **100%** in every real run this session — this gate is a canary,
  not an expected trigger.

## Rollback plan

**Inserts** (exact — this run's new rows only):
```sql
DELETE FROM pin_products
 WHERE discovery_method = 'outbound_link_bootstrap'
   AND created_at >= '<RUN_START_ISO>';
```

**Overwritten existing rows are NOT covered by that delete.** The harvester's
`upsert(on_conflict=parent_pin_id,source_url)` can **update** pre-existing rows
sharing that key (refreshing save counts, image_url, etc.) without changing their
`created_at`. Since the recommended daily 48h window deliberately re-touches
yesterday's rows every run, these overwrites are routine, not an edge case — hence
**the pre-apply snapshot defaults ON**: export `id, parent_pin_id, source_url,
discovery_method, created_at, image_url, save_count, source_pin_save_count,
product_name` for the whole table to `logs/harvest_snapshot_<stamp>.json` (cheap —
a few thousand rows) before writing. Restoring an overwritten row = re-upserting its
snapshot pre-image on `(parent_pin_id, source_url)`.

## systemd units (full text, install-only — does NOT enable)

`vibepin-harvest-outbound.service`:
```ini
[Unit]
Description=VibePin outbound-link harvester (pure-DB, preflight-gated, tree-kill)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=oneshot
WorkingDirectory=/opt/vibepin/backend
EnvironmentFile=-/opt/vibepin/backend/.env
Environment=VIBEPIN_HARVEST_MODE=preflight
Environment=VIBEPIN_LOCK_DIR=/opt/vibepin/locks
ExecStart=/opt/vibepin/backend/scripts/cloud_run_harvest_outbound.sh
TimeoutStartSec=900
TimeoutStopSec=60
KillMode=control-group
Restart=no
Nice=10
IOSchedulingClass=idle
StandardOutput=journal
StandardError=journal
SyslogIdentifier=vibepin-harvest-outbound

[Install]
WantedBy=multi-user.target
```

`vibepin-harvest-outbound.timer`:
```ini
[Unit]
Description=VibePin outbound-link harvester daily timer (13:00 Asia/Shanghai)

[Timer]
OnCalendar=*-*-* 13:00:00 Asia/Shanghai
RandomizedDelaySec=600
Persistent=false
Unit=vibepin-harvest-outbound.service

[Install]
WantedBy=timers.target
```

## Cadence, window, and schedule placement

- **Daily**, since the job costs ~5s regardless of window.
- **`--since-hours 48`, not 336.** Yield is driven by *new* eligible links since the
  last run, not window width — on a daily cadence, 336h just re-scans the same rows
  as idempotent updates. 48h gives a deliberate 1-day overlap (safe if a run is
  skipped) with no extra cost, thanks to the unique-constraint dedup. (336h remains
  correct for a one-off backfill, not steady state.)
- **`--limit 800` (raise to 2000+ if backfilling).** After the Task A pagination fix
  the scan honors the full limit. Corrected dry-runs (2026-07-07, pagination-fixed):
  **336h scanned 1809 pins → 361 projected inserts / 369 updates**; **48h scanned only
  14 pins → 2 projected inserts.** The 361 is a *one-time backlog* (the rank-1001+ pins
  the pre-fix capped code never reached), NOT a daily rate.
- **Expected steady-state yield: essentially crawler-bound.** With no crawler running,
  the 48h window currently holds only ~14 eligible pins → ~2 inserts/day. The earlier
  "~70–90/day" estimate assumed a daily crawler feeding fresh `pin_samples.outbound_link`.
  **Without the Pin crawler, this harvester's daily yield is ~0–2 and the backlog is
  finite.** Recommended rollout: (1) one manual `--since-hours 336 --limit 2000 --apply`
  to drain the ~361 backlog, then (2) the daily 48h timer, which only pays off once the
  crawler is also feeding new pins.
- **`OnCalendar` = 13:00 Asia/Shanghai.** Existing timers: trends 09:00, pin-crawl
  10:30 (≤90min), product-supply 23:00. 13:00 sits ~1h after the crawl's worst-case
  finish (same-day freshness) and 10h before product-supply — no collision with any
  Pinterest/Playwright window, and the harvester's own preflight defers (`WAIT`) if
  `pinterest_network.lock` is somehow still live. Full daily order becomes:
  trends → crawl → **harvest (new)** → product-supply.

## Enable / disable / stop

**Install only (no timer enabled):**
```bash
sudo cp backend/deploy/systemd/vibepin-harvest-outbound.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/vibepin-harvest-outbound.service
sudo systemctl start vibepin-harvest-outbound.service   # safe preflight-only default
journalctl -u vibepin-harvest-outbound.service --no-pager | tail -40
```

**Go live (only after review):** set `VIBEPIN_HARVEST_MODE=apply` +
`VIBEPIN_HARVEST_APPLY_CONFIRM=APPLY_OUTBOUND_HARVEST` in the service file, then
`sudo systemctl daemon-reload && sudo systemctl enable --now vibepin-harvest-outbound.timer`.

**Disable / stop:**
```bash
sudo systemctl disable --now vibepin-harvest-outbound.timer   # instant, no data change
sudo systemctl stop vibepin-harvest-outbound.service           # if a run is in flight
# Full removal:
sudo rm -f /etc/systemd/system/vibepin-harvest-outbound.{service,timer}
sudo systemctl daemon-reload
```

## What was verified vs. assumed (Opus design pass, 2026-07-06)

**Verified by reading the code:** harvest is pure-DB (no Playwright import anywhere
in its path); today's apply gate is weak (no confirm/lock/preflight); the
STL-vs-harvest lock asymmetry; exact JSON report field names (cross-checked against
a real `logs/harvest_apply.log`); `cloud_lib.sh`'s self-trip-avoiding log-name
convention; existing schedule times; `UNIQUE(parent_pin_id, source_url)` and the
`discovery_method` CHECK constraint allowing `outbound_link_bootstrap`; the clean-row
predicate as used by the actual product API route.

**Assumed / not fully confirmed:** `.env` on the VPS contains `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` under those exact names (inferred from the preflight
script using them); the `.timer` files' exact prior text (only `.service` files were
available to read, so the timer text above is freshly authored in-style, not copied).
