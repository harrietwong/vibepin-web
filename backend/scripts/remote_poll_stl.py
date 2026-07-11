#!/usr/bin/env python3
"""Poll VPS until stl-score run finishes, then print status."""
from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from deploy_vps_paramiko import load_deploy_env  # noqa: E402
import paramiko

PY = ".venv/bin/python"
REMOTE = "/opt/vibepin/backend"


def run(c, cmd: str, timeout: int = 120) -> str:
    _i, o, e = c.exec_command(f"cd {REMOTE} && {cmd}", timeout=timeout)
    return (o.read() + e.read()).decode("utf-8", errors="replace")


def main() -> int:
    cfg = load_deploy_env()
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(cfg["VPS_HOST"], port=int(cfg.get("VPS_PORT", "22")),
              username=cfg["VPS_USER"], password=cfg["VPS_PASSWORD"], timeout=30)

    print("Polling stl-score on VPS...", flush=True)
    for i in range(120):  # up to 60 min
        out = run(c, f"{PY} -c \""
            "import sys; sys.path.insert(0,'db'); "
            "from db import select_one; "
            "r=select_one('pipeline_runs',{{'job_type':'stl-score'}}); "
            "rows=__import__('db').select_many('pipeline_runs',order='started_at.desc',limit=1); "
            "r=rows[0] if rows else {{}}; "
            "print(r.get('status'), r.get('started_at'), r.get('finished_at'))\" 2>&1 || "
            f"{PY} scripts/check_pipeline_status.py 2>&1 | head -15")
        # simpler poll
        out = run(c, "ps aux | grep -E 'shop_the_look|stl-score|run_worker' | grep -v grep || echo NO_PROC")
        if "NO_PROC" in out and i > 2:
            print("stl process not running", flush=True)
            break
        if i % 6 == 0:
            print(f"[{i*30}s] {out.strip()[:200]}", flush=True)
        time.sleep(30)

    print("\n== final status ==", flush=True)
    for cmd in [f"{PY} scripts/check_pipeline_status.py", f"{PY} scripts/verify_db_labels.py"]:
        text = run(c, cmd, timeout=180)
        sys.stdout.buffer.write(text.encode("utf-8", errors="replace"))

    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
