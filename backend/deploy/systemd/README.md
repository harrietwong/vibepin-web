# VibePin Product-Supply systemd units (DISABLED by default)

These units schedule the **hardened, preflight-gated** Product-Supply runner on the
VPS. They are **not** enabled by shipping them — a timer only fires after an operator
runs `systemctl enable`. Nothing here auto-runs a crawler or a DB write.

## Files
| File | Role |
|------|------|
| `vibepin-product-supply.service` | oneshot; runs `scripts/cloud_run_product_supply.sh` (default mode `preflight` = safe no-op). Never calls `run_worker.py` directly. |
| `vibepin-product-supply.timer` | daily trigger at `23:00 Asia/Shanghai` (timezone pinned in OnCalendar) + 900s jitter. Disabled until enabled. See `DAILY_PIPELINE.md` for the full three-job schedule. |

## Install (on the VPS — does NOT enable the timer)
```bash
sudo cp /opt/vibepin/backend/deploy/systemd/vibepin-product-supply.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
# Validate without enabling:
systemd-analyze verify /etc/systemd/system/vibepin-product-supply.service
sudo systemctl start vibepin-product-supply.service   # runs the SAFE preflight-only default
journalctl -u vibepin-product-supply.service --no-pager | tail -n 40
```

## Going live later (ONLY after explicit approval)
1. Readiness check: `bash scripts/cloud_readiness_check.sh` (or `python scripts/cloud_readiness_check.py`).
2. Choose a mode by setting it in the service (do **not** inline secrets):
   - dry-run: `Environment=VIBEPIN_CLOUD_MODE=dry-run`
   - apply:   `Environment=VIBEPIN_CLOUD_MODE=apply` **and** `Environment=VIBEPIN_APPLY_CONFIRM=APPLY_BOOTSTRAP_PRODUCTS`
   `sudo systemctl daemon-reload`
3. Enable the daily timer: `sudo systemctl enable --now vibepin-product-supply.timer`
4. Confirm: `systemctl list-timers vibepin-product-supply.timer`

## Notes
- Secrets live only in `/opt/vibepin/backend/.env` (mode 600), loaded via `EnvironmentFile=` / python-dotenv. Never inline them in unit files.
- `VIBEPIN_LOCK_DIR=/opt/vibepin/locks` is required on Linux (the code default is a Windows path).
- The service cgroup + `KillMode=control-group` + the runner's own process-tree kill together prevent orphan post-timeout writes.
- `Restart=no`, no auto-retries — by design.
