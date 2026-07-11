"""
scraper_v2.py — Pinterest direct API scraper (no browser)

Calls Pinterest's internal JSON endpoints directly via curl_cffi.
Keywords come exclusively from the crawl_queue table, which is populated
by trend_fetcher.py from Pinterest Trends data. No hardcoded seed keywords.

Data flow (single source of truth):
  Pinterest Trends → trend_keywords → crawl_queue → pin_samples → pin_products

Primary entry point: process_queue_item() — called by pipeline.py
This CLI is for ad-hoc testing only. Production runs: py pipeline.py

Usage:
  py scraper_v2.py --test                          # smoke-test (25 pins)
  py scraper_v2.py --keyword "japandi bedroom"     # single keyword, ad-hoc
  py scraper_v2.py --keyword "..." --no-db         # JSONL only, no DB write
  py pipeline.py --step crawl                      # production queue processing
"""

import argparse, asyncio, json, os, random, sys, time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import urlparse, urlunparse, urlencode, quote

import httpx
from curl_cffi.requests import AsyncSession as CurlSession

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT     = Path(__file__).parent
LIB_ROOT = ROOT / "vibe_library"

# ── Domain sets (kept in sync with scraper.py) ──────────────────────────────
SOCIAL_DOMAINS: Set[str] = {
    "pinterest.com", "instagram.com", "facebook.com", "tiktok.com",
    "twitter.com", "x.com", "youtube.com", "reddit.com", "tumblr.com",
    "snapchat.com", "linkedin.com", "whatsapp.com", "threads.net",
}
ECOMMERCE_DOMAINS: Set[str] = {
    "etsy.com", "amazon.com", "amazon.co.uk", "shopify.com", "ebay.com",
    "wayfair.com", "target.com", "walmart.com", "homedepot.com",
    "westelm.com", "cb2.com", "crateandbarrel.com",
}

# ── Universal style vocabulary (keyword-derived, no hardcoded category seeds) ─
# Keywords come exclusively from Pinterest Trends → crawl_queue.
_STYLE_TAGS: List[str] = [
    "minimalist", "boho", "bohemian", "farmhouse", "vintage", "modern", "cozy",
    "neutral", "aesthetic", "scandinavian", "japandi", "coastal", "preppy",
    "y2k", "cottagecore", "dark academia", "old money", "coquette", "eclectic",
    "casual", "chic", "streetwear", "formal", "glam", "natural", "clean",
    "dewy", "editorial", "soft", "bold", "maximalist", "transitional",
]

_PRODUCT_TERMS: List[str] = [
    "pillow", "rug", "candle", "wall art", "vase", "lighting", "shelf",
    "plant", "clothing", "outfit", "dress", "shoes", "bag", "jewelry",
    "skincare", "makeup", "nail", "hair", "perfume", "fragrance",
    "furniture", "mirror", "art print", "throw", "blanket", "planter",
    "lamp", "curtain", "bedding", "cushion", "basket",
]

from content_filters import evaluate_pin_content, get_filter_stats, reset_filter_stats  # noqa: E402

IMAGE_SIZE_PRIORITY = ["orig", "originals", "736x", "564x", "474x", "236x"]

# ── Pin signal tiers ─────────────────────────────────────────────────────────
# Each tier is a strict subset of the next. Used in scrapers, stats, and APIs.
PIN_CANDIDATE_SAVES  = 500       # Candidate Pin: minimum bar to enter the dataset
PIN_VIRAL_SAVES      = 5_000     # Viral Pin: STL-eligible, top-of-funnel intelligence
PIN_PREMIUM_SAVES    = 10_000    # Premium Pin: highest signal, drives scoring confidence

# ── Intelligence filter thresholds ───────────────────────────────────────────
# Goal: high-signal trend intelligence, not a Pinterest archive.
FRESHNESS_DAYS       = 90        # reject pins older than 90 days (trend recency)
MIN_SAVE_COUNT       = PIN_CANDIDATE_SAVES   # alias — keeps tiers in sync
STL_TRIGGER_SAVES    = PIN_VIRAL_SAVES       # alias — keeps tiers in sync

# Category-aware overrides. Digital products are EVERGREEN (a printable/template
# pinned years ago is still valid — trend-recency does not apply) and carry lower
# absolute save counts than viral lifestyle pins. Diagnostic proved the default
# 90-day / 500-save gate rejected ~99% of valid digital/template pins (64% stale,
# 36% low_saves; only 2/677 rejects were actual junk). These overrides apply ONLY
# to digital-products; every other category keeps FRESHNESS_DAYS / MIN_SAVE_COUNT.
DIGITAL_CATEGORIES       = frozenset({"digital-products"})
DIGITAL_MIN_SAVE_COUNT   = 100   # admit real low-save templates; still filters 0-save noise
DIGITAL_SKIP_FRESHNESS   = True  # evergreen → no freshness reject
VELOCITY_HIGH_GROWTH = 100.0     # saves/day → is_high_growth flag

# Trend stage thresholds (saves/day)
STAGE_EMERGING = 300.0
STAGE_GROWING  = 150.0
STAGE_VIRAL    = 50.0

# ── Development-only seed keywords ───────────────────────────────────────────
# ONLY used when --dev-seeds CLI flag is explicitly passed.
# Production pipeline reads exclusively from crawl_queue (Pinterest Trends source).
# Records from dev seeds carry source_type="dev_seed" and are EXCLUDED from
# opportunity scoring in calculate_product_scores.py.
_DEV_SEEDS: Dict[str, List[str]] = {
    "home":    ["minimalist home decor", "cozy bedroom aesthetic", "japandi living room"],
    "fashion": ["old money aesthetic outfit", "quiet luxury fashion", "coquette style"],
    "beauty":  ["clean girl makeup", "glazed donut nails", "soft glam look"],
    "food":    ["aesthetic coffee drinks", "viral food recipes", "cottage bakery aesthetic"],
    "travel":  ["dark academia travel aesthetic", "coastal grandmother vacation"],
}


# ── Data extraction helpers (same logic as scraper.py) ──────────────────────

def _nested_get(obj: Any, path: str) -> Any:
    for key in path.split("."):
        if isinstance(obj, dict):
            obj = obj.get(key)
        elif isinstance(obj, list) and key.isdigit():
            i = int(key)
            obj = obj[i] if i < len(obj) else None
        else:
            return None
        if obj is None:
            return None
    return obj

def _to_int(val: Any, default: int = 0) -> int:
    try:
        return int(val)
    except (TypeError, ValueError):
        return default

def _first(*vals: Any) -> Any:
    return next((v for v in vals if v is not None), None)

