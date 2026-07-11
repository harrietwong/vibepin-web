#!/usr/bin/env bash
# One-command Docker image build (run from repo root or backend/)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
echo "Building vibepin-worker from $ROOT ..."
docker build -t vibepin-worker .
echo "OK: docker image vibepin-worker ready"
echo "Next: ./scripts/docker_smoke.sh"
