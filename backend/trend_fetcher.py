"""
trend_fetcher.py 鈥?Autonomous trend keyword discovery from Pinterest Trends.

Three-layer discovery (legacy fallback only — official v5 is primary):
  official_v5 — api.pinterest.com/v5/trends (OAuth Bearer, partner Trends API)
  Layer 1 — trends.pinterest.com/api/v3  (experimental; often 404)
  Layer 2 — www.pinterest.com/resource/* (experimental; often 404)
  Layer 3 — AdvancedTypeaheadResource scoring (weak estimated fallback)

Filter rules applied to every keyword regardless of source:
  鈥?search_volume_score 鈮?2  ("medium" or above)
  鈥?pct_growth_yoy      鈮?100 %  (only skyrocketing aesthetics)
  鈥?pct_growth_wow      鈮?0 %   (stable or rising this week)

Interests are loaded from the trend_interests DB table (populated by
interest_discovery.py). The old CATEGORY_INTERESTS hardcoded dict is removed.

Output: sorted by search_volume DESC 鈫?yoy_growth DESC 鈫?top-N keywords.
Keywords are also inserted into crawl_queue for the scraper to consume.

Usage:
  py trend_fetcher.py                     # all active interests from DB
  py trend_fetcher.py --interest home_decor
  py trend_fetcher.py --top 30 --db
  py trend_fetcher.py --run-scraper       # fetch + launch pipeline.py
"""

import argparse, asyncio, json, os, random, sys, time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlencode, quote

from curl_cffi.requests import AsyncSession as CurlSession

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent

# 鈹€鈹€ Layer feature flags (set env to "false" to disable a layer) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
ENABLE_PINTEREST_TRENDS_L1 = os.getenv("ENABLE_PINTEREST_TRENDS_L1", "false").lower() != "false"
ENABLE_PINTEREST_RESOURCE_L2 = os.getenv("ENABLE_PINTEREST_RESOURCE_L2", "false").lower() != "false"
ENABLE_TYPEAHEAD_L3 = os.getenv("ENABLE_TYPEAHEAD_L3", "true").lower() != "false"
ENABLE_EXPERIMENTAL_FALLBACK = os.getenv("ENABLE_PINTEREST_TRENDS_EXPERIMENTAL_FALLBACK", "true").lower() != "false"
ALLOW_DEGRADED_L3_WRITES = os.getenv("ALLOW_DEGRADED_L3_WRITES", "false").lower() != "false"

# Maps internal trend_source → DB source / quality labels
SOURCE_LABELS: Dict[str, Tuple[str, str, str]] = {
    "pinterest_trends_v5":  ("pinterest_v5_official", "official", "high"),
    "pinterest_trends_api": ("pinterest_trends_official", "official", "high"),
    "internal_resource":    ("pinterest_resource", "resource", "medium"),
    "typeahead_estimate":   ("pinterest_typeahead_estimated", "estimated", "low"),
    # Human-curated bootstrap seeds — never "official". data_quality="manual".
    "manual_bootstrap":     ("manual_bootstrap", "manual", "medium"),
    "csv_bootstrap":        ("csv_bootstrap", "manual", "medium"),
}

SOURCE_LAYERS: Dict[str, str] = {
    "pinterest_trends_v5":  "official_v5",
    "pinterest_trends_api": "L1",
    "internal_resource":    "L2",
    "typeahead_estimate":   "L3",
    "manual_bootstrap":     "manual_bootstrap",
    "csv_bootstrap":        "csv_bootstrap",
}

# Last provider run summary (reset per trends job)
PROVIDER_RUN_SUMMARY: dict[str, Any] = {
    "official_v5_count": 0,
    "l1_count": 0,
    "l2_count": 0,
    "l3_count": 0,
    "http_errors": {"official_v5": 0, "L1": 0, "L2": 0, "L3": 0},
    "primary_provider": None,
    "v5_status": None,
    "blocker": False,
    "blocker_reason": None,
}


def reset_provider_run_summary() -> None:
    PROVIDER_RUN_SUMMARY.clear()
    PROVIDER_RUN_SUMMARY.update({
        "official_v5_count": 0,
        "l1_count": 0,
        "l2_count": 0,
        "l3_count": 0,
        "http_errors": {"official_v5": 0, "L1": 0, "L2": 0, "L3": 0},
        "primary_provider": None,
        "v5_status": None,
        "blocker": False,
        "blocker_reason": None,
    })


def source_metadata(trend_source: str) -> Tuple[str, str, str]:
    """Return (source, data_quality, confidence) for a trend_source key."""
    return SOURCE_LABELS.get(
        trend_source,
        ("pinterest_typeahead_estimated", "estimated", "low"),
    )


def source_layer(trend_source: str) -> str:
    """Return L1/L2/L3 for an internal trend_source key."""
    return SOURCE_LAYERS.get(trend_source, "L3")


def enabled_layer_flags() -> dict[str, bool]:
    """Expose layer flags for logs/tests without reaching into globals."""
    from pinterest_trends_v5_provider import ENABLE_OFFICIAL_V5, v5_auth_present
    return {
        "official_v5": ENABLE_OFFICIAL_V5,
        "official_v5_auth": v5_auth_present(),
        "L1": ENABLE_PINTEREST_TRENDS_L1,
        "L2": ENABLE_PINTEREST_RESOURCE_L2,
        "L3": ENABLE_TYPEAHEAD_L3,
        "experimental_fallback": ENABLE_EXPERIMENTAL_FALLBACK,
        "allow_degraded_l3_writes": ALLOW_DEGRADED_L3_WRITES,
    }


# 鈹€鈹€ Commercial filter thresholds 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
MIN_YOY_GROWTH      = 100.0   # % 鈥?reject anything growing slower than 100% YoY
MIN_WEEKLY_CHANGE   =   0.0   # % 鈥?reject falling keywords (must be stable or rising)
MIN_VOLUME_SCORE    =   2     # 1=low 2=medium 3=high 4=very_high
TOP_N_DEFAULT       =  20     # keywords to return per category

VOLUME_LABEL_SCORE = {"very_high": 4, "high": 3, "medium": 2, "low": 1}

BASE_HEADERS = {
    "User-Agent":  ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/147.0.0.0 Safari/537.36"),
    "Accept":       "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    "X-Requested-With": "XMLHttpRequest",
}


# 鈹€鈹€ Session wrapper 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

