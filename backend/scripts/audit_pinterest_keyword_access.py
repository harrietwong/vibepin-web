#!/usr/bin/env python3
"""
Read-only audit: Pinterest official keyword/trend/volume API access for VibePin.
No DB writes. Tokens never printed.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = ROOT.parent / "web"
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "db"))

try:
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
    load_dotenv(WEB_ROOT / ".env.local")
except ImportError:
    pass

from curl_cffi.requests import Session

API_BASE = "https://api.pinterest.com/v5"
SAMPLE_KEYWORDS = [
    "home decor ideas",
    "home decoration ideas",
    "summer outfit ideas",
    "skirt outfit",
    "digital planner",
]

CONFIGURED_SCOPES = [
    "user_accounts:read",
    "boards:read",
    "boards:write",
    "pins:read",
    "pins:write",
]

TOKEN_ENV_KEYS = (
    "PINTEREST_TRENDS_ACCESS_TOKEN",
    "PINTEREST_API_ACCESS_TOKEN",
    "PINTEREST_ACCESS_TOKEN",
    "pinterest_access_token",
)


def _mask(s: str | None) -> str:
    if not s:
        return "(absent)"
    if len(s) <= 8:
        return "***"
    return f"{s[:4]}…{s[-4:]}"


def _body_sample(text: str, limit: int = 600) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit] + "…"


def _parse_error(body: str) -> dict[str, Any]:
    try:
        data = json.loads(body)
    except Exception:
        return {"raw": _body_sample(body, 300)}
    out: dict[str, Any] = {}
    for k in ("code", "message", "status", "error", "error_description", "details"):
        if k in data and data[k] is not None:
            out[k] = data[k]
    if not out:
        out["keys"] = list(data.keys())[:20] if isinstance(data, dict) else []
    return out


def _decrypt_token(ciphertext: str, key_raw: str) -> str:
    import base64
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if not ciphertext.startswith("v1:"):
        raise ValueError("bad ciphertext prefix")
    raw = base64.b64decode(ciphertext[3:])
    iv, ct, tag = raw[:12], raw[12:-16], raw[-16:]
    if re.fullmatch(r"[0-9a-fA-F]{64}", key_raw):
        key = bytes.fromhex(key_raw)
    else:
        key = base64.b64decode(key_raw)
    aes = AESGCM(key)
    return aes.decrypt(iv, ct + tag, None).decode("utf-8")


def load_connections_metadata() -> list[dict[str, Any]]:
    """SELECT metadata only — no token values in output."""
    try:
        from db import select_many  # type: ignore
    except Exception as exc:
        return [{"error": f"db_import_failed: {exc}"}]

    try:
        rows = select_many("pinterest_connections", limit=20)
    except Exception as exc:
        err = str(exc).lower()
        if "does not exist" in err or "pinterest_connections" in err:
            return [{"error": "table_missing_or_inaccessible", "detail": str(exc)[:200]}]
        return [{"error": "select_failed", "detail": str(exc)[:200]}]

    out = []
    for r in rows:
        if r.get("disconnected_at"):
            continue
        out.append({
            "vibepinUserId": r.get("vibepin_user_id"),
            "pinterestUserId": r.get("pinterest_user_id"),
            "pinterestUsername": r.get("pinterest_username"),
            "pinterestAccountType": r.get("pinterest_account_type"),
            "scopesGranted": r.get("scopes") or [],
            "hasAccessTokenEncrypted": bool(r.get("access_token_encrypted")),
            "accessTokenExpiresAt": r.get("access_token_expires_at"),
            "needsReconnect": r.get("needs_reconnect"),
            "adsReadPresent": "ads:read" in (r.get("scopes") or []),
        })
    return out


def resolve_token_for_test(connections: list[dict]) -> tuple[str | None, str, list[str]]:
    """Return (token, source_label, scopes_if_known). Never log token."""
    scopes: list[str] = []
    last_db_err: str | None = None
    for key in TOKEN_ENV_KEYS:
        val = os.getenv(key, "").strip()
        if val and val.lower() not in ("placeholder", "changeme", ""):
            return val, f"env:{key}", scopes

    enc_key = os.getenv("PINTEREST_TOKEN_ENC_KEY", "").strip()
    user_id = os.getenv("PINTEREST_TRENDS_VIBEPIN_USER_ID", "").strip()
    if enc_key and user_id:
        try:
            from db import select_one  # type: ignore
            row = select_one("pinterest_connections", {"vibepin_user_id": user_id})
            if row and row.get("access_token_encrypted") and not row.get("disconnected_at"):
                token = _decrypt_token(row["access_token_encrypted"], enc_key)
                scopes = list(row.get("scopes") or [])
                return token, "db:pinterest_connections", scopes
        except Exception as exc:
            last_db_err = str(exc)[:120]

    if enc_key:
        try:
            from db import select_many  # type: ignore
            rows = select_many("pinterest_connections", limit=10)
            for row in rows:
                if row.get("disconnected_at") or not row.get("access_token_encrypted"):
                    continue
                token = _decrypt_token(row["access_token_encrypted"], enc_key)
                scopes = list(row.get("scopes") or [])
                uid = row.get("vibepin_user_id")
                return token, f"db:first_active_connection({uid})", scopes
        except Exception as exc:
            last_db_err = str(exc)[:120]

    if last_db_err:
        return None, f"none(db_decrypt_failed:{last_db_err})", scopes
    return None, "none", scopes


def api_get(token: str, path: str, params: dict | None = None) -> dict[str, Any]:
    url = f"{API_BASE}{path}"
    if params:
        url = f"{url}?{urlencode(params)}"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    try:
        with Session(impersonate="chrome146") as s:
            r = s.get(url, headers=headers, timeout=45)
        body = r.text or ""
        parsed = {}
        try:
            parsed = r.json() if body else {}
        except Exception:
            parsed = {"_non_json": True}
        return {
            "url": path.split("?")[0],
            "httpStatus": r.status_code,
            "error": _parse_error(body) if r.status_code >= 400 else None,
            "bodySample": _body_sample(body) if r.status_code >= 400 else None,
            "parsed": parsed if r.status_code == 200 else None,
        }
    except Exception as exc:
        return {"url": path, "httpStatus": None, "error": {"exception": str(exc)}}


def analyze_trends_response(parsed: dict | None) -> dict[str, Any]:
    if not isinstance(parsed, dict):
        return {"hasTrends": False}
    items = parsed.get("items") or parsed.get("trends") or parsed.get("keywords") or []
    if isinstance(items, dict):
        items = items.get("items") or []
    sample = items[0] if items else {}
    fields = set()
    if isinstance(sample, dict):
        fields.update(sample.keys())
        td = sample.get("trends_data") or sample.get("trend_data") or {}
        if isinstance(td, dict):
            fields.update(td.keys())
    growth_fields = [f for f in fields if "growth" in f.lower() or "pct" in f.lower()]
    return {
        "hasTrends": len(items) > 0,
        "itemCount": len(items) if isinstance(items, list) else 0,
        "sampleKeyword": sample.get("keyword") if isinstance(sample, dict) else None,
        "topLevelKeys": list(parsed.keys())[:15],
        "sampleFields": sorted(fields)[:25],
        "growthFieldsPresent": growth_fields,
        "hasTimeSeries": bool(
            isinstance(sample, dict)
            and (sample.get("time_series") or (sample.get("trends_data") or {}).get("time_series"))
        ),
        "hasPctGrowthWow": any("wow" in f.lower() for f in growth_fields),
        "hasPctGrowthMom": any("mom" in f.lower() for f in growth_fields),
        "hasPctGrowthYoy": any("yoy" in f.lower() for f in growth_fields),
    }


def analyze_keyword_metrics(parsed: dict | None) -> dict[str, Any]:
    if not isinstance(parsed, dict):
        return {"hasMetrics": False}
    items = parsed.get("items") or parsed.get("keywords") or parsed.get("data") or []
    if isinstance(items, dict):
        items = items.get("items") or []
    sample = items[0] if items else {}
    fields: set[str] = set()
    if isinstance(sample, dict):
        for k, v in sample.items():
            fields.add(k)
            if isinstance(v, dict):
                fields.update(v.keys())
    volume_like = [
        f for f in fields
        if any(x in f.lower() for x in ("volume", "search", "audience", "impression", "index", "demand", "query"))
    ]
    return {
        "hasMetrics": len(items) > 0 if isinstance(items, list) else bool(items),
        "itemCount": len(items) if isinstance(items, list) else 0,
        "topLevelKeys": list(parsed.keys())[:15],
        "sampleFields": sorted(fields)[:30],
        "volumeLikeFields": volume_like,
        "sample": {
            k: sample.get(k)
            for k in sorted(fields)[:12]
            if isinstance(sample, dict)
        } if isinstance(sample, dict) else None,
    }


def classify_error(http_status: int | None, err: dict | None) -> str:
    if http_status == 401:
        return "auth_invalid_or_expired"
    if http_status == 403:
        msg = json.dumps(err or {}).lower()
        if "scope" in msg or "permission" in msg or "access" in msg:
            return "scope_or_app_access_denied"
        return "forbidden"
    if http_status == 404:
        return "not_found"
    if http_status is None:
        return "network_or_client_error"
    if http_status >= 500:
        return "pinterest_server_error"
    return "other_http_error"


def main() -> int:
    report: dict[str, Any] = {
        "auditType": "read_only",
        "dbWrites": False,
    }

    # Task 1 — OAuth scopes
    report["oauth"] = {
        "scopesRequestedByApp": CONFIGURED_SCOPES,
        "adsReadRequested": False,
        "trendsScopeRequested": False,
        "note": "VibePin OAuth connect requests publish scopes only; no ads:read or trends-specific scope in code.",
        "envPresent": {
            "PINTEREST_APP_ID": bool(os.getenv("PINTEREST_APP_ID", "").strip()),
            "PINTEREST_APP_SECRET": bool(os.getenv("PINTEREST_APP_SECRET", "").strip()),
            "PINTEREST_TOKEN_ENC_KEY": bool(os.getenv("PINTEREST_TOKEN_ENC_KEY", "").strip()),
            "PINTEREST_TRENDS_ACCESS_TOKEN": bool(os.getenv("PINTEREST_TRENDS_ACCESS_TOKEN", "").strip()),
        },
    }

    connections = load_connections_metadata()
    report["oauth"]["storedConnections"] = connections
    report["oauth"]["activeConnectionCount"] = len([c for c in connections if "vibepinUserId" in c])
    granted_union: set[str] = set()
    for c in connections:
        granted_union.update(c.get("scopesGranted") or [])
    report["oauth"]["scopesGrantedUnion"] = sorted(granted_union)
    report["oauth"]["adsReadGranted"] = "ads:read" in granted_union
    report["oauth"]["anyConnectionHasToken"] = any(c.get("hasAccessTokenEncrypted") for c in connections)

    token, token_source, token_scopes = resolve_token_for_test(connections)
    report["oauth"]["tokenSourceForTests"] = token_source
    report["oauth"]["tokenAvailableForTests"] = bool(token)
    if token_scopes:
        report["oauth"]["tokenScopesUsed"] = token_scopes
        report["oauth"]["adsReadOnTokenUsed"] = "ads:read" in token_scopes

    if not token:
        report["task2_trendsApi"] = {
            "skipped": True,
            "reason": "no_bearer_token_available",
            "classification": "unavailable_auth",
        }
        report["task3_keywordMetricsApi"] = {
            "skipped": True,
            "reason": "no_bearer_token_available",
        }
        report["task3_adAccounts"] = {"skipped": True, "reason": "no_bearer_token_available"}
        print(json.dumps(report, indent=2, ensure_ascii=False, default=str))
        return 0

    # Task 2 — Trends API
    trends = api_get(token, "/trends/keywords/US/top/growing", {"limit": 5})
    trends_analysis = analyze_trends_response(trends.get("parsed"))
    report["task2_trendsApi"] = {
        "endpoint": "GET /v5/trends/keywords/US/top/growing",
        "httpStatus": trends.get("httpStatus"),
        "tokenAccepted": trends.get("httpStatus") == 200,
        "error": trends.get("error"),
        "bodySample": trends.get("bodySample"),
        "classification": classify_error(trends.get("httpStatus"), trends.get("error")),
        **trends_analysis,
    }

    # Task 3 — Ad accounts + keyword metrics
    ad_list = api_get(token, "/ad_accounts", {"page_size": 5})
    ad_items = []
    if isinstance(ad_list.get("parsed"), dict):
        ad_items = ad_list["parsed"].get("items") or []
    ad_account_ids = [str(i.get("id")) for i in ad_items if isinstance(i, dict) and i.get("id")]

    report["task3_adAccounts"] = {
        "endpoint": "GET /v5/ad_accounts",
        "httpStatus": ad_list.get("httpStatus"),
        "error": ad_list.get("error"),
        "bodySample": ad_list.get("bodySample"),
        "classification": classify_error(ad_list.get("httpStatus"), ad_list.get("error")),
        "adAccountIdsFound": ad_account_ids[:5],
        "adAccountCount": len(ad_items),
        "sampleAccountNames": [
            i.get("name") for i in ad_items[:3] if isinstance(i, dict)
        ],
    }

    metrics_results = []
    ad_id = ad_account_ids[0] if ad_account_ids else os.getenv("PINTEREST_AD_ACCOUNT_ID", "").strip()
    if ad_id and report["oauth"].get("adsReadGranted") or report["oauth"].get("adsReadOnTokenUsed"):
        pass  # will try regardless — API will tell us if scope missing

    if ad_id:
        params = {
            "country_code": "US",
            "keywords": ",".join(SAMPLE_KEYWORDS),
        }
        km = api_get(token, f"/ad_accounts/{ad_id}/keywords/metrics", params)
        km_analysis = analyze_keyword_metrics(km.get("parsed"))
        metrics_results.append({
            "adAccountId": ad_account_ids[0] if ad_account_ids else ad_id,
            "endpoint": f"GET /v5/ad_accounts/{{id}}/keywords/metrics",
            "httpStatus": km.get("httpStatus"),
            "error": km.get("error"),
            "bodySample": km.get("bodySample"),
            "classification": classify_error(km.get("httpStatus"), km.get("error")),
            **km_analysis,
        })
    else:
        metrics_results.append({
            "skipped": True,
            "reason": "no_ad_account_id_discovered_and_PINTEREST_AD_ACCOUNT_ID_not_set",
            "note": "ads:read scope likely required; ad account list returned no IDs",
        })

    report["task3_keywordMetricsApi"] = metrics_results

    # Task 5 — recommendation
    trends_ok = report["task2_trendsApi"].get("hasTrends") is True
    metrics_ok = any(r.get("hasMetrics") for r in metrics_results if isinstance(r, dict))
    ads_read = report["oauth"].get("adsReadGranted") or report["oauth"].get("adsReadOnTokenUsed")

    if trends_ok:
        rec = "A"
        rec_text = "Use official_v5 Trends as primary signal source."
    elif metrics_ok:
        rec = "B" if not trends_ok else "A"
        rec_text = "Add keyword_metrics provider as official volume source (separate from Trends)."
    elif not trends_ok and not metrics_ok and ads_read:
        rec = "C"
        rec_text = "Trends failed; if keyword metrics become available, use metrics + typeahead + crawler evidence interim."
    else:
        rec = "D"
        rec_text = "Both official paths unavailable with current scopes/token. Continue CSV bootstrap + crawler evidence; do not block Create Pins."

    report["recommendation"] = {
        "choice": rec,
        "summary": rec_text,
        "productionReady": trends_ok or metrics_ok,
        "nextSteps": [
            "Re-authorize Pinterest with ads:read if Keyword Metrics needed",
            "Confirm Trends & Insights API access on Pinterest developer app",
            "Set PINTEREST_TRENDS_ACCESS_TOKEN or ensure active pinterest_connections row",
        ],
    }

    print(json.dumps(report, indent=2, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
