"""
official_v5_seed_quality.py — Dedup, relevance, commercial intent, cadence guards for v5 seeds.
"""

from __future__ import annotations

import json
import re
from typing import Any

from trend_seed_pipeline import (
    COMMERCIAL_BONUS_TOKENS,
    P0_CATEGORIES,
    normalize_category,
)

# ── Keyword normalization for dedup ─────────────────────────────────────────

_DEDUP_PUNCT_RE = re.compile(r"[^\w\s#]+", re.UNICODE)
_WS_RE = re.compile(r"\s+")

P0_REPORT_BUCKETS = frozenset(P0_CATEGORIES)

# Schema category for DB row (may differ from p0_bucket)
P0_BUCKET_SCHEMA_CATEGORY: dict[str, str] = {
    "womens-fashion": "fashion",
    "fashion": "fashion",
    "mens-fashion": "fashion",
    "kids-fashion": "fashion",
    "beauty": "beauty",
    "home-decor": "home-decor",
    "digital-products": "digital-products",
}

# Interest slugs excluded from P0 official_v5 dry-run (not core P0 buckets)
NON_P0_INTEREST_SLUGS = frozenset({
    "childrens_fashion",
    "mens_fashion",
    "health",
})

ALLOWED_SHORT_COMMERCIAL_TERMS = frozenset({
    "nails", "nail", "outfit", "outfits", "hairstyle", "hairstyles", "hair",
    "makeup", "beauty", "decor", "aesthetic", "linen", "skirt", "dress",
})

INTEREST_SLUG_P0_BUCKET: dict[str, str] = {
    "womens_fashion": "womens-fashion",
    "mens_fashion": "mens-fashion",
    "childrens_fashion": "kids-fashion",
    "home_decor": "home-decor",
    "architecture": "home-decor",
    "design": "home-decor",
    "digital_products": "digital-products",
    "beauty": "beauty",
    "fashion": "fashion",
}


def normalize_keyword_dedup_key(keyword: str) -> str:
    s = (keyword or "").strip().lower()
    s = _WS_RE.sub(" ", s)
    while s.startswith("#"):
        s = s[1:].lstrip()
    s = _DEDUP_PUNCT_RE.sub(" ", s)
    return _WS_RE.sub(" ", s).strip()


def resolve_p0_bucket(*, interest_slug: str = "", normalized_category: str = "") -> str:
    slug = (interest_slug or "").strip().lower()
    if slug in INTEREST_SLUG_P0_BUCKET:
        return INTEREST_SLUG_P0_BUCKET[slug]
    cat = (normalized_category or "").replace("_", "-")
    return cat


def schema_category_for_bucket(p0_bucket: str) -> str:
    return P0_BUCKET_SCHEMA_CATEGORY.get(p0_bucket, p0_bucket)


def is_p0_interest_slug(interest_slug: str) -> bool:
    slug = (interest_slug or "").strip().lower()
    if slug in NON_P0_INTEREST_SLUGS:
        return False
    bucket = resolve_p0_bucket(interest_slug=slug)
    return bucket in P0_REPORT_BUCKETS


# ── Category relevance tokens ───────────────────────────────────────────────

CATEGORY_POSITIVE_TOKENS: dict[str, tuple[str, ...]] = {
    "fashion": (
        "outfit", "outfits", "dress", "style", "styling", "wear", "capsule", "wardrobe",
        "blazer", "linen", "skirt", "pants", "jeans", "coat", "jacket", "sneakers",
        "aesthetic", "look", "fashion", "fall outfits", "winter outfits", "summer outfits",
    ),
    "womens-fashion": (
        "outfit", "outfits", "dress", "skirt", "blazer", "women", "womens", "midi",
        "maxi", "work outfit", "date night", "capsule wardrobe", "linen pants outfit",
    ),
    "beauty": (
        "nails", "nail", "nail inspo", "makeup", "skin", "skincare", "hair", "hairstyle",
        "hairstyles", "lip", "gloss", "blush", "beauty", "manicure", "pedicure",
        "summer nails", "lip liner",
    ),
    "home-decor": (
        "home decor", "decor", "bedroom", "living room", "gallery wall", "interior",
        "furniture", "cozy", "minimalist", "small bedroom", "wall art", "room decor",
        "kitchen decor", "bathroom decor", "dining room decor",
    ),
    "digital-products": (
        "template", "printable", "planner", "notion", "canva", "worksheet", "checklist",
        "digital download", "pdf", "spreadsheet", "preset", "bundle",
    ),
}