def get_domain(url: str) -> str:
    if not url:
        return ""
    try:
        return urlparse(url).netloc.lower().removeprefix("www.")
    except Exception:
        return ""

def normalize_url(url: str) -> str:
    if not url:
        return ""
    try:
        p = urlparse(url)
        return urlunparse((p.scheme, p.netloc, p.path, "", "", "")).rstrip("/")
    except Exception:
        return url

def is_social(url: str) -> bool:
    d = get_domain(url)
    return any(d == s or d.endswith("." + s) for s in SOCIAL_DOMAINS) if d else False

def is_ecommerce_url(url: str) -> bool:
    if not url:
        return False
    d = get_domain(url)
    if "myshopify.com" in d:
        return True
    return any(d == s or d.endswith("." + s) for s in ECOMMERCE_DOMAINS) if d else False

def extract_image_url(obj: dict) -> Optional[str]:
    for path in ("images.orig.url", "images.originals.url", "images.736x.url",
                 "images.564x.url", "media.images.orig.url", "image_url"):
        url = _nested_get(obj, path)
        if url and isinstance(url, str) and url.startswith("http"):
            return url
    images = obj.get("images")
    if isinstance(images, dict):
        for size in IMAGE_SIZE_PRIORITY:
            img = images.get(size)
            if isinstance(img, dict):
                url = img.get("url")
                if url and isinstance(url, str) and url.startswith("http"):
                    return url
    return None

def extract_image_ratio(obj: dict) -> Optional[float]:
    for size in ("orig", "originals", "736x", "564x"):
        images = obj.get("images") or {}
        if isinstance(images, dict):
            img = images.get(size) or {}
            if isinstance(img, dict):
                w, h = img.get("width"), img.get("height")
                try:
                    if w and h and int(h) > 0:
                        return round(int(w) / int(h), 3)
                except (TypeError, ValueError):
                    pass
    return None

def extract_image_dims(obj: dict) -> tuple[Optional[int], Optional[int]]:
    """Return (width, height) pixels from the best available image size.
    Iterates IMAGE_SIZE_PRIORITY — same order as extract_image_url — so the
    dimensions always correspond to the same variant as the stored image_url."""
    images = obj.get("images") or {}
    if not isinstance(images, dict):
        return None, None
    for size in IMAGE_SIZE_PRIORITY:
        img = images.get(size)
        if isinstance(img, dict):
            try:
                w = int(img["width"])
                h = int(img["height"])
                if w > 0 and h > 0:
                    return w, h
            except (KeyError, TypeError, ValueError):
                pass
    return None, None

def extract_outbound_link(obj: dict) -> Optional[str]:
    def _ok(url: Any) -> bool:
        return (isinstance(url, str) and url.startswith("http")
                and "pinterest.com" not in url)
    for key in ("link", "outbound_link", "product_url"):
        if _ok(obj.get(key)):
            return obj[key]
    url = _nested_get(obj, "rich_metadata.url")
    if _ok(url):
        return url
    domain = obj.get("domain")
    if isinstance(domain, str) and "." in domain:
        excluded = ("pinterest", "instagram", "facebook", "tiktok", "twitter", "youtube")
        if not any(x in domain for x in excluded):
            return f"https://{domain}"
    return None

def extract_save_count(obj: dict) -> int:
    for val in (obj.get("save_count"), obj.get("saves"), obj.get("repin_count"),
                _nested_get(obj, "aggregated_pin_data.aggregated_stats.saves")):
        if val is not None:
            return _to_int(val)
    return 0

def extract_reaction_count(obj: dict) -> int:
    for val in (obj.get("reaction_counts"), obj.get("reaction_count"),
                obj.get("total_reaction_count"),
                _nested_get(obj, "aggregated_pin_data.aggregated_stats.reactions")):
        if val is None:
            continue
        if isinstance(val, dict):
            return sum(_to_int(v) for v in val.values())
        return _to_int(val)
    return 0

def extract_created_at(obj: dict) -> Optional[str]:
    for key in ("created_at", "createdAt", "created_time", "timestamp"):
        val = obj.get(key)
        if not val:
            continue
        try:
            if isinstance(val, (int, float)) and val > 0:
                return datetime.fromtimestamp(float(val), tz=timezone.utc).isoformat()
            if isinstance(val, str):
                try:
                    return parsedate_to_datetime(val).isoformat()
                except Exception:
                    pass
                return datetime.fromisoformat(val.replace("Z", "+00:00")).isoformat()
        except Exception:
            pass
    return None

def _looks_like_pin(obj: Any) -> bool:
    if not isinstance(obj, dict):
        return False
    if not (obj.get("id") or obj.get("pin_id")):
        return False
    signals = {"images", "save_count", "repin_count", "saves", "grid_title",
               "closeup_description", "domain", "outbound_link", "rich_metadata"}
    return bool(signals & obj.keys())

def find_pins(data: Any, depth: int = 0) -> List[dict]:
    if depth > 10:
        return []
    results: List[dict] = []
    if isinstance(data, dict):
        if _looks_like_pin(data):
            results.append(data)
        else:
            for v in data.values():
                if isinstance(v, (dict, list)):
                    results.extend(find_pins(v, depth + 1))
    elif isinstance(data, list):
        for item in data:
            results.extend(find_pins(item, depth + 1))
    return results


def compute_viral_metrics(rec: dict, now: datetime) -> dict:
    """
    Compute save_velocity, intent_ratio, is_high_growth, days_since_creation,
    age_days, and trend_stage. Mutates rec in-place and returns it.
    """
    save_count     = int(rec.get("save_count") or 0)
    reaction_count = int(rec.get("reaction_count") or 0)
    created_at_str = rec.get("pin_created_at") or rec.get("created_at_source")

    days_since: Optional[int] = None
    if created_at_str:
        try:
            created_dt = datetime.fromisoformat(str(created_at_str).replace("Z", "+00:00"))
            if created_dt.tzinfo is None:
                created_dt = created_dt.replace(tzinfo=timezone.utc)
            days_since = max(1, (now - created_dt).days)
        except Exception:
            pass

    age_days      = days_since if days_since is not None else None
    save_velocity = round(save_count / days_since, 2) if days_since else None
    intent_ratio  = round(save_count / reaction_count, 1) if reaction_count > 0 else None
    is_high_growth = bool(save_velocity and save_velocity >= VELOCITY_HIGH_GROWTH)

    if save_velocity is not None:
        if save_velocity >= STAGE_EMERGING:
            trend_stage = "emerging"
        elif save_velocity >= STAGE_GROWING:
            trend_stage = "growing"
        elif save_velocity >= STAGE_VIRAL:
            trend_stage = "viral"
        else:
            trend_stage = "stable"
    else:
        trend_stage = None

    rec["days_since_creation"] = days_since
    rec["age_days"]            = age_days
    rec["save_velocity"]       = save_velocity
    rec["intent_ratio"]        = intent_ratio
    rec["is_high_growth"]      = is_high_growth
    rec["trend_stage"]         = trend_stage
    return rec


