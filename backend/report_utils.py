"""
report_utils.py — shared read helpers for dataset health / launch reports.

Read-only. Paginates past the Supabase 1000-row response cap and exposes an
exact-count helper. No schema or data changes.
"""

from __future__ import annotations

import sys
import unicodedata
from pathlib import Path

_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(_ROOT))
sys.path.insert(0, str(_ROOT / "db"))
from db import _get_http  # noqa: E402


def fetch_all(
    table: str,
    *,
    columns: str | None = None,
    filters: dict | None = None,
    page: int = 1000,
    max_rows: int = 100_000,
) -> list[dict]:
    """Fetch every row of a table/view, paginating with offset."""
    http = _get_http()
    out: list[dict] = []
    offset = 0
    while offset < max_rows:
        params: dict = {"limit": str(page), "offset": str(offset)}
        if columns:
            params["select"] = columns
        for col, val in (filters or {}).items():
            params[col] = val if "." in str(val) else f"eq.{val}"
        resp = http.get(table, params=params)
        if resp.status_code != 200:
            raise RuntimeError(f"fetch_all {table} failed [{resp.status_code}]: {resp.text[:200]}")
        rows = resp.json() or []
        out.extend(rows)
        if len(rows) < page:
            break
        offset += page
    return out


def count_exact(table: str, *, filters: dict | None = None) -> int:
    """Exact row count via PostgREST content-range header."""
    http = _get_http()
    params: dict = {"select": "id", "limit": "1"}
    for col, val in (filters or {}).items():
        params[col] = val if "." in str(val) else f"eq.{val}"
    resp = http.get(table, params=params, headers={"Prefer": "count=exact"})
    cr = resp.headers.get("content-range", "")
    if "/" in cr:
        tail = cr.split("/")[-1]
        if tail.isdigit():
            return int(tail)
    return len(resp.json() or [])


def normalize_keyword(kw: str | None) -> str:
    if not kw:
        return ""
    nfd = unicodedata.normalize("NFD", kw.lower().strip())
    base = "".join(c for c in nfd if unicodedata.category(c) != "Mn")
    return " ".join(base.split())


def norm_category(cat: str | None) -> str:
    return (cat or "unknown").strip().lower().replace("_", "-") or "unknown"