# Negative patterns per bucket — match => strong penalty or reject
CATEGORY_NEGATIVE_PATTERNS: dict[str, tuple[tuple[str, str], ...]] = {
    "home-decor": (
        (r"\bdinner\b", "food_not_decor"),
        (r"\blunch\b", "food_not_decor"),
        (r"\brecipe\b", "food_not_decor"),
        (r"\bfood\b", "food_not_decor"),
        (r"\bdrawing ideas\b", "art_not_decor"),
        (r"\bdrawing\b", "art_not_decor"),
        (r"\bsketch\b", "art_not_decor"),
        (r"\bfather'?s? day\b", "gift_not_decor"),
        (r"\bmother'?s? day\b", "gift_not_decor"),
        (r"\bgift ideas\b", "gift_not_decor"),
        (r"\bcard ideas\b", "gift_not_decor"),
        (r"\bbirthday card\b", "gift_not_decor"),
    ),
    "fashion": (
        (r"\bkids?\b", "kids_not_generic_fashion"),
        (r"\bchildren\b", "kids_not_generic_fashion"),
        (r"\btoddler\b", "kids_not_generic_fashion"),
        (r"\bbaby\b", "kids_not_generic_fashion"),
    ),
    "womens-fashion": (
        (r"\bkids?\b", "kids_not_womens_fashion"),
        (r"\bmen'?s?\b", "mens_not_womens_fashion"),
        (r"\bboys?\b", "kids_not_womens_fashion"),
    ),
    "kids-fashion": (
        (r"\bwork outfit\b", "adult_not_kids"),
        (r"\bdate night\b", "adult_not_kids"),
    ),
}

COMMERCIAL_INTENT_TOKENS: tuple[str, ...] = (
    "outfit", "outfits", "decor", "nails", "template", "printable", "planner",
    "aesthetic", "styling", "look", "looks", "bedroom", "gallery wall", "linen",
    "skirt", "tutorial", "how to", "inspo", "inspiration", "guide", "tips",
    *COMMERCIAL_BONUS_TOKENS,
)

VIRAL_NOISE_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"\blove island\b", "viral_tv:love_island"),
    (r"\bworld cup\b", "viral_event:world_cup"),
    (r"\breaction pic\b", "viral_meme:reaction_pic"),
    (r"\biconic by mistake\b", "viral_phrase"),
    (r"\bfanart\b", "viral_fanart"),
    (r"\bwallpaper\b", "viral_wallpaper"),
    (r"\bmeme\b", "viral_meme"),
    (r"\bconcert\b", "viral_event:concert"),
    (r"\bcelebrity\b", "viral_celebrity"),
    (r"\btiktok trend\b", "viral_social"),
    (r"\bfairs reaction\b", "viral_meme:fairs"),
    (r"\bnfl\b|\bnba\b|\bsuper bowl\b", "viral_event:sports"),
    (r"\bvs\.?\s+\w+", "viral_celebrity:versus"),
)

GIBBERISH_PATTERN = re.compile(r"^[a-z]{5,12} ideas$")


def _keyword_text(keyword: str) -> str:
    return (keyword or "").strip().lower()


def _is_pure_hashtag(text: str) -> bool:
    t = text.strip()
    if not t.startswith("#"):
        return False
    if " " in t:
        return False
    body = t[1:]
    return bool(body) and body.isalnum()


def detect_viral_noise(keyword: str) -> tuple[bool, str | None]:
    text = _keyword_text(keyword)
    if not text:
        return True, "viral_noise:empty"

    if text in ALLOWED_SHORT_COMMERCIAL_TERMS:
        return False, None

    for pat, reason in VIRAL_NOISE_PATTERNS:
        if re.search(pat, text, re.IGNORECASE):
            return True, reason

    if _is_pure_hashtag(text):
        return True, "viral_hashtag_only"

    # Single-token commercial terms (not hashtag-only false positive)
    tokens = text.split()
    if len(tokens) == 1 and tokens[0] in ALLOWED_SHORT_COMMERCIAL_TERMS:
        return False, None
    if len(tokens) == 2 and tokens[1] in ("inspo", "ideas", "aesthetic") and tokens[0] in ALLOWED_SHORT_COMMERCIAL_TERMS:
        return False, None

    if GIBBERISH_PATTERN.match(text):
        first = text.replace(" ideas", "")
        if first not in ALLOWED_SHORT_COMMERCIAL_TERMS and not any(
            t in text for t in CATEGORY_POSITIVE_TOKENS.get("home-decor", ())
        ):
            return True, "gibberish:unknown_term"

    return False, None


