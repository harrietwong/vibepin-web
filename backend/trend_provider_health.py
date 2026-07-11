"""
trend_provider_health.py — Probe Pinterest trend provider availability.

Usage:
  python run_worker.py --job trend-provider-health
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from pinterest_trends_v5_provider import (
    ENABLE_OFFICIAL_V5,
    audit_config,
    fetch_v5_top_keywords,
    resolve_v5_access_token,
    v5_auth_present,
)
from trend_fetcher import (
    ENABLE_PINTEREST_RESOURCE_L2,
    ENABLE_PINTEREST_TRENDS_L1,
    ENABLE_TYPEAHEAD_L3,
    TrendSession,
    layer1_trends_api,
    layer2_internal_resource,
    layer3_typeahead_scoring,
)


def _provider_entry(
    *,
    enabled: bool,
    auth_present: bool | None = None,
    status: str,
    sample_count: int = 0,
    http_status: int | None = None,
    error: str | None = None,
    body_sample: str | None = None,
    url: str | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "enabled": enabled,
        "status": status,
        "sampleCount": sample_count,
        "httpStatus": http_status,
        "error": error,
    }
    if auth_present is not None:
        out["authPresent"] = auth_present
    if body_sample:
        out["bodySample"] = body_sample
    if url:
        out["url"] = url
    return out


async def probe_official_v5(region: str = "US") -> dict[str, Any]:
    cfg = audit_config()
    if not cfg["enabled"]:
        return _provider_entry(enabled=False, auth_present=cfg["authPresent"], status="disabled")

    res = await fetch_v5_top_keywords(region=region, trend_type="growing", limit=5)
    usable = 0
    if res.keywords:
        from trend_seed_pipeline import process_trend_seeds  # noqa: E402
        for interest in ("home_decor", "womens_fashion", "beauty"):
            try:
                from interest_discovery import slug_to_category  # type: ignore
                cat = slug_to_category(interest)
            except ImportError:
                cat = interest.replace("_", "-")
            scored = process_trend_seeds(
                res.keywords[:10],
                category=cat,
                interest_slug=interest,
                top_n=10,
            )
            usable += len(scored.seeds)
            if usable:
                break

    status = "healthy" if res.http_status == 200 and len(res.keywords) > 0 else res.provider_status
    if res.http_status == 200 and not res.keywords:
        status = "empty"

    entry = _provider_entry(
        enabled=True,
        auth_present=cfg["authPresent"],
        status=status,
        sample_count=len(res.keywords),
        http_status=res.http_status,
        error=res.error,
        body_sample=res.body_sample,
        url=res.url,
    )
    entry["usableSeedCount"] = usable
    return entry


async def probe_internal_l1(region: str = "US") -> dict[str, Any]:
    if not ENABLE_PINTEREST_TRENDS_L1:
        return _provider_entry(enabled=False, status="disabled", error="ENABLE_PINTEREST_TRENDS_L1=false")

    async with TrendSession() as session:
        kws = await layer1_trends_api(session, "home_decor", region)
        last = session.last_probe or {}
        return _provider_entry(
            enabled=True,
            status="ok" if kws else ("http_error" if last.get("http_status") else "empty"),
            sample_count=len(kws),
            http_status=last.get("http_status"),
            error=last.get("error"),
            body_sample=last.get("body_sample"),
            url=last.get("url"),
        )


async def probe_internal_l2(region: str = "US") -> dict[str, Any]:
    if not ENABLE_PINTEREST_RESOURCE_L2:
        return _provider_entry(enabled=False, status="disabled", error="ENABLE_PINTEREST_RESOURCE_L2=false")

    async with TrendSession() as session:
        kws = await layer2_internal_resource(session, "home_decor", region)
        last = session.last_probe or {}
        return _provider_entry(
            enabled=True,
            status="ok" if kws else ("http_error" if last.get("http_status") else "empty"),
            sample_count=len(kws),
            http_status=last.get("http_status"),
            error=last.get("error"),
            body_sample=last.get("body_sample"),
            url=last.get("url"),
        )


async def probe_l3_typeahead(region: str = "US") -> dict[str, Any]:
    if not ENABLE_TYPEAHEAD_L3:
        return _provider_entry(enabled=False, status="disabled", error="ENABLE_TYPEAHEAD_L3=false")

    async with TrendSession() as session:
        kws = await layer3_typeahead_scoring(session, "home-decor", region, "home_decor")
        return _provider_entry(
            enabled=True,
            status="ok" if kws else "empty",
            sample_count=len(kws),
        )


def _select_primary(health: dict[str, Any]) -> str:
    v5 = health.get("official_v5") or {}
    if v5.get("enabled") and v5.get("sampleCount", 0) > 0:
        return "official_v5"
    l1 = health.get("internal_l1") or {}
    if l1.get("enabled") and l1.get("sampleCount", 0) > 0:
        return "internal_l1"
    l2 = health.get("internal_l2") or {}
    if l2.get("enabled") and l2.get("sampleCount", 0) > 0:
        return "internal_l2"
    l3 = health.get("l3_typeahead") or {}
    if l3.get("enabled") and l3.get("sampleCount", 0) > 0:
        return "l3_typeahead"
    if v5.get("authPresent"):
        return "official_v5"
    return "none"


def _compute_blocker(health: dict[str, Any]) -> tuple[bool, str | None]:
    v5 = health.get("official_v5") or {}
    l1 = health.get("internal_l1") or {}
    l2 = health.get("internal_l2") or {}

    v5_ok = v5.get("enabled") and v5.get("sampleCount", 0) > 0
    if v5_ok:
        return False, None

    v5_auth = v5.get("authPresent", False)
    v5_unavailable = (
        not v5.get("enabled")
        or not v5_auth
        or v5.get("status") == "unavailable_auth_or_access"
    )

    l1_404 = l1.get("enabled") and l1.get("httpStatus") == 404
    l2_404 = l2.get("enabled") and l2.get("httpStatus") == 404
    l1_fail = l1.get("enabled") and l1.get("sampleCount", 0) == 0 and l1.get("httpStatus") not in (None, 200)
    l2_fail = l2.get("enabled") and l2.get("sampleCount", 0) == 0 and l2.get("httpStatus") not in (None, 200)

    if v5_unavailable and (l1_404 or l2_404 or (l1_fail and l2_fail)):
        if not v5_auth:
            return True, "official_v5: no OAuth token; internal L1/L2 return HTTP errors (not production-ready)"
        return True, (
            f"official_v5 unavailable ({v5.get('status')}: {v5.get('error')}); "
            f"L1 HTTP {l1.get('httpStatus')}, L2 HTTP {l2.get('httpStatus')}"
        )

    if v5_unavailable and not v5_auth:
        return True, "official_v5: no OAuth Bearer token configured for Trends API"

    if health.get("selectedPrimaryProvider") == "l3_typeahead":
        return True, "only L3 typeahead available — estimated data, not authoritative production trends"

    return False, None


async def run_provider_health(*, region: str = "US") -> dict[str, Any]:
    official_v5, internal_l1, internal_l2, l3_typeahead = await asyncio.gather(
        probe_official_v5(region),
        probe_internal_l1(region),
        probe_internal_l2(region),
        probe_l3_typeahead(region),
    )

    health = {
        "official_v5": official_v5,
        "internal_l1": internal_l1,
        "internal_l2": internal_l2,
        "l3_typeahead": l3_typeahead,
        "v5Config": audit_config(),
        "tokenSource": resolve_v5_access_token()[1],
    }
    health["selectedPrimaryProvider"] = _select_primary(health)
    blocker, reason = _compute_blocker(health)
    health["blocker"] = blocker
    health["blockerReason"] = reason
    return health


def format_health_json(health: dict[str, Any]) -> str:
    return json.dumps(health, indent=2, ensure_ascii=False, default=str)


async def main_async(region: str = "US") -> int:
    health = await run_provider_health(region=region)
    print(format_health_json(health))
    return 1 if health.get("blocker") else 0


def main() -> int:
    return asyncio.run(main_async())


if __name__ == "__main__":
    raise SystemExit(main())