class TrendSession:
    """
    curl_cffi session bootstrapped against pinterest.com for cookies/CSRF.
    Shared across all three discovery layers.
    """

    def __init__(self, proxy: Optional[str] = None):
        self._proxy   = proxy
        self._session: Optional[CurlSession] = None
        self._csrf    = ""
        self._app_ver = ""
        self._last    = 0.0
        self.stats    = {
            "l1_http_errors": 0,
            "l2_http_errors": 0,
            "l3_http_errors": 0,
            "l1_disabled": 0,
            "l2_disabled": 0,
            "l3_disabled": 0,
        }
        self.last_probe: dict[str, Any] = {}
        self._last_http_status: int | None = None
        self._last_body_sample: str | None = None

    async def __aenter__(self) -> "TrendSession":
        kwargs: dict = {"impersonate": "chrome146", "headers": BASE_HEADERS}
        if self._proxy:
            kwargs["proxies"] = {"https": self._proxy, "http": self._proxy}
        self._session = CurlSession(**kwargs)
        await self._bootstrap()
        return self

    async def __aexit__(self, *_) -> None:
        if self._session:
            await self._session.close()

    async def _bootstrap(self) -> None:
        import re
        r = await self._session.get(
            "https://www.pinterest.com/",
            headers={"Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                     "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"},
        )
        self._csrf = self._session.cookies.get("csrftoken", "")
        m = re.search(r'<script[^>]+id=["\']__PWS_DATA__["\'][^>]*>(.*?)</script>',
                      r.text, re.DOTALL)
        if m:
            try:
                self._app_ver = json.loads(m.group(1)).get("appVersion", "")
            except Exception:
                pass
        print(f"[trends] session ready  csrf={'ok' if self._csrf else 'missing'}  "
              f"app_version={self._app_ver or 'n/a'}")
        await asyncio.sleep(random.uniform(0.8, 1.4))

    @staticmethod
    def _b3() -> dict:
        import secrets
        tid = secrets.token_hex(8)
        return {"X-B3-TraceId": tid, "X-B3-SpanId": secrets.token_hex(8),
                "X-B3-ParentSpanId": tid, "X-B3-Flags": "0"}

    async def get(
        self, url: str, *,
        params:      dict           = None,
        referer:     str            = "https://www.pinterest.com/",
        source_url:  str            = "",
        pws_handler: str            = "",
        delay:       float          = 1.0,
    ) -> dict:
        """Rate-limited GET with full Pinterest API headers 鈫?JSON dict."""
        elapsed = time.monotonic() - self._last
        if elapsed < delay:
            await asyncio.sleep(delay - elapsed)
        self._last = time.monotonic()

        extra = {"Referer": referer, **self._b3()}
        if self._csrf:
            extra["X-CSRFToken"] = self._csrf
        if self._app_ver:
            extra["X-App-Version"] = self._app_ver
        if source_url:
            extra["X-Pinterest-Source-Url"] = source_url
        if pws_handler:
            extra["X-Pinterest-Pws-Handler"] = pws_handler

        try:
            r = await self._session.get(url, params=params or {}, headers=extra)
            self._last_http_status = r.status_code
            body_text = r.text or ""
            if r.status_code == 200:
                return r.json()
            self._last_body_sample = body_text[:400] + ("…" if len(body_text) > 400 else "")
            self.last_probe = {
                "url": url[:200],
                "http_status": r.status_code,
                "body_sample": self._last_body_sample,
                "error": f"HTTP {r.status_code}",
            }
            if "trends.pinterest.com/api/v3" in url:
                self.stats["l1_http_errors"] += 1
            elif "TrendingSearchResource" in url or "TrendKeywordsResource" in url:
                self.stats["l2_http_errors"] += 1
            else:
                self.stats["l3_http_errors"] += 1
            print(f"  [trends] HTTP {r.status_code} for {url[:80]}")
            return {}
        except Exception as exc:
            self.last_probe = {"url": url[:200], "error": str(exc)}
            print(f"  [trends] GET error: {exc}")
            return {}


# 鈹€鈹€ Layer 1: Official Pinterest Trends API (trends.pinterest.com) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async def layer1_trends_api(
    session: TrendSession,
    interest: str,
    region: str = "US",
) -> List[dict]:
    """
    Call trends.pinterest.com/api/v3/trends to get trending keywords
    with real pct_growth_yoy / pct_growth_wow / time_series metrics.

    Returns list of raw keyword dicts from the API.
    """
    endpoints_to_try = [
        # Suggested keywords for an interest category
        (
            "https://trends.pinterest.com/api/v3/trends/keywords/suggested/",
            {"country_code": region, "locale": "en-US",
             "interests[]": interest, "limit": 50},
            "suggested",
        ),
        # Top trending keywords across a category
        (
            "https://trends.pinterest.com/api/v3/trends/categories/top/",
            {"country_code": region, "locale": "en-US",
             "interests[]": interest, "limit": 50},
            "categories_top",
        ),
    ]

    for url, params, label in endpoints_to_try:
        data = await session.get(url, params=params,
                                 referer="https://trends.pinterest.com/")
        kws = _parse_trends_response(data)
        if kws:
            print(f"  [L1:{label}] {interest} 鈫?{len(kws)} keywords")
            return kws

    return []


def _parse_trends_response(data: Any) -> List[dict]:
    """
    Normalise the trends.pinterest.com API response into a flat list of dicts:
      { keyword, pct_growth_yoy, pct_growth_wow, volume_score, search_volume_level }
    Handles multiple known response shapes.
    """
    if not isinstance(data, dict):
        return []

    # Shape A: {"status": "success", "data": {"keywords": [...]}}
    kw_list = (data.get("data", {}) or {}).get("keywords") or []

    # Shape B: {"status": "success", "data": [...]}   (array directly)
    if not kw_list and isinstance(data.get("data"), list):
        kw_list = data["data"]

    # Shape C: {"keywords": [...]}  (flat)
    if not kw_list:
        kw_list = data.get("keywords") or []

    results = []
    for item in kw_list:
        if not isinstance(item, dict):
            continue
        kw = (item.get("keyword") or item.get("term") or item.get("name") or "").strip()
        if not kw:
            continue

        # Growth metrics 鈥?try nested trends_data, then flat
        td            = item.get("trends_data") or item.get("trend_data") or {}
        yoy           = float(td.get("pct_growth_yoy", 0) or item.get("pct_growth_yoy", 0))
        wow           = float(td.get("pct_growth_wow", 0) or item.get("pct_growth_wow", 0))
        mom           = float(td.get("pct_growth_mom", 0) or item.get("pct_growth_mom", 0))

        # Search volume 鈥?label or time_series tail (last few weeks)
        vol_label     = (item.get("search_volume_level") or "").lower()
        ts            = item.get("time_series") or td.get("time_series") or []
        vol_score     = VOLUME_LABEL_SCORE.get(vol_label, 0)
        if vol_score == 0 and ts:
            recent_avg = sum(ts[-4:]) / max(1, len(ts[-4:]))
            vol_score  = 4 if recent_avg >= 75 else 3 if recent_avg >= 50 else \
                         2 if recent_avg >= 25 else 1
            vol_label  = {4: "very_high", 3: "high", 2: "medium", 1: "low"}.get(vol_score, "low")

        results.append({
            "keyword":              kw,
            "pct_growth_yoy":       yoy,
            "pct_growth_wow":       wow,
            "pct_growth_mom":       mom,
            "search_volume":        item.get("search_volume"),
            "search_volume_level":  vol_label or "unknown",
            "volume_score":         vol_score,
            "trend_source":         "pinterest_trends_api",
            "time_series":          ts,   # 52-week normalized 0-100 array (may be [])
        })

    return results


