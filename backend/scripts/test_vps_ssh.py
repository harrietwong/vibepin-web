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
        cfg[k.strip()] = v.strip().strip('"').strip("'")

print("connecting...", flush=True)
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(
    cfg["VPS_HOST"],
    port=int(cfg.get("VPS_PORT", "22")),
    username=cfg["VPS_USER"],
    password=cfg["VPS_PASSWORD"],
    timeout=20,
)
print("SSH OK", flush=True)
_, stdout, _ = c.exec_command("uname -a", timeout=10)
print(stdout.read().decode().strip(), flush=True)
c.close()
