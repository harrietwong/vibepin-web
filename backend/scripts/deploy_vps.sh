#!/usr/bin/env bash
# VibePin VPS bootstrap — run ON the Ubuntu server as deploy user.
# Usage (on VPS):
#   curl -fsSL <raw-url>/deploy_vps.sh | bash
#   OR after git clone:
#   cd /opt/vibepin/backend && bash scripts/deploy_vps.sh
set -euo pipefail

DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/vibepin}"
BACKEND_DIR="$DEPLOY_ROOT/backend"
VENV_DIR="$BACKEND_DIR/.venv"
LOG_DIR="$BACKEND_DIR/logs"

echo "== VibePin VPS deploy =="
echo "Deploy root: $DEPLOY_ROOT"

export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq git python3 python3-venv python3-pip ca-certificates
fi

mkdir -p "$DEPLOY_ROOT" "$LOG_DIR"

if [[ ! -f "$BACKEND_DIR/run_worker.py" ]]; then
  echo "ERROR: $BACKEND_DIR/run_worker.py not found."
  echo "Clone or copy the repo first, e.g.:"
  echo "  sudo mkdir -p $DEPLOY_ROOT && sudo chown \$USER:\$USER $DEPLOY_ROOT"
  echo "  git clone <your-repo-url> $DEPLOY_ROOT"
  exit 1
fi

cd "$BACKEND_DIR"

if [[ ! -d "$VENV_DIR" ]]; then
  python3 -m venv "$VENV_DIR"
fi
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
pip install --upgrade pip -q
pip install -r requirements-cloud.txt -q
# Shop the Look (stl-score job) needs Chromium
playwright install chromium 2>/dev/null || python -m playwright install chromium
playwright install-deps chromium 2>/dev/null || true

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo ""
  echo "Created .env from .env.example — EDIT REQUIRED:"
  echo "  nano $BACKEND_DIR/.env"
  echo "Set at minimum: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY"
  echo "Recommended: ENABLE_PINTEREST_TRENDS_L1=false"
  exit 2
fi

# Quick env check without printing secrets
python3 - <<'PY'
import os
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(dotenv_path=Path.cwd() / ".env")
missing = [k for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY") if not os.getenv(k)]
if missing:
    raise SystemExit(f"Missing env vars in .env: {', '.join(missing)}")
print("Env vars OK (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY present)")
PY

chmod +x scripts/*.sh 2>/dev/null || true

echo ""
echo "Running smoke test..."
"$VENV_DIR/bin/python" run_worker.py --job smoke
echo ""
echo "Smoke passed. Optional validation:"
echo "  $VENV_DIR/bin/python run_worker.py --job trends"
echo "  $VENV_DIR/bin/python run_worker.py --job crawl --limit-keywords 20"
echo "  $VENV_DIR/bin/python run_worker.py --job stl-score"
echo "  $VENV_DIR/bin/python scripts/check_pipeline_status.py"
echo ""
echo "Install daily cron:"
echo "  (crontab -l 2>/dev/null; echo '0 9 * * * cd $BACKEND_DIR && $VENV_DIR/bin/python run_worker.py --job daily >> $LOG_DIR/cron_daily.log 2>&1') | crontab -"