# 鈹€鈹€ Layer 2: Internal Pinterest TrendingSearchResource 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async def layer2_internal_resource(
    session: TrendSession,
    interest: str,
    region: str = "US",
) -> List[dict]:
    """
    Try www.pinterest.com/resource/TrendingSearchResource/get/ 鈥?a known
    pattern matching BaseSearchResource.  Returns normalised keyword dicts.
    """
    options = {"category": interest.replace("_", " "), "region": region.lower()}
    params  = {
        "source_url": "/today/",
        "data":       json.dumps({"options": options, "context": {}},
                                 separators=(',', ':')),
        "_":          str(int(time.time() * 1000)),
    }
    url  = ("https://www.pinterest.com/resource/TrendingSearchResource/get/?"
            + urlencode(params))
    data = await session.get(url, referer="https://www.pinterest.com/today/",
                             source_url="/today/",
                             pws_handler="www/today.js",
                             delay=1.2)

    # Also try TrendKeywordsResource
    if not _has_keyword_data(data):
        params2 = {
            "source_url": "/trends/",
            "data":       json.dumps(
                {"options": {"interest": interest, "region": region, "limit": 50},
                 "context": {}}, separators=(',', ':')),
            "_": str(int(time.time() * 1000)),
        }
        url2 = ("https://www.pinterest.com/resource/TrendKeywordsResource/get/?"
                + urlencode(params2))
        data = await session.get(url2, referer="https://www.pinterest.com/",
                                 source_url="/trends/",
                                 pws_handler="www/trends.js",
                                 delay=1.2)

    raw  = data.get("resource_response", {}).get("data") or {}
    kws  = _parse_internal_resource(raw, interest)
    if kws:
        print(f"  [L2:internal] {interest} 鈫?{len(kws)} keywords")
    return kws


def _has_keyword_data(data: dict) -> bool:
    raw = data.get("resource_response", {}).get("data") or {}
    if isinstance(raw, list) and raw:
        return True
    if isinstance(raw, dict):
        return bool(raw.get("keywords") or raw.get("trending_keywords")
                    or raw.get("trending_searches"))
    return False


def _parse_internal_resource(raw: Any, interest: str) -> List[dict]:
    items: List[Any] = []
    if isinstance(raw, list):
        items = raw
    elif isinstance(raw, dict):
        for key in ("keywords", "trending_keywords", "trending_searches", "results"):
            if isinstance(raw.get(key), list):
                items = raw[key]
                break

    results = []
    for item in items:
        if isinstance(item, str):
            kw = item.strip()
        elif isinstance(item, dict):
            kw = (item.get("keyword") or item.get("query") or item.get("term") or "").strip()
        else:
            continue
        if not kw:
            continue
        results.append({
            "keyword":             kw,
            "pct_growth_yoy":      float(item.get("yoy_growth", 0)
                                         if isinstance(item, dict) else 0),
            "pct_growth_wow":      float(item.get("wow_growth", 0)
                                         if isinstance(item, dict) else 0),
            "pct_growth_mom":      0.0,
            "search_volume":       item.get("search_volume") if isinstance(item, dict) else None,
            "search_volume_level": "unknown",
            "volume_score":        2,   # assume "medium" when unknown
            "trend_source":        "internal_resource",
        })
    return results


# 鈹€鈹€ Layer 3: Typeahead scoring (always-available fallback) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async def layer3_typeahead_scoring(
    session: TrendSession,
    category: str,
    region: str = "US",
    interest_slug: str = "",
) -> List[dict]:
    """
    Use AdvancedTypeaheadResource + BaseSearchResource result counts to
    construct a scored keyword list.  Always works; metrics are estimates.

    Seed comes from the interest_slug (e.g. "home_decor" 鈫?"home decor").
    No hardcoded keyword lists 鈥?Pinterest Trends remains the source of truth.

    Scoring:
      volume_score  = binned by how many pins the search returns
      pct_growth_yoy = estimated from average save_velocity of top pins
      pct_growth_wow = estimated from % of pins created in last 7 days
    """
    seed_text = (interest_slug.replace("_", " ") if interest_slug
                 else category.replace("_", " "))
    seeds = [seed_text]

    results: List[dict] = []
    seen: set = set()

    for seed in seeds[:5]:   # probe first 5 seeds
        # Step A: expand via typeahead
        src_param = f"/search/pins/?q={seed.replace(' ', '+')}"
        params = {
            "source_url": src_param,
            "data": json.dumps({"options": {"term": seed, "pin_scope": "pins",
                                            "autocomplete_request_surface": 0},
                                "context": {}}, separators=(',', ':')),
            "_": str(int(time.time() * 1000)),
        }
        url  = ("https://www.pinterest.com/resource/AdvancedTypeaheadResource/get/?"
                + urlencode(params))
        data = await session.get(
            url,
            referer=f"https://www.pinterest.com/search/pins/?q={quote(seed)}",
            source_url=src_param,
            pws_handler="www/search/[scope].js",
            delay=1.0,
        )

        items = ((data.get("resource_response", {}) or {})
                 .get("data", {}) or {})
        items = items.get("items") or []

        suggestions: List[str] = []
        for item in items[:8]:
            # API returns {query, label} (newer) or {item:{term}} (older format)
            term = (item.get("query") or item.get("label")
                    or item.get("display")
                    or (item.get("item") or {}).get("term") or "").strip()
            if term and term.lower() != seed.lower() and term not in seen:
                seen.add(term)
                suggestions.append(term)

        # Step B: score each suggestion by fetching page 1 of search results
        for kw in suggestions[:4]:
            score_data = await _score_keyword_via_search(session, kw)
            results.append({
                "keyword":             kw,
                "pct_growth_yoy":      score_data["est_yoy"],
                "pct_growth_wow":      score_data["est_wow"],
                "pct_growth_mom":      0.0,
                "search_volume_level": score_data["vol_label"],
                "volume_score":        score_data["vol_score"],
                "trend_source":        "typeahead_estimate",
                "_est_velocity":       score_data["avg_velocity"],
            })
            await asyncio.sleep(random.uniform(0.3, 0.7))

    print(f"  [L3:typeahead] {category} 鈫?{len(results)} keyword candidates")
    return results


