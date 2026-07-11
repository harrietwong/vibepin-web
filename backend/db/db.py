"""
db.py — 用 httpx 直接调用 Supabase PostgREST API（无需 supabase-py）

需要 .env：
    SUPABASE_URL=https://xxx.supabase.co
    SUPABASE_SERVICE_ROLE_KEY=eyJ...
"""

import os
import httpx
from dotenv import load_dotenv

load_dotenv()

_client: httpx.Client | None = None


def _make_client() -> httpx.Client:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        raise RuntimeError("请在 .env 里设置 SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY")
    return httpx.Client(
        base_url=f"{url}/rest/v1/",
        headers={
            "apikey":          key,
            "Authorization":   f"Bearer {key}",
            "Content-Type":    "application/json",
            "Accept":          "application/json",
        },
        timeout=httpx.Timeout(connect=10, read=60, write=30, pool=5),
        limits=httpx.Limits(max_keepalive_connections=5, keepalive_expiry=30),
    )


def _get_http() -> httpx.Client:
    global _client
    if _client is None:
        _client = _make_client()
    return _client


def _reset_client() -> httpx.Client:
    """Close stale client and return a fresh one."""
    global _client
    try:
        if _client is not None:
            _client.close()
    except Exception:
        pass
    _client = _make_client()
    return _client


_MAX_ATTEMPTS = 5


def _request(method: str, *args, **kwargs):
    """Execute an HTTP request, retrying transient connection/SSL errors.

    httpx.TransportError is the base class for ConnectError, ReadError,
    WriteError, ConnectTimeout, ReadTimeout, PoolTimeout, RemoteProtocolError,
    etc. — i.e. every connection-level drop Supabase throws on long runs.
    Each retry resets the client (the keep-alive socket is usually dead) and
    backs off exponentially.
    """
    import ssl, time
    _RETRYABLE = (httpx.TransportError, ssl.SSLError)
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            http = _get_http()
            return getattr(http, method)(*args, **kwargs)
        except _RETRYABLE as exc:
            if attempt == _MAX_ATTEMPTS:
                raise
            backoff = min(2 ** (attempt - 1), 8)
            print(
                f"[db] connection error ({exc.__class__.__name__}), "
                f"resetting client; retry {attempt}/{_MAX_ATTEMPTS - 1} in {backoff}s..."
            )
            time.sleep(backoff)
            _reset_client()


def upsert(table: str, rows: list[dict], on_conflict: str) -> list[dict]:
    """
    批量 upsert，返回写入后的行（含 id 等字段）。

    on_conflict: 唯一约束列，逗号分隔，如 "pin_id" 或 "keyword,category"

    WARNING: uses resolution=merge-duplicates — on conflict the existing row IS
    updated. Do NOT use this for pin_products STL bootstrap writes; use insert_rows().
    """
    if not rows:
        return []
    resp = _request(
        "post", table,
        json=rows,
        params={"on_conflict": on_conflict},
        headers={"Prefer": "resolution=merge-duplicates,return=representation"},
    )
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"upsert {table} 失败 [{resp.status_code}]: {resp.text[:300]}")
    return resp.json()


def insert_rows(
    table: str,
    rows: list[dict],
    on_conflict: str | None = None,
) -> list[dict]:
    """INSERT-only write — never updates existing rows.

    When on_conflict is provided (a unique constraint column name):
        Prefer: resolution=ignore-duplicates  →  ON CONFLICT DO NOTHING
        Conflicting rows are silently skipped; the existing row is unchanged.
        Returns only the actually-inserted rows.

    When on_conflict is None:
        No conflict target is declared. A unique-constraint violation causes
        PostgREST to return 409, which raises RuntimeError (fail closed).

    resolution=merge-duplicates is NEVER sent by this function.
    """
    if not rows:
        return []
    params: dict = {}
    if on_conflict:
        params["on_conflict"] = on_conflict
        prefer = "resolution=ignore-duplicates,return=representation"
    else:
        prefer = "return=representation"
    resp = _request(
        "post", table,
        json=rows,
        params=params,
        headers={"Prefer": prefer},
    )
    if resp.status_code not in (200, 201):
        raise RuntimeError(
            f"insert {table} failed [{resp.status_code}]: {resp.text[:300]}"
        )
    return resp.json()


def select_one(table: str, filters: dict) -> dict | None:
    """按等值条件查单行，返回 dict 或 None。"""
    params = {col: f"eq.{val}" for col, val in filters.items()}
    params["limit"] = "1"
    resp = _request("get", table, params=params)
    if resp.status_code != 200:
        raise RuntimeError(f"select {table} 失败 [{resp.status_code}]: {resp.text[:200]}")
    data = resp.json()
    return data[0] if data else None


def select_many(table: str, filters: dict | None = None,
                order: str | None = None, limit: int | None = None) -> list[dict]:
    """
    查多行。filters 支持 eq/gt/lt 等：
        {"status": "eq.active", "priority_score": "gte.0"}
    order 格式: "priority_score.desc,last_scraped_at.asc"
    """
    params: dict = {}
    for col, val in (filters or {}).items():
        params[col] = val if "." in str(val) else f"eq.{val}"
    if order:
        params["order"] = order
    if limit:
        params["limit"] = str(limit)
    resp = _request("get", table, params=params)
    if resp.status_code != 200:
        raise RuntimeError(f"select {table} 失败 [{resp.status_code}]: {resp.text[:200]}")
    return resp.json()


