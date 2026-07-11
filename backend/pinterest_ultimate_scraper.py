#!/usr/bin/env python3
"""
pinterest_ultimate_scraper.py  —  Pinterest Home Decor Vibe Library Builder

Classifies pins into:
  aesthetic_trends  – High-save visually appealing home decor images
  product_leads     – Pins with external e-commerce links

Quick start:
  python pinterest_ultimate_scraper.py
  python pinterest_ultimate_scraper.py --max-scrolls 30 --no-download-images
  python pinterest_ultimate_scraper.py --keywords "japandi decor" "wabi sabi interior"
"""

import asyncio
import argparse
import hashlib
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

# ── Supabase DB helpers (optional — skipped if db/ not installed) ──────────
_db_upsert = _db_update_where = _db_select_many = None
try:
    import sys as _sys
    _sys.path.insert(0, str(Path(__file__).parent / "db"))
    from db import upsert as _db_upsert            # type: ignore[assignment]
    from db import update_where as _db_update_where  # type: ignore[assignment]
    from db import select_many as _db_select_many    # type: ignore[assignment]
except Exception:
    pass

import httpx
import pandas as pd
from playwright.async_api import async_playwright, Page, Response
from tqdm import tqdm


# ══════════════════════════════════════════════════════════════════════════════
# CONSTANTS
# ══════════════════════════════════════════════════════════════════════════════

DEFAULT_KEYWORDS: List[str] = [
    "living room decor ideas",
    "cozy bedroom decor",
    "vintage home decor",
    "boho living room ideas",
    "neutral living room decor",
    "modern farmhouse decor",
    "small apartment decor",
    "wall art decor ideas",
    "coffee table styling",
    "home decor collage",
]

SOCIAL_DOMAINS: Set[str] = {
    "pinterest.com", "instagram.com", "facebook.com", "tiktok.com",
    "twitter.com", "x.com", "youtube.com", "reddit.com", "tumblr.com",
    "snapchat.com", "linkedin.com", "whatsapp.com", "threads.net",
    "vk.com", "weibo.com",
}

ECOMMERCE_DOMAINS: Set[str] = {
    "etsy.com", "amazon.com", "amazon.co.uk", "amazon.de", "amazon.fr",
    "amazon.ca", "amazon.co.jp", "amazon.com.au", "shopify.com",
    "ebay.com", "ebay.co.uk", "wayfair.com", "target.com", "walmart.com",
    "homedepot.com", "westelm.com", "cb2.com", "crateandbarrel.com",
}

HOME_DECOR_KWS: List[str] = [
    "decor", "home", "living", "bedroom", "kitchen", "bathroom", "room",
    "furniture", "interior", "design", "style", "cozy", "aesthetic", "boho",
    "farmhouse", "vintage", "modern", "wall", "shelf", "table", "chair",
    "lamp", "rug", "curtain", "pillow", "vase", "plant", "candle", "art",
]

COMMERCIAL_KWS: List[str] = [
    "shop", "buy", "product", "gift", "finds", "decor", "sale", "discount",
    "price", "order", "store", "market", "deal", "get", "link in bio",
]

# API URL fragments that suggest JSON pin data
API_FRAGMENTS: List[str] = [
    "/resource/", "/search/", "/graphql", "/seo/", "/feed/",
    "/baseboards/", "/pins/", "/unified/", "/v3/", "/api/v",
    "get_pin", "SearchResource", "PinResource", "RelatedPinFeed",
    "BoardFeedResource", "UserHomeFeedResource",
]

# Ordered image-size preference for extraction
IMAGE_SIZE_PRIORITY: List[str] = [
    "orig", "originals", "736x", "564x", "474x", "345x", "236x", "170x",
]

OUTPUT_FIELDS: List[str] = [
    "pin_id", "source_keyword", "pin_type", "title",
    "save_count", "reaction_count", "reaction_save_ratio",
    "created_at", "date_unknown", "image_url", "local_image_path",
    "outbound_link", "domain", "is_ecommerce",
    "commercial_intent_score", "make_similar_score",
    "reject_reason", "source_url", "scraped_at",
    "download_status", "download_error",
]


# ══════════════════════════════════════════════════════════════════════════════
# LOGGING
# ══════════════════════════════════════════════════════════════════════════════

def _setup_logging() -> logging.Logger:
    fmt = "%(asctime)s [%(levelname)-8s] %(message)s"
    # Force UTF-8 on Windows stdout to avoid GBK codec errors with non-ASCII chars
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
        netloc = urlparse(url).netloc.lower()
        return netloc.removeprefix("www.")
    except Exception:
        return ""


def normalize_url(url: str) -> str:
    """Strip query string and fragment for deduplication."""
    if not url:
        return ""
    try:
        p = urlparse(url)
        return urlunparse((p.scheme, p.netloc, p.path, "", "", "")).rstrip("/")
    except Exception:
        return url


def _domain_in(url: str, domain_set: Set[str]) -> bool:
    d = get_domain(url)
    if not d:
        return False
    return any(d == s or d.endswith("." + s) for s in domain_set)


def is_social_domain(url: str) -> bool:
    return _domain_in(url, SOCIAL_DOMAINS)


def is_ecommerce_domain(url: str) -> bool:
    if not url:
        return False
    if "myshopify.com" in get_domain(url):
        return True
    return _domain_in(url, ECOMMERCE_DOMAINS)


# ══════════════════════════════════════════════════════════════════════════════
# RECURSIVE JSON TRAVERSAL
# ══════════════════════════════════════════════════════════════════════════════

def _nested_get(obj: Any, path: str) -> Any:
    """Dot-separated path lookup; returns None on any miss."""
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
    """Heuristic: does this dict resemble a Pinterest pin?"""
    if not isinstance(obj, dict):
        return False
    has_id = bool(obj.get("id") or obj.get("pin_id") or obj.get("pinId"))
    if not has_id:
        return False
    pin_signals = {
        "images", "save_count", "repin_count", "saves", "grid_title",
        "closeup_description", "domain", "outbound_link", "rich_metadata",
        "shopping_links", "aggregated_pin_data",
    }
    generic = {"title", "description", "image_url", "link", "type"}
    return bool(pin_signals & obj.keys()) or len(generic & obj.keys()) >= 2


def find_pins(data: Any, depth: int = 0, max_depth: int = 14) -> List[dict]:
    """Recursively collect all pin-like dicts from an arbitrary JSON structure."""
    if depth > max_depth:
        return []
    results: List[dict] = []
    if isinstance(data, dict):
        if _looks_like_pin(data):
            results.append(data)
        # Always recurse: a pin can contain nested related pins
        for v in data.values():
            if isinstance(v, (dict, list)):
                results.extend(find_pins(v, depth + 1, max_depth))
    elif isinstance(data, list):
        for item in data:
            results.extend(find_pins(item, depth + 1, max_depth))
    return results


