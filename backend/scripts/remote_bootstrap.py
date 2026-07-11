#!/usr/bin/env python3
"""Run deploy_vps.sh on VPS (after files already uploaded)."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from deploy_vps_paramiko import load_deploy_env  # noqa: E402

import paramiko


def main() -> int:
    cfg = load_deploy_env()
    host, user, password = cfg["VPS_HOST"], cfg["VPS_USER"], cfg["VPS_PASSWORD"]
    port = int(cfg.get("VPS_PORT", "22"))
    deploy_root = cfg.get("VPS_DEPLOY_ROOT", "/opt/vibepin")
    remote = f"{deploy_root}/backend"

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, port=port, username=user, password=password, timeout=30)

    cmd = (
        f"export DEPLOY_ROOT='{deploy_root}' && cd {remote} && "
        f"sed -i 's/\\r$//' scripts/*.sh && bash scripts/deploy_vps.sh"
    )
    print(f"Running: {cmd[:80]}...", flush=True)
    _i, stdout, stderr = c.exec_command(cmd, timeout=3600)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    def safe_print(text: str, stream=None) -> None:
        stream = stream or sys.stdout
        enc = getattr(stream, "encoding", None) or "utf-8"
        stream.write(text.encode(enc, errors="replace").decode(enc, errors="replace"))
        if not text.endswith("\n"):
            stream.write("\n")
        stream.flush()

    if out:
        safe_print(out)
    if err:
        safe_print(err, sys.stderr)
    c.close()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