def update_where(table: str, updates: dict, filters: dict) -> list[dict]:
    """PATCH 满足 filters 的行，返回更新后的行。"""
    params = {col: f"eq.{val}" for col, val in filters.items()}
    resp = _request(
        "patch", table,
        json=updates,
        params=params,
        headers={"Prefer": "return=representation"},
    )
    if resp.status_code not in (200, 204):
        raise RuntimeError(f"update {table} 失败 [{resp.status_code}]: {resp.text[:200]}")
    return resp.json() if resp.status_code == 200 else []


class DB:
    """
    OO wrapper around the module-level PostgREST helpers.
    Lets scripts written against `DB()` share the same HTTP client.

    select_many / select_one accept an optional `columns` kwarg (comma-separated
    string) which maps to PostgREST's `select=` query parameter.

    upsert accepts a single dict *or* a list[dict]; `on_conflict` is optional
    (defaults to empty string = no conflict resolution) and `returning` is
    optional (defaults to None = no return body).
    """

    # ── read ──────────────────────────────────────────────────────────────────

    # PostgREST/Supabase truncate huge single responses and frequently drop the
    # connection mid-body on large reads. Page large reads to stay reliable.
    _PAGE = 1000

    def select_many(
        self,
        table: str,
        *,
        columns: str | None = None,
        filters: dict | None = None,
        order: str | None = None,
        limit: int | None = None,
    ) -> list[dict]:
        base: dict = {}
        if columns:
            base["select"] = columns
        for col, val in (filters or {}).items():
            base[col] = val if "." in str(val) else f"eq.{val}"
        if order:
            base["order"] = order

        # Small bounded read → single request (preserves prior behaviour).
        if limit is not None and limit <= self._PAGE:
            params = {**base, "limit": str(limit)}
            resp = _request("get", table, params=params)
            if resp.status_code != 200:
                raise RuntimeError(f"select {table} 失败 [{resp.status_code}]: {resp.text[:300]}")
            return resp.json() or []

        # Large or unbounded read → paginate in pages of _PAGE.
        out: list[dict] = []
        offset = 0
        remaining = limit  # None = unbounded
        while True:
            page = self._PAGE if remaining is None else min(self._PAGE, remaining)
            params = {**base, "limit": str(page), "offset": str(offset)}
            resp = _request("get", table, params=params)
            if resp.status_code != 200:
                raise RuntimeError(f"select {table} 失败 [{resp.status_code}]: {resp.text[:300]}")
            rows = resp.json() or []
            out.extend(rows)
            if remaining is not None:
                remaining -= len(rows)
                if remaining <= 0:
                    break
            if len(rows) < page:
                break
            offset += len(rows)
        return out

    def select_one(
        self,
        table: str,
        *,
        columns: str | None = None,
        filters: dict | None = None,
    ) -> dict | None:
        rows = self.select_many(table, columns=columns, filters=filters, limit=1)
        return rows[0] if rows else None

    # ── write ─────────────────────────────────────────────────────────────────

    def upsert(
        self,
        table: str,
        data: dict | list[dict],
        on_conflict: str = "",
        returning: str | None = None,
    ) -> list[dict]:
        rows = data if isinstance(data, list) else [data]
        if not rows:
            return []
        params: dict = {}
        if on_conflict:
            params["on_conflict"] = on_conflict
        prefer_parts = ["resolution=merge-duplicates"]
        if returning:
            prefer_parts.append("return=representation")
        resp = _request(
            "post", table,
            json=rows,
            params=params,
            headers={"Prefer": ",".join(prefer_parts)},
        )
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"upsert {table} 失败 [{resp.status_code}]: {resp.text[:300]}")
        return resp.json() if returning else []

    def update_where(
        self,
        table: str,
        *,
        data: dict,
        filters: dict,
    ) -> list[dict]:
        params = {col: f"eq.{val}" if "." not in str(val) else val
                  for col, val in filters.items()}
        resp = _request(
            "patch", table,
            json=data,
            params=params,
            headers={"Prefer": "return=representation"},
        )
        if resp.status_code not in (200, 204):
            raise RuntimeError(f"update {table} 失败 [{resp.status_code}]: {resp.text[:300]}")
        return resp.json() if resp.status_code == 200 else []


def test_connection() -> tuple[bool, str]:
    """
    测试连接。返回 (ok: bool, message: str)。
    - 200/206: 连接正常且表存在
    - 404:     连接正常但表尚未建立（需先运行 schema.sql）
    - 401/403: API Key 错误
    - Exception: 网络不通
    """
    try:
        http = _get_http()
        resp = http.get("trend_keywords", params={"limit": "1"})
        if resp.status_code in (200, 206):
            return True, "连接正常，表存在"
        if resp.status_code == 404:
            return True, "连接正常，但表尚未建立（请先运行 schema.sql）"
        if resp.status_code in (401, 403):
            return False, f"认证失败 [{resp.status_code}]，请检查 SUPABASE_SERVICE_ROLE_KEY"
        return False, f"意外状态码 {resp.status_code}: {resp.text[:100]}"
    except Exception as exc:
        return False, f"网络错误: {exc}"