# ══════════════════════════════════════════════════════════════════════════════
# FIELD EXTRACTION
# ══════════════════════════════════════════════════════════════════════════════

def _first(*vals) -> Any:
    for v in vals:
        if v is not None:
            return v
    return None


def extract_pin_id(obj: dict) -> Optional[str]:
    v = _first(obj.get("id"), obj.get("pin_id"), obj.get("pinId"))
    return str(v) if v is not None else None


def extract_title(obj: dict) -> str:
    v = _first(
        obj.get("title"),
        obj.get("grid_title"),
        obj.get("description"),
        obj.get("closeup_description"),
    )
    return str(v).strip()[:500] if v else ""


def extract_image_url(obj: dict) -> Optional[str]:
    # Try dot-path shortcuts first
    for path in (
        "images.orig.url", "images.originals.url",
        "images.736x.url", "images.564x.url",
        "media.images.orig.url", "media.images.736x.url",
        "image_url",
    ):
        url = _nested_get(obj, path)
        if url and isinstance(url, str) and url.startswith("http"):
            return url

    # Walk the images dict by priority
    images = obj.get("images")
    if isinstance(images, dict):
        for size in IMAGE_SIZE_PRIORITY:
            img = images.get(size)
            if isinstance(img, dict):
                url = img.get("url")
                if url and isinstance(url, str) and url.startswith("http"):
                    return url
    return None


def extract_outbound_link(obj: dict) -> Optional[str]:
    def _ok(url: Any) -> bool:
        return (
            isinstance(url, str)
            and url.startswith("http")
            and "pinterest.com" not in url
        )

    for key in ("link", "outbound_link", "product_url"):
        url = obj.get(key)
        if _ok(url):
            return url

    url = _nested_get(obj, "rich_metadata.url")
    if _ok(url):
        return url

    for container_key in ("shopping_links", "closeups", "shop_the_look"):
        for item in (obj.get(container_key) or []):
            if isinstance(item, dict):
                url = item.get("url") or item.get("link")
                if _ok(url):
                    return url

    # domain field as last-resort hint
    domain = obj.get("domain")
    if isinstance(domain, str) and "." in domain:
        excluded = ("pinterest", "instagram", "facebook", "tiktok", "twitter", "youtube")
        if not any(x in domain for x in excluded):
            return f"https://{domain}"
    return None


def extract_save_count(obj: dict) -> int:
    for val in (
        obj.get("save_count"),
        obj.get("saves"),
        obj.get("repin_count"),
        _nested_get(obj, "aggregated_pin_data.aggregated_stats.saves"),
    ):
        if val is not None:
            try:
                return int(val)
            except (TypeError, ValueError):
                pass
    return 0


def extract_reaction_count(obj: dict) -> int:
    for val in (
        obj.get("reaction_counts"),
        obj.get("reaction_count"),
        obj.get("total_reaction_count"),
        obj.get("comment_count"),
        obj.get("comments"),
        _nested_get(obj, "aggregated_pin_data.aggregated_stats.reactions"),
    ):
        if val is None:
            continue
        if isinstance(val, dict):
            try:
                return sum(int(v) for v in val.values()
                           if isinstance(v, (int, float, str)) and str(v).isdigit())
            except Exception:
                pass
        try:
            return int(val)
        except (TypeError, ValueError):
            pass
    return 0


def extract_created_at(obj: dict) -> Tuple[Optional[datetime], bool]:
    """Returns (datetime_utc | None, date_unknown: bool)."""
    from email.utils import parsedate_to_datetime
    for key in ("created_at", "createdAt", "created_time", "timestamp"):
        val = obj.get(key)
        if val is None:
            continue
        try:
            if isinstance(val, (int, float)) and val > 0:
                return datetime.fromtimestamp(float(val), tz=timezone.utc), False
            if isinstance(val, str) and val:
                # Try RFC 2822 first (Pinterest API format: "Sat, 10 Jan 2026 00:31:20 +0000")
                try:
                    return parsedate_to_datetime(val), False
                except Exception:
                    pass
                # Fallback to ISO 8601
                return datetime.fromisoformat(val.replace("Z", "+00:00")), False
        except Exception:
            pass
    return None, True


# ══════════════════════════════════════════════════════════════════════════════
# RECORD CONSTRUCTION
# ══════════════════════════════════════════════════════════════════════════════

def build_record(obj: dict, keyword: str, now: datetime) -> Optional[dict]:
    pin_id = extract_pin_id(obj)
    if pin_id is None:
        return None

    image_url     = extract_image_url(obj)
    outbound_link = extract_outbound_link(obj)
    save_count    = extract_save_count(obj)
    reaction_count = extract_reaction_count(obj)
    created_at, date_unknown = extract_created_at(obj)
    title         = extract_title(obj)
    domain        = get_domain(outbound_link) if outbound_link else (obj.get("domain") or "")

    return {
        "pin_id":          pin_id,
        "source_keyword":  keyword,
        "pin_type":        None,
        "title":           title,
        "save_count":      save_count,
        "reaction_count":  reaction_count,
        "reaction_save_ratio": round(reaction_count / max(save_count, 1), 4),
        "created_at":      created_at.isoformat() if created_at else None,
        "date_unknown":    date_unknown,
        "image_url":       image_url,
        "local_image_path": None,
        "outbound_link":   outbound_link,
        "domain":          domain,
        "is_ecommerce":    is_ecommerce_domain(outbound_link) if outbound_link else False,
        "commercial_intent_score": 0,
        "make_similar_score":      0,
        "reject_reason":   None,
        "source_url": (
            f"https://www.pinterest.com/search/pins/"
            f"?q={keyword.replace(' ', '%20')}"
        ),
        "scraped_at":      now.isoformat(),
        "download_status": None,
        "download_error":  None,
        "_raw":            obj,   # stripped before file output
    }


# ══════════════════════════════════════════════════════════════════════════════
# SCORING
# ══════════════════════════════════════════════════════════════════════════════

def score_commercial_intent(rec: dict) -> int:
    score = 0
    raw   = rec.get("_raw", {})

    if rec["outbound_link"]:
        score += 3

    if any(kw in rec["title"].lower() for kw in COMMERCIAL_KWS):
        score += 2

    d = rec["domain"]
    if d and ("etsy.com" in d or "amazon.com" in d or "myshopify.com" in d):
        score += 2

    if rec["save_count"] > 1000:
        score += 1

    price_val = (
        _nested_get(raw, "rich_metadata.price")
        or _nested_get(raw, "price")
        or _nested_get(raw, "buyable_product.price_value")
    )
    if price_val is not None:
        score += 2

    img = rec.get("image_url") or ""
    if "736x" in img or "orig" in img or "564x" in img:
        score += 1  # standard Pinterest portrait sizes

    return min(score, 10)


