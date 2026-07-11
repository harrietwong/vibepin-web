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

remote = f"{cfg.get('VPS_DEPLOY_ROOT', '/opt/vibepin')}/backend"
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(cfg["VPS_HOST"], port=int(cfg.get("VPS_PORT", "22")),
          username=cfg["VPS_USER"], password=cfg["VPS_PASSWORD"], timeout=30)
cmd = f"cd {remote} && sed -i 's/\\r$//' scripts/install_cron_daily.sh && bash scripts/install_cron_daily.sh && crontab -l"
_, o, e = c.exec_command(cmd, timeout=60)
out = o.read().decode("utf-8", errors="replace")
err = e.read().decode("utf-8", errors="replace")
code = o.channel.recv_exit_status()
sys.stdout.buffer.write(out.encode("utf-8", errors="replace"))
if err:
    sys.stderr.buffer.write(err.encode("utf-8", errors="replace"))
c.close()
raise SystemExit(code)
