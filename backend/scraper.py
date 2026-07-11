#!/usr/bin/env python3
"""
scraper.py  —  Pinterest Vibe Library Builder  (multi-category, 3-stage)

Stage 1 : Keyword expansion  — seed → autocomplete long-tail keywords
Stage 2 : Search scraping    — scroll search results, capture Pin metadata
Stage 3 : Related pins       — visit high-score Pin detail pages, capture More-like-this

Usage:
  py scraper.py --category home    --limit-keywords 2
  py scraper.py --category fashion --limit-keywords 2 --max-search-pins 30
  py scraper.py --category beauty  --limit-keywords 2 --dry-run
  py scraper.py --category all     --limit-keywords 5 --skip-related
"""

import asyncio
import argparse
import csv
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import urlparse, urlunparse

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ── Supabase DB helpers (optional) ──────────────────────────────────────────
_db_upsert = _db_update_where = _db_select_many = None
try:
    sys.path.insert(0, str(Path(__file__).parent / "db"))
    from db import upsert as _db_upsert            # type: ignore[assignment]
    from db import update_where as _db_update_where  # type: ignore[assignment]
    from db import select_many as _db_select_many    # type: ignore[assignment]
except Exception:
    pass

from playwright.async_api import async_playwright, Page, Response


# ══════════════════════════════════════════════════════════════════════════════
# CONSTANTS
# ══════════════════════════════════════════════════════════════════════════════

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

API_FRAGMENTS: List[str] = [
    "/resource/", "/search/", "/graphql", "/seo/", "/feed/",
    "/baseboards/", "/pins/", "/unified/", "/v3/", "/api/v",
    "SearchResource", "PinResource", "RelatedPinFeed",
    "BoardFeedResource", "UserHomeFeedResource", "VisualRecommendations",
]

IMAGE_SIZE_PRIORITY: List[str] = [
    "orig", "originals", "736x", "564x", "474x", "345x", "236x",
]

INTENT_GENERAL: List[str] = [
    "aesthetic", "ideas", "inspo", "style", "trend",
    "outfit", "decor", "look", "tutorial", "design",
]

INTENT_BY_CATEGORY: Dict[str, List[str]] = {
    "home": [
        "living room", "bedroom", "kitchen", "apartment",
        "vintage", "boho", "cozy", "luxury", "wall decor",
    ],
    "fashion": [
        "outfit", "ideas", "women", "concert", "graduation",
        "game day", "summer", "street style", "capsule",
    ],
    "beauty": [
        "nails", "pedicure", "braids", "makeup", "hair",
        "tutorial", "summer", "graduation", "design",
    ],
}

NEGATIVE_TERMS: List[str] = [
    "meme", "funny", "wallpaper", "kids drawing",
    "cartoon", "anime", "manga", "fan art",
]

_STYLE_POOL: Dict[str, List[str]] = {
    "home":    ["minimalist", "boho", "farmhouse", "vintage", "modern", "cozy",
                "neutral", "aesthetic", "scandinavian", "japandi", "maximalist",
                "luxury", "southern", "spanish", "witchy", "90s"],
    "fashion": ["casual", "chic", "streetwear", "formal", "bohemian", "preppy",
                "minimalist", "aesthetic", "y2k", "cottagecore", "dark academia",
                "old money", "coastal", "graduation", "game day"],
    "beauty":  ["natural", "glam", "minimal", "bold", "soft", "clean", "dewy",
                "editorial", "everyday", "grunge", "coquette", "graduation", "summer"],
}

_BEST_FOR: Dict[str, List[str]] = {
    "home":    ["throw pillows", "rugs", "candles", "wall art", "vases",
                "lighting", "shelving", "storage baskets", "plants"],
    "fashion": ["clothing", "accessories", "shoes", "bags", "jewelry", "outerwear"],
    "beauty":  ["skincare", "makeup", "nail products", "hair care",
                "fragrances", "beauty tools"],
}

_PROMPT_SEEDS: Dict[str, str] = {
    "home":    "cozy interior, warm soft lighting, minimal clutter, Pinterest-worthy, high-end aesthetic",
    "fashion": "stylish outfit flatlay, clean neutral background, trendy fashion, aesthetic composition",
    "beauty":  "beauty product arrangement, soft background, glowy aesthetic, studio light, clean flatlay",
}

BONUS_KEYWORDS = ["outfit", "nails", "decor", "ideas", "aesthetic", "styling"]


# ══════════════════════════════════════════════════════════════════════════════
# LOGGING
# ══════════════════════════════════════════════════════════════════════════════

