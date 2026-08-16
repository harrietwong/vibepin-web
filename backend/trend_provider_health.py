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
    # Label-only, deliberately no retry: this probe fires immediately after the
    # run has spent the v5 rate-limit window, so retrying would add calls to an
    # already-throttled window for no decision value — _compute_blocker no longer
    # treats a throttled probe as proof of unavailability.
    entry["transient"] = _probe_transient(entry)
    if entry["transient"] and res.http_status == 429:
        entry["transientKind"] = "rate_limited"
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


# ── Probe vs. actual run ──────────────────────────────────────────────────────
# The health probe is a *separate* HTTP call (limit=5) fired AFTER the real fetch
# loop has already run. It therefore says nothing about what the job actually got
# — and worse, it is systematically self-defeating: the more interests the run
# successfully pulled from v5, the more of the rate-limit window it consumed, so
# the more likely the trailing probe eats an HTTP 429.
#
# That is exactly the 2026-08-10 01:04Z failure: the run pulled 1932 official_v5
# keywords across 23 interests (Layer results: v5=1932 L1=0 L2=0 L3=0, ZERO L3),
# 53 of which survived filters — and then the probe got 429, so _select_primary
# fell through to "l3_typeahead" and the job died claiming "only L3 typeahead
# available — estimated data". No L3 seed ever existed in that run.
#
# The red line (RL1/RL2: never pass estimated L3 data off as authoritative
# Pinterest trends) is preserved by inverting what the decision is grounded in:
# blocker is now decided by what the run ACTUALLY produced when that is known,
# and only falls back to the probe when actual results are unavailable
# (e.g. the standalone `--job trend-provider-health` invocation).


