#!/usr/bin/env python3
"""
Run full cloud pipeline verification on VPS via SSH.
Reads deploy.env locally — never prints secrets.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from deploy_vps_paramiko import load_deploy_env  # noqa: E402

import paramiko

PY = ".venv/bin/python"
REMOTE = None  # set in main


def ssh_connect(cfg: dict) -> paramiko.SSHClient:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        cfg["VPS_HOST"], port=int(cfg.get("VPS_PORT", "22")),
        username=cfg["VPS_USER"], password=cfg["VPS_PASSWORD"], timeout=30,
    )
    return c


def run_step(c: paramiko.SSHClient, label: str, cmd: str, timeout: int = 3600) -> int:
    full = f"cd {REMOTE} && {cmd}"
    print(f"\n{'='*60}\n>> {label}\n$ {cmd}\n", flush=True)
    t0 = time.time()
    _i, stdout, stderr = c.exec_command(full, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    elapsed = time.time() - t0
    def emit(text: str) -> None:
        if text:
            sys.stdout.buffer.write(text.encode("utf-8", errors="replace"))
            if not text.endswith("\n"):
                sys.stdout.write("\n")
    emit(out[-8000:] if len(out) > 8000 else out)
    if err and code != 0:
        emit(err[-2000:])
    print(f"[{label}] exit={code} elapsed={elapsed:.0f}s", flush=True)
    return code


def upload_file(c: paramiko.SSHClient, local: Path, remote_path: str) -> None:
    sftp = c.open_sftp()
    sftp.put(str(local), remote_path)
    sftp.close()


def main() -> int:
    global REMOTE
    cfg = load_deploy_env()
    REMOTE = f"{cfg.get('VPS_DEPLOY_ROOT', '/opt/vibepin')}/backend"
    c = ssh_connect(cfg)

    steps = [
        ("Step 1: confirm deploy", f"pwd && ls -la run_worker.py scripts/check_pipeline_status.py .env {PY} 2>&1 && {PY} --version", 60),
        ("Step 2: smoke", f"{PY} run_worker.py --job smoke", 3600),
        ("Step 3a: trends", f"{PY} run_worker.py --job trends", 3600),
        ("Step 3b: crawl", f"{PY} run_worker.py --job crawl --limit-keywords 20", 7200),
        ("Step 3c: stl-score", f"{PY} run_worker.py --job stl-score", 7200),
        ("Step 3d: pipeline status", f"{PY} scripts/check_pipeline_status.py", 120),
    ]

    results: dict[str, int] = {}
    for label, cmd, timeout in steps:
        code = run_step(c, label, cmd, timeout=timeout)
        results[label] = code
        if code != 0 and "confirm" not in label and "status" not in label:
            print(f"\nSTOP: {label} failed (exit {code})", flush=True)
            break

    # Upload and run DB verify script
    upload_file(c, ROOT / "scripts" / "verify_db_labels.py", f"{REMOTE}/scripts/verify_db_labels.py")
    results["Step 4: db labels"] = run_step(c, "Step 4: db labels", f"{PY} scripts/verify_db_labels.py", 180)

    results["Step 6: crontab"] = run_step(c, "Step 6: crontab", "crontab -l 2>&1", 30)

    c.close()

    print("\n" + "=" * 60)
    print("SUMMARY")
    for k, v in results.items():
        print(f"  {'PASS' if v == 0 else 'FAIL'} ({v}) — {k}")

    failed = [k for k, v in results.items() if v != 0 and "confirm" not in k]
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
