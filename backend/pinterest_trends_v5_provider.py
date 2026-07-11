"""
pinterest_trends_v5_provider.py — Official Pinterest Marketing API v5 Trends client.

Endpoint (partner / OAuth Bearer):
  GET https://api.pinterest.com/v5/trends/keywords/{region}/top/{trend_type}

Requires Trends & Insights API access on the OAuth app + valid access token.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode

try:
    from curl_cffi.requests import AsyncSession as CurlSession
except ImportError:  # pragma: no cover
    CurlSession = None  # type: ignore

API_BASE = os.getenv("PINTEREST_API_BASE", "https://api.pinterest.com/v5").rstrip("/")
TREND_TYPES = ("growing", "monthly", "yearly", "seasonal", "top")
VOLUME_LABEL_SCORE = {"very_high": 4, "high": 3, "medium": 2, "low": 1}

ENABLE_OFFICIAL_V5 = os.getenv("ENABLE_PINTEREST_TRENDS_V5", "true").lower() != "false"

TOKEN_ENV_KEYS = (
    "PINTEREST_TRENDS_ACCESS_TOKEN",
    "PINTEREST_API_ACCESS_TOKEN",
    "PINTEREST_ACCESS_TOKEN",
    "pinterest_access_token",
)


@dataclass
class V5FetchResult:
    ok: bool
    keywords: list[dict] = field(default_factory=list)
    http_status: int | None = None
    error: str | None = None
    body_sample: str | None = None
    url: str | None = None
    provider_status: str = "unknown"


def resolve_v5_access_token() -> tuple[str | None, str]:
    """Return (token, source_env_key). Optional DB lookup when configured."""
    for key in TOKEN_ENV_KEYS:
        val = os.getenv(key, "").strip()
        if val and val.lower() not in ("placeholder", "changeme", "your-token"):
            return val, key

    user_id = os.getenv("PINTEREST_TRENDS_VIBEPIN_USER_ID", "").strip()
    enc_key = os.getenv("PINTEREST_TOKEN_ENC_KEY", "").strip()
    if enc_key and user_id:
        try:
            token = _load_token_from_db(user_id, enc_key)
            if token:
                return token, "pinterest_connections(db)"
        except Exception as exc:
            return None, f"db_error:{exc}"

    if enc_key:
        try:
            import sys
            from pathlib import Path
            root = Path(__file__).resolve().parent
            sys.path.insert(0, str(root / "db"))
            from db import select_many  # type: ignore
            for row in select_many("pinterest_connections", limit=10):
                if row.get("disconnected_at") or not row.get("access_token_encrypted"):
                    continue
                token = _decrypt_secret(row["access_token_encrypted"], enc_key)
                uid = row.get("vibepin_user_id")
                return token, f"pinterest_connections(first_active:{uid})"
        except Exception as exc:
            return None, f"db_error:{exc}"

    return None, "none"


def _load_token_from_db(vibepin_user_id: str, encryption_key: str) -> str | None:
    """Decrypt access token from pinterest_connections (same format as web crypto)."""
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parent
    sys.path.insert(0, str(root / "db"))
    from db import select_one  # type: ignore

    row = select_one("pinterest_connections", {"vibepin_user_id": vibepin_user_id})
    if not row or row.get("disconnected_at"):
        return None
    enc = row.get("access_token_encrypted")
    if not enc:
        return None
    return _decrypt_secret(enc, encryption_key)


def _decrypt_secret(ciphertext: str, key_raw: str) -> str:
    """AES-256-GCM decrypt (v1: iv|ct|tag — matches web/src/lib/server/crypto.ts)."""
    import base64
    import re
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if not ciphertext.startswith("v1:"):
        raise ValueError("unsupported ciphertext format")
    raw = base64.b64decode(ciphertext[3:])
    if len(raw) < 29:
        raise ValueError("ciphertext too short")
    iv, ct, tag = raw[:12], raw[12:-16], raw[-16:]
    if re.fullmatch(r"[0-9a-fA-F]{64}", key_raw):
        key = bytes.fromhex(key_raw)
    else:
        key = base64.b64decode(key_raw)
    if len(key) != 32:
        raise ValueError("PINTEREST_TOKEN_ENC_KEY must decode to 32 bytes")
    aes = AESGCM(key)
    return aes.decrypt(iv, ct + tag, None).decode("utf-8")


def v5_auth_present() -> bool:
    token, _ = resolve_v5_access_token()
    return bool(token)


def _body_sample(text: str, limit: int = 400) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit] + "…"


def _normalize_time_series(ts: Any) -> list[float]:
    """Accept list of numbers, date→value dict, or Pinterest object shapes."""
    if not ts:
        return []
    if isinstance(ts, dict):
        # Pinterest v5: {"2025-06-27": 0, "2025-06-12": 71, ...}
        if ts and all(isinstance(k, str) for k in ts.keys()):
            try:
                ordered = sorted(ts.keys())
                return [float(ts[k]) for k in ordered]
            except (TypeError, ValueError):
                pass
        ts = ts.get("values") or ts.get("data") or ts.get("points") or []
    if not isinstance(ts, list):
        return []
    out: list[float] = []
    for v in ts:
        if isinstance(v, (int, float)):
            out.append(float(v))
        elif isinstance(v, dict):
            raw = v.get("value") or v.get("v") or v.get("normalized_value")
            if raw is not None:
                try:
                    out.append(float(raw))
                except (TypeError, ValueError):
                    continue
    return out


def _parse_v5_items(data: Any) -> list[dict]:
    """Normalize v5 trends list response into trend_fetcher keyword dicts."""
    if not isinstance(data, dict):
        return []

    items = (
        data.get("items")
        or data.get("trends")
        or data.get("keywords")
        or data.get("data")
        or []
    )
    if isinstance(items, dict):
        items = items.get("items") or items.get("keywords") or []

    results: list[dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        kw = (
            item.get("keyword")
            or item.get("term")
            or item.get("name")
            or item.get("query")
            or ""
        ).strip()
        if not kw:
            continue

        td = item.get("trends_data") or item.get("trend_data") or item
        yoy = float(td.get("pct_growth_yoy") or td.get("percent_growth_yoy") or item.get("pct_growth_yoy") or 0)
        wow = float(td.get("pct_growth_wow") or td.get("percent_growth_wow") or item.get("pct_growth_wow") or 0)
        mom = float(td.get("pct_growth_mom") or td.get("percent_growth_mom") or item.get("pct_growth_mom") or 0)

        vol_label = (item.get("search_volume_level") or td.get("search_volume_level") or "").lower()
        ts = _normalize_time_series(
            item.get("time_series") or td.get("time_series") or item.get("trend_time_series")
        )
        vol_score = VOLUME_LABEL_SCORE.get(vol_label, 0)
        if vol_score == 0 and ts:
            recent = ts[-4:] if len(ts) >= 4 else ts
            avg = sum(float(v) for v in recent) / max(1, len(recent))
            vol_score = 4 if avg >= 75 else 3 if avg >= 50 else 2 if avg >= 25 else 1
            vol_label = {4: "very_high", 3: "high", 2: "medium", 1: "low"}.get(vol_score, "low")

        if vol_score == 0:
            vol_score = 2
            vol_label = vol_label or "medium"

        results.append({
            "keyword": kw,
            "pct_growth_yoy": yoy,
            "pct_growth_wow": wow,
            "pct_growth_mom": mom,
            "search_volume": item.get("search_volume") or td.get("search_volume"),
            "search_volume_level": vol_label or "unknown",
            "volume_score": vol_score,
            "trend_source": "pinterest_trends_v5",
            "time_series": ts,
            "interest": item.get("interest") or item.get("category"),
        })
    return results


def build_v5_url(region: str, trend_type: str, *, limit: int = 50, interest: str | None = None) -> str:
    path = f"{API_BASE}/trends/keywords/{region.upper()}/top/{trend_type}"
    params: dict[str, Any] = {"limit": limit}
    if interest:
        params["interest"] = interest
    return f"{path}?{urlencode(params)}"


async def fetch_v5_top_keywords(
    *,
    region: str = "US",
    trend_type: str = "growing",
    limit: int = 50,
    interest: str | None = None,
    access_token: str | None = None,
) -> V5FetchResult:
    """Fetch one v5 top-trends page."""
    if not ENABLE_OFFICIAL_V5:
        return V5FetchResult(ok=False, provider_status="disabled", error="ENABLE_PINTEREST_TRENDS_V5=false")

    token = access_token
    if not token:
        token, _ = resolve_v5_access_token()
    if not token:
        return V5FetchResult(
            ok=False,
            provider_status="unavailable_auth_or_access",
            error="no OAuth Bearer token (set PINTEREST_TRENDS_ACCESS_TOKEN or connect Pinterest OAuth)",
        )

    url = build_v5_url(region, trend_type, limit=limit, interest=interest)
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": "VibePin-TrendsWorker/1.0",
    }

    if CurlSession is None:
        return V5FetchResult(ok=False, provider_status="http_error", error="curl_cffi not installed", url=url)

    try:
        async with CurlSession(impersonate="chrome146") as session:
            r = await session.get(url, headers=headers, timeout=30)
            body = r.text or ""
            sample = _body_sample(body)

            if r.status_code == 200:
                try:
                    data = r.json()
                except Exception:
                    return V5FetchResult(
                        ok=False,
                        http_status=200,
                        error="invalid JSON",
                        body_sample=sample,
                        url=url,
                        provider_status="http_error",
                    )
                kws = _parse_v5_items(data)
                return V5FetchResult(
                    ok=len(kws) > 0,
                    keywords=kws,
                    http_status=200,
                    url=url,
                    provider_status="ok" if kws else "http_error",
                    body_sample=sample if not kws else None,
                    error=None if kws else "200 OK but 0 keywords parsed",
                )

            if r.status_code in (401, 403):
                return V5FetchResult(
                    ok=False,
                    http_status=r.status_code,
                    error=f"HTTP {r.status_code} — Trends API access denied or token invalid",
                    body_sample=sample,
                    url=url,
                    provider_status="unavailable_auth_or_access",
                )

            return V5FetchResult(
                ok=False,
                http_status=r.status_code,
                error=f"HTTP {r.status_code}",
                body_sample=sample,
                url=url,
                provider_status="http_error",
            )
    except Exception as exc:
        return V5FetchResult(
            ok=False,
            error=str(exc),
            url=url,
            provider_status="http_error",
        )


async def fetch_v5_for_interest(
    interest_slug: str,
    *,
    region: str = "US",
    limit_per_type: int = 25,
    trend_types: tuple[str, ...] = TREND_TYPES,
) -> V5FetchResult:
    """Try multiple trend_type values; merge deduped keywords."""
    merged: list[dict] = []
    seen: set[str] = set()
    last_err: V5FetchResult | None = None

    interest_param = interest_slug.replace("_", " ")

    for tt in trend_types:
        res = await fetch_v5_top_keywords(
            region=region,
            trend_type=tt,
            limit=limit_per_type,
            interest=interest_param,
        )
        if res.provider_status == "unavailable_auth_or_access":
            return res
        if not res.ok:
            last_err = res
            continue
        for kw in res.keywords:
            key = kw["keyword"].lower()
            if key not in seen:
                seen.add(key)
                entry = dict(kw)
                entry.setdefault("trend_type", tt)
                entry.setdefault("v5_interest_param", interest_param)
                entry.setdefault("region", region.upper())
                entry.setdefault("interest_slug", interest_slug)
                merged.append(entry)

    if merged:
        return V5FetchResult(ok=True, keywords=merged, provider_status="ok", http_status=200)

    if last_err:
        last_err.keywords = []
        return last_err

    return V5FetchResult(
        ok=False,
        provider_status="unavailable_auth_or_access" if not v5_auth_present() else "http_error",
        error="no keywords from any trend_type",
    )


def audit_config() -> dict[str, Any]:
    """Static audit of v5 config (no network)."""
    token, source = resolve_v5_access_token()
    return {
        "enabled": ENABLE_OFFICIAL_V5,
        "authPresent": bool(token),
        "tokenSource": source,
        "apiBase": API_BASE,
        "exampleUrl": build_v5_url("US", "growing", limit=1),
        "trendTypes": list(TREND_TYPES),
        "tokenEnvKeysChecked": list(TOKEN_ENV_KEYS),
        "appIdPresent": bool(os.getenv("PINTEREST_APP_ID", "").strip()),
        "appSecretPresent": bool(os.getenv("PINTEREST_APP_SECRET", "").strip()),
    }
