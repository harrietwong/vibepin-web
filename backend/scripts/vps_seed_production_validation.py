#!/usr/bin/env python3
"""
VPS production validation for trend seed pipeline.
Uploads latest seed modules, checks locks, runs trends + seed-report.
"""
from __future__ import annotations

import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from deploy_vps_paramiko import load_deploy_env  # noqa: E402

import paramiko

PY = ".venv/bin/python"
UPLOAD_FILES = [
    "trend_seed_pipeline.py",
    "seed_report.py",
    "trend_fetcher.py",
    "pinterest_trends_v5_provider.py",
    "official_v5_seed_quality.py",
    "trend_provider_health.py",
    "crawl_queue_ops.py",
    "pipeline.py",
    "run_worker.py",
    "scraper_v2.py",
    "content_filters.py",
    "scripts/check_trends_lock.py",
    "scripts/cleanup_e2e_fixture_seeds.py",
    "scripts/vps_seed_production_validation.py",
]


def connect(cfg: dict) -> paramiko.SSHClient:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        cfg["VPS_HOST"], port=int(cfg.get("VPS_PORT", "22")),
        username=cfg["VPS_USER"], password=cfg["VPS_PASSWORD"],
        timeout=60, banner_timeout=60, auth_timeout=60,
    )
    return c


def exec_remote(c: paramiko.SSHClient, remote: str, cmd: str, timeout: int = 7200) -> tuple[int, str]:
    full = f"cd {remote} && {cmd}"
    print(f"\n>> {cmd[:120]}", flush=True)
    _i, stdout, stderr = c.exec_command(full, timeout=timeout)
    out = (stdout.read() + stderr.read()).decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    return code, out


def upload_seed_modules(c: paramiko.SSHClient, remote: str) -> None:
    sftp = c.open_sftp()
    for rel in UPLOAD_FILES:
        local = ROOT / rel
        if not local.exists():
            continue
        remote_path = f"{remote}/{rel.replace(chr(92), '/')}"
        remote_dir = str(Path(remote_path).parent).replace(chr(92), "/")
        try:
            sftp.stat(remote_dir)
        except OSError:
            parts = remote_dir.split("/")
            cur = ""
            for p in parts:
                if not p:
                    continue
                cur += f"/{p}"
                try:
                    sftp.stat(cur)
                except OSError:
                    sftp.mkdir(cur)
        sftp.put(str(local), remote_path)
        print(f"  uploaded {rel}", flush=True)
    sftp.close()


def parse_json_from_output(text: str) -> dict | None:
    # Find largest JSON object in output
    start = text.find('{\n  "jobTimestamp"')
    if start < 0:
        start = text.rfind("{")
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def enrich_report(report: dict, remote: str, c: paramiko.SSHClient) -> dict:
    """Pull top-N lists and layer stats from trends log if missing."""
    qv = report.get("queueVerification") or {}
    report["top20HighSeeds"] = (report.get("topHighSeeds") or [])[:20]
    report["top20MediumSeeds"] = (report.get("topMediumSeeds") or [])[:20]
    report["top20WatchlistSeeds"] = (report.get("topWatchlistSeeds") or [])[:20]
    report["top20ExcludedSeedsWithReasons"] = (report.get("topExcludedSeedsWithReasons") or [])[:20]
    report["p0CategoriesPresent"] = report.get("p0CategoriesPresent") or []
    report["p0CategoriesMissing"] = report.get("p0CategoriesMissing") or []
    report["nextCrawlAtDistribution"] = qv.get("nextCrawlAtDistribution")
    report["recentSeedQueueRows"] = qv.get("recentSeedQueueRows")
    report["sampleHighPriorityQueueRow"] = qv.get("sampleHighPriorityQueueRow")
    report["sampleMediumQueueRow"] = qv.get("sampleMediumQueueRow")
    report["sampleWatchlistNotInQueue"] = qv.get("sampleWatchlistNotInQueue")
    report["sampleCluster"] = qv.get("sampleCluster")
    report["clusterBudgetWarnings"] = report.get("clusterBudgetWarnings") or []
    return report


