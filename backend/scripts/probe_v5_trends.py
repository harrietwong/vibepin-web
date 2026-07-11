#!/usr/bin/env python3
"""One-shot v5 trends probe on VPS (no token logging)."""
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
except ImportError:
    pass

from pinterest_trends_v5_provider import fetch_v5_top_keywords, resolve_v5_access_token


async def main() -> int:
    _, source = resolve_v5_access_token()
    res = await fetch_v5_top_keywords(region="US", trend_type="growing", limit=3)
    print(json.dumps({
        "tokenSource": source,
        "ok": res.ok,
        "httpStatus": res.http_status,
        "error": res.error,
        "keywordCount": len(res.keywords),
        "sampleKeywords": [k.get("keyword") for k in res.keywords[:3]],
        "bodySample": res.body_sample,
    }, indent=2, ensure_ascii=False))
    return 0 if res.ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
