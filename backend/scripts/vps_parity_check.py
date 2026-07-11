#!/usr/bin/env python3
"""VPS parity check — pre/post deploy (no secrets printed)."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_deploy_env() -> dict[str, str]:
    cfg: dict[str, str] = {}
    for line in (ROOT / "deploy.env").read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        cfg[k.strip()] = v.strip().strip('"').strip("'")
    return cfg


def ssh_run(client, cmd: str, timeout: int = 7200) -> tuple[int, str, str]:
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    return code, out, err


def connect():
    import paramiko

    cfg = load_deploy_env()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        cfg["VPS_HOST"],
        port=int(cfg.get("VPS_PORT", "22")),
        username=cfg.get("VPS_USER", "root"),
        password=cfg["VPS_PASSWORD"],
        timeout=30,
    )
    backend = f"{cfg.get('VPS_DEPLOY_ROOT', '/opt/vibepin')}/backend"
    venv_py = f"{backend}/.venv/bin/python"
    return client, backend, venv_py


def cmd_inspect() -> int:
    client, backend, venv_py = connect()
    checks = [
        ("run_worker_help", f"cd {backend} && {venv_py} run_worker.py --help 2>&1 | head -20"),
        ("job_classify", f"grep -n 'job_classify\\|classify + opportunities\\|step_classify' {backend}/run_worker.py {backend}/pipeline.py 2>/dev/null | head -15"),
        ("import_paths", f"grep -n 'from db' {backend}/classify_product_signals.py {backend}/classify_reference_pins.py {backend}/generate_opportunities.py 2>/dev/null | head -10"),
        ("failure_reraise", f"grep -n 'traceback.print_exc\\|raise' {backend}/pipeline.py 2>/dev/null | grep -A0 -B0 'step_classify\\|step_opportunities' | head -8 || grep -n 'traceback.print_exc' {backend}/pipeline.py | head -5"),
        ("ref_filter", f"grep -n 'reference_quality_score\\|RECENT_CLASSIFY' {backend}/classify_reference_pins.py 2>/dev/null | head -8"),
        ("crontab", "crontab -l 2>/dev/null || echo '(no crontab)'"),
    ]
    for label, cmd in checks:
        code, out, err = ssh_run(client, cmd, timeout=120)
        print(f"=== {label} (exit {code}) ===")
        print((out or err).strip() or "(empty)")
        print()
    client.close()
    return 0


def cmd_run(job: str, created_by: str = "manual") -> int:
    client, backend, venv_py = connect()
    extra = f" --created-by {created_by}" if job != "smoke" else ""
    cmd = f"cd {backend} && {venv_py} run_worker.py --job {job}{extra} 2>&1"
    print(f"Running: run_worker.py --job {job}{extra}")
    code, out, err = ssh_run(client, cmd, timeout=7200)
    # Print tail only — avoid huge logs
    combined = (out + err).strip()
    lines = combined.splitlines()
    print("--- output (last 40 lines) ---")
    for line in lines[-40:]:
        safe = line.encode("utf-8", errors="replace").decode("utf-8", errors="replace")
        print(safe)
    print(f"--- exit {code} ---")
    client.close()
    return code


def cmd_db_metrics() -> int:
    sys.path.insert(0, str(ROOT / "db"))
    from db import _get_http, select_many

    http = _get_http()

    def cnt(table: str, filt: dict | None = None) -> str:
        p: dict = {"limit": "0", "select": "id"}
        for k, v in (filt or {}).items():
            p[k] = v if "." in str(v) else f"eq.{v}"
        r = http.head(table, params=p, headers={"Prefer": "count=exact"})
        cr = r.headers.get("Content-Range", "")
        return cr.split("/")[-1] if "/" in cr else "?"

    opp = select_many("opportunities", order="updated_at.desc", limit=1)
    runs = select_many("pipeline_runs", order="started_at.desc", limit=5)
    print("=== DB metrics (shared Supabase) ===")
    print(f"pin_samples eligible_true: {cnt('pin_samples', {'is_reference_eligible': 'true'})}")
    print(f"pin_samples ref_score_null: {cnt('pin_samples', {'reference_quality_score': 'is.null'})}")
    print(f"opportunities total: {cnt('opportunities', {})}")
    print(f"opportunities latest updated_at: {opp[0].get('updated_at') if opp else '—'}")
    print("latest pipeline_runs:")
    for r in runs:
        print(f"  {r.get('job_type')} {r.get('status')} {r.get('started_at')} dur={r.get('duration_seconds')}")
    return 0


def cmd_import_test() -> int:
    client, backend, venv_py = connect()
    cmd = f"cd {backend} && {venv_py} -c 'from classify_product_signals import run; print(\"imports_ok\")'"
    code, out, err = ssh_run(client, cmd, timeout=60)
    print(f"import_test exit {code}: {(out or err).strip()}")
    client.close()
    return code


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["inspect", "smoke", "classify", "metrics", "import_test"])
    args = ap.parse_args()
    if args.action == "inspect":
        return cmd_inspect()
    if args.action == "smoke":
        return cmd_run("smoke")
    if args.action == "classify":
        return cmd_run("classify", "manual")
    if args.action == "import_test":
        return cmd_import_test()
    return cmd_db_metrics()


if __name__ == "__main__":
    raise SystemExit(main())
