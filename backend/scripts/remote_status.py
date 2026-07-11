#!/usr/bin/env python3
"""Run check_pipeline_status.py on VPS."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from deploy_vps_paramiko import load_deploy_env  # noqa: E402

import paramiko


def main() -> int:
    cfg = load_deploy_env()
    remote = f"{cfg.get('VPS_DEPLOY_ROOT', '/opt/vibepin')}/backend"
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        cfg["VPS_HOST"], port=int(cfg.get("VPS_PORT", "22")),
        username=cfg["VPS_USER"], password=cfg["VPS_PASSWORD"], timeout=30,
    )
    cmd = f"cd {remote} && .venv/bin/python scripts/check_pipeline_status.py 2>&1 || python3 scripts/check_pipeline_status.py 2>&1"
    _i, stdout, stderr = c.exec_command(cmd, timeout=120)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    sys.stdout.buffer.write(out.encode("utf-8", errors="replace"))
    if err:
        sys.stderr.buffer.write(err.encode("utf-8", errors="replace"))
    c.close()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
