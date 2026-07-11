#!/usr/bin/env python3
"""Upload fixes + run P0 official_v5 dry-run on VPS."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from deploy_vps_paramiko import load_deploy_env
from vps_seed_production_validation import connect, exec_remote, parse_json_from_output, upload_seed_modules

PY = ".venv/bin/python"
OUT = ROOT / "logs" / "p0_v5_dry_run_report.json"


def main() -> int:
    cfg = load_deploy_env()
    remote = f"{cfg.get('VPS_DEPLOY_ROOT', '/opt/vibepin')}/backend"
    c = connect(cfg)

    extra = ["scripts/p0_v5_trends_dry_run.py", "db/migrate_v29_trend_type_provenance.sql"]
    upload_seed_modules(c, remote)
    sftp = c.open_sftp()
    for rel in extra:
        local = ROOT / rel
        if local.exists():
            sftp.put(str(local), f"{remote}/{rel.replace(chr(92), '/')}")
    sftp.close()

    t0 = time.time()
    cmd = (
        "ENABLE_PINTEREST_TRENDS_EXPERIMENTAL_FALLBACK=false "
        "ENABLE_PINTEREST_TRENDS_L1=false ENABLE_PINTEREST_RESOURCE_L2=false "
        f"{PY} scripts/p0_v5_trends_dry_run.py --top-n 8 "
        f"--out logs/p0_v5_dry_run_report.json 2>&1 | tee logs/p0_v5_dry_run.log"
    )
    code, out = exec_remote(c, remote, cmd, timeout=7200)
    report = parse_json_from_output(out) or {}
    if not report and (ROOT / "logs").exists():
        pass
    # Try read remote-written file via cat
    _, out_file = exec_remote(c, remote, "cat logs/p0_v5_dry_run_report.json 2>/dev/null || true", timeout=60)
    if out_file.strip().startswith("{"):
        try:
            report = json.loads(out_file)
        except json.JSONDecodeError:
            pass

    result = {
        "exitCode": code,
        "elapsedSec": int(time.time() - t0),
        "report": report,
        "consoleTail": out[-4000:],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    print(f"Saved {OUT}")
    c.close()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