def passes_premium_filter(rec: dict) -> Tuple[bool, str]:
    """
    Returns (True, '') when pin passes freshness + volume filters.
    Returns (False, reason) otherwise — caller sets rec['reject_reason'].
    """
    is_digital = (rec.get("category") or "").strip().lower() in DIGITAL_CATEGORIES
    days = rec.get("days_since_creation")
    # Evergreen digital products are not trend-recency sensitive → skip freshness gate.
    skip_freshness = is_digital and DIGITAL_SKIP_FRESHNESS
    if not skip_freshness and days is not None and days > FRESHNESS_DAYS:
        return False, f"stale:{days}d"
    save_count = int(rec.get("save_count") or 0)
    min_saves = DIGITAL_MIN_SAVE_COUNT if is_digital else MIN_SAVE_COUNT
    if save_count < min_saves:
        return False, f"low_saves:{save_count}"
    decision = evaluate_pin_content(
        title=rec.get("title"),
        description=rec.get("description"),
        keyword=rec.get("seed_keyword") or rec.get("source_keyword"),
        category=rec.get("category"),
    )
    if decision.reject:
        return False, decision.reason or "negative_term"
    return True, ""


def analyze_pin_style(title: str, keyword: str, category: str) -> dict:
    text = f"{keyword} {title}".lower()
    style_tags = [s for s in _STYLE_TAGS if s in text] or ["aesthetic"]
    if any(w in text for w in ("room", "decor", "interior", "home", "kitchen", "bedroom")):
        layout = "interior_scene"
    elif any(w in text for w in ("outfit", "look", "ootd")):
        layout = "outfit_flatlay"
    elif any(w in text for w in ("nails", "nail", "pedicure")):
        layout = "nail_closeup"
    elif any(w in text for w in ("collage", "ideas", "collection", "inspo")):
        layout = "collage"
    else:
        layout = "single_image"
    best_for = [p for p in _PRODUCT_TERMS if any(w in text for w in p.split())] or [keyword.split()[0]]
    color_hints = ["neutral", "white", "black", "beige", "cream", "pink",
                   "sage", "green", "blue", "brown", "gold", "warm"]
    dominant_colors = [c for c in color_hints if c in text][:3] or ["neutral"]
    extra_style = ", ".join(style_tags[:2])
    prompt_seed = f"{extra_style}, {keyword}, Pinterest-worthy aesthetic"
    return {
        "style_tags":        style_tags,
        "layout_type":       layout,
        "dominant_colors":   dominant_colors,
        "best_for_products": best_for[:4],
        "prompt_seed":       prompt_seed,
    }


# ── Pinterest API session ────────────────────────────────────────────────────

BASE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/147.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-US",
    "Accept-Encoding": "gzip, deflate, br",
    "Sec-Ch-Ua": '"Chromium";v="147", "Not.A/Brand";v="8", "Google Chrome";v="147"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Ch-Ua-Platform-Version": '"19.0.0"',
    "Sec-Ch-Ua-Model": '""',
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "X-Requested-With": "XMLHttpRequest",
    "X-Pinterest-AppState": "active",
    "Screen-Dpr": "1",
}


def _resolve_http_timeout() -> float:
    """Total per-request timeout (seconds) for EVERY Pinterest curl_cffi call.

    Env: PINTEREST_HTTP_TIMEOUT_SECONDS (default 30). Clamped to [5, 120] so a
    misconfigured value can never re-introduce an effectively-infinite wait. Every
    request in this module must carry a timeout so a stalled proxy / Pinterest
    response fails fast (raises) instead of blocking the asyncio event loop forever.
    """
    raw = os.environ.get("PINTEREST_HTTP_TIMEOUT_SECONDS", "30")
    try:
        val = float(raw)
    except (TypeError, ValueError):
        val = 30.0
    return max(5.0, min(val, 120.0))


