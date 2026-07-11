#!/usr/bin/env python3
"""Run full VPS provider fix validation sequence."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from deploy_vps_paramiko import load_deploy_env
from vps_seed_production_validation import UPLOAD_FILES, connect, exec_remote, parse_json_from_output
import paramiko

PY = ".venv/bin/python"
OUT = ROOT / "logs" / "vps_provider_fix_validation.json"


def upload_all(c: paramiko.SSHClient, remote: str) -> None:
    sftp = c.open_sftp()
    for rel in UPLOAD_FILES:
        local = ROOT / rel
        if not local.exists():
            continue
        remote_path = f"{remote}/{rel.replace(chr(92), '/')}"
        remote_dir = str(Path(remote_path).parent).replace(chr(92), "/")
        try:
            sftp.stat(remote_dir)
        except OSError:
            parts = remote_dir.split("/")
            cur = ""
            for p in parts:
                if not p:
                    continue
                cur += f"/{p}"
                try:
                    sftp.stat(cur)
                except OSError:
                    sftp.mkdir(cur)
        sftp.put(str(local), remote_path)
        print(f"  uploaded {rel}", flush=True)
    sftp.close()


def main() -> int:
    cfg = load_deploy_env()
    remote = f"{cfg.get('VPS_DEPLOY_ROOT', '/opt/vibepin')}/backend"
    c = connect(cfg)
    report: dict = {"steps": []}

    print("== upload ==")
    upload_all(c, remote)

    print("\n== cleanup fixtures ==")
    code, out = exec_remote(c, remote, f"{PY} scripts/cleanup_e2e_fixture_seeds.py", timeout=120)
    report["fixtureCleanup"] = {"exitCode": code, "output": out[-2000:]}

    print("\n== trend-provider-health ==")
    code, out = exec_remote(c, remote, f"{PY} run_worker.py --job trend-provider-health", timeout=300)
    health = parse_json_from_output(out) or {}
    report["providerHealth"] = health
    report["providerHealthExitCode"] = code

    print("\n== trends job ==")
    t0 = time.time()
    code, out = exec_remote(
        c, remote,
        f"{PY} run_worker.py --job trends --created-by manual 2>&1 | tee logs/trends_provider_fix.log",
        timeout=7200,
    )
    report["trends"] = {
        "exitCode": code,
        "elapsedSec": int(time.time() - t0),
        "seedReport": parse_json_from_output(out),
        "tail": out[-3000:],
    }

    print("\n== seed-report json ==")
    code, out = exec_remote(c, remote, f"{PY} run_worker.py --job seed-report --report-hours 24", timeout=300)
    report["seedReport"] = parse_json_from_output(out) or {"raw": out[-2000:]}

    print("\n== seed-report markdown ==")
    code, md = exec_remote(
        c, remote,
        f"{PY} run_worker.py --job seed-report --report-format markdown --report-hours 24 2>&1 | tail -30",
        timeout=300,
    )
    report["seedReportMarkdownTail"] = md

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    print(f"\nSaved {OUT}")
    c.close()
    return 0 if not health.get("blocker") and report["trends"]["exitCode"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
