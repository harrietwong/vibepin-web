#!/usr/bin/env python3
"""Install playwright on VPS and rerun stl-score + status checks."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from deploy_vps_paramiko import load_deploy_env  # noqa: E402
import paramiko

PY = ".venv/bin/python"
REMOTE = "/opt/vibepin/backend"


def run(c, cmd: str, timeout: int = 7200) -> tuple[int, str]:
    print(f"$ {cmd[:100]}...", flush=True)
    _i, o, e = c.exec_command(f"cd {REMOTE} && {cmd}", timeout=timeout)
    out = o.read().decode("utf-8", errors="replace")
    err = e.read().decode("utf-8", errors="replace")
    code = o.channel.recv_exit_status()
    text = (out + err)[-6000:]
    if text:
        sys.stdout.buffer.write(text.encode("utf-8", errors="replace"))
    print(f"exit={code}", flush=True)
    return code, out


def main() -> int:
    cfg = load_deploy_env()
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(cfg["VPS_HOST"], port=int(cfg.get("VPS_PORT", "22")),
              username=cfg["VPS_USER"], password=cfg["VPS_PASSWORD"], timeout=30)

    sftp = c.open_sftp()
    sftp.put(str(ROOT / "requirements-cloud.txt"), f"{REMOTE}/requirements-cloud.txt")
    sftp.put(str(ROOT / "scripts" / "verify_db_labels.py"), f"{REMOTE}/scripts/verify_db_labels.py")
    sftp.close()

    steps = [
        f"{PY} -m pip install playwright -q",
        f"{PY} -m playwright install chromium",
        f"export DEBIAN_FRONTEND=noninteractive && {PY} -m playwright install-deps chromium",
        f"{PY} run_worker.py --job stl-score",
        f"{PY} scripts/check_pipeline_status.py",
        f"{PY} scripts/verify_db_labels.py",
    ]
    for cmd in steps:
        code, _ = run(c, cmd)
        if "stl-score" in cmd and code != 0:
            c.close()
            return code
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
