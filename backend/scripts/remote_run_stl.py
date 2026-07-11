#!/usr/bin/env python3
"""Run stl-score on VPS with long timeout, then status + db verify."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from deploy_vps_paramiko import load_deploy_env  # noqa: E402
import paramiko

PY = ".venv/bin/python"
REMOTE = "/opt/vibepin/backend"


def main() -> int:
    cfg = load_deploy_env()
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(cfg["VPS_HOST"], port=int(cfg.get("VPS_PORT", "22")),
              username=cfg["VPS_USER"], password=cfg["VPS_PASSWORD"], timeout=30)

    cmds = [
        (f"{PY} run_worker.py --job stl-score", 7200),
        (f"{PY} scripts/check_pipeline_status.py", 120),
        (f"{PY} scripts/verify_db_labels.py", 180),
        ("crontab -l", 30),
    ]
    for cmd, timeout in cmds:
        print(f"\n>> {cmd}", flush=True)
        _i, o, e = c.exec_command(f"cd {REMOTE} && {cmd}", timeout=timeout)
        out = o.read().decode("utf-8", errors="replace")
        err = e.read().decode("utf-8", errors="replace")
        code = o.channel.recv_exit_status()
        text = (out + err)[-10000:]
        if text:
            sys.stdout.buffer.write(text.encode("utf-8", errors="replace"))
        print(f"exit={code}", flush=True)
        if "stl-score" in cmd and code != 0:
            c.close()
            return code
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