async def _score_keyword_via_search(session: TrendSession, keyword: str) -> dict:
    """
    Fetch page 1 of BaseSearchResource for keyword, compute proxy metrics.
    Returns est_yoy, est_wow, vol_label, vol_score, avg_velocity.
    """
    src = f"/search/pins/?q={keyword.replace(' ', '+')}&rs=typed"
    options: Dict[str, Any] = {"query": keyword, "scope": "pins", "page_size": 25}
    params = {
        "source_url": src,
        "data": json.dumps({"options": options, "context": {}}, separators=(',', ':')),
        "_": str(int(time.time() * 1000)),
    }
    url  = ("https://www.pinterest.com/resource/BaseSearchResource/get/?"
            + urlencode(params))
    data = await session.get(
        url,
        referer=f"https://www.pinterest.com/search/pins/?q={quote(keyword)}",
        source_url=src,
        pws_handler="www/search/[scope].js",
        delay=0.8,
    )

    resource   = data.get("resource_response", {})
    resp_data  = resource.get("data") or {}
    results    = resp_data.get("results") if isinstance(resp_data, dict) else []
    pins       = _flatten_pins(results or [])

    now = datetime.now(timezone.utc)
    save_velocities, recent_count = [], 0

    for p in pins[:20]:
        saves = int(p.get("save_count") or p.get("repin_count") or 0)
        created_str = p.get("created_at") or ""
        days = None
        if created_str:
            try:
                from email.utils import parsedate_to_datetime
                try:
                    dt = parsedate_to_datetime(created_str)
                except Exception:
                    dt = datetime.fromisoformat(created_str.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                days = max(1, (now - dt).days)
                if days <= 7:
                    recent_count += 1
            except Exception:
                pass
        if days and saves:
            save_velocities.append(saves / days)

    avg_vel   = sum(save_velocities) / max(1, len(save_velocities))
    wow_pct   = round(100 * recent_count / max(1, len(pins[:20])), 1)

    # Velocity bins 鈥?tuned so common trending keywords hit "medium"+ (vol_score鈮?)
    # vel 鈮?100 鈫?very_high, 鈮?20 鈫?high, 鈮?3 鈫?medium, else low
    est_yoy   = min(500, round(avg_vel * 1.5, 1))
    vol_score = 4 if avg_vel >= 100 else 3 if avg_vel >= 20 else \
                2 if avg_vel >= 3  else 1
    vol_label = {4: "very_high", 3: "high", 2: "medium", 1: "low"}[vol_score]

    return {"est_yoy": est_yoy, "est_wow": wow_pct,
            "vol_label": vol_label, "vol_score": vol_score,
            "avg_velocity": round(avg_vel, 1)}


def _flatten_pins(obj: Any, depth: int = 0) -> List[dict]:
    """Recursively extract dicts that look like pins from a search result."""
    if depth > 6 or not isinstance(obj, (dict, list)):
        return []
    if isinstance(obj, list):
        out = []
        for item in obj:
            out.extend(_flatten_pins(item, depth + 1))
        return out
    if obj.get("type") == "pin" or (obj.get("id") and obj.get("save_count") is not None):
        return [obj]
    out = []
    for v in obj.values():
        if isinstance(v, (dict, list)):
            out.extend(_flatten_pins(v, depth + 1))
    return out


# 鈹€鈹€ Master filter + rank 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

def filter_and_rank(
    keywords: List[dict],
    min_yoy:    float = MIN_YOY_GROWTH,
    min_wow:    float = MIN_WEEKLY_CHANGE,
    min_vol:    int   = MIN_VOLUME_SCORE,
    top_n:      int   = TOP_N_DEFAULT,
) -> List[dict]:
    """
    Apply commercial filters and return sorted top-N list.

    Official/resource data keeps stricter growth thresholds. L3 typeahead uses
    explicit estimated rules: volume_score >= 1 and weekly signal >= 0.
    """
    out = []
    for kw in keywords:
        source = kw.get("trend_source", "")
        is_est = source == "typeahead_estimate"

        if is_est:
            # L3 is estimated. Keep broad but honest: no official growth claim,
            # no exact search volume, and minimum low+ volume signal.
            if kw.get("volume_score", 0) < 1:
                continue
            if kw.get("pct_growth_wow", 0) < 0:
                continue
        else:
            # Real Pinterest Trends data: apply strict thresholds
            if kw.get("pct_growth_yoy", 0) < min_yoy:
                continue
            if kw.get("pct_growth_wow", 0) < min_wow:
                continue
            if kw.get("volume_score", 0) < min_vol:
                continue

        out.append(kw)

    # Sort: volume DESC 鈫?yoy DESC
    out.sort(key=lambda x: (
        -float(x.get("volume_score", 0) or 0),
        -float(x.get("_est_velocity", x.get("pct_growth_yoy", 0)) or 0),
        -compute_priority_score(x),
        str(x.get("keyword", "")).lower(),
    ))
    return out[:top_n]


def compute_priority_score(kw: dict) -> float:
    """
    Map to priority_score format used by the existing trend_keywords table.
    Prefers TrendSeedScore pipeline output when present.
    """
    if kw.get("priority_score") is not None:
        return float(kw["priority_score"])

    yoy  = kw.get("pct_growth_yoy",  0) or 0
    wow  = kw.get("pct_growth_wow",  0) or 0
    mom  = kw.get("pct_growth_mom",  0) or 0
    vscore = kw.get("volume_score",  0) or 0

    score = (yoy / 10) * 1.0 + wow * 2.0 + (mom / 10) * 1.5 + vscore * 5.0

    bonuses = ["outfit", "nails", "decor", "ideas", "aesthetic", "styling",
               "vintage", "cozy", "boho", "minimal"]
    if any(b in kw["keyword"].lower() for b in bonuses):
        score += 10.0

    return round(score, 2)


# 鈹€鈹€ Per-keyword time series enrichment 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

def _extract_time_series_from_response(data: Any, keyword: str) -> List[float]:
    """
    Try every known Pinterest Trends API response shape to extract a time_series list.
    Returns [] if nothing found.
    """
    if not isinstance(data, dict):
        return []

    def _from_item(item: Any) -> List[float]:
        if not isinstance(item, dict):
            return []
        td  = item.get("trends_data") or item.get("trend_data") or {}
        ts  = item.get("time_series") or td.get("time_series") or []
        return [float(v) for v in ts] if ts else []

    # Shape A: top-level time_series
    if isinstance(data.get("time_series"), list):
        return [float(v) for v in data["time_series"]]

    d = data.get("data") or {}

    # Shape B: data.time_series
    if isinstance(d, dict) and isinstance(d.get("time_series"), list):
        return [float(v) for v in d["time_series"]]

    # Shape C: data.keywords[*]  鈥?find the matching keyword
    items = []
    if isinstance(d, dict):
        items = d.get("keywords") or d.get("results") or []
    elif isinstance(d, list):
        items = d

    kw_lower = keyword.lower().strip()
    for item in items:
        if not isinstance(item, dict):
            continue
        name = (item.get("keyword") or item.get("term") or item.get("name") or "").lower()
        if name == kw_lower or not name:   # accept first item if keyword unclear
            ts = _from_item(item)
            if ts:
                return ts

    return []


async def fetch_keyword_time_series(
    session: TrendSession,
    keyword: str,
    region:  str = "US",
) -> List[float]:
    """
    Fetch a 52-week normalized (0-100) time series for a single keyword.

    Tries multiple Pinterest Trends endpoint patterns in priority order.
    Returns [] when nothing is found (caller should keep existing data).

    Endpoint candidates (tried in order):
      1. /api/v3/trends/keywords/time_series/  鈥?dedicated history endpoint
      2. /api/v3/trends/keywords/suggested/    鈥?suggested keywords for a query
         (some regions return time_series per keyword here)
      3. /api/v3/trends/keyword_search/        鈥?keyword detail page endpoint
    """
    candidates = [
        (
            "https://trends.pinterest.com/api/v3/trends/keywords/time_series/",
            {"country_code": region, "locale": "en-US", "keywords[]": keyword},
        ),
        (
            "https://trends.pinterest.com/api/v3/trends/keywords/suggested/",
            {"country_code": region, "locale": "en-US",
             "query": keyword, "limit": 1},
        ),
        (
            "https://trends.pinterest.com/api/v3/trends/keyword_search/",
            {"country_code": region, "locale": "en-US",
             "keyword": keyword, "limit": 1},
        ),
    ]

    for url, params in candidates:
        data = await session.get(
            url, params=params,
            referer="https://trends.pinterest.com/",
            delay=0.6,
        )
        if not data:
            continue
        ts = _extract_time_series_from_response(data, keyword)
        if ts:
            return ts

    return []


async def enrich_with_time_series(
    session:  TrendSession,
    keywords: List[dict],
    region:   str = "US",
) -> List[dict]:
    """
    Add 52-week time_series to each keyword dict via per-keyword API calls.
    Keywords that already have a non-empty time_series are skipped.

    Rate-limited: ~0.6 s per keyword (no burst).
    Typically called after discover_trends_for_interest() and before upsert.
    """
    need   = [kw for kw in keywords if not kw.get("time_series")]
    have   = len(keywords) - len(need)

    if have:
        print(f"  [enrich] {have} keywords already have time_series 鈥?skipping")

    enriched = 0
    for kw in need:
        ts = await fetch_keyword_time_series(session, kw["keyword"], region)
        kw["time_series"] = ts
        if ts:
            enriched += 1

    total  = len(need)
    missed = total - enriched
    print(f"  [enrich] {enriched}/{total} keywords enriched with time_series"
          + (f"  ({missed} had no data 鈥?will stay as unclear lifecycle)" if missed else ""))
    return keywords


# 鈹€鈹€ DB helpers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

def _db():
    """Lazy import of db module (avoids import errors when running without .env)."""
    import sys as _sys
    _sys.path.insert(0, str(ROOT / "db"))
    from db import upsert, select_many, select_one, update_where  # type: ignore
    return upsert, select_many, select_one, update_where


CRAWL_QUEUE_LAST_STATS: dict[str, int] = {
    "inserted": 0,
    "updated_pending": 0,
    "requeued": 0,
    "requeued_failed": 0,
    "skipped": 0,
    "written": 0,
}


def build_trend_keyword_row(
    kw: dict,
    category: str,
    *,
    region: str = "US",
    now_iso: str | None = None,
) -> dict:
    """Map one discovered keyword dict to a trend_keywords DB row."""
    now_iso = now_iso or datetime.now(tz=timezone.utc).isoformat()
    trend_src = kw.get("trend_source", "typeahead_estimate")
    region = kw.get("region") or region
    source, data_quality, confidence = source_metadata(trend_src)
    vol_signal = kw.get("volume_signal") or kw.get("search_volume_level", "unknown")
    vol_score = kw.get("volume_score", 0)
    normalized = kw.get("normalized_category") or normalize_category(category)
    try:
        from trend_seed_pipeline import build_seed_notes, TrendSeed  # type: ignore
        notes = build_seed_notes(TrendSeed(
            keyword=kw["keyword"],
            normalized_category=normalized,
            trend_seed_score=float(kw.get("trend_seed_score") or 0),
            crawl_priority=kw.get("crawl_priority") or "low",
            refresh_cadence=kw.get("refresh_cadence") or "weekly",
            cluster_id=kw.get("cluster_id"),
            seed_disposition=kw.get("seed_disposition") or "accepted",
            priority_score=float(kw.get("priority_score") or compute_priority_score(kw)),
            raw=kw,
        ))
    except Exception:
        notes = None

    row = {
        "keyword":             kw["keyword"],
        "category":            normalized,
        "region":              region,
        "source":              source,
        "data_quality":        data_quality,
        "confidence":          confidence,
        "source_layer":        kw.get("_source_layer_override") or source_layer(trend_src),
        "priority_score":      compute_priority_score(kw),
        "weekly_change":       kw.get("pct_growth_wow", 0),
        "monthly_change":      kw.get("pct_growth_mom", 0),
        "yearly_change":       kw.get("pct_growth_yoy", 0),
        "search_volume_level": vol_signal,
        "volume_signal":       vol_signal,
        "volume_score":        vol_score,
        "search_volume_score": vol_score,
        "search_volume":       None if trend_src in ("typeahead_estimate", "manual_bootstrap", "csv_bootstrap") else kw.get("search_volume"),
        "status":              "active",
        "is_seed":             True,
        "notes":               notes,
        "last_updated_at":     now_iso,
    }
    if os.getenv("ENABLE_TREND_V29_PROVENANCE_COLUMNS", "false").lower() == "true":
        if kw.get("trend_type"):
            row["trend_type"] = kw["trend_type"]
        if kw.get("v5_interest_param"):
            row["v5_interest_param"] = kw["v5_interest_param"]
    return row


def normalize_category(category: str, interest_slug: str = "") -> str:
    """Re-export for build_trend_keyword_row fallback."""
    from trend_seed_pipeline import normalize_category as _norm  # type: ignore
    return _norm(category, interest_slug or None)


def upsert_trend_keywords(keywords: List[dict], category: str,
                          source_interest: str = "") -> int:
    """Write filtered keywords to Supabase trend_keywords table."""
    try:
        upsert, _, _, _ = _db()
    except ImportError as exc:
        print(f"[db] cannot import db module: {exc}")
        return 0

    rows = []
    for kw in keywords:
        row: dict = build_trend_keyword_row(kw, category)
        # Only write trend_history when Layer 1 returned a real time series.
        # Omitting the key (not passing None) preserves any existing value.
        ts = kw.get("time_series")
        if ts:
            now_iso = datetime.now(tz=timezone.utc).isoformat()
            row["trend_history"] = ts
            row["trend_series"] = ts
            src = kw.get("trend_source", "")
            row["trend_series_source"] = (
                "pinterest_v5_official" if src == "pinterest_trends_v5" else "pinterest_trends_api"
            )
            row["trend_series_granularity"] = "weekly"
            row["trend_series_updated_at"] = now_iso
        rows.append(row)

    try:
        result = upsert("trend_keywords", rows, on_conflict="keyword,category")
        return len(result)
    except Exception as exc:
        print(f"[db] upsert error: {exc}")
        return 0


def upsert_crawl_queue(keywords: List[dict], source_interest: str,
                       category: str) -> int:
    """
    Upsert discovered keywords into crawl_queue with stale requeue logic.

    - New keywords 鈫?pending
    - Pending 鈫?keep pending, bump priority if higher
    - Processing/running 鈫?untouched
    - Completed (stale >7d) 鈫?requeue pending
    - Failed (attempts < 3) 鈫?requeue pending

    Returns number of rows written.
    """
    try:
        upsert, _, select_one, _ = _db()
    except ImportError as exc:
        print(f"[db] cannot import db module: {exc}")
        return 0

    from crawl_queue_ops import classify_queue_plan, plan_crawl_queue_row  # type: ignore
    from trend_seed_pipeline import next_crawl_at_from_cadence  # type: ignore

    now_dt = datetime.now(tz=timezone.utc)
    now_iso = now_dt.isoformat()
    rows: List[dict] = []
    seen_keywords: set[str] = set()
    stats = {
        "inserted": 0,
        "updated_pending": 0,
        "requeued": 0,
        "requeued_failed": 0,
        "skipped": 0,
        "written": 0,
    }
    for kw in keywords:
        if kw.get("crawl_queue_eligible") is False:
            stats["skipped"] += 1
            continue
        cadence = kw.get("refresh_cadence") or "weekly"
        if cadence in ("paused", "none"):
            stats["skipped"] += 1
            continue
        keyword = (kw.get("keyword") or "").strip()
        dedupe_key = keyword.lower()
        if not keyword or dedupe_key in seen_keywords:
            continue
        seen_keywords.add(dedupe_key)
        per_interest = (kw.get("interest_slug") or source_interest or "").strip()
        try:
            existing = select_one("crawl_queue", {"keyword": keyword})
        except Exception:
            existing = None
        planned = plan_crawl_queue_row(
            existing,
            keyword=keyword,
            priority_score=compute_priority_score(kw),
            source_interest=per_interest or source_interest,
            category=kw.get("normalized_category") or category,
            now_iso=now_iso,
            next_crawl_at=next_crawl_at_from_cadence(now_dt, cadence),
        )
        stats[classify_queue_plan(existing, planned)] += 1
        if planned:
            rows.append(planned)

    if not rows:
        CRAWL_QUEUE_LAST_STATS.update(stats)
        return 0

    try:
        result = upsert("crawl_queue", rows, on_conflict="keyword")
        written = len(result) if result else len(rows)
        stats["written"] = written
        CRAWL_QUEUE_LAST_STATS.update(stats)
        print(
            "[db] crawl_queue "
            f"inserted={stats['inserted']} updated_pending={stats['updated_pending']} "
            f"requeued={stats['requeued']} requeued_failed={stats['requeued_failed']} "
            f"skipped={stats['skipped']} written={written}"
        )
        return written
    except Exception as exc:
        print(f"[db] crawl_queue upsert error: {exc}")
        CRAWL_QUEUE_LAST_STATS.update(stats)
        return 0


def write_deduped_seed_batch(
    accumulator: dict,
    *,
    region: str = "US",
    v5_auth_available: bool = False,
) -> dict[str, int]:
    """
    Persist globally deduped seeds after global_dedupe_job_seeds().
    Must not be called before dedup — apply path writes only canonical rows.
    """
    from collections import defaultdict

    seeds = list(accumulator.get("seeds") or [])
    watchlist = list(accumulator.get("watchlist") or [])
    totals = {
        "trend_keywords": 0,
        "crawl_queue": 0,
        "watchlist_keywords": 0,
        "interests_updated": 0,
    }
    if not seeds and not watchlist:
        CRAWL_QUEUE_LAST_STATS.update({
            "inserted": 0, "updated_pending": 0, "requeued": 0,
            "requeued_failed": 0, "skipped": 0, "written": 0,
        })
        return totals

    queue_seeds = [kw for kw in seeds if kw.get("crawl_queue_eligible")]
    all_l3 = bool(queue_seeds) and all(
        source_layer(kw.get("trend_source", "typeahead_estimate")) == "L3"
        for kw in queue_seeds
    )
    if all_l3 and not v5_auth_available and not ALLOW_DEGRADED_L3_WRITES:
        print(
            "[db] deduped batch write blocked — L3-only seeds and "
            "ALLOW_DEGRADED_L3_WRITES=false"
        )
        CRAWL_QUEUE_LAST_STATS.update({
            "inserted": 0, "updated_pending": 0, "requeued": 0,
            "requeued_failed": 0, "skipped": len(queue_seeds), "written": 0,
        })
        return totals

    if all_l3 and not v5_auth_available:
        for kw in queue_seeds:
            kw["_source_layer_override"] = "l3_typeahead_degraded"

    by_cat: dict[str, list[dict]] = defaultdict(list)
    for kw in seeds:
        cat = kw.get("normalized_category") or normalize_category("", kw.get("interest_slug") or "")
        by_cat[cat].append(kw)
    for cat, kws in by_cat.items():
        slug = (kws[0].get("interest_slug") or "").strip()
        totals["trend_keywords"] += upsert_trend_keywords(kws, cat, slug)

    if queue_seeds:
        totals["crawl_queue"] = upsert_crawl_queue(
            queue_seeds,
            source_interest="",
            category="",
        )

    if watchlist:
        wl_by_cat: dict[str, list[dict]] = defaultdict(list)
        for kw in watchlist:
            cat = kw.get("normalized_category") or normalize_category("", kw.get("interest_slug") or "")
            wl_by_cat[cat].append(kw)
        for cat, kws in wl_by_cat.items():
            slug = (kws[0].get("interest_slug") or "").strip()
            totals["watchlist_keywords"] += upsert_trend_keywords(kws, cat, slug)

    interest_counts: dict[str, int] = defaultdict(int)
    for kw in seeds + watchlist:
        slug = (kw.get("interest_slug") or "").strip()
        if slug:
            interest_counts[slug] += 1
    for slug, count in interest_counts.items():
        update_interest_fetched(slug, region, count)
        totals["interests_updated"] += 1

    return totals


def update_interest_fetched(interest_slug: str, country: str,
                            keyword_count: int) -> None:
    """Mark a trend_interest as last fetched with keyword count."""
    try:
        _, _, _, update_where = _db()
    except ImportError:
        return
    now_iso = datetime.now(tz=timezone.utc).isoformat()
    try:
        update_where(
            "trend_interests",
            {"last_fetched_at": now_iso, "keyword_count": keyword_count},
            {"interest_slug": interest_slug, "country": country},
        )
    except Exception:
        pass


# 鈹€鈹€ Main discovery orchestrator 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async def discover_trends_for_interest(
    interest_slug: str,
    category:      str,
    region:        str = "US",
    top_n:         int = TOP_N_DEFAULT,
    proxy:         Optional[str] = None,
    session:       Optional["TrendSession"] = None,
    min_yoy:       float = MIN_YOY_GROWTH,
    min_vol:       int   = MIN_VOLUME_SCORE,
    min_wow:       float = MIN_WEEKLY_CHANGE,
) -> List[dict]:
    """
    Full 3-layer trend discovery for one Pinterest interest slug.
    Returns filtered + ranked list of keyword dicts.

    If session is provided it is reused (for batched multi-interest runs).
    """
    raw_keywords: List[dict] = []

    async def _run(sess: "TrendSession") -> None:
        nonlocal raw_keywords
        from pinterest_trends_v5_provider import (  # noqa: E402
            ENABLE_OFFICIAL_V5,
            fetch_v5_for_interest,
            v5_auth_present,
        )

        if ENABLE_OFFICIAL_V5:
            v5_res = await fetch_v5_for_interest(interest_slug, region=region)
            if v5_res.keywords:
                raw_keywords.extend(v5_res.keywords)
                PROVIDER_RUN_SUMMARY["official_v5_count"] += len(v5_res.keywords)
                PROVIDER_RUN_SUMMARY["primary_provider"] = "official_v5"
                print(f"  [official_v5] {interest_slug} -> {len(v5_res.keywords)} keywords")
            elif v5_auth_present():
                PROVIDER_RUN_SUMMARY["v5_status"] = {
                    "status": v5_res.provider_status,
                    "http_status": v5_res.http_status,
                    "error": v5_res.error,
                    "body_sample": v5_res.body_sample,
                }
                if v5_res.provider_status == "unavailable_auth_or_access":
                    PROVIDER_RUN_SUMMARY["blocker"] = True
                    PROVIDER_RUN_SUMMARY["blocker_reason"] = (
                        v5_res.error or "official_v5 Trends API access denied"
                    )
                    print(f"[trends] official_v5 blocked for {interest_slug}: {v5_res.error}")
                    return

        if raw_keywords:
            return

        if not ENABLE_EXPERIMENTAL_FALLBACK:
            print(f"[trends] No v5 data and experimental fallback disabled for {interest_slug}")
            return

        if ENABLE_PINTEREST_TRENDS_L1:
            kws = await layer1_trends_api(sess, interest_slug, region)
            if kws:
                raw_keywords.extend(kws)
                PROVIDER_RUN_SUMMARY["l1_count"] += len(kws)
                if not PROVIDER_RUN_SUMMARY["primary_provider"]:
                    PROVIDER_RUN_SUMMARY["primary_provider"] = "internal_l1"
        else:
            if hasattr(sess, "stats"):
                sess.stats["l1_disabled"] += 1
            print(f"[trends] L1 disabled for {interest_slug}")

        if not raw_keywords and ENABLE_PINTEREST_RESOURCE_L2:
            print(f"[trends] L1 empty for {interest_slug} — trying L2 (experimental)...")
            kws = await layer2_internal_resource(sess, interest_slug, region)
            if kws:
                raw_keywords.extend(kws)
                PROVIDER_RUN_SUMMARY["l2_count"] += len(kws)
                if not PROVIDER_RUN_SUMMARY["primary_provider"]:
                    PROVIDER_RUN_SUMMARY["primary_provider"] = "internal_l2"
        elif not raw_keywords and not ENABLE_PINTEREST_RESOURCE_L2:
            if hasattr(sess, "stats"):
                sess.stats["l2_disabled"] += 1
            print(f"[trends] L2 disabled for {interest_slug}")

        if not raw_keywords and ENABLE_TYPEAHEAD_L3:
            print(f"[trends] L2 empty for {interest_slug} — falling back to L3 (weak)...")
            l3_kws = await layer3_typeahead_scoring(sess, category, region, interest_slug)
            raw_keywords.extend(l3_kws)
            if l3_kws:
                PROVIDER_RUN_SUMMARY["l3_count"] += len(l3_kws)
                if not PROVIDER_RUN_SUMMARY["primary_provider"]:
                    PROVIDER_RUN_SUMMARY["primary_provider"] = "l3_typeahead"
        elif not raw_keywords:
            if hasattr(sess, "stats") and not ENABLE_TYPEAHEAD_L3:
                sess.stats["l3_disabled"] += 1
            print(f"[trends] All layers disabled/empty for {interest_slug}")

    if session is not None:
        await _run(session)
    else:
        async with TrendSession(proxy=proxy) as sess:
            await _run(sess)

    # Dedup by keyword string
    seen: set = set()
    unique: List[dict] = []
    for kw in raw_keywords:
        k = kw["keyword"].lower().strip()
        if k and k not in seen:
            seen.add(k)
            unique.append(kw)

    from trend_seed_pipeline import process_trend_seeds, SEED_LAST_STATS  # noqa: E402

    seed_result = process_trend_seeds(
        unique,
        category=category,
        interest_slug=interest_slug,
        top_n=top_n,
        min_yoy=min_yoy,
        min_wow=min_wow,
        min_vol=min_vol,
    )
    filtered = seed_result.seeds
    if seed_result.stats.get("excluded"):
        print(
            f"[trends] seed pipeline excluded={seed_result.stats['excluded']} "
            f"(negative={seed_result.stats.get('negative_filtered', 0)} "
            f"commercial={seed_result.stats.get('commercial_filtered', 0)}) "
            f"watchlist={seed_result.stats.get('watchlist', 0)} "
            f"clusters={seed_result.stats.get('clusters', 0)}"
        )
    by_layer: dict[str, int] = {"official_v5": 0, "L1": 0, "L2": 0, "L3": 0}
    for kw in unique:
        layer_key = source_layer(kw.get("trend_source", "typeahead_estimate"))
        bucket = layer_key if layer_key in by_layer else "L3"
        by_layer[bucket] += 1
    print(
        f"[trends] {interest_slug}: {len(unique)} raw "
        f"(v5={by_layer['official_v5']} L1={by_layer['L1']} L2={by_layer['L2']} L3={by_layer['L3']}) "
        f"-> {len(filtered)} after filters"
    )
    return filtered