def _setup_logging() -> logging.Logger:
    fmt = "%(asctime)s [%(levelname)-8s] %(message)s"
    stdout_stream = open(sys.stdout.fileno(), mode="w", encoding="utf-8",
                         buffering=1, closefd=False)
    handlers: List[logging.Handler] = [
        logging.StreamHandler(stdout_stream),
        logging.FileHandler("scraper.log", encoding="utf-8"),
    ]
    logging.basicConfig(level=logging.INFO, format=fmt, datefmt="%H:%M:%S",
                        handlers=handlers)
    for noisy in ("httpx", "asyncio", "playwright"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    return logging.getLogger("pinterest")

log = _setup_logging()


# ══════════════════════════════════════════════════════════════════════════════
# URL / DOMAIN UTILITIES
# ══════════════════════════════════════════════════════════════════════════════

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

def is_ecommerce(url: str) -> bool:
    if not url:
        return False
    d = get_domain(url)
    if "myshopify.com" in d:
        return True
    return any(d == s or d.endswith("." + s) for s in ECOMMERCE_DOMAINS) if d else False


# ══════════════════════════════════════════════════════════════════════════════
# PIN EXTRACTION
# ══════════════════════════════════════════════════════════════════════════════

def _nested_get(obj: Any, path: str) -> Any:
    for key in path.split("."):
        if isinstance(obj, dict):
            obj = obj.get(key)
        elif isinstance(obj, list) and key.isdigit():
            idx = int(key)
            obj = obj[idx] if idx < len(obj) else None
        else:
            return None
        if obj is None:
            return None
    return obj

def _looks_like_pin(obj: Any) -> bool:
    if not isinstance(obj, dict):
        return False
    if not (obj.get("id") or obj.get("pin_id") or obj.get("pinId")):
        return False
    signals = {"images", "save_count", "repin_count", "saves", "grid_title",
               "closeup_description", "domain", "outbound_link", "rich_metadata"}
    return bool(signals & obj.keys())

def find_pins(data: Any, depth: int = 0, max_depth: int = 14) -> List[dict]:
    if depth > max_depth:
        return []
    results: List[dict] = []
    if isinstance(data, dict):
        if _looks_like_pin(data):
            results.append(data)
        for v in data.values():
            if isinstance(v, (dict, list)):
                results.extend(find_pins(v, depth + 1, max_depth))
    elif isinstance(data, list):
        for item in data:
            results.extend(find_pins(item, depth + 1, max_depth))
    return results

def _first(*vals: Any) -> Any:
    for v in vals:
        if v is not None:
            return v
    return None

def _to_int(val: Any, default: int = 0) -> int:
    try:
        return int(val)
    except (TypeError, ValueError):
        return default

def extract_pin_id(obj: dict) -> Optional[str]:
    v = _first(obj.get("id"), obj.get("pin_id"), obj.get("pinId"))
    return str(v) if v is not None else None

def extract_title(obj: dict) -> str:
    v = _first(obj.get("title"), obj.get("grid_title"),
               obj.get("description"), obj.get("closeup_description"))
    return str(v).strip()[:500] if v else ""

def extract_description(obj: dict) -> str:
    v = _first(obj.get("closeup_description"), obj.get("description"),
               obj.get("rich_summary"), obj.get("pin_note"))
    return str(v).strip()[:2000] if v else ""

def extract_image_url(obj: dict) -> Optional[str]:
    for path in ("images.orig.url", "images.originals.url",
                 "images.736x.url", "images.564x.url",
                 "media.images.orig.url", "image_url"):
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
    """width / height ratio — Pinterest portrait is typically 0.55–0.85."""
    for size in ("orig", "originals", "736x", "564x"):
        images = obj.get("images") or {}
        if isinstance(images, dict):
            img = images.get(size) or {}
            if isinstance(img, dict):
                w = img.get("width")
                h = img.get("height")
                try:
                    if w and h and int(h) > 0:
                        return round(int(w) / int(h), 3)
                except (TypeError, ValueError):
                    pass
    return None

def extract_outbound_link(obj: dict) -> Optional[str]:
    def _ok(url: Any) -> bool:
        return (isinstance(url, str) and url.startswith("http")
                and "pinterest.com" not in url)
    for key in ("link", "outbound_link", "product_url"):
        url = obj.get(key)
        if _ok(url):
            return url
    url = _nested_get(obj, "rich_metadata.url")
    if _ok(url):
        return url
    for container in ("shopping_links", "closeups", "shop_the_look"):
        for item in (obj.get(container) or []):
            if isinstance(item, dict):
                url = item.get("url") or item.get("link")
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
            try:
                return int(val)
            except (TypeError, ValueError):
                pass
    return 0

def extract_reaction_count(obj: dict) -> int:
    for val in (obj.get("reaction_counts"), obj.get("reaction_count"),
                obj.get("total_reaction_count"),
                _nested_get(obj, "aggregated_pin_data.aggregated_stats.reactions")):
        if val is None:
            continue
        if isinstance(val, dict):
            try:
                return sum(_to_int(v) for v in val.values())
            except Exception:
                pass
        try:
            return int(val)
        except (TypeError, ValueError):
            pass
    return 0

def extract_comment_count(obj: dict) -> int:
    for val in (obj.get("comment_count"), obj.get("comments"),
                _nested_get(obj, "aggregated_pin_data.aggregated_stats.comments")):
        if val is not None:
            try:
                return int(val)
            except (TypeError, ValueError):
                pass
    return 0

def extract_created_at(obj: dict) -> Optional[str]:
    from email.utils import parsedate_to_datetime
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


def build_pin_record(
    obj: dict,
    seed_keyword: str,
    source_keyword: str,
    category: str,
    now: datetime,
    source_type: str = "search_result",
    parent_pin_id: Optional[str] = None,
    related_rank: Optional[int] = None,
) -> Optional[dict]:
    pin_id = extract_pin_id(obj)
    if pin_id is None:
        return None

    image_url      = extract_image_url(obj)
    outbound_link  = extract_outbound_link(obj)
    save_count     = extract_save_count(obj)
    reaction_count = extract_reaction_count(obj)
    comment_count  = extract_comment_count(obj)
    created_at     = extract_created_at(obj)
    title          = extract_title(obj)
    description    = extract_description(obj)
    domain         = get_domain(outbound_link) if outbound_link else (obj.get("domain") or "")
    image_ratio    = extract_image_ratio(obj)

    return {
        "pin_id":          pin_id,
        "seed_keyword":    seed_keyword,
        "source_keyword":  source_keyword,
        "category":        category,
        "title":           title,
        "description":     description,
        "image_url":       image_url,
        "source_url": (
            f"https://www.pinterest.com/search/pins/"
            f"?q={source_keyword.replace(' ', '%20')}"
        ),
        "outbound_link":   outbound_link,
        "domain":          domain,
        "is_ecommerce":    is_ecommerce(outbound_link) if outbound_link else False,
        "save_count":      save_count,
        "reaction_count":  reaction_count,
        "comment_count":   comment_count,
        "image_ratio":     image_ratio,
        "created_at":      created_at,
        "scraped_at":      now.isoformat(),
        "source_type":     source_type,
        "parent_pin_id":   parent_pin_id,
        "related_rank":    related_rank,
        "pin_type":        None,
        "reject_reason":   None,
        "_raw":            obj,
    }


# ══════════════════════════════════════════════════════════════════════════════
# SCORING
# ══════════════════════════════════════════════════════════════════════════════

def score_expanded_keyword(kw: str, category: str) -> int:
    kw_lower = kw.lower()
    if any(neg in kw_lower for neg in NEGATIVE_TERMS):
        return 0
    score = 10
    score += min(len(kw.split()) - 1, 4) * 3   # longer = more specific
    for term in INTENT_GENERAL:
        if term in kw_lower:
            score += 5
    for term in INTENT_BY_CATEGORY.get(category, []):
        if term in kw_lower:
            score += 8
    return min(score, 100)

def score_commercial_intent(rec: dict) -> int:
    score = 0
    if rec.get("outbound_link"):
        score += 3
    if any(k in (rec.get("title") or "").lower()
           for k in ("shop", "buy", "price", "sale", "order", "link")):
        score += 2
    d = rec.get("domain") or ""
    if any(x in d for x in ("etsy.com", "amazon.com", "myshopify.com")):
        score += 2
    if rec.get("save_count", 0) > 1000:
        score += 1
    if _nested_get(rec.get("_raw", {}), "rich_metadata.price") is not None:
        score += 2
    return min(score, 10)

def score_make_similar(rec: dict) -> int:
    score = 0
    img = rec.get("image_url") or ""
    if img:
        score += 2 if any(s in img for s in ("736x", "564x", "474x")) else 1
    saves = rec.get("save_count", 0)
    if saves >= 5_000:
        score += 3
    elif saves >= 1_000:
        score += 2
    elif saves >= 100:
        score += 1
    if len(rec.get("title") or "") > 10:
        score += 1
    ratio = rec.get("image_ratio")
    if ratio is not None:
        score += 2 if 0.55 <= ratio <= 0.85 else 0
    else:
        score += 1  # unknown ratio — no penalty
    if rec.get("reject_reason") != "low_quality_ad":
        score += 1
    return min(score, 10)


# ══════════════════════════════════════════════════════════════════════════════
# HEURISTIC STYLE ANALYSIS
# ══════════════════════════════════════════════════════════════════════════════

def analyze_pin_style(rec: dict, category: str) -> dict:
    title   = (rec.get("title") or "").lower()
    keyword = (rec.get("source_keyword") or "").lower()
    text    = f"{keyword} {title}"

    pool       = _STYLE_POOL.get(category, _STYLE_POOL["home"])
    style_tags = [s for s in pool if s in text] or ["aesthetic"]

    if any(w in text for w in ("collage", "ideas", "collection", "inspo")):
        layout = "collage"
    elif any(w in text for w in ("outfit", "look", "ootd", "wear")):
        layout = "outfit_flatlay"
    elif any(w in text for w in ("tutorial", "step", "how to", "diy", "guide")):
        layout = "tutorial_steps"
    elif any(w in text for w in ("nails", "nail", "pedicure")):
        layout = "nail_closeup"
    elif any(w in text for w in ("room", "decor", "interior", "home", "kitchen", "bedroom")):
        layout = "interior_scene"
    else:
        layout = "single_image"

    has_text = any(w in title for w in
                   ("how", "tips", "ideas", "ways", "#", "vs", "tutorial", "guide", "steps"))

    best_pool = _BEST_FOR.get(category, _BEST_FOR["home"])
    best_for  = [p for p in best_pool if any(w in text for w in p.split())]
    if not best_for:
        best_for = best_pool[:2]

    color_hints = ["neutral", "white", "black", "beige", "cream", "pink",
                   "sage", "green", "blue", "brown", "gold", "warm"]
    dominant_colors = [c for c in color_hints if c in text][:3] or ["neutral"]

    base_seed   = _PROMPT_SEEDS.get(category, _PROMPT_SEEDS["home"])
    extra_style = ", ".join(style_tags[:2])
    prompt_seed = f"{extra_style}, {base_seed}" if extra_style else base_seed

    return {
        "style_tags":          style_tags,
        "layout_type":         layout,
        "dominant_colors":     dominant_colors,
        "has_text_overlay":    has_text,
        "best_for_products":   best_for[:4],
        "prompt_seed":         prompt_seed,
        "analysis_reason":     (
            f"heuristic_v1 | styles={','.join(style_tags)} | layout={layout}"
        ),
    }


# ══════════════════════════════════════════════════════════════════════════════
# CLASSIFICATION
# ══════════════════════════════════════════════════════════════════════════════

def classify_pin(
    rec: dict,
    min_save_count:         int = 5000,
    min_save_count_product: int = 1000,
    min_ci_score:           int = 6,
    min_ms_score:           int = 7,
) -> Tuple[Optional[str], Optional[str]]:
    """
    Returns (pin_type | None, reject_reason | None).

    Aesthetic/blog pins: must clear min_save_count (default 5000).
    Ecommerce product pins (is_ecommerce=True, ci>=5): use min_save_count_product (default 1000).
    Missing save_count → reject as missing_save_count.
    """
    img       = rec.get("image_url")
    link      = rec.get("outbound_link")
    ratio     = rec.get("image_ratio")
    reactions = rec.get("reaction_count", 0)

    if not img:
        return None, "no_image"

    # Missing save_count
    raw_saves = rec.get("save_count")
    if raw_saves is None:
        return None, "missing_save_count"
    saves = int(raw_saves)

    # Low-quality ad filter (high saves but almost no reactions)
    if saves > min_save_count and reactions < 10:
        return None, "high_save_low_reaction_ad_like"

    # Save gate — ecommerce product pins use a lower threshold
    is_ecomm   = rec.get("is_ecommerce", False)
    ci_early   = rec.get("commercial_intent_score", 0)
    threshold  = min_save_count_product if (is_ecomm and ci_early >= 5) else min_save_count
    if saves < threshold:
        return None, "save_count_below_5000"

    ms = rec.get("make_similar_score", 0)
    ci = rec.get("commercial_intent_score", 0)

    # A — aesthetic_trend
    ratio_ok  = (ratio is None) or (0.55 <= ratio <= 0.85)
    aesthetic = ms >= min_ms_score and ratio_ok

    # B — product_lead
    product = (
        bool(link)
        and not is_social(link or "")
        and ci >= min_ci_score
    )

    if aesthetic and product:
        return "both", None
    if aesthetic:
        return "aesthetic_trend", None
    if product:
        return "product_lead", None

    reasons = []
    if ms < min_ms_score:
        reasons.append(f"low_ms_{ms}")
    if ratio is not None and not ratio_ok:
        reasons.append(f"bad_ratio_{ratio:.2f}")
    if not link:
        reasons.append("no_product_link")
    elif ci < min_ci_score:
        reasons.append(f"low_ci_{ci}")
    return None, (",".join(reasons) if reasons else "below_threshold")


# ══════════════════════════════════════════════════════════════════════════════
# DEDUPLICATION
# ══════════════════════════════════════════════════════════════════════════════

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


# ══════════════════════════════════════════════════════════════════════════════
# SCRAPER
# ══════════════════════════════════════════════════════════════════════════════

class PinterestScraper:

    _AUTOCOMPLETE_INPUT_SELS = [
        'input[name="searchBoxInput"]',
        '[data-test-id="search-bar-input"]',
        'input[placeholder*="Search"]',
        'input[placeholder*="search"]',
        'input[type="search"]',
    ]
    _AUTOCOMPLETE_ITEM_SELS = [
        '[data-test-id="typeahead-item"]',
        '[data-test-id="search-suggestion"]',
        'li[role="option"]',
        '[class*="Typeahead"] li',
        '[class*="typeahead"] li',
    ]

    def __init__(self, args: argparse.Namespace) -> None:
        self.args  = args
        self._now  = datetime.now(tz=timezone.utc)
        self.dedup = Dedup()

        ts           = self._now.strftime("%Y%m%d_%H%M%S")
        self.run_dir = Path(args.output_dir) / f"style_library_{ts}"
        self.run_dir.mkdir(parents=True, exist_ok=True)

        self._stats: Dict[str, int] = {
            "seeds_run": 0, "expansions": 0, "raw_pins": 0,
            "related_pins": 0, "style_library": 0,
            "rejected": 0, "db_ok": 0, "db_fail": 0,
        }
        self._reject_reasons: Dict[str, int] = {}

    def _track_reject(self, reason: str) -> None:
        r = reason or "unknown"
        self._reject_reasons[r] = self._reject_reasons.get(r, 0) + 1
        self._stats["rejected"] += 1

    # ── Browser ───────────────────────────────────────────────────────────

    async def _launch_ctx(self, pw):
        browser = await pw.chromium.launch(
            headless=self.args.headless,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        )
        return await browser.new_context(
            viewport={"width": 1280, "height": 900},
            locale="en-US",
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        )

    # ── Popup dismissal ───────────────────────────────────────────────────

    async def _dismiss_popups(self, page: Page) -> None:
        """Remove Pinterest signup/login modals that block interactions."""
        try:
            removed = await page.evaluate("""() => {
                let count = 0;
                // Remove the modal and its backdrop
                const sels = [
                    '[data-test-id="fullPageSignupModal"]',
                    '[data-test-id="signup-modal"]',
                    '[data-test-id="login-modal"]',
                ];
                for (const sel of sels) {
                    document.querySelectorAll(sel).forEach(el => {
                        el.remove(); count++;
                    });
                }
                // Also remove any fixed overlay divs that block clicks
                document.querySelectorAll('div[style*="position: fixed"]').forEach(el => {
                    const testId = el.getAttribute('data-test-id') || '';
                    if (testId.includes('Modal') || testId.includes('modal') ||
                        testId.includes('signup') || testId.includes('login')) {
                        el.remove(); count++;
                    }
                });
                // Restore body scroll if Pinterest locked it
                document.body.style.overflow = '';
                return count;
            }""")
            if removed:
                log.info(f"  Removed {removed} modal element(s)")
                await asyncio.sleep(0.3)
        except Exception:
            pass

    # ── Stage 1: Autocomplete expansion ──────────────────────────────────

    async def get_autocomplete_keywords(self, page: Page, seed_kw: str) -> List[str]:
        """Type seed_kw in search bar; return autocomplete suggestions. Never raises."""
        suggestions: List[str] = []

        async def _on_typeahead(response: Response) -> None:
            url = str(response.url)
            if "TypeaheadResource" not in url and "typeahead" not in url.lower():
                return
            try:
                data  = await response.json()
                items = (
                    _nested_get(data, "resource_response.data.items") or
                    _nested_get(data, "resource_response.data.guides") or []
                )
                for item in items:
                    if isinstance(item, dict):
                        term = (item.get("term") or item.get("query")
                                or item.get("name") or "")
                        if term and len(str(term)) > len(seed_kw):
                            suggestions.append(str(term).strip())
            except Exception:
                pass

        page.on("response", _on_typeahead)
        try:
            if "pinterest.com" not in page.url:
                await page.goto("https://www.pinterest.com",
                                wait_until="domcontentloaded", timeout=30_000)
                await asyncio.sleep(2)

            await self._dismiss_popups(page)

            search_el = None
            for sel in self._AUTOCOMPLETE_INPUT_SELS:
                try:
                    search_el = await page.wait_for_selector(sel, timeout=4_000)
                    if search_el:
                        break
                except Exception:
                    continue

            if search_el is None:
                log.warning(f"  autocomplete: search box not found for '{seed_kw}'")
                return []

            await self._dismiss_popups(page)
            await search_el.click(timeout=5000)
            await asyncio.sleep(0.3)
            await page.keyboard.press("Control+a")
            await page.keyboard.press("Delete")
            await page.keyboard.type(seed_kw, delay=60)
            await asyncio.sleep(2.0)

            for sel in self._AUTOCOMPLETE_ITEM_SELS:
                try:
                    items = await page.query_selector_all(sel)
                    for item in items[:12]:
                        try:
                            text = (await item.inner_text()).strip()
                            if text and text.lower() != seed_kw.lower():
                                suggestions.append(text)
                        except Exception:
                            pass
                    if suggestions:
                        break
                except Exception:
                    continue

            await page.keyboard.press("Escape")
            await asyncio.sleep(0.5)

        except Exception as exc:
            log.warning(f"  autocomplete error for '{seed_kw}': {exc}")
        finally:
            page.remove_listener("response", _on_typeahead)

        seen: Set[str] = set()
        result: List[str] = []
        for s in suggestions:
            sc = s.strip()
            if sc and sc.lower() not in seen:
                seen.add(sc.lower())
                result.append(sc)

        log.info(f"  autocomplete '{seed_kw}' -> {len(result)} suggestions")
        return result

    # ── Stage 2: Search result scraping ──────────────────────────────────

    async def scrape_search_results(
        self, page: Page, seed_kw: str, expanded_kw: str,
        category: str, max_pins: int,
    ) -> List[dict]:
        buffer: List[dict] = []
        cap = max_pins * 4  # collect extra for post-filtering headroom

        async def _handler(response: Response) -> None:
            if len(buffer) >= cap:
                return
            url = str(response.url)
            if not any(f in url for f in API_FRAGMENTS):
                return
            ct = response.headers.get("content-type", "")
            if "json" not in ct and "javascript" not in ct:
                return
            try:
                text = await response.text()
                if len(text) < 80:
                    return
                data = json.loads(text)
            except Exception:
                return
            for raw in find_pins(data):
                if len(buffer) >= cap:
                    break
                try:
                    rec = build_pin_record(raw, seed_kw, expanded_kw, category,
                                           self._now, "search_result")
                    if rec and not self.dedup.is_dup(rec):
                        self.dedup.register(rec)
                        buffer.append(rec)
                except Exception as exc:
                    log.debug(f"  pin build error: {exc}")

        page.on("response", _handler)
        try:
            url = (f"https://www.pinterest.com/search/pins/"
                   f"?q={expanded_kw.replace(' ', '%20')}&rs=typed")
            await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            await asyncio.sleep(3)
            await self._dismiss_popups(page)

            scrolls = max(3, max_pins // 8)
            for i in range(scrolls):
                if len(buffer) >= cap:
                    break
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await asyncio.sleep(1.8)
        except Exception as exc:
            log.error(f"  search error '{expanded_kw}': {exc}")
        finally:
            page.remove_listener("response", _handler)

        log.info(f"  search '{expanded_kw}' -> {len(buffer)} raw pins")
        return buffer

    # ── Stage 3: Related pins from detail page ────────────────────────────

    async def scrape_related_pins(
        self, page: Page, parent_pin: dict, max_related: int,
    ) -> List[dict]:
        pin_id = parent_pin.get("pin_id")
        if not pin_id:
            return []

        buffer: List[dict] = []
        seed_kw   = parent_pin.get("seed_keyword", "")
        source_kw = parent_pin.get("source_keyword", "")
        category  = parent_pin.get("category", "home")

        RELATED_FRAGS = [
            "RelatedPinFeed", "VisualRecommendations",
            "closeup_recommendations", "related_pin",
        ]

        async def _handler(response: Response) -> None:
            if len(buffer) >= max_related * 2:
                return
            url = str(response.url)
            if not any(f in url for f in RELATED_FRAGS + API_FRAGMENTS):
                return
            if "json" not in response.headers.get("content-type", ""):
                return
            try:
                text = await response.text()
                data = json.loads(text)
            except Exception:
                return
            for i, raw in enumerate(find_pins(data)):
                if len(buffer) >= max_related * 2:
                    break
                rpid = extract_pin_id(raw)
                if rpid == pin_id:
                    continue
                try:
                    rec = build_pin_record(
                        raw, seed_kw, source_kw, category, self._now,
                        source_type="related_pin",
                        parent_pin_id=pin_id,
                        related_rank=len(buffer) + 1,
                    )
                    if rec and not self.dedup.is_dup(rec):
                        self.dedup.register(rec)
                        buffer.append(rec)
                except Exception as exc:
                    log.debug(f"  related pin build error: {exc}")

        page.on("response", _handler)
        try:
            await page.goto(f"https://www.pinterest.com/pin/{pin_id}/",
                            wait_until="domcontentloaded", timeout=30_000)
            await asyncio.sleep(3)
            await self._dismiss_popups(page)
            for _ in range(3):
                if len(buffer) >= max_related:
                    break
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await asyncio.sleep(2)
        except Exception as exc:
            log.error(f"  related pins error (pin {pin_id}): {exc}")
        finally:
            page.remove_listener("response", _handler)

        result = buffer[:max_related]
        log.info(f"  pin {pin_id} -> {len(result)} related pins")
        return result

    # ── Fetch real save counts via PinResource ────────────────────────────

    async def fetch_save_counts(self, page: Page, pin_ids: List[str]) -> Dict[str, int]:
        import urllib.parse
        import time as _time

        if not pin_ids:
            return {}

        id_to_saves: Dict[str, int] = {}
        batch_size = 10

        for i in range(0, len(pin_ids), batch_size):
            batch = pin_ids[i: i + batch_size]
            ts    = str(int(_time.time() * 1000))
            urls  = []
            for pid in batch:
                data = json.dumps({
                    "options": {
                        "id": pid, "field_set_key": "detailed",
                        "fetch_visual_search_objects": True,
                    },
                    "context": {},
                })
                params = urllib.parse.urlencode(
                    {"_": ts, "data": data, "source_url": "/homefeed/"}
                )
                urls.append(
                    f"https://www.pinterest.com/resource/PinResource/get/?{params}"
                )

            try:
                results = await page.evaluate(
                    """async (urls) => {
                        return await Promise.all(urls.map(url =>
                            fetch(url, {
                                headers: {
                                    'Accept': 'application/json',
                                    'x-pinterest-pws-handler': 'www/homefeed.js'
                                }
                            }).then(r => r.ok ? r.json() : null).catch(() => null)
                        ));
                    }""",
                    urls,
                )
                for j, resp in enumerate(results or []):
                    if resp:
                        pin_data = (resp.get("resource_response") or {}).get("data") or {}
                        saves = pin_data.get("repin_count") or pin_data.get("save_count") or 0
                        id_to_saves[batch[j]] = int(saves)
            except Exception as exc:
                log.debug(f"PinResource batch {i//batch_size} error: {exc}")

            if (i // batch_size + 1) % 5 == 0:
                await asyncio.sleep(0.5)

        return id_to_saves

    # ── Process pins (score + classify + analyze) ─────────────────────────

    def process_pins(
        self, pins: List[dict], category: str
    ) -> Tuple[List[dict], List[dict]]:
        kept: List[dict] = []
        rejected: List[dict] = []

        for rec in pins:
            rec["commercial_intent_score"] = score_commercial_intent(rec)
            rec["make_similar_score"]      = score_make_similar(rec)

            pin_type, reason = classify_pin(
                rec,
                min_save_count=self.args.min_save_count,
                min_save_count_product=self.args.min_save_count_product,
                min_ci_score=self.args.min_commercial_score,
                min_ms_score=self.args.min_make_similar_score,
            )

            if pin_type is None:
                rec["reject_reason"] = reason
                rejected.append(rec)
                self._track_reject(reason or "unknown")
            else:
                rec["pin_type"] = pin_type
                rec.update(analyze_pin_style(rec, category))
                kept.append(rec)

        return kept, rejected

    def _should_fetch_related(self, rec: dict) -> bool:
        saves = rec.get("save_count", 0)
        ms    = rec.get("make_similar_score", 0)
        ci    = rec.get("commercial_intent_score", 0)
        threshold = self.args.min_save_count
        return (saves >= threshold and ms >= 7) or (saves >= threshold and ci >= 6)

    # ── DB writes ─────────────────────────────────────────────────────────

    def _write_to_db(self, pins: List[dict], kw_id: Optional[str],
                     category: str) -> None:
        if _db_upsert is None or not pins:
            return

        now_iso = self._now.isoformat()
        sample_rows = []
        for rec in pins:
            if not rec.get("pin_id"):
                continue
            sample_rows.append({
                "pin_id":            rec["pin_id"],
                "trend_keyword_id":  kw_id,
                "source_keyword":    rec.get("source_keyword"),
                "seed_keyword":      rec.get("seed_keyword"),
                "category":          category,
                "title":             (rec.get("title") or "")[:500] or None,
                "description":       (rec.get("description") or "")[:2000] or None,
                "source_url":        rec.get("source_url"),
                "image_url":         rec.get("image_url"),
                "outbound_link":     rec.get("outbound_link"),
                "is_ecommerce":      bool(rec.get("is_ecommerce")),
                "save_count":        int(rec.get("save_count") or 0),
                "reaction_count":    int(rec.get("reaction_count") or 0),
                "comment_count":     int(rec.get("comment_count") or 0),
                "image_ratio":       rec.get("image_ratio"),
                "parent_pin_id":     rec.get("parent_pin_id"),
                "related_rank":      rec.get("related_rank"),
                "source_type":       rec.get("source_type"),
                "created_at_source": rec.get("created_at"),
                "scraped_at":        now_iso,
            })

        try:
            inserted     = _db_upsert("pin_samples", sample_rows, on_conflict="pin_id")
            pin_id_to_db = {str(r["pin_id"]): str(r["id"])
                            for r in inserted if r.get("id")}
            self._stats["db_ok"] += len(inserted)
            log.info(f"  DB: {len(inserted)} pin_samples")
        except Exception as exc:
            log.error(f"  DB pin_samples failed: {exc}")
            self._stats["db_fail"] += len(sample_rows)
            return

        analysis_rows = []
        for rec in pins:
            db_id = pin_id_to_db.get(str(rec.get("pin_id", "")))
            if not db_id:
                continue
            analysis_rows.append({
                "pin_sample_id":           db_id,
                "pin_type":                rec.get("pin_type"),
                "style_tags":              rec.get("style_tags") or [],
                "layout_type":             rec.get("layout_type"),
                "dominant_colors":         rec.get("dominant_colors") or [],
                "has_text_overlay":        bool(rec.get("has_text_overlay")),
                "best_for_products":       rec.get("best_for_products") or [],
                "commercial_intent_score": float(rec.get("commercial_intent_score") or 0),
                "make_similar_score":      float(rec.get("make_similar_score") or 0),
                "prompt_template":         rec.get("prompt_seed"),
                "analysis_reason":         rec.get("analysis_reason"),
                "model_name":              "scraper_heuristic",
                "analyzed_at":             now_iso,
            })

        if analysis_rows:
            try:
                _db_upsert("pin_style_analysis", analysis_rows,
                           on_conflict="pin_sample_id,model_name")
                log.info(f"  DB: {len(analysis_rows)} pin_style_analysis")
            except Exception as exc:
                log.error(f"  DB pin_style_analysis failed: {exc}")

    # ── Output ────────────────────────────────────────────────────────────

    def _save_jsonl(self, path: Path, records: List[dict]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as fh:
            for rec in records:
                out = {k: v for k, v in rec.items() if k != "_raw"}
                fh.write(json.dumps(out, ensure_ascii=False, default=str) + "\n")
        log.info(f"  -> {path.name}: {len(records)} records")

    # ── Summary ───────────────────────────────────────────────────────────

    def _print_summary(self) -> None:
        s   = self._stats
        rr  = self._reject_reasons
        bar = "=" * 62
        print(f"\n{bar}")
        print("  SCRAPING SUMMARY")
        print(bar)
        print(f"  min_save_count filter  {self.args.min_save_count:>6}")
        print(f"  Seeds run              {s['seeds_run']:>6}")
        print(f"  Expanded keywords      {s['expansions']:>6}")
        print(f"  Raw pins captured      {s['raw_pins']:>6}")
        print(f"  Related pins           {s['related_pins']:>6}")
        print(f"  Style library (kept)   {s['style_library']:>6}")
        print(f"  Rejected               {s['rejected']:>6}")
        print(f"    -> save_count_below_5000   "
              f"{rr.get('save_count_below_5000', 0):>6}")
        print(f"    -> missing_save_count      "
              f"{rr.get('missing_save_count', 0):>6}")
        print(f"    -> high_save_low_react_ad  "
              f"{rr.get('high_save_low_reaction_ad_like', 0):>6}")
        print(f"  DB writes OK           {s['db_ok']:>6}")
        print(f"  DB writes failed       {s['db_fail']:>6}")
        if rr:
            print("\n  All reject reasons:")
            for reason, cnt in sorted(rr.items(), key=lambda x: -x[1])[:12]:
                print(f"    {reason:<44} {cnt:>4}")
        print(f"\n  Output: {self.run_dir.resolve()}")
        print(f"{bar}\n")

    # ── Main orchestrator ─────────────────────────────────────────────────

    async def run(self, seed_records: List[dict]) -> None:
        all_expansions: List[dict] = []
        all_raw_pins:   List[dict] = []
        all_related:    List[dict] = []
        all_kept:       List[dict] = []
        all_rejected:   List[dict] = []

        async with async_playwright() as pw:
            ctx  = await self._launch_ctx(pw)
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()

            try:
                await page.goto("https://www.pinterest.com",
                                wait_until="domcontentloaded", timeout=30_000)
                await asyncio.sleep(3)

                if "login" in page.url or "signup" in page.url:
                    log.warning("Pinterest requires login — please sign in "
                                "within 120s …")
                    for _ in range(120):
                        await asyncio.sleep(1)
                        if "login" not in page.url and "signup" not in page.url:
                            log.info("Logged in. Starting scrape.")
                            break
                    else:
                        raise SystemExit("Login timeout.")
                else:
                    log.info("Pinterest ready.")

                for kw_record in seed_records:
                    seed_kw  = kw_record["keyword"]
                    category = kw_record.get("category", self.args.category)
                    kw_id    = str(kw_record["id"]) if kw_record.get("id") else None

                    log.info(f"\n{'-'*50}")
                    log.info(f"Seed: '{seed_kw}'  category={category}")
                    self._stats["seeds_run"] += 1

                    # ── Stage 1: keyword expansion ────────────────────────
                    raw_suggestions = await self.get_autocomplete_keywords(
                        page, seed_kw
                    )
                    scored = sorted(
                        [(s, score_expanded_keyword(s, category))
                         for s in raw_suggestions],
                        key=lambda x: -x[1],
                    )
                    top_expanded = [kw for kw, sc in scored[:self.args.top_expanded]
                                    if sc > 0]
                    if not top_expanded:
                        log.info(f"  No expansions found; using seed directly.")
                        top_expanded = [seed_kw]

                    score_map = dict(scored)
                    for ekw in top_expanded:
                        all_expansions.append({
                            "seed_keyword":     seed_kw,
                            "expanded_keyword": ekw,
                            "category":         category,
                            "intent_score":     score_map.get(ekw, 0),
                            "scraped_at":       self._now.isoformat(),
                        })
                        self._stats["expansions"] += 1

                    log.info(f"  Top expanded keywords: {top_expanded}")

                    # ── Stage 2: search scraping ──────────────────────────
                    kw_raw: List[dict] = []
                    for ekw in top_expanded:
                        pins = await self.scrape_search_results(
                            page, seed_kw, ekw, category,
                            self.args.max_search_pins,
                        )
                        kw_raw.extend(pins)
                        await asyncio.sleep(1.5)

                    # Fetch real save counts
                    if kw_raw:
                        pin_ids = [r["pin_id"] for r in kw_raw if r.get("pin_id")]
                        log.info(f"  Fetching save counts for {len(pin_ids)} pins …")
                        id_to_saves = await self.fetch_save_counts(page, pin_ids)
                        nz  = sum(1 for v in id_to_saves.values() if v > 0)
                        avg = (sum(id_to_saves.values()) / len(id_to_saves)
                               if id_to_saves else 0)
                        log.info(f"  Save counts: {nz}/{len(id_to_saves)} non-zero,"
                                 f" avg={avg:.0f}")
                        for rec in kw_raw:
                            pid = rec.get("pin_id")
                            if pid and pid in id_to_saves:
                                rec["save_count"] = id_to_saves[pid]

                    all_raw_pins.extend(kw_raw)
                    self._stats["raw_pins"] += len(kw_raw)

                    kw_kept, kw_rejected = self.process_pins(kw_raw, category)
                    all_kept.extend(kw_kept)
                    all_rejected.extend(kw_rejected)
                    log.info(f"  Classified: kept={len(kw_kept)}"
                             f" rejected={len(kw_rejected)}")

                    # ── Stage 3: related pins ─────────────────────────────
                    if not self.args.skip_related:
                        parents = [p for p in kw_kept
                                   if self._should_fetch_related(p)]
                        log.info(f"  High-score pins for related fetch: "
                                 f"{len(parents)} (cap 5)")

                        kw_related: List[dict] = []
                        for parent in parents[:5]:
                            related = await self.scrape_related_pins(
                                page, parent, self.args.max_related_pins
                            )
                            kw_related.extend(related)
                            await asyncio.sleep(1)

                        if kw_related:
                            rel_kept, rel_rejected = self.process_pins(
                                kw_related, category
                            )
                            all_related.extend(kw_related)
                            all_kept.extend(rel_kept)
                            all_rejected.extend(rel_rejected)
                            self._stats["related_pins"] += len(kw_related)
                            log.info(f"  Related: kept={len(rel_kept)}"
                                     f" rejected={len(rel_rejected)}")

                    # DB write (per-seed)
                    if not self.args.dry_run:
                        self._write_to_db(kw_kept, kw_id, category)

                    await asyncio.sleep(2)

            finally:
                await ctx.close()

        # ── Deduplicate kept pins by pin_id ───────────────────────────────
        seen_ids: Set[str] = set()
        style_library: List[dict] = []
        for rec in all_kept:
            pid = rec.get("pin_id", "")
            if pid and pid not in seen_ids:
                seen_ids.add(pid)
                style_library.append(rec)

        self._stats["style_library"] = len(style_library)

        # ── Write output files ────────────────────────────────────────────
        self._save_jsonl(self.run_dir / "keyword_expansions.jsonl", all_expansions)
        self._save_jsonl(self.run_dir / "raw_pins.jsonl",           all_raw_pins)
        self._save_jsonl(self.run_dir / "related_pins.jsonl",       all_related)
        self._save_jsonl(self.run_dir / "style_library.jsonl",      style_library)
        self._save_jsonl(self.run_dir / "rejected_pins.jsonl",      all_rejected)

        self._print_summary()


# ══════════════════════════════════════════════════════════════════════════════
# SEED KEYWORD LOADING
# ══════════════════════════════════════════════════════════════════════════════

def _compute_priority(row: dict) -> float:
    try:
        monthly = float(row.get("monthly_change") or 0)
        weekly  = float(row.get("weekly_change")  or 0)
        yearly  = float(row.get("yearly_change")  or 0)
    except (TypeError, ValueError):
        monthly = weekly = yearly = 0.0
    score = monthly * 3.0 + weekly * 2.0 + yearly * 1.0
    kw = str(row.get("keyword", "")).lower()
    if any(b in kw for b in BONUS_KEYWORDS):
        score += 10
    return score if score > 0 else 50.0


def _load_seed_records(args: argparse.Namespace) -> List[dict]:
    cat = args.category  # "home" | "fashion" | "beauty" | "all"

    if args.keywords:
        records = [{"id": None, "keyword": kw,
                    "category": cat if cat != "all" else "home"}
                   for kw in args.keywords]
        return records[:args.limit_keywords] if args.limit_keywords else records

    # Try Supabase
    if _db_select_many is not None:
        try:
            filters = {"status": "active"}
            if cat != "all":
                filters["category"] = cat
            records = _db_select_many(
                "trend_keywords",
                filters=filters,
                order="priority_score.desc,last_scraped_at.asc",
                limit=args.limit_keywords,
            )
            if records:
                log.info(f"Loaded {len(records)} seed keywords from Supabase")
                return records
            log.warning("Supabase returned no active keywords; falling back to CSV")
        except Exception as exc:
            log.warning(f"Supabase load failed ({exc}); falling back to CSV")

    # CSV fallback
    csv_path = (Path(args.keyword_file) if args.keyword_file
                else Path(__file__).parent / "trend_keywords_seed.csv")
    if not csv_path.exists():
        log.error(f"CSV not found: {csv_path}")
        raise SystemExit(1)

    records = []
    with csv_path.open(encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            kw  = row.get("keyword", "").strip()
            row_cat = row.get("category", "home").strip()
            if not kw:
                continue
            if cat != "all" and row_cat != cat:
                continue
            if row.get("status", "active").strip().lower() == "rejected":
                continue
            records.append({
                "id":             None,
                "keyword":        kw,
                "category":       row_cat,
                "priority_score": _compute_priority(row),
            })

    records.sort(key=lambda x: -float(x.get("priority_score") or 0))
    if args.limit_keywords:
        records = records[:args.limit_keywords]

    log.info(f"Loaded {len(records)} seed keywords from CSV (category={cat})")
    for r in records:
        log.info(f"  [{r['category']}] {r['keyword']}  score={r['priority_score']:.0f}")
    return records


# ══════════════════════════════════════════════════════════════════════════════
# CLI
# ══════════════════════════════════════════════════════════════════════════════

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Pinterest Vibe Library Scraper — multi-category, 3-stage",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  py scraper.py --category home    --limit-keywords 2
  py scraper.py --category fashion --limit-keywords 2 --max-search-pins 30
  py scraper.py --category beauty  --limit-keywords 2 --dry-run
  py scraper.py --category all     --limit-keywords 5 --skip-related
""",
    )
    p.add_argument("--category",              default="home",
                   choices=["home", "fashion", "beauty", "all"],
                   help="Category to scrape (default: home)")
    p.add_argument("--keywords",              nargs="+", metavar="KW",
                   help="Override seed keywords manually")
    p.add_argument("--keyword-file",          metavar="FILE",
                   help="Path to seed CSV (default: trend_keywords_seed.csv)")
    p.add_argument("--limit-keywords",        type=int, default=None,
                   help="Max seed keywords to process")
    p.add_argument("--max-search-pins",       type=int, default=30,
                   dest="max_search_pins",
                   help="Max pins per expanded keyword (default: 30)")
    p.add_argument("--max-related-pins",      type=int, default=20,
                   dest="max_related_pins",
                   help="Max related pins per parent pin (default: 20)")
    p.add_argument("--top-expanded",          type=int, default=3,
                   dest="top_expanded",
                   help="Top N autocomplete expansions per seed (default: 3)")
    p.add_argument("--min-save-count",         type=int, default=5000,
                   dest="min_save_count",
                   help="Min save_count for aesthetic/blog pins (default: 5000)")
    p.add_argument("--min-save-count-product", type=int, default=1000,
                   dest="min_save_count_product",
                   help="Min save_count for ecommerce product pins (default: 1000)")
    p.add_argument("--min-commercial-score",  type=int, default=6,
                   dest="min_commercial_score",
                   help="Min commercial intent score for product_lead (default: 6)")
    p.add_argument("--min-make-similar-score", type=int, default=7,
                   dest="min_make_similar_score",
                   help="Min make-similar score for aesthetic_trend (default: 7)")
    p.add_argument("--skip-related",          action="store_true", default=False,
                   help="Skip Stage 3 (related pins from detail pages)")
    p.add_argument("--dry-run",               action="store_true", default=False,
                   help="Scrape and classify only; skip Supabase writes")
    p.add_argument("--headless",              action="store_true", default=False,
                   help="Run browser headless")
    p.add_argument("--user-data-dir",
                   default=os.path.expandvars(r"%LOCALAPPDATA%\PinterestScraper\profile"),
                   help="Chrome profile directory")
    p.add_argument("--output-dir",            default="vibe_library",
                   help="Output base directory (default: vibe_library)")
    return p.parse_args()


# ══════════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    _args    = _parse_args()
    _records = _load_seed_records(_args)
    if not _records:
        log.error("No seed keywords found. Exiting.")
        raise SystemExit(1)
    asyncio.run(PinterestScraper(_args).run(_records))