def _category_negative_hit(keyword: str, p0_bucket: str) -> str | None:
    text = _keyword_text(keyword)
    for pat, reason in CATEGORY_NEGATIVE_PATTERNS.get(p0_bucket, ()):
        if re.search(pat, text, re.IGNORECASE):
            return reason
    return None


def score_category_relevance(keyword: str, *, p0_bucket: str) -> float:
    text = _keyword_text(keyword)
    neg = _category_negative_hit(keyword, p0_bucket)
    if neg:
        return 5.0

    tokens = CATEGORY_POSITIVE_TOKENS.get(p0_bucket, ())
    if not tokens:
        return 10.0

    # Phrase matches (longer first)
    phrase_hits = sum(1 for t in sorted(tokens, key=len, reverse=True) if t in text)
    if phrase_hits >= 2:
        return 90.0
    if phrase_hits == 1:
        # "ideas" alone is not enough — require anchor token
        if text.endswith(" ideas") or " ideas" in text:
            anchor = text.replace(" ideas", "").strip()
            if anchor in ALLOWED_SHORT_COMMERCIAL_TERMS or any(
                anchor in t for t in tokens if t != "ideas"
            ):
                return 72.0
            if p0_bucket == "home-decor" and any(
                x in text for x in ("decor", "bedroom", "gallery wall", "living room", "room")
            ):
                return 70.0
            return 25.0
        return 68.0

    # Single-word beauty/fashion anchors
    if text in ALLOWED_SHORT_COMMERCIAL_TERMS:
        if p0_bucket == "beauty" and text in ("nails", "nail", "hairstyle", "hairstyles", "hair", "makeup"):
            return 75.0
        if p0_bucket in ("fashion", "womens-fashion") and text in ("outfit", "outfits"):
            return 70.0

    return 12.0


def route_best_p0_bucket(keyword: str) -> str | None:
    """Pick best P0 bucket from keyword text alone (ignoring interest bleed)."""
    scores = {
        b: score_category_relevance(keyword, p0_bucket=b)
        for b in P0_REPORT_BUCKETS
        if b != "digital-products"
    }
    if not scores:
        return None
    best_bucket = max(scores, key=scores.get)
    if scores[best_bucket] < 40:
        return None
    # Generic fashion beats kids-fashion unless kids tokens present
    text = _keyword_text(keyword)
    if "kids-fashion" in scores and scores.get("fashion", 0) >= scores.get("kids-fashion", 0):
        if not re.search(r"\b(kids?|children|toddler|baby)\b", text):
            if scores["fashion"] >= 40:
                best_bucket = "fashion"
    if re.search(r"\b(women|womens|ladies|feminine|midi|maxi)\b", text):
        if scores.get("womens-fashion", 0) >= 40:
            best_bucket = "womens-fashion"
    return best_bucket


def score_commercial_intent(keyword: str) -> float:
    text = _keyword_text(keyword)
    score = 10.0
    hits = sum(1 for t in COMMERCIAL_INTENT_TOKENS if t in text)
    score += min(hits * 12.0, 48.0)
    if re.search(r"\b(how to|tutorial|guide|tips)\b", text):
        score += 10.0
    if text in ALLOWED_SHORT_COMMERCIAL_TERMS:
        score = max(score, 38.0)
    tokens = text.split()
    if len(tokens) == 2 and tokens[1] in ("inspo", "ideas") and tokens[0] in ALLOWED_SHORT_COMMERCIAL_TERMS:
        score = max(score, 42.0)
    if re.search(r"\blove island\b", text):
        score -= 40.0
    if _is_pure_hashtag(text):
        score -= 30.0
    return round(max(0.0, min(100.0, score)), 1)