# 鈹€鈹€ Load interests from DB (or fallback to official list) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

def load_interests(country: str = "US") -> List[dict]:
    """
    Load active interests from trend_interests table.
    Falls back to interest_discovery._official_seed_as_dicts() if DB unavailable.
    Returns list of dicts with at least: interest_slug, interest_name.
    """
    try:
        from interest_discovery import load_interests_from_db  # type: ignore
        rows = load_interests_from_db(country=country, active_only=True)
        if rows:
            return rows
    except Exception as exc:
        print(f"[trends] load_interests error: {exc}")

    # Pure fallback 鈥?import official list directly
    try:
        from interest_discovery import _official_seed_as_dicts  # type: ignore
        return _official_seed_as_dicts()
    except Exception:
        pass

    return []


# 鈹€鈹€ CLI 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async def main() -> None:
    ap = argparse.ArgumentParser(
        description="Autonomous Pinterest trend keyword discovery 鈥?interest-driven"
    )
    ap.add_argument("--interest",  default=None, action="append",
                    help="Interest slug to fetch (e.g. home_decor). Repeat for multiple. "
                         "Omit to run all active interests from DB.")
    ap.add_argument("--region",    default="US",
                    help="Country code e.g. US, GB, AU")
    ap.add_argument("--top",       type=int, default=TOP_N_DEFAULT,
                    help="Max keywords to return per interest")
    ap.add_argument("--proxy",     default=None,
                    help="Proxy URL e.g. http://user:pass@host:port")
    ap.add_argument("--db",        action="store_true",
                    help="Upsert keywords to trend_keywords + crawl_queue tables")
    ap.add_argument("--min-yoy",   type=float, default=None,
                    help="Min YoY growth %% (overrides --mode default)")
    ap.add_argument("--min-wow",   type=float, default=MIN_WEEKLY_CHANGE,
                    help=f"Min weekly change %% (default {MIN_WEEKLY_CHANGE})")
    ap.add_argument("--mode",      default="growth", choices=["growth", "volume"],
                    help="growth (default): YoY鈮?00%% filter for fast-rising keywords. "
                         "volume: no YoY filter, min volume=high 鈥?fetch top keywords "
                         "by search volume regardless of growth rate.")
    ap.add_argument("--enrich",    action="store_true",
                    help="After discovery, call per-keyword time_series endpoint to "
                         "populate trend_history (needed by classify_trends.py).")
    ap.add_argument("--probe",     default=None, metavar="KEYWORD",
                    help="Probe the time_series endpoints for a single keyword and "
                         "print what each returns.  Useful to verify the API works.")
    args = ap.parse_args()

    try:
        from interest_discovery import slug_to_category  # type: ignore
    except ImportError:
        def slug_to_category(slug: str) -> str:
            return slug

    # 鈹€鈹€ --probe mode: test time_series endpoints for a single keyword 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    if args.probe:
        print(f"\n[probe] Testing time_series endpoints for keyword: {args.probe!r}")
        candidates = [
            (
                "https://trends.pinterest.com/api/v3/trends/keywords/time_series/",
                {"country_code": args.region, "locale": "en-US",
                 "keywords[]": args.probe},
            ),
            (
                "https://trends.pinterest.com/api/v3/trends/keywords/suggested/",
                {"country_code": args.region, "locale": "en-US",
                 "query": args.probe, "limit": 1},
            ),
            (
                "https://trends.pinterest.com/api/v3/trends/keyword_search/",
                {"country_code": args.region, "locale": "en-US",
                 "keyword": args.probe, "limit": 1},
            ),
        ]
        async with TrendSession(proxy=args.proxy) as sess:
            for url, params in candidates:
                print(f"\n  鈫?{url.split('/api/')[1]}  params={params}")
                data = await sess.get(url, params=params,
                                      referer="https://trends.pinterest.com/",
                                      delay=0.8)
                ts = _extract_time_series_from_response(data, args.probe)
                if ts:
                    print(f"    鉁?time_series found  n={len(ts)}  "
                          f"sample={ts[:6]}...")
                else:
                    top_keys = list(data.keys())[:6] if isinstance(data, dict) else "[]"
                    print(f"    鉁?no time_series  top-level keys: {top_keys}")
        print("\n[probe] done 鈥?run with --enrich to populate trend_history")
        return

    # Build interest list
    if args.interest:
        interests = [{"interest_slug": s, "interest_name": s} for s in args.interest]
    else:
        interests = load_interests(args.region)
        if not interests:
            print("[trends] No interests found. Run: py interest_discovery.py")
            return

    # Resolve effective filter thresholds (mode takes precedence, then explicit --min-yoy)
    if args.mode == "volume":
        eff_min_yoy = args.min_yoy if args.min_yoy is not None else 0.0
        eff_min_vol = 2   # require medium+ for real data; typeahead estimates use max(1, vol-1)=1
    else:
        eff_min_yoy = args.min_yoy if args.min_yoy is not None else MIN_YOY_GROWTH
        eff_min_vol = MIN_VOLUME_SCORE

    mode_label = f"mode={args.mode}  min_yoy={eff_min_yoy}%  min_vol={eff_min_vol}  min_wow={args.min_wow}%"
    print(f"\n[trends] Processing {len(interests)} interest(s) for region={args.region}  {mode_label}")

    async with TrendSession(proxy=args.proxy) as session:
        for rec in interests:
            slug     = rec["interest_slug"]
            category = slug_to_category(slug)

            print(f"\n{'='*60}")
            print(f"  Interest: {slug}  鈫? category: {category}")
            print(f"{'='*60}")

            keywords = await discover_trends_for_interest(
                interest_slug=slug,
                category=category,
                region=args.region,
                top_n=args.top,
                proxy=args.proxy,
                session=session,
                min_yoy=eff_min_yoy,
                min_vol=eff_min_vol,
                min_wow=args.min_wow,
            )

            # 鈹€鈹€ Optional: enrich with per-keyword time_series 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
            if args.enrich and keywords:
                keywords = await enrich_with_time_series(session, keywords, args.region)

            # Print results table
            ts_col = "ts?" if args.enrich else ""
            print(f"\n  {'#':<3}  {'keyword':<38}  {'vol':>8}  {'yoy%':>7}  {'wow%':>6}  {ts_col}")
            print(f"  {'-'*3}  {'-'*38}  {'-'*8}  {'-'*7}  {'-'*6}  {'-'*4}")
            for i, kw in enumerate(keywords, 1):
                vol = kw.get("search_volume_level", "?")
                yoy = kw.get("pct_growth_yoy", 0)
                wow = kw.get("pct_growth_wow", 0)
                ts_flag = f"n={len(kw.get('time_series') or [])}" if args.enrich else ""
                print(f"  {i:<3}  {kw['keyword']:<38}  {vol:>8}  "
                      f"{yoy:>6.0f}%  {wow:>5.0f}%  {ts_flag}")

            if args.db and keywords:
                kw_written = upsert_trend_keywords(keywords, category, slug)
                q_written  = upsert_crawl_queue(keywords, slug, category)
                update_interest_fetched(slug, args.region, len(keywords))
                ts_written = sum(1 for kw in keywords if kw.get("time_series"))
                print(f"\n  [db] {kw_written} trend_keywords  |  "
                      f"{q_written} new crawl_queue entries"
                      + (f"  |  {ts_written} with trend_history" if args.enrich else ""))

            await asyncio.sleep(random.uniform(0.5, 1.2))

    print("\n[trends] done.")


if __name__ == "__main__":
    asyncio.run(main())
