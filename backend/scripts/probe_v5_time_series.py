#!/usr/bin/env python3
"""Probe raw v5 time_series shape (read-only)."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
try:
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
    load_dotenv(ROOT.parent / "web" / ".env.local")
except ImportError:
    pass

from pinterest_trends_v5_provider import (
    _normalize_time_series,
    build_v5_url,
    fetch_v5_top_keywords,
    resolve_v5_access_token,
)


async def main() -> int:
    res = await fetch_v5_top_keywords(region="US", trend_type="growing", limit=2)
    print("parsed keywords:", len(res.keywords))
    if res.keywords:
        kw = res.keywords[0]
        print("keyword:", kw.get("keyword"))
        print("normalized ts len:", len(kw.get("time_series") or []))

    token, _ = resolve_v5_access_token()
    if not token:
        print("no token")
        return 1
    from curl_cffi.requests import AsyncSession
    url = build_v5_url("US", "growing", limit=2)
    async with AsyncSession(impersonate="chrome146") as s:
        r = await s.get(
            url,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            timeout=30,
        )
        data = r.json()
    item = (data.get("trends") or [None])[0]
    if not item:
        print("no item")
        return 1
    ts = item.get("time_series")
    print("raw ts type:", type(ts).__name__)
    print("raw ts sample:", json.dumps(ts, default=str)[:1200])
    norm = _normalize_time_series(ts)
    print("normalized len:", len(norm))
    if norm:
        print("first values:", norm[:5])
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
