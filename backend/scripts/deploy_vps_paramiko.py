#!/usr/bin/env python3
"""Deploy backend to VPS via SSH/SFTP (reads backend/deploy.env)."""
from __future__ import annotations

import os
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SKIP_DIRS = {
    ".venv", "venv", "__pycache__", "logs", ".git", "tests",
    "pinterest_profile", "vibe_library",  # local browser/cache — not for worker
}
SKIP_FILES = {"deploy.env"}


def load_deploy_env() -> dict[str, str]:
    path = ROOT / "deploy.env"
    if not path.exists():
        raise SystemExit(f"Missing {path} — copy deploy.env.example")
    cfg: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        cfg[k.strip()] = v
    return cfg


def iter_upload_files(base: Path):
    for p in base.rglob("*"):
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        if p.is_file() and p.name not in SKIP_FILES:
            yield p


def build_zip() -> Path:
    fd, name = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    zpath = Path(name)
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as zf:
        for local in iter_upload_files(ROOT):
            zf.write(local, local.relative_to(ROOT).as_posix())
    return zpath


def main() -> int:
    try:
        import paramiko
    except ImportError:
        print("Run: pip install paramiko", flush=True)
        return 1

    cfg = load_deploy_env()
    host = cfg.get("VPS_HOST", "")
    user = cfg.get("VPS_USER", "root")
    password = cfg.get("VPS_PASSWORD", "")
    port = int(cfg.get("VPS_PORT", "22"))
    deploy_root = cfg.get("VPS_DEPLOY_ROOT", "/opt/vibepin")
    remote_backend = f"{deploy_root}/backend"

    if not host:
        raise SystemExit("Set VPS_HOST in deploy.env")
    if not password:
        raise SystemExit("VPS_PASSWORD is empty — save deploy.env (Ctrl+S)")

    if not (ROOT / "run_worker.py").exists():
        raise SystemExit(f"Backend not found: {ROOT}")
    if not (ROOT / ".env").exists():
        raise SystemExit("Missing backend/.env (Supabase secrets)")

    print("== VibePin VPS deploy (paramiko) ==", flush=True)
    print(f"Target: {user}@{host}:{port} -> {remote_backend}", flush=True)

    print("Building zip bundle...", flush=True)
    zpath = build_zip()
    print(f"Bundle size: {zpath.stat().st_size // 1024} KB", flush=True)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print("Connecting SSH...", flush=True)
    client.connect(host, port=port, username=user, password=password, timeout=30)
    sftp = client.open_sftp()

    def run(cmd: str, timeout: int = 3600) -> tuple[int, str, str]:
        print(f"$ {cmd[:100]}...", flush=True)
        _in, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        code = stdout.channel.recv_exit_status()
        return code, out, err

    run(f"mkdir -p {deploy_root} && rm -rf {remote_backend} && mkdir -p {remote_backend}")

    remote_zip = f"{remote_backend}/vibepin-bundle.zip"
    print("Uploading bundle...", flush=True)
    sftp.put(str(zpath), remote_zip)
    zpath.unlink(missing_ok=True)

    code, out, err = run(
        "export DEBIAN_FRONTEND=noninteractive && "
        "apt-get update -qq && apt-get install -y -qq unzip python3 python3-venv python3-pip",
        timeout=600,
    )
    if code != 0:
        print(err, file=sys.stderr, flush=True)
        sftp.close()
        client.close()
        return code

    code, out, err = run(
        f"cd {remote_backend} && unzip -o vibepin-bundle.zip && rm vibepin-bundle.zip && "
        f"chmod +x scripts/*.sh",
        timeout=300,
    )
    if out:
        print(out[-2000:], flush=True)
    if code != 0:
        print(err, file=sys.stderr, flush=True)
        sftp.close()
        client.close()
        return code

    print("Running bootstrap + smoke (may take 10-20 min)...", flush=True)
    code, out, err = run(
        f"export DEPLOY_ROOT='{deploy_root}' && cd {remote_backend} && "
        f"sed -i 's/\\r$//' scripts/*.sh && bash scripts/deploy_vps.sh",
        timeout=3600,
    )
    if out:
        print(out, flush=True)
    if err:
        print(err, file=sys.stderr, flush=True)

    sftp.close()
    client.close()

    if code != 0:
        print(f"Remote bootstrap failed (exit {code})", flush=True)
        return code
    print("Deploy + smoke finished.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
