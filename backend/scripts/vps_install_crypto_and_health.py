#!/usr/bin/env python3
"""Install cryptography on VPS and re-run health checks."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from deploy_vps_paramiko import load_deploy_env
from vps_seed_production_validation import connect, exec_remote, parse_json_from_output

PY = ".venv/bin/python"


def main() -> int:
    cfg = load_deploy_env()
    remote = f"{cfg.get('VPS_DEPLOY_ROOT', '/opt/vibepin')}/backend"
    c = connect(cfg)

    steps = [
        (".venv/bin/pip install cryptography -q", 180),
        (f"{PY} -c 'import cryptography; print(cryptography.__version__)'", 60),
        (f"{PY} scripts/verify_pinterest_token_decrypt.py", 120),
        (f"{PY} run_worker.py --job trend-provider-health", 300),
    ]
    for cmd, timeout in steps:
        code, out = exec_remote(c, remote, cmd, timeout=timeout)
        print(f"\n=== {cmd[:70]} (exit {code}) ===")
        print(out[-4000:])
        if "trend-provider-health" in cmd:
            health = parse_json_from_output(out) or {}
            print("\nPARSED HEALTH:", json.dumps(health, indent=2, ensure_ascii=False, default=str)[:5000])
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
