#!/usr/bin/env python3
"""Shared VPS connection-credential loader for one-off ops scripts.

Usage (from a script in this same directory):

    from _vps_env import get_vps_credentials

    host, port, user, password = get_vps_credentials()

Credentials are read from environment variables — never hardcoded:
    VPS_HOST      required, e.g. 47.89.181.103
    VPS_PORT      optional, default 22
    VPS_USER      optional, default "root"
    VPS_PASSWORD  required

Values are picked up from the process environment. If backend/deploy.env
exists (see deploy.env.example), it is loaded first via python-dotenv so
scripts run standalone still pick up the same config used by
scripts/deploy_from_windows.ps1. Missing required variables raise
SystemExit with a clear message — there is no hardcoded fallback.
"""
from __future__ import annotations

import os
from pathlib import Path


def _load_deploy_env() -> None:
    """Best-effort load of backend/deploy.env into os.environ (does not override already-set vars)."""
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    deploy_env_path = Path(__file__).resolve().parent.parent / "deploy.env"
    if deploy_env_path.exists():
        load_dotenv(dotenv_path=deploy_env_path, override=False)


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(
            f"Missing required env var: {name}. Set it (e.g. in backend/deploy.env, "
            f"copied from deploy.env.example) before running this script."
        )
    return value


def get_vps_credentials() -> tuple[str, int, str, str]:
    """Return (host, port, user, password) for the VPS, sourced only from the environment."""
    _load_deploy_env()
    host = _require("VPS_HOST")
    port = int(os.environ.get("VPS_PORT", "22"))
    user = os.environ.get("VPS_USER", "root")
    password = _require("VPS_PASSWORD")
    return host, port, user, password
