#!/usr/bin/env python3
import sys
from pathlib import Path
import paramiko

ROOT = Path(__file__).resolve().parent.parent
cfg = {}
for line in (ROOT / "deploy.env").read_text(encoding="utf-8-sig").splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        cfg[k.strip()] = v.strip()

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(cfg["VPS_HOST"], port=int(cfg.get("VPS_PORT", "22")),
          username=cfg["VPS_USER"], password=cfg["VPS_PASSWORD"], timeout=30)

cmds = [
    "ls -la /opt/vibepin/backend/run_worker.py /opt/vibepin/backend/.venv/bin/python",
    "crontab -l 2>/dev/null || echo '(no cron yet)'",
    "cd /opt/vibepin/backend && .venv/bin/python run_worker.py --help 2>&1 | head -3",
]
for cmd in cmds:
    _, o, _ = c.exec_command(cmd, timeout=60)
    print(f"--- {cmd}")
    sys.stdout.buffer.write(o.read())
    print()

c.close()