def score_make_similar(rec: dict) -> int:
    score = 0
    img   = rec.get("image_url") or ""

    if img:
        if "736x" in img or "564x" in img or "474x" in img:
            score += 2  # canonical Pinterest vertical sizes
        else:
            score += 1

    saves = rec["save_count"]
    if saves >= 10_000:
        score += 2
    elif saves >= 1_000:
        score += 1

    if len(rec["title"]) > 10:
        score += 1

    if rec.get("reject_reason") != "low_quality_ad":
        score += 2

    if any(kw in rec["title"].lower() for kw in HOME_DECOR_KWS):
        score += 2

    if "orig" in img:
        score += 1

    # Penalise pins with unknown date — less trustworthy as trend reference
    if rec.get("date_unknown"):
        score = max(0, score - 2)

    return min(score, 10)


# ══════════════════════════════════════════════════════════════════════════════
# EXTENDED HEURISTIC ANALYSIS  (style_tags, prompt_seed, patterns, etc.)
# ══════════════════════════════════════════════════════════════════════════════

_STYLE_POOL: Dict[str, List[str]] = {
    "home":    ["minimalist", "boho", "farmhouse", "vintage", "modern", "cozy",
                "neutral", "aesthetic", "scandinavian", "japandi", "maximalist",
                "eclectic", "industrial", "cottagecore"],
    "fashion": ["casual", "chic", "streetwear", "formal", "bohemian", "preppy",
                "minimalist", "aesthetic", "y2k", "cottagecore", "dark academia",
                "old money", "coastal grandmother"],
    "beauty":  ["natural", "glam", "minimal", "bold", "soft", "clean", "dewy",
                "editorial", "everyday", "grunge", "coquette", "clean girl"],
}

_BEST_FOR: Dict[str, List[str]] = {
    "home":    ["throw pillows", "rugs", "candles", "wall art", "vases",
                "lighting fixtures", "shelving", "storage baskets", "plants"],
    "fashion": ["clothing", "accessories", "shoes", "bags", "jewelry", "outerwear"],
    "beauty":  ["skincare", "makeup", "nail products", "hair care",
                "fragrances", "beauty tools"],
}

_PROMPT_SEEDS: Dict[str, str] = {
    "home":    ("cozy interior, warm soft lighting, minimal clutter, "
                "Pinterest-worthy composition, high-end aesthetic, soft shadows"),
    "fashion": ("stylish outfit flatlay, clean neutral background, "
                "trendy fashion, aesthetic composition, soft natural light"),
    "beauty":  ("beauty product arrangement, soft pink or neutral background, "
                "glowy aesthetic, studio light, clean flatlay, pastel tones"),
}

_TITLE_PATTERNS: Dict[str, str] = {
    "home":    "{Style} {Keyword} | Home Inspo 🏠",
    "fashion": "{Season} {Keyword} Looks You Need 🔥",
    "beauty":  "{Keyword} Tutorial | {Trend} Aesthetic 💄",
}

_DESC_PATTERNS: Dict[str, str] = {
    "home":    ("Transform your space with these {keyword} ideas. "
                "Save for your next home refresh! ✨ #homedecor #interiordesign"),
    "fashion": ("Obsessed with this {keyword} look! Perfect for every occasion 🔥 "
                "#fashion #ootd #style"),
    "beauty":  ("This {keyword} is everything 💅 Try it and tag us! "
                "#beauty #makeup #nails"),
}


def generate_extended_analysis(rec: dict, category: str) -> dict:
    """
    Heuristic style analysis for a pin record.
    Produces style_tags, layout_type, has_text_overlay, best_for_products,
    prompt_seed, title_pattern, description_pattern.
    """
    title   = (rec.get("title") or "").lower()
    keyword = (rec.get("source_keyword") or "").lower()
    text    = f"{keyword} {title}"

    # Style tags
    pool       = _STYLE_POOL.get(category, _STYLE_POOL["home"])
    style_tags = [s for s in pool if s in text] or ["aesthetic"]

    # Layout type
    if any(w in text for w in ("collage", "ideas", "collection")):
        layout = "collage"
    elif any(w in text for w in ("outfit", "look", "ootd", "wear")):
        layout = "outfit_flatlay"
    elif any(w in text for w in ("tutorial", "step", "how to", "diy")):
        layout = "tutorial_steps"
    elif any(w in text for w in ("nails", "nail")):
        layout = "nail_closeup"
    else:
        layout = "single_image"

    # Text overlay hint
    has_text = any(w in title for w in ("how", "tips", "ideas", "ways",
                                        "#", "vs", "tutorial", "guide"))

    # Best-for products
    best_pool = _BEST_FOR.get(category, _BEST_FOR["home"])
    best_for  = [p for p in best_pool if any(w in text for w in p.split())]
    if not best_for:
        best_for = best_pool[:3]

    # Prompt seed
    extra_style = ", ".join(style_tags[:3])
    base_seed   = _PROMPT_SEEDS.get(category, _PROMPT_SEEDS["home"])
    prompt_seed = f"{extra_style}, {base_seed}" if extra_style else base_seed

    # Patterns
    kw_title = keyword.title()
    title_pattern = _TITLE_PATTERNS.get(category, "{Keyword} Ideas").replace("{Keyword}", kw_title)
    desc_pattern  = _DESC_PATTERNS.get(category, "Trending {keyword} inspiration").replace(
        "{keyword}", keyword
    )

    return {
        "style_tags":          style_tags,
        "layout_type":         layout,
        "has_text_overlay":    has_text,
        "best_for_products":   best_for[:5],
        "prompt_seed":         prompt_seed,
        "title_pattern":       title_pattern,
        "description_pattern": desc_pattern,
    }


# ══════════════════════════════════════════════════════════════════════════════
# CLASSIFICATION
# ══════════════════════════════════════════════════════════════════════════════