def passes_v5_category_gate(keyword: str, *, p0_bucket: str) -> tuple[bool, str | None]:
    is_viral, viral_reason = detect_viral_noise(keyword)
    if is_viral:
        return False, viral_reason

    neg = _category_negative_hit(keyword, p0_bucket)
    if neg:
        return False, f"category_negative:{neg}"

    rel = score_category_relevance(keyword, p0_bucket=p0_bucket)
    comm = score_commercial_intent(keyword)

    if rel < 40:
        return False, "category_irrelevant"
    if comm < 25:
        return False, "low_commercial_intent"
    return True, None


def assign_v5_crawl_tier(
    *,
    trend_seed_score: float,
    commercial_intent: float,
    category_relevance: float,
    kw: dict,
) -> tuple[str, str, bool, str]:
    is_viral, viral_reason = detect_viral_noise(kw.get("keyword", ""))
    if is_viral:
        return "excluded", "paused", False, viral_reason or "viral_noise"

    if (
        commercial_intent >= 55
        and category_relevance >= 55
        and trend_seed_score >= 55
    ):
        return "high", "daily", True, "high_commercial_relevant"

    if commercial_intent >= 45 and category_relevance >= 45 and trend_seed_score >= 42:
        return "medium", "every_3_days", True, "medium_commercial"

    if commercial_intent >= 35 and category_relevance >= 40 and trend_seed_score >= 28:
        return "low", "weekly", True, "low_commercial"

    if trend_seed_score >= 22 or commercial_intent >= 20:
        return "watchlist", "paused", False, "watchlist_weak_commercial"

    return "excluded", "paused", False, "below_quality_floor"


def compute_v5_composite_score(
    kw: dict,
    *,
    base_score: float,
    commercial_intent: float,
    category_relevance: float,
) -> float:
    blended = base_score * 0.45 + commercial_intent * 0.35 + category_relevance * 0.20
    if commercial_intent < 35:
        blended = min(blended, 45.0)
    if category_relevance < 35:
        blended = min(blended, 38.0)
    return round(min(100.0, max(0.0, blended)), 2)


def build_provenance_notes(seed: dict) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for key in (
        "matched_interests", "matched_p0_buckets", "matched_trend_types",
        "dedup_merged_count", "dedup_canonical_reason", "p0_bucket",
        "commercial_intent_score", "category_relevance_score", "disposition_reason",
    ):
        if seed.get(key) is not None:
            payload[key] = seed.get(key)
    return payload


def annotate_seed_provenance(seed_dict: dict, *, interest_slug: str) -> dict:
    out = dict(seed_dict)
    cat = out.get("normalized_category") or out.get("category") or ""
    slug = interest_slug or out.get("interest_slug") or ""
    out["interest_slug"] = slug or out.get("interest_slug")
    out["p0_bucket"] = resolve_p0_bucket(interest_slug=slug, normalized_category=cat)
    out["commercial_intent_score"] = score_commercial_intent(out.get("keyword", ""))
    out["category_relevance_score"] = score_category_relevance(
        out.get("keyword", ""), p0_bucket=out["p0_bucket"],
    )
    if out.get("time_series"):
        out["trend_series_source"] = "pinterest_v5_official"
    return out


def _seed_quality_rank(seed: dict) -> tuple[float, float, float]:
    return (
        float(seed.get("category_relevance_score") or 0),
        float(seed.get("commercial_intent_score") or 0),
        float(seed.get("trend_seed_score") or 0),
    )


def finalize_canonical_seed(keyword: str, rows: list[dict]) -> dict:
    """Choose one canonical seed row with bucket/category before any DB write."""
    enriched: list[dict] = []
    for r in rows:
        row = dict(r)
        slug = row.get("interest_slug") or ""
        bucket = resolve_p0_bucket(
            interest_slug=slug,
            normalized_category=row.get("normalized_category") or "",
        )
        row["p0_bucket"] = bucket
        row["category_relevance_score"] = score_category_relevance(keyword, p0_bucket=bucket)
        row["commercial_intent_score"] = score_commercial_intent(keyword)
        enriched.append(row)

    routed_bucket = route_best_p0_bucket(keyword)
    if routed_bucket:
        candidates = [r for r in enriched if r.get("p0_bucket") == routed_bucket]
        pool = candidates or enriched
    else:
        pool = enriched

    canonical = max(pool, key=_seed_quality_rank)
    canon = dict(canonical)
    canon.pop("_bucket", None)

    best_bucket = routed_bucket or canon.get("p0_bucket") or "fashion"
    matched_interests = sorted({
        r.get("interest_slug") or r.get("v5_interest_param") or "unknown" for r in rows
    })
    if "womens_fashion" in matched_interests:
        wf_rel = score_category_relevance(keyword, p0_bucket="womens-fashion")
        if wf_rel >= 40 and best_bucket in ("fashion", "womens-fashion"):
            best_bucket = "womens-fashion"
    canon["p0_bucket"] = best_bucket
    canon["normalized_category"] = schema_category_for_bucket(best_bucket)
    canon["category"] = canon["normalized_category"]
    canon["category_relevance_score"] = score_category_relevance(keyword, p0_bucket=best_bucket)

    matched_buckets = sorted({r.get("p0_bucket") or "unknown" for r in enriched})
    matched_trend_types = sorted({r.get("trend_type") or "unknown" for r in rows})

    canon["matched_interests"] = matched_interests
    canon["matched_p0_buckets"] = matched_buckets
    canon["matched_trend_types"] = matched_trend_types
    if len(rows) > 1:
        canon["dedup_merged_count"] = len(rows)
        canon["dedup_canonical_reason"] = f"routed_to_{best_bucket}"

    prov = build_provenance_notes(canon)
    if prov:
        canon["_provenance"] = prov
    return canon


