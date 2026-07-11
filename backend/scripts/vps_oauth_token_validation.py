#!/usr/bin/env python3
"""
VPS OAuth token + official_v5 validation (read-only / dry-run only).

Steps:
  1. Sync PINTEREST_TOKEN_ENC_KEY from web/.env.local (never logged)
  2. Upload provider modules
  3. Verify token decrypt
  4. trend-provider-health
  5. trends --dry-run (official_v5 only, no DB writes)
  6. seed-report --report-hours 24
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from deploy_vps_paramiko import load_deploy_env
from vps_seed_production_validation import UPLOAD_FILES, connect, exec_remote, parse_json_from_output

PY = ".venv/bin/python"
OUT = ROOT / "logs" / "vps_oauth_token_validation.json"

EXTRA_UPLOAD = [
    "scripts/verify_pinterest_token_decrypt.py",
    "scripts/sync_vps_pinterest_enc_key.py",
]


def upload_all(c, remote: str) -> None:
    import paramiko
    files = list(dict.fromkeys(UPLOAD_FILES + EXTRA_UPLOAD))
    sftp = c.open_sftp()
    for rel in files:
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
    report: dict = {"steps": []}

    print("== Step 2a: sync PINTEREST_TOKEN_ENC_KEY to VPS ==")
    r = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "sync_vps_pinterest_enc_key.py")],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    sync_out = (r.stdout or "") + (r.stderr or "")
    # Strip any accidental key lines
    safe_sync = "\n".join(
        ln for ln in sync_out.splitlines()
        if "PINTEREST_TOKEN_ENC_KEY=" not in ln or "=***" in ln
    )
    print(safe_sync)
    report["encKeySync"] = {"exitCode": r.returncode, "output": safe_sync[-1500:]}
    if r.returncode != 0:
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
        return 1

    cfg = load_deploy_env()
    remote = f"{cfg.get('VPS_DEPLOY_ROOT', '/opt/vibepin')}/backend"
    c = connect(cfg)

    print("\n== Step 2b: upload provider modules ==")
    upload_all(c, remote)

    print("\n== Step 2c: verify token decrypt ==")
    code, out = exec_remote(c, remote, f"{PY} scripts/verify_pinterest_token_decrypt.py", timeout=120)
    token_verify = parse_json_from_output(out) or {"raw": out[-2000:]}
    report["tokenVerify"] = token_verify
    report["tokenVerifyExitCode"] = code
    print(json.dumps(token_verify, indent=2, ensure_ascii=False, default=str))

    print("\n== Step 3: trend-provider-health ==")
    code, out = exec_remote(c, remote, f"{PY} run_worker.py --job trend-provider-health", timeout=300)
    health = parse_json_from_output(out) or {}
    report["providerHealth"] = health
    report["providerHealthExitCode"] = code
    print(json.dumps(health, indent=2, ensure_ascii=False, default=str)[:4000])

    if health.get("blocker") or code != 0:
        report["stopped"] = "provider health failed"
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        c.close()
        return 1

    print("\n== Step 4: trends dry-run (official_v5 only, P0 interests) ==")
    t0 = time.time()
    dry_cmd = (
        f"ENABLE_PINTEREST_TRENDS_EXPERIMENTAL_FALLBACK=false "
        f"ENABLE_PINTEREST_TRENDS_L1=false "
        f"ENABLE_PINTEREST_RESOURCE_L2=false "
        f"{PY} run_worker.py --job trends --dry-run --limit-interests 5 --created-by manual "
        f"2>&1 | tee logs/trends_v5_dryrun.log"
    )
    code, out = exec_remote(c, remote, dry_cmd, timeout=7200)
    dry_report = parse_json_from_output(out) or {}
    report["trendsDryRun"] = {
        "exitCode": code,
        "elapsedSec": int(time.time() - t0),
        "seedReport": dry_report,
        "tail": out[-3000:],
    }
    print(json.dumps(dry_report, indent=2, ensure_ascii=False, default=str)[:5000] if dry_report else out[-2000:])

    print("\n== Step 6: seed-report (24h) ==")
    code, out = exec_remote(c, remote, f"{PY} run_worker.py --job seed-report --report-hours 24", timeout=300)
    seed_report = parse_json_from_output(out) or {"raw": out[-2000:]}
    report["seedReport"] = seed_report

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    print(f"\nSaved {OUT}")
    c.close()

    ok = (
        not health.get("blocker")
        and token_verify.get("tokenDecryptOk")
        and report["trendsDryRun"]["exitCode"] == 0
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
