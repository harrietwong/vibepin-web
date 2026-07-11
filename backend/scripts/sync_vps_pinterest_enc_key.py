#!/usr/bin/env python3
"""
Sync PINTEREST_TOKEN_ENC_KEY from web/.env.local to VPS backend/.env.
Never prints the key value.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB_ENV = ROOT.parent / "web" / ".env.local"
sys.path.insert(0, str(ROOT / "scripts"))

from deploy_vps_paramiko import load_deploy_env
import paramiko

KEY = "PINTEREST_TOKEN_ENC_KEY"
FALLBACK_FLAGS = {
    "ENABLE_PINTEREST_TRENDS_EXPERIMENTAL_FALLBACK": "false",
    "ENABLE_PINTEREST_TRENDS_L1": "false",
    "ENABLE_PINTEREST_RESOURCE_L2": "false",
    "ENABLE_TYPEAHEAD_L3": "true",
    "ENABLE_PINTEREST_TRENDS_V5": "true",
}


def read_local_key() -> str:
    if not WEB_ENV.exists():
        raise SystemExit(f"Missing {WEB_ENV}")
    for line in WEB_ENV.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if line.startswith(f"{KEY}="):
            val = line.split("=", 1)[1].strip().strip('"').strip("'")
            if val:
                return val
    raise SystemExit(f"{KEY} not found in {WEB_ENV}")


def patch_env_content(content: str, key: str, value: str, extra: dict[str, str]) -> str:
    lines = content.splitlines()
    out: list[str] = []
    seen = {KEY: False, **{k: False for k in extra}}
    for line in lines:
        stripped = line.strip()
        if stripped.startswith(f"{KEY}="):
            out.append(f"{KEY}={value}")
            seen[KEY] = True
            continue
        matched = False
        for ek in extra:
            if stripped.startswith(f"{ek}="):
                out.append(f"{ek}={extra[ek]}")
                seen[ek] = True
                matched = True
                break
        if not matched:
            out.append(line)
    if not seen[KEY]:
        out.append(f"\n# Pinterest OAuth token decrypt (synced from web/.env.local)")
        out.append(f"{KEY}={value}")
    for ek, ev in extra.items():
        if not seen[ek]:
            out.append(f"{ek}={ev}")
    return "\n".join(out).rstrip() + "\n"


def main() -> int:
    value = read_local_key()
    cfg = load_deploy_env()
    remote = f"{cfg.get('VPS_DEPLOY_ROOT', '/opt/vibepin')}/backend"
    env_path = f"{remote}/.env"

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        cfg["VPS_HOST"], port=int(cfg.get("VPS_PORT", 22)),
        username=cfg["VPS_USER"], password=cfg["VPS_PASSWORD"], timeout=60,
    )
    sftp = c.open_sftp()
    try:
        with sftp.open(env_path, "r") as f:
            current = f.read().decode("utf-8", errors="replace")
    except OSError:
        current = ""
    patched = patch_env_content(current, KEY, value, FALLBACK_FLAGS)
    with sftp.open(env_path, "w") as f:
        f.write(patched)
    sftp.close()

    _, stdout, _ = c.exec_command(
        f"grep -E '^(PINTEREST_TOKEN_ENC_KEY|ENABLE_PINTEREST)=' {env_path} | sed 's/=.*$/=***/'",
        timeout=30,
    )
    print("VPS .env updated (values masked):")
    print(stdout.read().decode("utf-8", errors="replace"))
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