def global_dedupe_job_seeds(accumulator: dict[str, Any]) -> dict[str, Any]:
    groups: dict[str, list[dict]] = {}
    for bucket_name in ("seeds", "watchlist"):
        for seed in accumulator.get(bucket_name, []):
            key = normalize_keyword_dedup_key(seed.get("keyword", ""))
            if not key:
                continue
            groups.setdefault(key, []).append({**seed, "_bucket": bucket_name})

    kept_seeds: list[dict] = []
    kept_watchlist: list[dict] = []
    duplicate_groups: list[dict] = []
    raw_accepted = len(accumulator.get("seeds", []))

    for dedup_key, rows in groups.items():
        keyword = rows[0].get("keyword", "")
        if len(rows) == 1:
            canon = finalize_canonical_seed(keyword, rows)
        else:
            canon = finalize_canonical_seed(keyword, rows)
            duplicate_groups.append({
                "dedupKey": dedup_key,
                "keyword": keyword,
                "duplicateCount": len(rows),
                "matchedInterests": canon.get("matched_interests", []),
                "matchedP0Buckets": canon.get("matched_p0_buckets", []),
                "canonicalCategory": canon.get("normalized_category"),
                "canonicalP0Bucket": canon.get("p0_bucket"),
                "examples": [r.get("keyword") for r in rows[:5]],
            })

        if canon.get("crawl_priority") == "watchlist":
            kept_watchlist.append(canon)
        elif canon.get("crawl_queue_eligible"):
            kept_seeds.append(canon)
        elif canon.get("crawl_priority") in ("high", "medium", "low"):
            kept_seeds.append(canon)
        else:
            kept_watchlist.append(canon)

    queue_eligible = sum(1 for s in kept_seeds if s.get("crawl_queue_eligible"))
    accumulator["seeds"] = kept_seeds
    accumulator["watchlist"] = kept_watchlist
    accumulator["_dedup_report"] = {
        "rawAcceptedCount": raw_accepted,
        "uniqueAcceptedCount": len(kept_seeds),
        "uniqueWatchlistCount": len(kept_watchlist),
        "duplicateGroups": len(duplicate_groups),
        "duplicateExamples": duplicate_groups[:15],
        "applySafe": True,
    }
    accumulator["queue_stats"] = {
        "inserted": queue_eligible,
        "updated_pending": 0,
        "requeued": 0,
        "requeued_failed": 0,
        "skipped": max(0, raw_accepted - len(kept_seeds)),
        "written": queue_eligible,
    }
    return accumulator["_dedup_report"]


def digital_products_v5_status(interest_slugs: list[str]) -> dict[str, Any]:
    has_slug = any(s in interest_slugs for s in ("digital_products", "digital-products"))
    return {
        "p0Bucket": "digital-products",
        "officialV5Coverage": "available" if has_slug else "unavailable",
        "reason": None if has_slug else "no Pinterest interest slug in trend_interests",
        "recommendedFallbacks": [
            "manual/csv bootstrap (seed-bootstrap job)",
            "typeahead-derived seed candidates (L3, labeled non-authoritative)",
            "curated marketplace/product-source bootstrap",
            "crawler evidence from digital-product search keywords",
        ],
    }
