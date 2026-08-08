#!/usr/bin/env python3
"""
stage_generation_worker.py — surgical staging of the WP3 generation worker.

Uploads worker code + systemd unit, installs deps, import-checks. Deliberately:
  - does NOT write LINAPI_KEY or any new secret to the VPS
  - does NOT enable or start the service (hard prerequisite: credential rotation)
  - does NOT run deploy_vps.sh (crawler pipeline; restarts timers)

Creds come from backend/deploy.env via _vps_env.get_vps_credentials().
Bundle is expected at %TEMP%/genworker-bundle.tar.gz (built by the .ps1 sibling
or the inline tar step below when missing).
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _vps_env import get_vps_credentials  # noqa: E402

import paramiko  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
BUNDLE = Path(tempfile.gettempdir()) / "genworker-bundle.tar.gz"


def build_bundle() -> None:
    stage = Path(tempfile.gettempdir()) / "vibepin-genworker-stage"
    if stage.exists():
        subprocess.run(["cmd", "/c", "rmdir", "/s", "/q", str(stage)], check=False)
    (stage / "api").mkdir(parents=True)
    (stage / "backend" / "deploy" / "systemd").mkdir(parents=True)
    subprocess.run(["robocopy", str(REPO / "api" / "app"), str(stage / "api" / "app"), "/e", "/njh", "/njs", "/ndl", "/nc", "/ns", "/np"], check=False)
    for src, dst in [
        (REPO / "api" / "requirements.txt", stage / "api" / "requirements.txt"),
        (REPO / "backend" / "generator.py", stage / "backend" / "generator.py"),
        (REPO / "backend" / "deploy" / "systemd" / "vibepin-generation-worker.service",
         stage / "backend" / "deploy" / "systemd" / "vibepin-generation-worker.service"),
    ]:
        dst.write_bytes(src.read_bytes())
    if BUNDLE.exists():
        BUNDLE.unlink()
    subprocess.run(["tar", "-czf", str(BUNDLE), "-C", str(stage), "."], check=True)
    print(f"bundle: {BUNDLE.stat().st_size} bytes")


def run(ssh: paramiko.SSHClient, cmd: str) -> str:
    _, out, err = ssh.exec_command(cmd, timeout=600)
    code = out.channel.recv_exit_status()
    o, e = out.read().decode("utf-8", "replace"), err.read().decode("utf-8", "replace")
    if code != 0:
        print(f"REMOTE FAIL ({code}): {cmd}\n{o}\n{e}", file=sys.stderr)
        raise SystemExit(1)
    return o.strip()


def main() -> None:
    if not BUNDLE.exists():
        build_bundle()
    host, port, user, password = get_vps_credentials()
    root = os.environ.get("VPS_DEPLOY_ROOT", "/opt/vibepin")

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(host, port=port, username=user, password=password, timeout=30)
    try:
        sftp = ssh.open_sftp()
        sftp.put(str(BUNDLE), "/tmp/genworker-bundle.tar.gz")
        sftp.close()

        run(ssh, f"mkdir -p {root}/api {root}/backend/deploy/systemd /tmp/genworker"
                 f" && tar -xzf /tmp/genworker-bundle.tar.gz -C /tmp/genworker")
        run(ssh, f"if [ -f {root}/backend/generator.py ]; then cp {root}/backend/generator.py {root}/backend/generator.py.pre-wp3.bak; fi")
        run(ssh, f"rm -rf {root}/api/app && cp -r /tmp/genworker/api/app {root}/api/app"
                 f" && (cp /tmp/genworker/api/requirements.txt {root}/api/ 2>/dev/null || true)"
                 f" && cp /tmp/genworker/backend/generator.py {root}/backend/generator.py")
        print(run(ssh, "python3 -m pip install --quiet --disable-pip-version-check httpx supabase pydantic-settings openai pillow 2>&1 | tail -2; echo deps-ok"))
        run(ssh, "cp /tmp/genworker/backend/deploy/systemd/vibepin-generation-worker.service /etc/systemd/system/"
                 " && systemctl daemon-reload")
        print(run(ssh, f"cd {root}/api && PYTHONPATH={root}/api:{root}/backend"
                       f" python3 -c 'import app.worker; import generator; print(\"import-ok\")'"))
        print("enabled? ", run(ssh, "systemctl is-enabled vibepin-generation-worker || true"))
        print("active?  ", run(ssh, "systemctl is-active vibepin-generation-worker || true"))
        run(ssh, "rm -rf /tmp/genworker /tmp/genworker-bundle.tar.gz")
        print("STAGING COMPLETE — no secrets written, service installed but disabled.")
    finally:
        ssh.close()


if __name__ == "__main__":
    main()
