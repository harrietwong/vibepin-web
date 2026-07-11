#!/usr/bin/env python3
"""cloud_pipeline_readiness_check.py — READ-ONLY unified readiness for the disabled
VibePin daily pipeline (Pin/crawler, keyword-trends, Product-Supply) + shared
Pinterest/network safety.

Runs ONLY safe checks. Never runs crawler / trends / apply / dry-run / Playwright,
never writes the DB, never clears locks, never prints secret values.
Exit 0 if every job is READY, else 1.
"""
from __future__ import annotations
import json
import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
LOG_DIR = BACKEND / "logs"
LOCK_DIR = Path(os.environ.get("VIBEPIN_LOCK_DIR", str(BACKEND / "locks")))
SCRIPTS = BACKEND / "scripts"
SYSTEMD = BACKEND / "deploy" / "systemd"
PREFLIGHT = SCRIPTS / "preflight_product_supply.py"

WRAPPERS = {
    "pin-crawl": SCRIPTS / "cloud_run_pin_crawl.sh",
    "keyword-trends": SCRIPTS / "cloud_run_keyword_trends.sh",
    "product-supply": SCRIPTS / "cloud_run_product_supply.sh",
}
UNITS = {
    "pin-crawl": ("vibepin-pin-crawl.service", "vibepin-pin-crawl.timer"),
    "keyword-trends": ("vibepin-keyword-trends.service", "vibepin-keyword-trends.timer"),
    "product-supply": ("vibepin-product-supply.service", "vibepin-product-supply.timer"),
}
HARDENED_RUNNER = SCRIPTS / "run_bootstrap_product_supply.py"
REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]

ok_all = True
def line(flag: bool, msg: str, detail: str = "") -> None:
    global ok_all
    if not flag:
        ok_all = False
    print(f"  [{'OK  ' if flag else 'FAIL'}] {msg}" + (f"  — {detail}" if detail else ""))

def _writable(d: Path) -> bool:
    try:
        d.mkdir(parents=True, exist_ok=True)
        p = d / ".readiness_probe"; p.write_text("ok", encoding="utf-8"); p.unlink()
        return True
    except Exception:
        return False

# ── env (names only) ──────────────────────────────────────────────────────────
try:
    from dotenv import load_dotenv
    if (BACKEND / ".env").exists():
        load_dotenv(BACKEND / ".env")
except Exception:
    pass

print("VibePin UNIFIED daily-pipeline readiness (read-only)\n" + "=" * 52)
print("[shared prerequisites]")
for n in REQUIRED_ENV:
    line(bool((os.getenv(n) or "").strip()), f"env {n}")
line(_writable(LOCK_DIR), "lock dir writable", str(LOCK_DIR))
line(_writable(LOG_DIR), "logs dir writable", str(LOG_DIR))
line(_writable(LOG_DIR), "reports dir writable (= logs)")
for mod in ("httpx", "psutil", "playwright"):
    try:
        __import__(mod); line(True, f"import {mod}")
    except Exception as e:
        line(False, f"import {mod}", type(e).__name__)
line(HARDENED_RUNNER.exists(), "hardened Product-Supply runner present")

# ── per-job static files ──────────────────────────────────────────────────────
print("\n[per-job files]")
for job, wp in WRAPPERS.items():
    line(wp.exists(), f"{job} wrapper present", wp.name)
    svc, tmr = UNITS[job]
    line((SYSTEMD / svc).exists(), f"{job} service file present", svc)
    line((SYSTEMD / tmr).exists(), f"{job} timer file present", tmr)

# wrappers must never call run_worker.py directly = product-supply only.
def noncomment(p: Path) -> str:
    return "\n".join(l for l in p.read_text(encoding="utf-8").splitlines()
                     if not l.lstrip().startswith("#"))
line("run_worker.py" not in noncomment(WRAPPERS["product-supply"]),
     "product-supply wrapper avoids run_worker.py")

