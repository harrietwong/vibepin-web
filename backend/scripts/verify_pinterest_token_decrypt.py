#!/usr/bin/env python3
"""Read-only: verify worker can decrypt pinterest_connections token."""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "db"))

try:
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
except ImportError:
    pass

from pinterest_trends_v5_provider import resolve_v5_access_token, v5_auth_present


def main() -> int:
    token, source = resolve_v5_access_token()
    from db import select_many  # type: ignore

    connections = []
    for row in select_many("pinterest_connections", limit=10):
        if row.get("disconnected_at"):
            continue
        exp = row.get("access_token_expires_at")
        valid = None
        if exp:
            try:
                dt = datetime.fromisoformat(str(exp).replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                valid = dt > datetime.now(tz=timezone.utc)
            except Exception:
                valid = None
        connections.append({
            "pinterestUsername": row.get("pinterest_username"),
            "pinterestAccountType": row.get("pinterest_account_type"),
            "scopes": row.get("scopes") or [],
            "accessTokenExpiresAt": exp,
            "tokenNotExpired": valid,
            "hasEncryptedToken": bool(row.get("access_token_encrypted")),
        })

    report = {
        "encKeyConfigured": bool(os.getenv("PINTEREST_TOKEN_ENC_KEY", "").strip()),
        "tokenDecryptOk": bool(token),
        "tokenSource": source,
        "authPresent": v5_auth_present(),
        "connections": connections,
    }
    print(json.dumps(report, indent=2, ensure_ascii=False, default=str))
    return 0 if report["tokenDecryptOk"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