def classify(
    rec: dict,
    min_saves_aesthetic: int,
    min_saves_product: int,
    max_age_days: int,
) -> Tuple[Optional[str], Optional[str]]:
    """
    Returns (pin_type | None, reject_reason | None).
    pin_type ∈ {"aesthetic_trend", "product_lead", "both"}

    Pinterest search API (BaseSearchResource) does not return save_count;
    reaction_count is used as the primary engagement signal when saves == 0.
    """
    saves     = rec["save_count"]
    reactions = rec["reaction_count"]
    img       = rec["image_url"]
    link      = rec["outbound_link"]
    date_unknown = rec["date_unknown"]
    created_at_str = rec["created_at"]

    # ── Low-quality ad filter (Rule from spec) ────────────────────────────
    # High saves but almost no reactions → likely a paid ad, not organic content
    if saves > 1000 and reactions < 10:
        return None, "low_quality_ad"

    # Use reaction_count as proxy when save_count is unavailable
    engagement = saves if saves > 0 else reactions

    # ── Age check ─────────────────────────────────────────────────────────
    is_fresh = True
    if not date_unknown and created_at_str:
        try:
            dt = datetime.fromisoformat(created_at_str)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            is_fresh = (datetime.now(tz=timezone.utc) - dt).days <= max_age_days
        except Exception:
            pass

    # ── Rule A: aesthetic_trend ───────────────────────────────────────────
    aesthetic = bool(img) and engagement >= min_saves_aesthetic and is_fresh

    # ── Rule B: product_lead ─────────────────────────────────────────────
    product = (
        bool(img)
        and bool(link)
        and engagement >= min_saves_product
        and not is_social_domain(link)
    )

    if aesthetic and product:
        return "both", None
    if aesthetic:
        return "aesthetic_trend", None
    if product:
        return "product_lead", None

    reasons: List[str] = []
    if not img:
        reasons.append("no_image")
    if engagement < min_saves_aesthetic and not link:
        reasons.append(f"low_engagement_{engagement}")
    if not is_fresh:
        reasons.append("too_old")
    if link and is_social_domain(link):
        reasons.append("social_domain_link")
    if not link and engagement < min_saves_product:
        reasons.append("no_product_link")
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
        pid  = rec.get("pin_id") or ""
        nimg = normalize_url(rec.get("image_url") or "")
        if pid:  self._ids.add(pid)
        if nimg: self._imgs.add(nimg)


# ══════════════════════════════════════════════════════════════════════════════
# IMAGE DOWNLOAD
# ══════════════════════════════════════════════════════════════════════════════

async def download_image(
    client: httpx.AsyncClient,
    rec: dict,
    images_dir: Path,
) -> None:
    """Download pin image; mutates rec in-place with result fields."""
    url = rec.get("image_url")
    if not url:
        rec["download_status"] = "no_url"
        return

    pin_id = rec.get("pin_id")
    fname  = f"{pin_id}.jpg" if pin_id else f"{hashlib.md5(url.encode()).hexdigest()[:12]}.jpg"
    dest   = images_dir / fname

    if dest.exists():
        rec["local_image_path"] = str(dest)
        rec["download_status"]  = "cached"
        return

    try:
        resp = await client.get(url, timeout=15.0, follow_redirects=True)
        resp.raise_for_status()
        dest.write_bytes(resp.content)
        rec["local_image_path"] = str(dest)
        rec["download_status"]  = "success"
    except Exception as exc:
        rec["download_status"] = "failed"
        rec["download_error"]  = str(exc)[:200]


# ══════════════════════════════════════════════════════════════════════════════
# OUTPUT HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def _clean(rec: dict) -> dict:
    """Return only the public output fields (strips _raw etc.)."""
    return {k: rec.get(k) for k in OUTPUT_FIELDS}