def main() -> int:
    cfg = load_deploy_env()
    remote = f"{cfg.get('VPS_DEPLOY_ROOT', '/opt/vibepin')}/backend"
    c = connect(cfg)

    print("== 1) Upload latest seed pipeline modules ==", flush=True)
    upload_seed_modules(c, remote)

    print("\n== 2) Lock state ==", flush=True)
    lock_script = r"""
import sys, json
from datetime import datetime, timezone
sys.path.insert(0, 'db')
from db import select_many, select_one
try:
    from pipeline_tracking import is_lock_held, _purge_expired_locks
    _purge_expired_locks()
except Exception:
    is_lock_held = lambda n: False
locks = select_many('pipeline_locks', limit=20)
runs = select_many('pipeline_runs', order='started_at.desc', limit=5)
proc = __import__('subprocess').run("ps aux | grep 'run_worker.py --job trends' | grep -v grep || true", shell=True, capture_output=True, text=True)
print(json.dumps({'locks': locks, 'recentRuns': runs, 'trendsLockHeld': is_lock_held('trends'), 'trendsProcess': proc.stdout.strip()}))
"""
    _, lock_out = exec_remote(c, remote, f"{PY} -c {json.dumps(lock_script)}", timeout=120)
    lock_state = {}
    if "{" in lock_out:
        try:
            j = lock_out[lock_out.rfind("{"):]
            lock_state = json.loads(j[: j.rfind("}") + 1])
        except Exception:
            lock_state = {"raw": lock_out[-2000:]}

    print(json.dumps(lock_state, indent=2, default=str)[:3000], flush=True)

    trends_proc = (lock_state.get("trendsProcess") or "").strip()
    trends_lock = lock_state.get("trendsLockHeld")
    stale_released = False
    if trends_lock and not trends_proc:
        print("Stale trends lock (no active process) — releasing trends lock only", flush=True)
        release_script = "import sys; sys.path.insert(0,'.'); from pipeline_tracking import release_lock; release_lock('trends'); print('released')"
        exec_remote(c, remote, f"{PY} -c \"{release_script}\"", timeout=60)
        stale_released = True
    elif trends_lock and trends_proc:
        print("ACTIVE trends job detected — not releasing lock", flush=True)
        c.close()
        return 2

    print("\n== 3) Full trends job ==", flush=True)
    t0 = time.time()
    code, trends_out = exec_remote(
        c, remote,
        f"{PY} run_worker.py --job trends --created-by manual 2>&1 | tee logs/trends_production_validation.log",
        timeout=7200,
    )
    trends_elapsed = time.time() - t0
    print(f"trends exit={code} elapsed={trends_elapsed:.0f}s", flush=True)

    trends_report = parse_json_from_output(trends_out)
    layer_match = re.search(r"L1=(\d+) L2=(\d+) L3=(\d+)", trends_out)
    http_errors = re.search(
        r"errors L1=(\d+) L2=(\d+) L3=(\d+)", trends_out,
    )
    l1_404 = trends_out.count("HTTP 404") if "HTTP 404" in trends_out else 0

    print("\n== 4) seed-report JSON ==", flush=True)
    _, report_out = exec_remote(
        c, remote,
        f"{PY} run_worker.py --job seed-report --report-hours 24 2>&1",
        timeout=600,
    )
    seed_report = parse_json_from_output(report_out) or {}

    print("\n== 5) seed-report markdown (tail) ==", flush=True)
    _, md_out = exec_remote(
        c, remote,
        f"{PY} run_worker.py --job seed-report --report-format markdown --report-hours 24 2>&1 | tail -40",
        timeout=600,
    )

    if trends_report:
        seed_report.update({k: v for k, v in trends_report.items() if k not in seed_report or not seed_report.get(k)})

    if layer_match:
        seed_report["layerCounts"] = {"L1": int(layer_match.group(1)), "L2": int(layer_match.group(2)), "L3": int(layer_match.group(3))}
    if http_errors:
        seed_report["httpErrors"] = {"L1": int(http_errors.group(1)), "L2": int(http_errors.group(2)), "L3": int(http_errors.group(3))}
    seed_report["http404Mentions"] = l1_404
    seed_report["trendsJobExitCode"] = code
    seed_report["trendsJobElapsedSec"] = int(trends_elapsed)
    seed_report["staleTrendsLockReleased"] = stale_released
    seed_report["lockStateBeforeRun"] = lock_state

    seed_report = enrich_report(seed_report, remote, c)

    # Acceptance
    scored = int(seed_report.get("seedsScored") or 0)
    cq = int(seed_report.get("crawlQueueEntriesCreated") or seed_report.get("queueStats", {}).get("written") or 0)
    p0_present = seed_report.get("p0CategoriesPresent") or []
    high_med_cats = set()
    for s in (seed_report.get("topHighSeeds") or []) + (seed_report.get("topMediumSeeds") or []):
        if s.get("category"):
            high_med_cats.add(s["category"])

    seed_report["acceptance"] = {
        "nonZeroScoredSeeds": scored > 0,
        "crawlQueueEntriesCreatedGt0": cq > 0,
        "p0CategoriesWithHighMedium": len(p0_present) >= 2 or len(high_med_cats & {"fashion", "womens-fashion", "home-decor", "beauty", "digital-products"}) >= 2,
        "providerBlocker": l1_404 > 5 and scored == 0,
    }

    out_path = ROOT / "logs" / "vps_seed_production_report.json"
    out_path.parent.mkdir(exist_ok=True)
    out_path.write_text(json.dumps(seed_report, indent=2, default=str), encoding="utf-8")
    print("\n== PRODUCTION REPORT ==", flush=True)
    print(json.dumps(seed_report, indent=2, default=str)[:25000], flush=True)
    print(f"\nSaved: {out_path}", flush=True)

    c.close()
    if seed_report["acceptance"].get("providerBlocker"):
        return 3
    if not seed_report["acceptance"].get("nonZeroScoredSeeds"):
        return 4
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
