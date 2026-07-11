#!/usr/bin/env python3
"""cloud_readiness_check.py — READ-ONLY VPS/cloud readiness check for the
Product-Supply scheduler. Runs ONLY safe checks. Never runs crawler / apply /
dry-run / Playwright, never writes the DB, never prints secret values.

Exit 0 if all required checks pass, else 1.
"""
from __future__ import annotations
import os
import sys
import subprocess
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
LOG_DIR = BACKEND / "logs"
LOCK_DIR = Path(os.environ.get("VIBEPIN_LOCK_DIR", str(BACKEND / "locks")))
RUNNER = BACKEND / "scripts" / "run_bootstrap_product_supply.py"
PREFLIGHT = BACKEND / "scripts" / "preflight_product_supply.py"
WRAPPER = BACKEND / "scripts" / "cloud_run_product_supply.sh"

REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
OPTIONAL_ENV = ["SUPABASE_ANON_KEY", "DATABASE_URL", "VIBEPIN_LOCK_DIR"]

results: list[tuple[str, bool, str]] = []
def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))

def _writable(d: Path) -> bool:
    try:
        d.mkdir(parents=True, exist_ok=True)
        probe = d / ".readiness_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return True
    except Exception:
        return False

# ── env presence (names only; values never printed) ───────────────────────────
try:
    from dotenv import load_dotenv
    if (BACKEND / ".env").exists():
        load_dotenv(BACKEND / ".env")
except Exception:
    pass
for name in REQUIRED_ENV:
    present = bool((os.getenv(name) or "").strip())
    check(f"env {name}", present, "present" if present else "MISSING (required)")
for name in OPTIONAL_ENV:
    present = bool((os.getenv(name) or "").strip())
    check(f"env {name} (optional)", True, "present" if present else "absent")

# ── directories writable ──────────────────────────────────────────────────────
check("lock dir writable", _writable(LOCK_DIR), str(LOCK_DIR))
check("logs dir writable", _writable(LOG_DIR), str(LOG_DIR))
check("reports dir writable (= logs)", _writable(LOG_DIR), str(LOG_DIR))

# ── python imports ────────────────────────────────────────────────────────────
for mod in ("httpx", "psutil", "playwright"):
    try:
        __import__(mod)
        check(f"import {mod}", True)
    except Exception as exc:
        check(f"import {mod}", False, f"{type(exc).__name__}")

# ── hardened runner + wrapper present ─────────────────────────────────────────
check("hardened runner present", RUNNER.exists(), str(RUNNER))
check("cloud wrapper present", WRAPPER.exists(), str(WRAPPER))
# Confirm wrapper never calls run_worker.py directly. Comments may mention it
# descriptively; only non-comment (executable) lines count as a real invocation.
try:
    wtext = WRAPPER.read_text(encoding="utf-8")
    noncomment = "\n".join(ln for ln in wtext.splitlines() if not ln.lstrip().startswith("#"))
    ok = "run_worker.py" not in noncomment
    check("wrapper avoids run_worker.py", ok,
          "no direct run_worker.py call" if ok else "FOUND direct call")
except Exception:
    check("wrapper avoids run_worker.py", False, "unreadable")

# ── preflight runs read-only; report active workers / locks ───────────────────
rec = "FAIL"; active = None; pw = None
try:
    proc = subprocess.run([sys.executable, str(PREFLIGHT)],
                          cwd=str(BACKEND), capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=60)
    import json
    rep = json.loads(proc.stdout)
    rec = rep.get("recommendation", "FAIL")
    active = len(rep.get("activePinterestProcs") or [])
    pw = int(rep.get("playwrightProcCount") or 0)
    locks = rep.get("locks", {})
    live_locks = sum(1 for v in locks.values() if isinstance(v, dict) and v.get("live"))
    check("preflight runs (read-only)", rec in ("SAFE_FOR_DRY_RUN", "SAFE_FOR_APPLY", "WAIT"),
          f"recommendation={rec}")
    check("no active crawler/Product-Supply worker", active == 0, f"activeProcs={active}")
    check("no Playwright process", pw == 0, f"playwrightProcs={pw}")
    check("no live locks", live_locks == 0, f"liveLocks={live_locks}")
except Exception as exc:
    check("preflight runs (read-only)", False, f"{type(exc).__name__}: {str(exc)[:80]}")

# ── report ────────────────────────────────────────────────────────────────────
print("VibePin cloud readiness check (read-only)\n" + "=" * 44)
required_failed = 0
for name, ok, detail in results:
    flag = "OK  " if ok else "FAIL"
    if not ok and "(optional)" not in name:
        required_failed += 1
    print(f"  [{flag}] {name}" + (f"  — {detail}" if detail else ""))
print("=" * 44)
if required_failed:
    print(f"NOT READY — {required_failed} required check(s) failed.")
    sys.exit(1)
print("READY — all required checks passed (scheduler still DISABLED; nothing was run).")
sys.exit(0)