class PinterestSession:
    """
    HTTP session that impersonates Chrome146 TLS fingerprint via curl_cffi.
    This bypasses Pinterest's JA3/JA4 TLS bot-detection that blocks plain httpx.

    SSL resilience: if the libcurl SSL context becomes corrupted (observed on
    Windows after certain network failures), _rebuild_session() tears down the
    old CurlSession and creates a fresh one, then re-bootstraps cookies/csrf.
    """

    def __init__(self, proxy: Optional[str] = None, delay: float = 1.2):
        self._proxy = proxy
        self._delay = delay
        self._timeout = _resolve_http_timeout()   # total per-request timeout (seconds)
        self._session: Optional[CurlSession] = None
        self._csrf: str = ""
        self._app_version: str = ""
        self._last_req: float = 0.0
        self._ssl_rebuilds: int = 0          # count rebuilds to avoid infinite loops

    def _make_session(self) -> CurlSession:
        # Session-level default timeout is the GUARANTEED chokepoint: every request
        # issued from this session inherits it even if a call site forgets to pass
        # one. Explicit per-request timeouts below are belt-and-suspenders.
        kwargs: dict = {"impersonate": "chrome146", "headers": BASE_HEADERS, "timeout": self._timeout}
        if self._proxy:
            kwargs["proxies"] = {"https": self._proxy, "http": self._proxy}
        return CurlSession(**kwargs)

    async def __aenter__(self) -> "PinterestSession":
        self._session = self._make_session()
        await self._bootstrap()
        return self

    async def __aexit__(self, *_) -> None:
        if self._session:
            await self._session.close()

    async def _rebuild_session(self) -> None:
        """Close the broken CurlSession and open a fresh one with new cookies/csrf."""
        self._ssl_rebuilds += 1
        print(f"  [session] SSL error — rebuilding session (attempt #{self._ssl_rebuilds})")
        try:
            if self._session:
                await self._session.close()
        except Exception:
            pass
        await asyncio.sleep(2.0)
        self._session = self._make_session()
        await self._bootstrap()

    async def _bootstrap(self) -> None:
        """Visit pinterest.com homepage to acquire session cookies, csrftoken, and app version."""
        import re
        try:
            r = await self._session.get(
                "https://www.pinterest.com/",
                headers={"Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                         "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"},
                timeout=self._timeout,
            )
        except Exception as exc:
            # Includes timeouts: a stalled proxy/Pinterest now RAISES within
            # self._timeout instead of hanging forever. No secrets logged.
            print(f"  [session] bootstrap GET failed (timeout={self._timeout}s, "
                  f"proxy={'on' if self._proxy else 'off'}): {exc}")
            # Return with empty state; _get_json will handle SSL retry on next call
            return
        self._csrf = self._session.cookies.get("csrftoken", "")

        # Extract app version from __PWS_DATA__ script tag
        m = re.search(r'<script[^>]+id=["\']__PWS_DATA__["\'][^>]*>(.*?)</script>', r.text, re.DOTALL)
        app_version = ""
        if m:
            try:
                pws = json.loads(m.group(1))
                app_version = pws.get("appVersion", "")
            except Exception:
                pass

        self._app_version = app_version

        print(f"[session] bootstrap  status={r.status_code}  "
              f"csrf={'ok' if self._csrf else 'missing'}  "
              f"app_version={app_version or 'n/a'}")
        await asyncio.sleep(random.uniform(0.8, 1.5))

    @staticmethod
    def _b3_headers() -> dict:
        """Generate random Zipkin B3 distributed tracing headers (Pinterest requires these)."""
        import secrets
        trace_id = secrets.token_hex(8)
        span_id  = secrets.token_hex(8)
        return {
            "X-B3-TraceId":      trace_id,
            "X-B3-SpanId":       span_id,
            "X-B3-ParentSpanId": trace_id,
            "X-B3-Flags":        "0",
        }

    async def _get_json(
        self,
        url: str,
        referer: str = "https://www.pinterest.com/",
        source_url: str = "",
        pws_handler: str = "",
    ) -> dict:
        """Rate-limited GET returning parsed JSON."""
        elapsed = time.monotonic() - self._last_req
        if elapsed < self._delay:
            await asyncio.sleep(self._delay - elapsed)
        self._last_req = time.monotonic()

        extra = {
            "Referer": referer,
            **self._b3_headers(),
        }
        if self._csrf:
            extra["X-CSRFToken"] = self._csrf
        if self._app_version:
            extra["X-App-Version"] = self._app_version
        if source_url:
            extra["X-Pinterest-Source-Url"] = source_url
        if pws_handler:
            extra["X-Pinterest-Pws-Handler"] = pws_handler
        for attempt in range(2):
            try:
                r = await self._session.get(url, headers=extra, timeout=self._timeout)
                if r.status_code != 200:
                    print(f"  [warn] HTTP {r.status_code} — {r.text[:120]}")
                    return {}
                return r.json()
            except Exception as e:
                err = str(e).lower()
                # SSL corruption: rebuild session and retry once
                is_ssl = any(kw in err for kw in ("ssl", "tls", "certificate", "handshake", "curl: (35)", "curl: (60)"))
                if is_ssl and attempt == 0 and self._ssl_rebuilds < 3:
                    await self._rebuild_session()
                    # Rebuild extra headers with fresh csrf/app_version
                    if self._csrf:        extra["X-CSRFToken"]   = self._csrf
                    if self._app_version: extra["X-App-Version"] = self._app_version
                    continue
                print(f"  [warn] GET failed: {e}")
                return {}
        return {}

    # ── Search via HTML + embedded JSON ──────────────────────────────────────

    async def search_pins(
        self,
        query: str,
        max_pins: int = 100,
    ) -> List[dict]:
        """
        Fetch the Pinterest search HTML page and extract embedded pin data
        from the <script> tags that contain Pinterest's initial state JSON.
        Falls back to the SearchResource JSON API on first page (which often
        works after visiting the HTML page because cookies are now set).
        """
        pins: List[dict] = []
        seen_ids: Set[str] = set()
        search_url = f"https://www.pinterest.com/search/pins/?q={quote(query)}&rs=typed"

        # --- Step 1: Fetch the HTML search page (sets cookies + app-state) ---
        elapsed = time.monotonic() - self._last_req
        if elapsed < self._delay:
            await asyncio.sleep(self._delay - elapsed)
        self._last_req = time.monotonic()

        r = await self._session.get(
            search_url,
            headers={"Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                     "Referer": "https://www.pinterest.com/"},
            timeout=self._timeout,
        )
        print(f"  [html] search page status={r.status_code}")
        if r.status_code == 200:
            html_pins = self._extract_pins_from_html(r.text)
            for p in html_pins:
                pid = str(p.get("id") or p.get("pin_id") or "")
                if pid and pid not in seen_ids:
                    seen_ids.add(pid)
                    pins.append(p)
            print(f"  [html] extracted {len(pins)} pins from HTML")

        # --- Step 2: Get pin IDs from BaseSearchResource, then fetch full details ---
        bookmarks: List[str] = []
        page = 0
        source_url_param = f"/search/pins/?q={query.replace(' ', '+')}&rs=typed"

        while len(pins) < max_pins:
            options: Dict[str, Any] = {
                "query":     query,
                "scope":     "pins",
                "page_size": 25,
                "no_fetch_context_on_resource": False,
            }
            if bookmarks:
                options["bookmarks"] = bookmarks

            data_json = json.dumps({"options": options, "context": {}}, separators=(',', ':'))
            params = {
                "source_url": source_url_param,
                "data":       data_json,
                "_":          str(int(time.time() * 1000)),
            }
            api_url = ("https://www.pinterest.com/resource/BaseSearchResource/get/?"
                       + urlencode(params))
            data = await self._get_json(
                api_url,
                referer=search_url,
                source_url=source_url_param,
                pws_handler="www/search/[scope].js",
            )

            resource      = data.get("resource_response", {})
            resp_data     = resource.get("data") or {}
            results       = resp_data.get("results") if isinstance(resp_data, dict) else (resp_data or [])
            # BaseSearchResource puts the cursor at resource_response.bookmark (singular)
            next_bookmark = resource.get("bookmark") or ""
            new_bookmarks = [next_bookmark] if next_bookmark else []

            # Extract pin IDs from story → objects
            batch_ids: List[str] = []
            # Recursively extract all numeric pin IDs from the results structure
            def collect_pin_ids(obj: Any, depth: int = 0) -> List[str]:
                if depth > 8 or not isinstance(obj, (dict, list)):
                    return []
                if isinstance(obj, list):
                    ids: List[str] = []
                    for item in obj:
                        ids.extend(collect_pin_ids(item, depth + 1))
                    return ids
                ids = []
                # A pin object typically has a long numeric ID and images/domain fields
                obj_type = obj.get("type", "")
                raw_id   = obj.get("id") or obj.get("pin_id") or ""
                if (obj_type == "pin" or (obj_type == "" and raw_id)):
                    pid = str(raw_id)
                    # Pinterest pin IDs are numeric and >10 digits
                    if pid.isdigit() and len(pid) > 10:
                        ids.append(pid)
                        return ids  # don't recurse into pin objects
                for v in obj.values():
                    if isinstance(v, (dict, list)):
                        ids.extend(collect_pin_ids(v, depth + 1))
                return ids

            for pid in collect_pin_ids(results or []):
                if pid not in seen_ids:
                    batch_ids.append(pid)
                    seen_ids.add(pid)

            if batch_ids:
                pin_details = await self._fetch_pin_details(batch_ids, concurrency=5)
                pins.extend(pin_details)
                page += 1
                print(f"  [api] page {page}: {len(batch_ids)} IDs → {len(pin_details)} pins  (total {len(pins)})")
            else:
                page += 1
                print(f"  [api] page {page}: 0 new pin IDs")
                break

            if not new_bookmarks or new_bookmarks == ["-end-"]:
                break
            bookmarks = new_bookmarks
            await asyncio.sleep(random.uniform(0.4, 0.9))

        return pins[:max_pins]

    async def _fetch_pin_details(self, pin_ids: List[str], concurrency: int = 5) -> List[dict]:
        """
        Fetch full pin details from PinResource for a list of pin IDs.
        Runs `concurrency` concurrent requests at a time.
        Returns list of raw pin dicts with save_count, images, link, etc.
        """
        sem = asyncio.Semaphore(concurrency)
        results: List[dict] = []

        async def fetch_one(pin_id: str) -> Optional[dict]:
            async with sem:
                await asyncio.sleep(random.uniform(0.1, 0.3))
                src = f"/pin/{pin_id}/"
                options = {"id": pin_id, "field_set_key": "grid_item"}
                params = {
                    "source_url": src,
                    "data": json.dumps({"options": options, "context": {}}, separators=(',', ':')),
                    "_": str(int(time.time() * 1000)),
                }
                url = "https://www.pinterest.com/resource/PinResource/get/?" + urlencode(params)
                data = await self._get_json(
                    url,
                    referer=f"https://www.pinterest.com/pin/{pin_id}/",
                    source_url=src,
                    pws_handler="www/pin/[id].js",
                )
                pin_data = data.get("resource_response", {}).get("data")
                if isinstance(pin_data, dict) and pin_data.get("id"):
                    return pin_data
                return None

        tasks = [fetch_one(pid) for pid in pin_ids]
        for coro in asyncio.as_completed(tasks):
            result = await coro
            if result:
                results.append(result)
        return results

    def _extract_pins_from_html(self, html: str) -> List[dict]:
        """
        Extract pin data from Pinterest's server-rendered HTML.
        Pinterest embeds the initial feed data in a <script id="initial-state"> tag
        or in window.__PAN_SHARED_INITIAL_DATA__ / window.__RELAY_STORE__.
        """
        import re
        pins: List[dict] = []

        # Pattern 1: <script id="initial-state" type="application/json">...</script>
        m = re.search(r'<script[^>]+id=["\']initial-state["\'][^>]*>(.*?)</script>', html, re.DOTALL)
        if m:
            try:
                data = json.loads(m.group(1))
                pins.extend(find_pins(data))
            except Exception:
                pass

        # Pattern 2: window.__INITIAL_STATE__ = {...}; or window.__INITIAL_DATA__ = {...};
        for pat in [
            r'window\.__INITIAL_STATE__\s*=\s*(\{.*?\})(?:;|\s*</script>)',
            r'window\.__INITIAL_DATA__\s*=\s*(\{.*?\})(?:;|\s*</script>)',
            r'"initial_redux_state"\s*:\s*(\{.*\})',
        ]:
            for m in re.finditer(pat, html, re.DOTALL):
                try:
                    data = json.loads(m.group(1))
                    pins.extend(find_pins(data))
                except Exception:
                    pass

        # Pattern 3: All JSON blobs in <script> tags (last resort)
        if not pins:
            for m in re.finditer(r'<script[^>]*type="application/json"[^>]*>(.*?)</script>', html, re.DOTALL):
                try:
                    data = json.loads(m.group(1))
                    pins.extend(find_pins(data))
                except Exception:
                    pass

        # Deduplicate
        seen: Set[str] = set()
        unique = []
        for p in pins:
            pid = str(p.get("id") or p.get("pin_id") or "")
            if pid and pid not in seen:
                seen.add(pid)
                unique.append(p)
        return unique

    # ── Typeahead (keyword expansion) ─────────────────────────────────────────

    async def expand_keywords(self, seed: str) -> List[str]:
        """Return autocomplete suggestions for a seed keyword."""
        params = {
            "source_url": f"/search/pins/?q={quote(seed)}",
            "data": json.dumps({
                "options": {
                    "term":      seed,
                    "pin_scope": "pins",
                    "autocomplete_request_surface": 0,
                },
                "context": {},
            }, separators=(',', ':')),
            "_": str(int(time.time() * 1000)),
        }
        src = f"/search/pins/?q={seed.replace(' ', '+')}"
        url = "https://www.pinterest.com/resource/AdvancedTypeaheadResource/get/?" + urlencode(params)
        data = await self._get_json(
            url,
            referer=f"https://www.pinterest.com/search/pins/?q={quote(seed)}",
            source_url=src,
            pws_handler="www/search/[scope].js",
        )
        items = _nested_get(data, "resource_response.data.items") or []
        suggestions: List[str] = []
        for item in items:
            # API returns {query, label} (current) or {item:{term}} (legacy)
            term = (item.get("query") or item.get("label")
                    or item.get("display")
                    or _nested_get(item, "item.term") or "")
            if term and isinstance(term, str) and term.strip() != seed:
                suggestions.append(term.strip())
        return suggestions[:10]

    async def fetch_related_pins(self, pin_id: str, max_pins: int = 25) -> List[dict]:
        """
        Fetch visually related pins via RelatedPinFeedResource.
        Called for premium pins to deepen the viral aesthetic graph.
        """
        src = f"/pin/{pin_id}/"
        options: Dict[str, Any] = {
            "pin_id":   pin_id,
            "add_vase": True,
            "page_size": max_pins,
        }
        params = {
            "source_url": src,
            "data": json.dumps({"options": options, "context": {}}, separators=(',', ':')),
            "_": str(int(time.time() * 1000)),
        }
        url = ("https://www.pinterest.com/resource/RelatedPinFeedResource/get/?"
               + urlencode(params))
        data = await self._get_json(
            url,
            referer=f"https://www.pinterest.com/pin/{pin_id}/",
            source_url=src,
            pws_handler="www/pin/[id].js",
        )
        raw_data = data.get("resource_response", {}).get("data") or {}
        raw_pins: List[dict] = raw_data if isinstance(raw_data, list) else find_pins(raw_data)
        pin_ids = [
            str(p.get("id") or p.get("pin_id") or "")
            for p in raw_pins
            if str(p.get("id") or p.get("pin_id") or "").isdigit()
        ]
        pin_ids = [pid for pid in pin_ids if len(pid) > 5]
        if not pin_ids:
            return []
        details = await self._fetch_pin_details(pin_ids[:max_pins], concurrency=3)
        print(f"    [related] {pin_id[:12]}... → {len(details)} related pins")
        return details


# ── Build pin record (same output schema as scraper.py) ─────────────────────

def build_record(
    raw: dict,
    seed_keyword: str,
    source_keyword: str,
    category: str,
    now: datetime,
) -> Optional[dict]:
    pin_id = str(raw.get("id") or raw.get("pin_id") or "")
    if not pin_id:
        return None

    image_url      = extract_image_url(raw)
    if not image_url:
        return None

    outbound_link  = extract_outbound_link(raw)
    save_count     = extract_save_count(raw)
    reaction_count = extract_reaction_count(raw)
    created_at     = extract_created_at(raw)
    title          = str(raw.get("title") or raw.get("grid_title") or raw.get("description") or "")[:500]
    description    = str(raw.get("closeup_description") or raw.get("description") or "")[:2000]
    domain         = get_domain(outbound_link) if outbound_link else (raw.get("domain") or "")
    image_ratio    = extract_image_ratio(raw)
    image_width, image_height = extract_image_dims(raw)
    style          = analyze_pin_style(title, source_keyword, category)

    return {
        "pin_id":          pin_id,
        "pinterest_url":   f"https://www.pinterest.com/pin/{pin_id}/",
        "seed_keyword":    seed_keyword,
        "source_keyword":  source_keyword,
        "category":        category,
        "title":           title,
        "description":     description,
        "image_url":       image_url,
        "source_url":      f"https://www.pinterest.com/search/pins/?q={source_keyword.replace(' ', '%20')}",
        "outbound_link":   outbound_link,
        "domain":          domain,
        "is_ecommerce":    is_ecommerce_url(outbound_link) if outbound_link else False,
        "save_count":      save_count,
        "reaction_count":  reaction_count,
        "comment_count":   _to_int(raw.get("comment_count")),
        "image_ratio":     image_ratio,
        "image_width":     image_width,
        "image_height":    image_height,
        "pin_created_at":  created_at,
        "scraped_at":      now.isoformat(),
        "source_type":     "search_result_v2",
        "style_tags":      style["style_tags"],
        "layout_type":     style["layout_type"],
        "dominant_colors": style["dominant_colors"],
        "best_for_products": style["best_for_products"],
        "prompt_seed":        style["prompt_seed"],
        "pin_type":           None,
        "reject_reason":      None,
        # viral metrics — filled by compute_viral_metrics() after build_record()
        "days_since_creation": None,
        "save_velocity":      None,
        "intent_ratio":       None,
        "is_high_growth":     False,
    }


# ── Deduplication ────────────────────────────────────────────────────────────

class Dedup:
    def __init__(self) -> None:
        self._ids:  Set[str] = set()
        self._imgs: Set[str] = set()

    def is_dup(self, rec: dict) -> bool:
        pid  = rec.get("pin_id") or ""
        nimg = normalize_url(rec.get("image_url") or "")
        return (bool(pid) and pid in self._ids) or (bool(nimg) and nimg in self._imgs)

    def register(self, rec: dict) -> None:
        if rec.get("pin_id"):
            self._ids.add(rec["pin_id"])
        nimg = normalize_url(rec.get("image_url") or "")
        if nimg:
            self._imgs.add(nimg)


# ── Direct DB ingestion ───────────────────────────────────────────────────────

def ingest_to_db(records: List[dict], category: str,
                 source_interest: str = "",
                 trend_keyword_id: str | None = None) -> int:
    """
    Upsert fully-built pin records to Supabase pin_samples.
    Returns number of rows written.
    """
    import sys as _sys
    _sys.path.insert(0, str(ROOT / "db"))
    try:
        from db import upsert  # type: ignore
    except ImportError as exc:
        print(f"[db] cannot import db module: {exc}")
        return 0

    BATCH = 100
    rows: List[dict] = []
    for rec in records:
        rows.append({
            "pin_id":              rec.get("pin_id"),
            "pinterest_url":       rec.get("pinterest_url"),
            "source_keyword":      rec.get("source_keyword"),
            "seed_keyword":        rec.get("seed_keyword"),
            "source_interest":     source_interest or rec.get("source_interest") or None,
            "category":            category,
            "title":               (rec.get("title") or "")[:500] or None,
            "description":         (rec.get("description") or "")[:2000] or None,
            "image_url":           rec.get("image_url"),
            "source_url":          rec.get("source_url"),
            "outbound_link":       rec.get("outbound_link"),
            "is_ecommerce":        bool(rec.get("is_ecommerce")),
            "save_count":          int(rec.get("save_count") or 0),
            "reaction_count":      int(rec.get("reaction_count") or 0),
            "comment_count":       int(rec.get("comment_count") or 0),
            "image_ratio":         rec.get("image_ratio"),
            "image_width":         rec.get("image_width"),
            "image_height":        rec.get("image_height"),
            "pin_created_at":      rec.get("pin_created_at"),
            "scraped_at":          rec.get("scraped_at"),
            "source_type":         rec.get("source_type", "search_result_v2"),
            # viral intelligence (migrate_v4)
            "days_since_creation": rec.get("days_since_creation"),
            "save_velocity":       rec.get("save_velocity"),
            "intent_ratio":        rec.get("intent_ratio"),
            "is_high_growth":      bool(rec.get("is_high_growth")),
            "reject_reason":       rec.get("reject_reason"),
            # pipeline intelligence (migrate_v8)
            "age_days":            rec.get("age_days"),
            "trend_stage":         rec.get("trend_stage"),
            # trend linkage (migrate_v12) — direct FK to trend_keywords
            "trend_keyword_id":    trend_keyword_id or None,
        })

    written = 0
    for i in range(0, len(rows), BATCH):
        batch = rows[i: i + BATCH]
        try:
            result = upsert("pin_samples", batch, on_conflict="pin_id")
            written += len(result)
            print(f"  [db] upserted {min(i + BATCH, len(rows))}/{len(rows)} rows")
        except Exception as exc:
            print(f"  [db] upsert error: {exc}")
    return written


def upsert_keyword_expansions(seed: str, expansions: List[str],
                               source_interest: str = "") -> int:
    """Store typeahead expansions to keyword_expansions table.

    `rank` = 1-based position in the Pinterest search dropdown (migrate_v36).
    Falls back to rank-less rows when the column has not been applied yet, so
    the crawler keeps working before/after the DDL lands.
    """
    import sys as _sys
    _sys.path.insert(0, str(ROOT / "db"))
    try:
        from db import upsert  # type: ignore
    except ImportError:
        return 0
    rows = []
    rank = 0
    for exp in expansions:
        if not exp or exp == seed:
            continue
        rank += 1
        rows.append({"seed_keyword": seed, "expanded_keyword": exp,
                     "source_interest": source_interest or None,
                     "rank": rank})
    if not rows:
        return 0
    try:
        result = upsert("keyword_expansions", rows,
                        on_conflict="seed_keyword,expanded_keyword")
        return len(result)
    except Exception as exc:
        # Pre-v36 schema: retry without the rank column (never lose expansions).
        if "rank" in str(exc).lower():
            try:
                for r in rows:
                    r.pop("rank", None)
                result = upsert("keyword_expansions", rows,
                                on_conflict="seed_keyword,expanded_keyword")
                return len(result)
            except Exception as exc2:
                print(f"  [db] keyword_expansions upsert error: {exc2}")
                return 0
        print(f"  [db] keyword_expansions upsert error: {exc}")
        return 0


def record_save_snapshots(records: List[dict]) -> int:
    """Write one save-count snapshot per pin per UTC day (migrate_v37).

    Powers REAL 7d/30d save velocity once history accumulates. Non-fatal by
    design: before the pin_save_snapshots table exists this logs once and
    returns 0 — the crawl itself is never affected.
    """
    import sys as _sys
    _sys.path.insert(0, str(ROOT / "db"))
    try:
        from db import upsert  # type: ignore
    except ImportError:
        return 0
    today = datetime.now(timezone.utc).date().isoformat()
    rows = []
    seen: Set[str] = set()
    for rec in records:
        pid = str(rec.get("pin_id") or "")
        if not pid or pid in seen:
            continue
        seen.add(pid)
        rows.append({
            "pin_id":         pid,
            "save_count":     int(rec.get("save_count") or 0),
            "reaction_count": int(rec.get("reaction_count") or 0),
            "captured_on":    today,
        })
    if not rows:
        return 0
    try:
        result = upsert("pin_save_snapshots", rows, on_conflict="pin_id,captured_on")
        return len(result)
    except Exception as exc:
        print(f"  [db] pin_save_snapshots skipped (non-fatal): {exc}")
        return 0


def _refresh_cadence_for_keyword(keyword: str) -> str | None:
    """Read refreshCadence from trend_keywords.notes JSON if present."""
    import json as _json
    import sys as _sys
    _sys.path.insert(0, str(ROOT / "db"))
    try:
        from db import select_one  # type: ignore
        row = select_one("trend_keywords", {"keyword": keyword})
        if row and row.get("notes"):
            meta = _json.loads(row["notes"])
            return meta.get("refreshCadence")
    except Exception:
        pass
    return None


def mark_queue_item(
    keyword: str,
    status: str,
    error: str = "",
    *,
    priority_score: float = 0,
    current_attempts: int = 0,
) -> None:
    """Update crawl_queue status with incremental scheduling fields."""
    import sys as _sys
    _sys.path.insert(0, str(ROOT / "db"))
    try:
        from db import update_where  # type: ignore
        from crawl_queue_ops import (  # type: ignore
            compute_completion_update,
            compute_failure_update,
        )
    except ImportError:
        return
    from datetime import datetime, timezone
    now = datetime.now(tz=timezone.utc)

    if status == "processing":
        updates = {"status": "processing", "updated_at": now.isoformat()}
    elif status == "completed":
        refresh_cadence = _refresh_cadence_for_keyword(keyword)
        updates = compute_completion_update(
            priority_score, now, refresh_cadence=refresh_cadence,
        )
    elif status == "failed":
        updates = compute_failure_update(current_attempts, now, error=error)
    else:
        updates = {"status": status, "updated_at": now.isoformat()}
        if error:
            updates["last_error"] = error[:500]

    try:
        update_where("crawl_queue", updates, {"keyword": keyword})
    except Exception:
        pass


async def process_queue_item(
    keyword: str,
    source_interest: str,
    category: str,
    session: "PinterestSession",
    max_pins: int = 75,
    expand_related: bool = True,
    write_db: bool = True,
    out_dir: Optional[Path] = None,
    source_type: str = "pinterest_trends",
) -> Tuple[int, List[dict]]:
    """
    Process a single crawl_queue item end-to-end:
      1. Expand keyword via typeahead
      2. Search pins for seed + top expansions
      3. Build + filter records
      4. Related expansion for premium pins
      5. Write to DB and/or JSONL

    source_type: "pinterest_trends" (default) or "dev_seed" (excluded from scoring).
    Returns (pins_saved, premium_pins).
    """
    queue_attempts = 0
    queue_priority = 0.0
    try:
        import sys as _sys
        _sys.path.insert(0, str(ROOT / "db"))
        from db import select_one as _sq_one  # type: ignore
        qrow = _sq_one("crawl_queue", {"keyword": keyword})
        if qrow:
            queue_attempts = int(qrow.get("attempts") or 0)
            queue_priority = float(qrow.get("priority_score") or 0)
    except Exception:
        pass

    mark_queue_item(keyword, "processing", priority_score=queue_priority,
                    current_attempts=queue_attempts)
    now = datetime.now(timezone.utc)
    dedup = Dedup()
    saved_records: List[dict] = []
    premium_pins: List[dict] = []

    # Resolve trend_keyword_id so pins can be linked directly to the trend record
    trend_keyword_id: str | None = None
    try:
        import sys as _sys
        _sys.path.insert(0, str(ROOT / "db"))
        from db import select_one as _select_one  # type: ignore
        kw_row = _select_one("trend_keywords", {"keyword": keyword})
        if kw_row:
            trend_keyword_id = str(kw_row["id"])
    except Exception:
        pass

    try:
        # Step 1: Typeahead expansion
        expansions = await session.expand_keywords(keyword)
        keywords_to_search = [keyword] + [e for e in expansions if e != keyword]

        if write_db:
            upsert_keyword_expansions(keyword, expansions, source_interest)

        # Step 2: Search pins for seed + top 2 expansions
        for kw in keywords_to_search[:3]:
            raw_pins = await session.search_pins(kw, max_pins=max_pins)
            for raw in raw_pins:
                rec = build_record(raw, keyword, kw, category, now)
                if not rec or dedup.is_dup(rec):
                    continue
                compute_viral_metrics(rec, now)
                # Collection-stage filter: require image + pin_id only
                if not rec.get("image_url") or not rec.get("pin_id"):
                    continue
                # Freshness + minimal save count filter
                ok, reason = passes_premium_filter(rec)
                if not ok:
                    rec["reject_reason"] = reason
                    continue
                rec["source_interest"] = source_interest
                dedup.register(rec)
                saved_records.append(rec)

                if int(rec.get("save_count") or 0) >= STL_TRIGGER_SAVES:
                    premium_pins.append(rec)

        # Step 3: Related pin expansion for premium pins
        if expand_related and premium_pins:
            for src_rec in premium_pins[:5]:
                related_raws = await session.fetch_related_pins(
                    src_rec["pin_id"], max_pins=25
                )
                for raw in related_raws:
                    rec = build_record(raw, keyword, f"related:{keyword}", category, now)
                    if not rec or dedup.is_dup(rec):
                        continue
                    compute_viral_metrics(rec, now)
                    if not rec.get("image_url"):
                        continue
                    ok, reason = passes_premium_filter(rec)
                    if not ok:
                        rec["reject_reason"] = reason
                        continue
                    rec["source_interest"] = source_interest
                    rec["source_type"]     = source_type
                    dedup.register(rec)
                    saved_records.append(rec)

        # Step 4: Write to DB
        written = 0
        if write_db and saved_records:
            written = ingest_to_db(saved_records, category, source_interest,
                                   trend_keyword_id=trend_keyword_id)
            # Daily save-count snapshot per observed pin (migrate_v37) — powers
            # real 7d/30d velocity later. Non-fatal if the table doesn't exist.
            record_save_snapshots(saved_records)

        # Step 5: Write to JSONL (optional local backup)
        if out_dir and saved_records:
            out_dir.mkdir(parents=True, exist_ok=True)
            jsonl = out_dir / "style_library.jsonl"
            with jsonl.open("a", encoding="utf-8") as fh:
                for rec in saved_records:
                    fh.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")

        mark_queue_item(keyword, "completed", priority_score=queue_priority,
                        current_attempts=queue_attempts)
        print(f"  [queue] '{keyword}' → {len(saved_records)} pins saved "
              f"({len(premium_pins)} premium)  db={written}")
        return len(saved_records), premium_pins

    except Exception as exc:
        mark_queue_item(keyword, "failed", str(exc),
                        priority_score=queue_priority, current_attempts=queue_attempts)
        print(f"  [queue] '{keyword}' FAILED: {exc}")
        return 0, []


# ── CLI (testing / ad-hoc only — production runs go through pipeline.py) ──────

async def main() -> None:
    ap = argparse.ArgumentParser(
        description=(
            "Pinterest scraper — ad-hoc testing only. "
            "Production use: py pipeline.py --step crawl"
        )
    )
    ap.add_argument("--keyword",  default=None,
                    help="Single keyword to process via process_queue_item(). "
                         "If omitted, a smoke-test keyword is used.")
    ap.add_argument("--category", default="general",
                    help="Category label attached to the keyword (default: general)")
    ap.add_argument("--interest", default="",
                    help="Source interest slug (for traceability)")
    ap.add_argument("--max-pins", type=int, default=75,
                    help="Max pins to fetch (default 75)")
    ap.add_argument("--proxy",    default=None)
    ap.add_argument("--delay",    type=float, default=1.2)
    ap.add_argument("--no-filter",  action="store_true",
                    help="Disable freshness/volume filters")
    ap.add_argument("--no-db",     action="store_true",
                    help="Skip DB writes (JSONL backup only)")
    ap.add_argument("--test",      action="store_true",
                    help="Smoke-test: forces a safe keyword, 25 pins, prints sample")
    ap.add_argument("--dev-seeds", action="store_true",
                    help="[DEV ONLY] Use built-in _DEV_SEEDS instead of crawl_queue. "
                         "Tags records source_type=dev_seed — excluded from opportunity scoring.")
    args = ap.parse_args()

    if args.no_filter:
        global MIN_SAVE_COUNT, FRESHNESS_DAYS
        MIN_SAVE_COUNT = 0
        FRESHNESS_DAYS = 99999

    # ── Keyword + source resolution ──────────────────────────────────────────
    if args.dev_seeds:
        cat = args.category if args.category != "general" else "home"
        keyword      = args.keyword or _DEV_SEEDS.get(cat, _DEV_SEEDS["home"])[0]
        source_label = "dev_seed"
        print(f"\033[93m  [DEV] source=dev_seed  keyword='{keyword}'"
              f"  (excluded from opportunity scoring)\033[0m")
    else:
        keyword      = args.keyword or ("minimalist home decor" if args.test else None)
        source_label = "pinterest_trends"
        if not args.test:
            print(f"  source=pinterest_trends")

    max_pins = 25 if args.test else args.max_pins

    if keyword is None:
        ap.error("--keyword is required (or use --test / --dev-seeds)")

    out_dir = LIB_ROOT / f"style_library_{args.interest or 'adhoc'}"

    async with PinterestSession(proxy=args.proxy, delay=args.delay) as session:
        pins_saved, premium = await process_queue_item(
            keyword         = keyword,
            source_interest = args.interest,
            category        = args.category,
            session         = session,
            max_pins        = max_pins,
            expand_related  = True,
            write_db        = not args.no_db,
            out_dir         = out_dir,
            source_type     = source_label,
        )

    print(f"\nDone: {pins_saved} pins saved, {len(premium)} premium.")

    if args.test:
        jsonl = out_dir / "style_library.jsonl"
        if jsonl.exists():
            lines = jsonl.read_text(encoding="utf-8").splitlines()
            print(f"\n-- Sample (first 3 pins) --")
            for line in lines[:3]:
                p = json.loads(line)
                print(f"  pin={p['pin_id']}  save={p['save_count']}  "
                      f"vel={p.get('save_velocity')}  "
                      f"stage={p.get('trend_stage')}  "
                      f"title={p.get('title','')[:50]}")


if __name__ == "__main__":
    asyncio.run(main())