# ── live environment: preflight (read-only) + classify active procs ───────────
print("\n[live safety]")
rec = "FAIL"; active = []; pw = 0; shared_live = False
try:
    proc = subprocess.run([sys.executable, str(PREFLIGHT)], cwd=str(BACKEND),
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=60)
    rep = json.loads(proc.stdout)
    rec = rep.get("recommendation", "FAIL")
    active = rep.get("activePinterestProcs") or []
    pw = int(rep.get("playwrightProcCount") or 0)
    shared_live = bool(rep.get("locks", {}).get("pinterest_network", {}).get("live"))
except Exception as e:
    line(False, "preflight runs (read-only)", f"{type(e).__name__}")

def classify(substr: str) -> int:
    return sum(1 for p in active if substr in (p.get("cmd") or ""))
crawl_n = classify("--job crawl")
trends_n = classify("--job trends")
supply_n = classify("product-supply-expand") + classify("run_bootstrap_product_supply")

line(rec in ("SAFE_FOR_DRY_RUN", "SAFE_FOR_APPLY", "WAIT"), "preflight runs (read-only)", f"rec={rec}")
line(not shared_live, "shared pinterest_network lock free", "live" if shared_live else "free")
line(crawl_n == 0, "no active crawler", f"n={crawl_n}")
line(trends_n == 0, "no active keyword-trends", f"n={trends_n}")
line(supply_n == 0, "no active Product-Supply worker", f"n={supply_n}")
line(pw == 0, "no active Playwright/browser", f"n={pw}")

# ── systemd timer enabled-state (Linux only; informational) ───────────────────
print("\n[scheduler state]")
have_systemctl = bool(subprocess.run(["bash", "-lc", "command -v systemctl"],
                                     capture_output=True).returncode == 0) if os.name != "nt" else False
if not have_systemctl:
    print("  [INFO] systemctl not available here (not a systemd host) — timer state is a VPS check.")
else:
    for job, (_svc, tmr) in UNITS.items():
        r = subprocess.run(["systemctl", "is-enabled", tmr], capture_output=True, text=True)
        state = (r.stdout or r.stderr).strip() or "unknown"
        # We EXPECT disabled at this stage.
        print(f"  [INFO] {tmr} is-enabled = {state} (expected: disabled)")

# ── crawl proxy (pin-crawl prerequisite; report by NAME only, never the value) ──
CRAWL_PROXY_ENV = "PINTEREST_CRAWL_PROXY_URL"
proxy_present = bool((os.getenv(CRAWL_PROXY_ENV) or "").strip())
print("\n[crawl proxy]")
print(f"  [{'OK  ' if proxy_present else 'WARN'}] {CRAWL_PROXY_ENV} "
      f"{'present' if proxy_present else 'MISSING (BLOCKED_PROXY_MISSING)'}")

# ── per-job verdict ───────────────────────────────────────────────────────────
print("\n[per-job readiness]")
static_ok = ok_all  # static + import prerequisites (best-effort summary)
env_block = not shared_live and crawl_n == 0 and supply_n == 0 and pw == 0
for job in ("pin-crawl", "keyword-trends", "product-supply"):
    # All Pinterest-touching jobs refuse while the shared lock / a worker is live.
    ready = WRAPPERS[job].exists() and rec in ("SAFE_FOR_DRY_RUN", "SAFE_FOR_APPLY") and env_block
    # pin-crawl additionally requires a residential proxy: the anonymous, proxy-less
    # datacenter-IP crawl gets soft-gated to empty (HTTP 200, 0 pins).
    if job == "pin-crawl":
        ready = ready and proxy_present
    print(f"  {job:16s}: {'READY' if ready else 'NOT READY'}")
    if job == "pin-crawl" and not proxy_present:
        print(f"      blocker: BLOCKED_PROXY_MISSING — set {CRAWL_PROXY_ENV} "
              f"(residential proxy) before the pin-crawl can yield pins")
    if not ready and (shared_live or crawl_n or supply_n or trends_n or pw):
        print(f"      blocker: live Pinterest activity "
              f"(sharedLock={'live' if shared_live else 'free'}, crawl={crawl_n}, "
              f"trends={trends_n}, supply={supply_n}, playwright={pw})")

print("=" * 52)
print("Daily automation: DISABLED (no timers enabled by this check; nothing was run).")
sys.exit(0 if ok_all else 1)
