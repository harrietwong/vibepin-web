#!/usr/bin/env python3
"""Safe VPS status check (reads deploy.env, no secrets printed)."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT.parent / "scripts"))

def load_deploy_env() -> dict[str, str]:
    path = ROOT / "deploy.env"
    cfg: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        cfg[k.strip()] = v.strip().strip('"').strip("'")
    return cfg


def ssh_run(client, cmd, timeout=60):
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    return stdout.read().decode("utf-8", errors="replace"), stderr.read().decode("utf-8", errors="replace")


def main() -> int:
    try:
        import paramiko
    except ImportError:
        print("paramiko not installed")
        return 1

    cfg = load_deploy_env()
    host = cfg.get("VPS_HOST", "")
    user = cfg.get("VPS_USER", "root")
    password = cfg.get("VPS_PASSWORD", "")
    if not host or not password:
        print("Missing VPS_HOST or VPS_PASSWORD in deploy.env")
        return 1

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, port=int(cfg.get("VPS_PORT", "22")), username=user, password=password, timeout=20)

    checks = [
        ("crontab", "crontab -l 2>/dev/null || echo '(no crontab)'"),
        ("git_head", "cd /opt/vibepin/backend && git rev-parse --short HEAD 2>/dev/null || echo 'no git'"),
        ("run_worker_classify", "grep -n 'classify + opportunities\\|job_classify\\|job_daily' /opt/vibepin/backend/run_worker.py | head -8"),
        ("crawl_guard", "grep -n 'PINTEREST_SEARCH_CRAWL\\|Search-crawl' /opt/vibepin/backend/pipeline.py 2>/dev/null | head -6 || echo 'no guard in pipeline.py'"),
        ("env_crawl_flag", "grep 'PINTEREST_SEARCH_CRAWL' /opt/vibepin/backend/.env 2>/dev/null || echo 'not set'"),
        ("daily_log_tail", "tail -n 40 /opt/vibepin/backend/logs/cron_daily.log 2>/dev/null | strings | tail -25"),
    ]

    for label, cmd in checks:
        out, err = ssh_run(client, cmd)
        print(f"=== {label} ===")
        print(out.strip() or err.strip() or "(empty)")

    client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