def write_json(recs: List[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump([_clean(r) for r in recs], fh, ensure_ascii=False,
                  indent=2, default=str)
    log.info(f"Wrote {len(recs):,} records  →  {path}")


def write_jsonl(recs: List[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for r in recs:
            fh.write(json.dumps(_clean(r), ensure_ascii=False, default=str) + "\n")
    log.info(f"Wrote {len(recs):,} records  →  {path}")


def write_csv(recs: List[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not recs:
        path.write_text("", encoding="utf-8")
        log.info(f"Wrote 0 records  →  {path}")
        return
    df = pd.DataFrame([_clean(r) for r in recs])
    for col in OUTPUT_FIELDS:
        if col not in df.columns:
            df[col] = None
    df[OUTPUT_FIELDS].to_csv(path, index=False, encoding="utf-8-sig")
    log.info(f"Wrote {len(recs):,} records  →  {path}")


def write_raw_samples(samples: List[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for s in samples:
            fh.write(json.dumps(s, ensure_ascii=False, default=str) + "\n")
    log.info(f"Wrote {len(samples)} raw samples  →  {path}")


# ══════════════════════════════════════════════════════════════════════════════
# CHROME DETECTION
# ══════════════════════════════════════════════════════════════════════════════

def find_chrome() -> Optional[str]:
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        r"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
    ]
    for p in candidates:
        if p and os.path.isfile(p):
            log.info(f"Chrome found: {p}")
            return p
    log.warning("Chrome binary not found in common paths; will use Playwright's bundled Chromium.")
    return None


# ══════════════════════════════════════════════════════════════════════════════
# SCRAPER
# ══════════════════════════════════════════════════════════════════════════════

class PinterestScraper:

    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self._now = datetime.now(tz=timezone.utc)

        # Collections
        self.kept:        List[dict] = []
        self.rejected:    List[dict] = []
        self.raw_samples: List[dict] = []
        self.dedup = Dedup()

        # Per-keyword buffer (filled by _ingest_pin, drained by _process_keyword_buffer)
        self._kw_buffer:  List[dict] = []

        # Current keyword (mutable state for response handler)
        self._kw = ""

        # Stats
        self._c: Dict[str, int] = dict(
            found=0, aesthetic=0, product=0, both=0,
            rejected=0, dl_ok=0, dl_fail=0,
        )

        # Directories
        base            = Path(args.output_dir)
        self.images_dir = base / "images"
        self.raw_dir    = base / "raw"
        self.out_dir    = base / "output"
        for d in (self.images_dir, self.raw_dir, self.out_dir):
            d.mkdir(parents=True, exist_ok=True)

    # ── Response handler ──────────────────────────────────────────────────

    async def _on_response(self, response: Response) -> None:
        url_str = str(response.url)

        if not any(frag in url_str for frag in API_FRAGMENTS):
            return

        ct = response.headers.get("content-type", "")
        if "json" not in ct and "javascript" not in ct:
            return

        try:
            text = await response.text()
        except Exception:
            return

        if len(text) < 80:
            return

        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return

        raw_pins = find_pins(data)
        if not raw_pins:
            return

        log.debug(f"  {len(raw_pins)} raw pin objects ← {url_str[:100]}")

        # Save samples for debugging (≤ 100 total, ≤ 3 per response)
        if len(self.raw_samples) < 100:
            for p in raw_pins[:3]:
                self.raw_samples.append({
                    "endpoint":    url_str,
                    "keyword":     self._kw,
                    "captured_at": self._now.isoformat(),
                    "sample":      p,
                })

        for raw in raw_pins:
            try:
                self._ingest_pin(raw)
            except Exception as exc:
                log.debug(f"  Pin ingest error: {exc}")

    def _ingest_pin(self, raw: dict) -> None:
        rec = build_record(raw, self._kw, self._now)
        if rec is None:
            return

        if self.dedup.is_dup(rec):
            return
        self.dedup.register(rec)
        self._c["found"] += 1
        self._kw_buffer.append(rec)

    # ── Per-keyword scraping ──────────────────────────────────────────────

    async def _scrape_keyword(self, page: Page, keyword: str) -> None:
        log.info(f"┌── Keyword: '{keyword}'")
        self._kw = keyword
        before   = self._c["found"]

        url = (
            f"https://www.pinterest.com/search/pins/"
            f"?q={keyword.replace(' ', '%20')}&rs=typed"
        )

        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            await asyncio.sleep(3)   # let the initial feed load

            for i in range(self.args.max_scrolls):
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await asyncio.sleep(2)

                if (i + 1) % 5 == 0 or i == self.args.max_scrolls - 1:
                    log.info(
                        f"│   scroll {i+1:2d}/{self.args.max_scrolls} "
                        f"│ +{self._c['found'] - before} new pins this keyword"
                    )

        except Exception as exc:
            log.error(f"│  ERROR: {exc}")

        log.info(
            f"└── Done '{keyword}' — "
            f"{self._c['found'] - before} new pins  "
            f"(kept total: {len(self.kept)})"
        )

    # ── Fetch real save counts via PinResource ────────────────────────────

    async def _fetch_saves_for_pins(self, page: Page,
                                    pin_ids: List[str]) -> Dict[str, int]:
        """Call PinResource API for a list of pin_ids; return {pin_id: saves}."""
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
                        "id": pid,
                        "field_set_key": "detailed",
                        "fetch_visual_search_objects": True,
                        "add_fields": "pin.gen_ai_topics",
                    },
                    "context": {},
                })
                params = urllib.parse.urlencode({
                    "_": ts,
                    "data": data,
                    "source_url": "/homefeed/",
                })
                urls.append(
                    f"https://www.pinterest.com/resource/PinResource/get/?{params}"
                )

            try:
                results = await page.evaluate(
                    """async (urls) => {
                        return await Promise.all(urls.map(url =>
                            fetch(url, {
                                method: 'GET',
                                headers: {
                                    'Accept': 'application/json',
                                    'Content-Type': 'application/json',
                                    'x-pinterest-pws-handler': 'www/homefeed.js'
                                }
                            })
                            .then(r => r.ok ? r.json() : null)
                            .catch(() => null)
                        ));
                    }""",
                    urls,
                )
                for j, resp in enumerate(results):
                    if resp:
                        pin_data = (resp.get("resource_response") or {}).get("data") or {}
                        saves = pin_data.get("repin_count") or pin_data.get("save_count") or 0
                        id_to_saves[batch[j]] = int(saves)
            except Exception as exc:
                log.debug(f"PinResource batch error: {exc}")

            if (i // batch_size + 1) % 10 == 0:
                await asyncio.sleep(0.3)

        return id_to_saves

    # ── Per-keyword buffer processing ────────────────────────────────────

    async def _process_keyword_buffer(
        self, page: Page, kw_record: dict
    ) -> Tuple[int, int]:
        """
        Drain self._kw_buffer for one keyword:
          1. Fetch real save counts
          2. Classify + score + extended analysis
          3. Apply max-pins-per-keyword cap
          4. Write to Supabase (unless --dry-run)
          5. Extend global self.kept / self.rejected
        Returns (n_kept, n_rejected).
        """
        if not self._kw_buffer:
            return 0, 0

        category = kw_record.get("category") or self.args.category
        pin_ids  = [r["pin_id"] for r in self._kw_buffer if r.get("pin_id")]

        # 1 — real save counts
        log.info(f"  获取收藏数: {len(pin_ids)} pins …")
        id_to_saves = await self._fetch_saves_for_pins(page, pin_ids)
        non_zero = sum(1 for v in id_to_saves.values() if v > 0)
        avg = (sum(id_to_saves.values()) / len(id_to_saves)) if id_to_saves else 0
        log.info(f"  收藏数: {non_zero}/{len(id_to_saves)} 非零, 均值 {avg:.0f}")

        for rec in self._kw_buffer:
            pid = rec.get("pin_id")
            if pid and pid in id_to_saves:
                rec["save_count"] = id_to_saves[pid]

        # 2 — classify + score + extended analysis
        kw_kept: List[dict]     = []
        kw_rejected: List[dict] = []

        for rec in self._kw_buffer:
            pin_type, reject_reason = classify(
                rec,
                self.args.min_saves_aesthetic,
                self.args.min_saves_product,
                self.args.max_age_days,
            )
            if pin_type is None:
                rec["reject_reason"] = reject_reason
                kw_rejected.append(rec)
                self._c["rejected"] += 1
            else:
                rec["pin_type"]                = pin_type
                rec["commercial_intent_score"] = score_commercial_intent(rec)
                rec["make_similar_score"]      = score_make_similar(rec)
                rec.update(generate_extended_analysis(rec, category))
                kw_kept.append(rec)
                if pin_type == "aesthetic_trend":
                    self._c["aesthetic"] += 1
                elif pin_type == "product_lead":
                    self._c["product"] += 1
                elif pin_type == "both":
                    self._c["both"] += 1

        # 3 — max-pins-per-keyword cap
        max_pins = self.args.max_pins_per_keyword
        if max_pins and len(kw_kept) > max_pins:
            kw_kept.sort(key=lambda x: -x.get("save_count", 0))
            for overflow_rec in kw_kept[max_pins:]:
                overflow_rec["reject_reason"] = "over_per_keyword_limit"
                kw_rejected.append(overflow_rec)
                self._c["rejected"] += 1
            kw_kept = kw_kept[:max_pins]

        # 4 — write to DB
        if not self.args.dry_run:
            self._write_keyword_to_db(kw_kept, kw_record)

        # 5 — accumulate globals and clear buffer
        self.kept.extend(kw_kept)
        self.rejected.extend(kw_rejected)
        self._kw_buffer.clear()

        return len(kw_kept), len(kw_rejected)

    # ── Write one keyword's results to Supabase ───────────────────────────

    def _write_keyword_to_db(self, kept: List[dict], kw_record: dict) -> None:
        if _db_upsert is None:
            log.warning("DB 模块未加载，跳过写入。")
            return

        now_iso  = self._now.isoformat()
        category = kw_record.get("category") or self.args.category
        kw_id    = str(kw_record["id"]) if kw_record.get("id") else None

        # pin_samples rows
        sample_rows = []
        for rec in kept:
            if not rec.get("pin_id"):
                continue
            sample_rows.append({
                "pin_id":            rec["pin_id"],
                "trend_keyword_id":  kw_id,
                "source_keyword":    rec.get("source_keyword"),
                "category":          category,
                "title":             (rec.get("title") or "")[:500] or None,
                "source_url":        rec.get("source_url"),
                "image_url":         rec.get("image_url"),
                "local_image_path":  rec.get("local_image_path"),
                "outbound_link":     rec.get("outbound_link"),
                "is_ecommerce":      bool(rec.get("is_ecommerce")),
                "save_count":        int(rec.get("save_count") or 0),
                "reaction_count":    int(rec.get("reaction_count") or 0),
                "created_at_source": rec.get("created_at"),
                "scraped_at":        now_iso,
            })

        if not sample_rows:
            return

        try:
            inserted      = _db_upsert("pin_samples", sample_rows, on_conflict="pin_id")
            pin_id_to_db  = {str(r["pin_id"]): str(r["id"])
                             for r in inserted if r.get("id")}
            log.info(f"  DB: {len(inserted)} pin_samples 写入")
        except Exception as exc:
            log.error(f"  DB pin_samples 写入失败: {exc}")
            return

        # pin_style_analysis rows
        analysis_rows = []
        for rec in kept:
            db_id = pin_id_to_db.get(str(rec.get("pin_id", "")))
            if not db_id:
                continue
            analysis_rows.append({
                "pin_sample_id":           db_id,
                "pin_type":                rec.get("pin_type"),
                "style_tags":              rec.get("style_tags") or [],
                "layout_type":             rec.get("layout_type"),
                "has_text_overlay":        bool(rec.get("has_text_overlay")),
                "best_for_products":       rec.get("best_for_products") or [],
                "commercial_intent_score": float(rec.get("commercial_intent_score") or 0),
                "make_similar_score":      float(rec.get("make_similar_score") or 0),
                "prompt_template":         rec.get("prompt_seed"),
                "prompt_seed":             rec.get("prompt_seed"),
                "title_pattern":           rec.get("title_pattern"),
                "description_pattern":     rec.get("description_pattern"),
                "model_name":              "scraper_heuristic",
                "analyzed_at":             now_iso,
            })

        if analysis_rows:
            try:
                _db_upsert("pin_style_analysis", analysis_rows,
                           on_conflict="pin_sample_id,model_name")
                log.info(f"  DB: {len(analysis_rows)} pin_style_analysis 写入")
            except Exception as exc:
                log.error(f"  DB pin_style_analysis 写入失败: {exc}")

        # Update last_scraped_at
        if kw_id:
            try:
                _db_update_where(
                    "trend_keywords",
                    {"last_scraped_at": now_iso},
                    {"id": kw_id},
                )
            except Exception as exc:
                log.error(f"  DB last_scraped_at 更新失败: {exc}")

    # ── Image downloads ───────────────────────────────────────────────────

    async def _download_all(self) -> None:
        if not self.args.download_images:
            log.info("Image download skipped (--no-download-images).")
            return
        if not self.kept:
            log.info("No pins to download.")
            return

        log.info(f"Downloading images for {len(self.kept):,} pins …")
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            )
        }
        async with httpx.AsyncClient(headers=headers, timeout=15.0) as client:
            batch_size = 8
            tasks = [download_image(client, rec, self.images_dir) for rec in self.kept]
            for i in tqdm(
                range(0, len(tasks), batch_size),
                desc="Images",
                unit="batch",
                file=sys.stdout,
            ):
                await asyncio.gather(*tasks[i: i + batch_size])

        self._c["dl_ok"]   = sum(1 for r in self.kept
                                  if r.get("download_status") in ("success", "cached"))
        self._c["dl_fail"] = sum(1 for r in self.kept
                                  if r.get("download_status") == "failed")

    # ── Persist outputs ───────────────────────────────────────────────────

    def _save(self) -> None:
        aesthetic = [r for r in self.kept if r.get("pin_type") in ("aesthetic_trend", "both")]
        product   = [r for r in self.kept if r.get("pin_type") in ("product_lead",   "both")]

        write_json (aesthetic,     self.out_dir / "aesthetic_trends.json")
        write_csv  (product,       self.out_dir / "product_leads.csv")
        write_jsonl(self.kept,     self.out_dir / "all_pins.jsonl")
        write_csv  (self.rejected, self.out_dir / "rejected_pins.csv")
        write_raw_samples(self.raw_samples, self.raw_dir / "raw_responses_sample.jsonl")
        self._generate_gallery(aesthetic, product)

    def _generate_gallery(self, aesthetic: List[dict], product: List[dict]) -> None:
        """Generate a browsable HTML gallery of all kept pins."""

        def _pin_card(r: dict, show_product_badge: bool = False) -> str:
            pid       = r.get("pin_id", "")
            title     = (r.get("title") or "No title")[:80]
            saves     = r.get("save_count", 0)
            reactions = r.get("reaction_count", 0)
            created   = (r.get("created_at") or "")[:10]
            img_url   = r.get("image_url") or ""
            local_img = r.get("local_image_path")
            link      = r.get("outbound_link") or ""
            domain    = r.get("domain") or ""
            ptype     = r.get("pin_type", "")
            ci_score  = r.get("commercial_intent_score", 0)
            ms_score  = r.get("make_similar_score", 0)
            pin_url   = f"https://www.pinterest.com/pin/{pid}/" if pid else "#"

            # Prefer local file path; fall back to remote URL
            if local_img:
                # Make path relative to the output dir
                try:
                    img_src = "../images/" + Path(local_img).name
                except Exception:
                    img_src = img_url
            else:
                img_src = img_url

            badge_color = {
                "aesthetic_trend": "#7c3aed",
                "product_lead":    "#0369a1",
                "both":            "#065f46",
            }.get(ptype, "#6b7280")

            badge_label = {
                "aesthetic_trend": "Aesthetic",
                "product_lead":    "Product",
                "both":            "Both",
            }.get(ptype, ptype)

            product_btn = ""
            if link:
                product_btn = (
                    f'<a class="product-btn" href="{link}" target="_blank" rel="noopener">'
                    f'🛒 {domain or "Shop"}</a>'
                )

            return f"""
<div class="card">
  <a href="{pin_url}" target="_blank" rel="noopener">
    <img src="{img_src}" alt="{title}" loading="lazy"
         onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22280%22><rect fill=%22%23eee%22 width=%22200%22 height=%22280%22/><text x=%2250%%22 y=%2250%%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%23aaa%22>No image</text></svg>'">
  </a>
  <div class="meta">
    <span class="badge" style="background:{badge_color}">{badge_label}</span>
    <p class="title">{title}</p>
    <div class="stats">
      <span>❤️ {saves:,} saves</span>
      <span>💬 {reactions:,}</span>
      {f'<span>📅 {created}</span>' if created else ''}
    </div>
    <div class="scores">CI:{ci_score}/10 · MS:{ms_score}/10</div>
    <div class="actions">
      <a href="{pin_url}" target="_blank" rel="noopener">📌 View Pin</a>
      {product_btn}
    </div>
    <div class="pin-id">ID: {pid}</div>
  </div>
</div>"""

        css = """
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
       background: #f8f8f8; color: #222; }
header { background: #fff; border-bottom: 1px solid #ddd; padding: 16px 24px;
         display: flex; align-items: center; gap: 16px; position: sticky; top: 0; z-index: 10; }
header h1 { font-size: 1.2rem; }
header .counts { font-size: 0.85rem; color: #666; }
.tabs { display: flex; gap: 8px; padding: 16px 24px 0; }
.tab { padding: 8px 18px; border-radius: 20px; cursor: pointer; font-size: 0.9rem;
       border: 2px solid transparent; background: #fff; }
.tab.active { border-color: #e60023; color: #e60023; font-weight: 600; }
.section { display: none; padding: 16px 24px 40px; }
.section.active { display: block; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
.card { background: #fff; border-radius: 12px; overflow: hidden;
        box-shadow: 0 1px 4px rgba(0,0,0,.10); transition: transform .15s; }
.card:hover { transform: translateY(-3px); box-shadow: 0 4px 12px rgba(0,0,0,.15); }
.card img { width: 100%; aspect-ratio: 2/3; object-fit: cover; display: block; }
.meta { padding: 10px 12px 12px; }
.badge { display: inline-block; font-size: 0.7rem; font-weight: 600; color: #fff;
         padding: 2px 8px; border-radius: 10px; margin-bottom: 6px; }
.title { font-size: 0.82rem; line-height: 1.35; margin-bottom: 6px;
         display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.stats { display: flex; gap: 8px; flex-wrap: wrap; font-size: 0.75rem; color: #555; margin-bottom: 4px; }
.scores { font-size: 0.7rem; color: #888; margin-bottom: 8px; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; }
.actions a, .product-btn { font-size: 0.75rem; padding: 4px 10px; border-radius: 14px;
                            background: #f3f3f3; color: #333; text-decoration: none; }
.actions a:hover, .product-btn:hover { background: #e60023; color: #fff; }
.product-btn { background: #e8f4fd; color: #0369a1; }
.pin-id { font-size: 0.65rem; color: #bbb; margin-top: 6px; }
"""

        now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
        aesthetic_cards = "\n".join(_pin_card(r) for r in
                                    sorted(aesthetic, key=lambda x: -x.get("save_count", 0)))
        product_cards   = "\n".join(_pin_card(r) for r in
                                    sorted(product,   key=lambda x: -x.get("save_count", 0)))
        all_cards       = "\n".join(_pin_card(r) for r in
                                    sorted(self.kept, key=lambda x: -x.get("save_count", 0)))

        html = f"""<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pinterest Vibe Library — {now_str}</title>
  <style>{css}</style>
</head>
<body>
<header>
  <h1>📌 Pinterest Vibe Library</h1>
  <span class="counts">
    抓取时间: {now_str} &nbsp;|&nbsp;
    Aesthetic: {len(aesthetic)} &nbsp;|&nbsp;
    Product: {len(product)} &nbsp;|&nbsp;
    Total: {len(self.kept)}
  </span>
</header>

<div class="tabs">
  <button class="tab active" onclick="show('aesthetic', this)">
    🎨 Aesthetic Trends ({len(aesthetic)})
  </button>
  <button class="tab" onclick="show('product', this)">
    🛒 Product Leads ({len(product)})
  </button>
  <button class="tab" onclick="show('all', this)">
    📋 All ({len(self.kept)})
  </button>
</div>

<div id="aesthetic" class="section active">
  <div class="grid">{aesthetic_cards}</div>
</div>
<div id="product" class="section">
  <div class="grid">{product_cards}</div>
</div>
<div id="all" class="section">
  <div class="grid">{all_cards}</div>
</div>

<script>
function show(id, btn) {{
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  btn.classList.add('active');
}}
</script>
</body>
</html>"""

        gallery_path = self.out_dir / "gallery.html"
        gallery_path.write_text(html, encoding="utf-8")
        log.info(f"Gallery  →  {gallery_path.resolve()}")

    # ── Summary ───────────────────────────────────────────────────────────

    def _summary(self) -> None:
        c = self._c
        kept_a = c["aesthetic"] + c["both"]
        kept_p = c["product"]   + c["both"]
        bar    = "═" * 62
        print(f"\n{bar}")
        print("  SCRAPING COMPLETE")
        print(bar)
        print(f"  Total pins discovered      {c['found']:>7,}")
        print(f"  ├─ aesthetic_trends kept   {kept_a:>7,}")
        print(f"  ├─ product_leads  kept     {kept_p:>7,}")
        print(f"  ├─ both (overlap)          {c['both']:>7,}")
        print(f"  └─ rejected                {c['rejected']:>7,}")
        print(f"  Images downloaded OK       {c['dl_ok']:>7,}")
        print(f"  Images failed / skipped    {c['dl_fail']:>7,}")
        print(f"  Output directory           {self.out_dir.resolve()}")
        print(f"{bar}\n")

    # ── Main ──────────────────────────────────────────────────────────────

    async def run(self, kw_records: List[dict]) -> None:
        # ── Extension: load from user's Chrome profile ────────────────────
        ext_id  = "mcmkeopcpbfgjlakblglpcccpodbjkel"
        ext_base = Path(os.path.expandvars(
            rf"%LOCALAPPDATA%\Google\Chrome\User Data\Default\Extensions\{ext_id}"
        ))
        ext_dir: Optional[str] = None
        if ext_base.exists():
            versions = sorted(ext_base.iterdir())
            if versions:
                ext_dir = str(versions[-1])
                log.info(f"插件已找到: {ext_dir}")
        if not ext_dir:
            log.warning(f"未找到 Pinterest Pin Stats 插件（{ext_base}），将不加载插件。")

        persist_dir = Path(self.args.user_data_dir)
        persist_dir.mkdir(parents=True, exist_ok=True)
        log.info(f"Profile dir : {persist_dir.resolve()}")

        # ── Build launch args ─────────────────────────────────────────────
        launch_args = [
            "--no-sandbox",
            "--disable-blink-features=AutomationControlled",
        ]
        if ext_dir:
            launch_args += [
                f"--disable-extensions-except={ext_dir}",
                f"--load-extension={ext_dir}",
            ]

        async with async_playwright() as pw:
            ctx = await pw.chromium.launch_persistent_context(
                str(persist_dir),
                headless=self.args.headless,
                args=launch_args,
                ignore_default_args=["--enable-automation"],
            )
            try:
                page = ctx.pages[0] if ctx.pages else await ctx.new_page()
                page.on("response", self._on_response)

                log.info("Navigating to Pinterest …")
                await page.goto(
                    "https://www.pinterest.com",
                    wait_until="domcontentloaded",
                    timeout=30_000,
                )
                await asyncio.sleep(3)

                if "login" in page.url or "signup" in page.url:
                    log.warning(
                        "Pinterest 需要登录 — 请在弹出的浏览器中手动登录，"
                        "登录后脚本自动继续（最多等 120 秒）…"
                    )
                    for _ in range(120):
                        await asyncio.sleep(1)
                        if "login" not in page.url and "signup" not in page.url:
                            log.info("登录成功，开始抓取。")
                            break
                    else:
                        log.error("120 秒内未登录，退出。")
                        raise SystemExit(1)
                else:
                    log.info("Pinterest 已登录，插件已加载，开始抓取。")

                total_kws = len(kw_records)
                for idx, kw_record in enumerate(kw_records, 1):
                    keyword  = kw_record["keyword"]
                    category = kw_record.get("category") or self.args.category
                    log.info(
                        f"[{idx}/{total_kws}] keyword='{keyword}'  category={category}"
                        + ("  (dry-run)" if self.args.dry_run else "")
                    )
                    await self._scrape_keyword(page, keyword)
                    n_kept, n_rejected = await self._process_keyword_buffer(
                        page, kw_record
                    )
                    log.info(
                        f"  => kept={n_kept}  rejected={n_rejected}  "
                        f"global_kept={len(self.kept)}"
                    )
                    await asyncio.sleep(2)

            finally:
                await ctx.close()

        await self._download_all()
        self._save()
        self._summary()


# ══════════════════════════════════════════════════════════════════════════════
# CLI
# ══════════════════════════════════════════════════════════════════════════════

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Pinterest Home Decor Scraper — Vibe Library Builder",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python pinterest_ultimate_scraper.py
  python pinterest_ultimate_scraper.py --max-scrolls 50
  python pinterest_ultimate_scraper.py --keywords "japandi decor" "wabi sabi interior"
  python pinterest_ultimate_scraper.py --keyword-file my_keywords.txt
  python pinterest_ultimate_scraper.py --min-saves-aesthetic 2000 --no-download-images
  python pinterest_ultimate_scraper.py --profile-directory Default --headless
""",
    )

    p.add_argument("--category",              default="home",
                   help="Category label used in logs (default: home)")
    p.add_argument("--keywords",              nargs="+", metavar="KW",
                   help="Override default keywords (quote multi-word phrases)")
    p.add_argument("--keyword-file",          metavar="FILE",
                   help="Text file with one keyword per line (# = comment)")
    p.add_argument("--max-scrolls",           type=int, default=15,
                   help="Scroll actions per keyword (default: 15; set 50 for deep scrape)")
    p.add_argument("--min-saves-aesthetic",   type=int, default=1000,
                   help="Min saves for aesthetic_trend (default: 1000)")
    p.add_argument("--min-saves-product",     type=int, default=10,
                   help="Min saves for product_lead (default: 10)")
    p.add_argument("--max-age-days",          type=int, default=180,
                   help="Max pin age in days (default: 180)")
    p.add_argument("--download-images",       dest="download_images",
                   action="store_true",  default=True,
                   help="Download images (default: enabled)")
    p.add_argument("--no-download-images",    dest="download_images",
                   action="store_false",
                   help="Skip image download")
    p.add_argument("--headless",              action="store_true", default=False,
                   help="Run browser headless (no GUI)")
    p.add_argument("--user-data-dir",
                   default=os.path.expandvars(r"%LOCALAPPDATA%\PinterestScraper\profile"),
                   help="爬虫专用 Chrome profile 目录（默认与日常 Chrome 隔离）")
    p.add_argument("--profile-directory",     default="Default",
                   help="Chrome profile 文件夹名（默认: Default）")
    p.add_argument("--output-dir",            default="vibe_library",
                   help="Base output directory (default: vibe_library)")
    p.add_argument("--limit-keywords",        type=int, default=None,
                   help="从 DB 最多取 N 个关键词（默认全取）")
    p.add_argument("--max-pins-per-keyword",  type=int, default=None,
                   dest="max_pins_per_keyword",
                   help="每个关键词最多保留 N 条 pin（按 save_count 降序截取）")
    p.add_argument("--dry-run",               action="store_true", default=False,
                   help="只抓取和分类，不写入 Supabase")

    return p.parse_args()


def _load_keyword_records(args: argparse.Namespace) -> List[dict]:
    """
    Returns a list of kw_record dicts, each with at least {keyword, category}.
    Priority: --keywords > --keyword-file > Supabase trend_keywords table.
    """
    if args.keywords:
        records = [{"id": None, "keyword": kw, "category": args.category}
                   for kw in args.keywords]
    elif args.keyword_file:
        f = Path(args.keyword_file)
        if not f.exists():
            log.error(f"Keyword file not found: {f}")
            raise SystemExit(1)
        kws = [
            line.strip()
            for line in f.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.startswith("#")
        ]
        records = [{"id": None, "keyword": kw, "category": args.category}
                   for kw in kws]
    elif _db_select_many is not None:
        try:
            records = _db_select_many(
                "trend_keywords",
                filters={"status": "active"},
                order="priority_score.desc,last_scraped_at.asc",
                limit=args.limit_keywords,
            )
            if not records:
                log.warning("trend_keywords 表无 active 关键词，使用默认列表")
                records = [{"id": None, "keyword": kw, "category": "home"}
                           for kw in DEFAULT_KEYWORDS]
        except Exception as exc:
            log.warning(f"无法从 Supabase 加载关键词 ({exc})，使用默认列表")
            records = [{"id": None, "keyword": kw, "category": "home"}
                       for kw in DEFAULT_KEYWORDS]
    else:
        log.warning("DB 未连接，使用默认关键词列表")
        records = [{"id": None, "keyword": kw, "category": "home"}
                   for kw in DEFAULT_KEYWORDS]

    if args.limit_keywords:
        records = records[:args.limit_keywords]

    log.info(f"Keywords ({len(records)}):")
    for r in records:
        log.info(f"  - [{r.get('category','?')}] {r['keyword']}")
    return records


# ══════════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    _args        = _parse_args()
    _kw_records  = _load_keyword_records(_args)
    asyncio.run(PinterestScraper(_args).run(_kw_records))
