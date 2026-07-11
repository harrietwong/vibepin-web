"""
content_filters.py — configurable low-intent pin / reference filters.

Used at collection (scraper_v2) and reference classification stages.
Digital-product commercial templates (printables, planners) are NOT filtered
when category is digital-products or product_type signals digital.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_NEGATIVE_TERMS: tuple[str, ...] = (
    "wallpaper",
    "meme",
    "funny meme",
    "fan art",
    "fanart",
    "logo only",
    "random quote",
    "screenshot",
    "kids drawing",
    "cartoon",
    "anime wallpaper",
    "phone wallpaper",
    "desktop wallpaper",
)

DIGITAL_COMMERCIAL_TOKENS: tuple[str, ...] = (
    "printable",
    "template",
    "planner",
    "worksheet",
    "checklist",
    "canva",
    "notion",
    "digital download",
    "pdf guide",
    "ebook",
)

_filter_stats: dict[str, int] = {"negative_term": 0, "skipped_digital": 0}


def reset_filter_stats() -> None:
    _filter_stats["negative_term"] = 0
    _filter_stats["skipped_digital"] = 0


def get_filter_stats() -> dict[str, int]:
    return dict(_filter_stats)


def load_negative_terms() -> tuple[str, ...]:
    extra = os.environ.get("CONTENT_FILTER_NEGATIVE_TERMS", "").strip()
    if not extra:
        return DEFAULT_NEGATIVE_TERMS
    merged = list(DEFAULT_NEGATIVE_TERMS)
    for t in extra.split(","):
        t = t.strip().lower()
        if t and t not in merged:
            merged.append(t)
    return tuple(merged)


def _text_blob(title: str | None, description: str | None, keyword: str | None = None) -> str:
    return " ".join([title or "", description or "", keyword or ""]).lower()


def is_digital_commercial_context(
    *,
    category: str | None = None,
    title: str | None = None,
    description: str | None = None,
) -> bool:
    if (category or "").lower().replace("_", "-") == "digital-products":
        return True
    text = _text_blob(title, description)
    return any(tok in text for tok in DIGITAL_COMMERCIAL_TOKENS)


def match_negative_term(text: str, terms: tuple[str, ...] | None = None) -> str | None:
    terms = terms or load_negative_terms()
    for term in terms:
        if term in text:
            return term
    return None


@dataclass
class FilterDecision:
    reject: bool
    reason: str | None = None
    matched_term: str | None = None
    skipped_digital: bool = False


def evaluate_pin_content(
    *,
    title: str | None = None,
    description: str | None = None,
    keyword: str | None = None,
    category: str | None = None,
    enabled: bool | None = None,
) -> FilterDecision:
    if enabled is None:
        enabled = os.environ.get("CONTENT_FILTER_NEGATIVE_TERMS_ENABLED", "true").lower() not in (
            "0", "false", "no",
        )
    if not enabled:
        return FilterDecision(reject=False)

    text = _text_blob(title, description, keyword)
    if not text.strip():
        return FilterDecision(reject=False)

    if is_digital_commercial_context(category=category, title=title, description=description):
        matched = match_negative_term(text)
        if matched and matched in ("wallpaper", "phone wallpaper", "desktop wallpaper", "anime wallpaper"):
            _filter_stats["negative_term"] += 1
            return FilterDecision(reject=True, reason=f"negative_term:{matched}", matched_term=matched)
        if matched:
            _filter_stats["skipped_digital"] += 1
        return FilterDecision(reject=False, skipped_digital=bool(matched))

    matched = match_negative_term(text)
    if matched:
        _filter_stats["negative_term"] += 1
        return FilterDecision(reject=True, reason=f"negative_term:{matched}", matched_term=matched)

    return FilterDecision(reject=False)
