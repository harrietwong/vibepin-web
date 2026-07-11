#!/usr/bin/env bash
# One-command Docker smoke test (requires .env with Supabase secrets)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${1:-$ROOT/.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE"
  echo "Create backend/.env from .env.example with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"
  exit 1
fi
echo "Running smoke in container (env: $ENV_FILE) ..."
docker run --rm --env-file "$ENV_FILE" vibepin-worker --job smoke