def summarize_actual_run(
    *,
    provider_run_summary: dict[str, Any] | None = None,
    authoritative_scored: int = 0,
    source_counts: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Condense what a trends run actually fetched into the shape _compute_blocker reads.

    `authoritative_scored` is the POST-FILTER count of official-layer keywords
    (official_v5/L1/L2) — deliberately preferred over the raw fetch count, because
    the red line is about what gets persisted, not about what was downloaded and
    then discarded.
    """
    prs = provider_run_summary or {}
    counts = source_counts or {}
    official_fetched = (
        int(prs.get("official_v5_count", 0) or 0)
        + int(prs.get("l1_count", 0) or 0)
        + int(prs.get("l2_count", 0) or 0)
    )
    return {
        "officialSeedsScored": int(authoritative_scored or 0),
        "officialSeedsFetched": official_fetched,
        "l3SeedsScored": int(counts.get("L3", 0) or 0),
        "l3SeedsFetched": int(prs.get("l3_count", 0) or 0),
        "primaryProvider": prs.get("primary_provider"),
        "accessDenied": bool(prs.get("blocker")),
        "accessDeniedReason": prs.get("blocker_reason"),
        "v5Status": prs.get("v5_status") or {},
    }


def _probe_transient(v5: dict[str, Any]) -> bool:
    """True when the probe failed for a reason that does NOT prove loss of access.

    Aligns with pinterest_trends_v5_provider's existing taxonomy rather than
    inventing a parallel one: that module maps 401/403 to
    `unavailable_auth_or_access` (permanent) and everything else — 429, 5xx,
    timeouts — to `http_error`. A 404 on the v5 endpoint is treated as permanent
    here because a missing endpoint is not something that retries fix.
    """
    if not v5.get("enabled"):
        return False
    if v5.get("status") == "unavailable_auth_or_access":
        return False
    if v5.get("httpStatus") == 404:
        return False
    return v5.get("status") == "http_error"


def _compute_blocker(
    health: dict[str, Any],
    actual_run: dict[str, Any] | None = None,
) -> tuple[bool, str | None]:
    v5 = health.get("official_v5") or {}
    l1 = health.get("internal_l1") or {}
    l2 = health.get("internal_l2") or {}

    if actual_run:
        # 1. The run itself was told "access denied" mid-flight (401/403 from the
        #    real fetch, not the probe). Permanent, and authoritative — block.
        if actual_run.get("accessDenied"):
            reason = actual_run.get("accessDeniedReason") or "official_v5 Trends API access denied"
            return True, f"official_v5 access denied during the run: {reason}"

        official_scored = int(actual_run.get("officialSeedsScored", 0) or 0)
        l3_scored = int(actual_run.get("l3SeedsScored", 0) or 0)
        l3_fetched = int(actual_run.get("l3SeedsFetched", 0) or 0)

        # 2. The run really did land official seeds. Whatever the trailing probe
        #    says, this job is NOT serving estimated data — do not fail it.
        if official_scored > 0:
            return False, None

        # 3. No official seeds survived, but L3 did. This is the case the red line
        #    exists for — block, and say precisely that.
        if l3_scored > 0 or l3_fetched > 0:
            return True, (
                f"run produced 0 official seeds and {l3_scored or l3_fetched} L3 typeahead seeds "
                "— estimated data, not authoritative production trends"
            )

        # 4. The run produced nothing at all from any layer. That is not a
        #    "we served estimates" problem; fall through to the probe verdict so
        #    a genuinely dead/unauthorized provider is still caught, while a
        #    merely rate-limited probe is not treated as proof of anything.

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
        if _probe_transient(v5):
            # No actual-run evidence, and the probe failed for a reason that does
            # not prove loss of access (429/5xx/timeout). Still a blocker — with
            # no evidence of official data, serving L3 would breach the red line
            # — but the reason must not claim official_v5 is unavailable, because
            # a throttled limit=5 request does not establish that.
            return True, (
                f"probe could not reach official_v5 (transient HTTP {v5.get('httpStatus')}: "
                f"{v5.get('error')}) and no official seeds were observed — only L3 typeahead "
                "available, estimated data, not authoritative production trends"
            )
        return True, "only L3 typeahead available — estimated data, not authoritative production trends"

    return False, None


async def run_provider_health(
    *,
    region: str = "US",
    actual_run: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Probe provider availability, and — when `actual_run` is supplied — decide the
    blocker from what the run actually produced instead of from the probe alone.

    `actual_run` is the dict returned by summarize_actual_run(). Callers with no
    run to describe (the standalone `--job trend-provider-health` diagnostic) pass
    nothing and get the unchanged probe-only verdict.
    """
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
    probe_primary = _select_primary(health)
    health["probePrimaryProvider"] = probe_primary
    health["probeTransientFailure"] = _probe_transient(official_v5)
    # _compute_blocker's probe-only fallback reads selectedPrimaryProvider; seed it
    # with the probe verdict before deciding, then overwrite below with the source
    # that actually fed the run.
    health["selectedPrimaryProvider"] = probe_primary

    if actual_run:
        health["actualRun"] = dict(actual_run)

    blocker, reason = _compute_blocker(health, actual_run)

    # selectedPrimaryProvider must name the source that actually fed the run, not
    # the one the trailing probe happened to reach. Reporting "l3_typeahead" for a
    # run whose every seed came from official_v5 (2026-08-10) is affirmatively
    # misleading about data provenance.
    selected = probe_primary
    decision_basis = "probe"
    if actual_run:
        if actual_run.get("primaryProvider"):
            selected = actual_run["primaryProvider"]
        decision_basis = "actual_run"
        if (
            int(actual_run.get("officialSeedsScored", 0) or 0) > 0
            and probe_primary != selected
        ):
            health["probeOverride"] = (
                f"probe selected {probe_primary!r} (official_v5 status="
                f"{official_v5.get('status')} HTTP {official_v5.get('httpStatus')}), but the run "
                f"produced {actual_run['officialSeedsScored']} official seeds via "
                f"{selected!r} — probe verdict discarded"
            )

    health["selectedPrimaryProvider"] = selected
    health["blockerDecisionBasis"] = decision_basis
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
