#!/usr/bin/env python3
"""Clear stale locks/runs on VPS, rerun stl-score, verify."""
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
    c.connect(
        cfg["VPS_HOST"], port=int(cfg.get("VPS_PORT", "22")),
        username=cfg["VPS_USER"], password=cfg["VPS_PASSWORD"],
        timeout=60, banner_timeout=60, auth_timeout=60,
    )

    sftp = c.open_sftp()
    for name in ("verify_db_labels.py", "clear_stale_runs.py"):
        sftp.put(str(ROOT / "scripts" / name), f"{REMOTE}/scripts/{name}")
    sftp.close()

    def exec_cmd(cmd: str, timeout: int = 7200) -> tuple[int, str]:
        print(f">> {cmd[:80]}...", flush=True)
        _i, o, e = c.exec_command(f"cd {REMOTE} && {cmd}", timeout=timeout)
        o.channel.settimeout(timeout)
        try:
            text = (o.read() + e.read()).decode("utf-8", errors="replace")
        except Exception as exc:
            text = f"(output read timeout: {exc})"
        code = o.channel.recv_exit_status()
        if text.strip():
            sys.stdout.buffer.write(text[-12000:].encode("utf-8", errors="replace"))
        print(f"exit={code}", flush=True)
        return code, text

    exec_cmd(f"{PY} scripts/clear_stale_runs.py", timeout=120)
    # Detach long stl job so SSH drop does not kill it
    exec_cmd(
        f"nohup {PY} run_worker.py --job stl-score >> logs/stl_manual.log 2>&1 & echo STL_PID=$!",
        timeout=30,
    )
    print("stl-score started in background on VPS (logs/stl_manual.log)", flush=True)
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
