"""
classify_reference_pins.py
───────────────────────────
Classifies pin_samples for reference eligibility — i.e. which pins are safe and
high-quality enough to show as "Pin References" in Studio for creative inspiration.

NOT every viral pin is a good reference pin.  A pin with 50k saves may be a
text-heavy infographic, a blurry screenshot, or a collage with visible watermarks.
This script keeps save_count evidence separate from reference candidacy.

Classification outputs (written back to pin_samples):
  is_reference_eligible   boolean   — true = can be shown in Studio reference picker
  reference_quality_score numeric   — 0–100 composite quality score
  visual_format           text      — lifestyle | flat_lay | collage | product_only |
                                      text_heavy | infographic | unknown
  human_presence          text      — none | hands | partial | full
  text_overlay_level      text      — none | light | moderate | heavy
  watermark_detected      boolean
  image_quality_band      text      — high | medium | low
  composition_type        text      — single_focal | multi_product | scene | abstract
  has_clear_subject       boolean

Since we do NOT have a CV model, classification uses heuristic signals:
  1. Image dimensions / aspect ratio
  2. Title / description token analysis (text-heaviness, collage signals)
  3. Domain / outbound link signals (some domains produce watermarked pins)
  4. Save velocity (slow-growing = likely text-heavy infographic)
  5. Existing trend_stage / source_type metadata

Usage:
  python classify_reference_pins.py                 # classify unclassified rows
  python classify_reference_pins.py --all           # reclassify all
  python classify_reference_pins.py --dry-run       # print, no writes
  python classify_reference_pins.py --limit 2000    # cap rows
  python classify_reference_pins.py --verbose       # log every decision
  python classify_reference_pins.py --min-saves 500 # only high-save pins
  python classify_reference_pins.py --only-with-dims --category fashion --dry-run

Dims-only re-band (--only-with-dims):
  Run AFTER new image dimensions are backfilled or newly extracted (image_width
  + image_height). It RE-BANDS already-classified pins that now have valid
  dimensions — needed because a normal run (reclassify_all=False) leaves existing
  classified rows untouched, so their stale "low" band would never be re-scored.
  Scope by --category first (P0 default), and always --dry-run before the real run.
  Orchestration equivalent: run_worker.py --job classify --category <c> --only-with-dims
"""

from __future__ import annotations

import argparse
import logging
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import NamedTuple

_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(_ROOT))
sys.path.insert(0, str(_ROOT / "db"))
from content_filters import evaluate_pin_content  # noqa: E402
from db import DB

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


# ── Token dictionaries ────────────────────────────────────────────────────────

TEXT_HEAVY_TOKENS = {
    "how to", "tips", "steps", "guide", "ways to", "reasons why",
    "infographic", "checklist", "things to know", "facts about",
    "#", "read more", "click here", "swipe", "link in bio",
    "save this", "pin this", "share this", "bookmark",
    "font", "typography", "quote", "quotes",
}

COLLAGE_TOKENS = {
    "collage", "roundup", "round up", "collection", "set", "bundle",
    "mood board", "moodboard", "aesthetic", "vibe", "inspiration",
    "outfit", "outfits", "look book", "lookbook", "haul", "finds",
    "gift guide", "best of", "top picks", "must have",
}

LIFESTYLE_TOKENS = {
    "lifestyle", "styled", "in real life", "irl", "worn",
    "home decor", "living room", "bedroom", "kitchen",
    "outfit", "ootd", "look", "style",
    "cozy", "aesthetic",
}

FLAT_LAY_TOKENS = {
    "flat lay", "flatlay", "flat-lay", "overhead", "top down",
    "knolling", "shelfie", "spread",
}

PRODUCT_ONLY_TOKENS = {
    "product photo", "white background", "studio shot",
    "cut out", "png", "transparent",
}

WATERMARK_DOMAINS = {
    "shutterstock.com", "gettyimages.com", "istockphoto.com",
    "depositphotos.com", "stock.adobe.com", "dreamstime.com",
    "123rf.com", "vectorstock.com",
}

WATERMARK_TITLE_TOKENS = {
    "shutterstock", "getty", "istock", "stock photo",
    "©", "copyright", "watermark",
}

# Domains known to produce high-quality editorial imagery
HIGH_QUALITY_DOMAINS = {
    "anthropologie.com", "westelm.com", "crateandbarrel.com",
    "potterybarn.com", "restoration hardware", "aritzia.com",
    "free people", "madewell.com", "lululemon.com",
    "nordstrom.com", "anthropologie", "pinterest.com",
}


# ── Classification NamedTuple ─────────────────────────────────────────────────

class PinClassification(NamedTuple):
    is_reference_eligible:   bool
    reference_quality_score: float
    visual_format:           str
    human_presence:          str
    text_overlay_level:      str
    watermark_detected:      bool
    image_quality_band:      str
    composition_type:        str
    has_clear_subject:       bool


# ── Heuristic helpers ─────────────────────────────────────────────────────────

def _has_token(text: str, tokens: set[str]) -> bool:
    t = text.lower()
    return any(tok in t for tok in tokens)


def _count_tokens(text: str, tokens: set[str]) -> int:
    t = text.lower()
    return sum(1 for tok in tokens if tok in t)


def _aspect_ratio_band(width: int | None, height: int | None) -> str:
    """'portrait' | 'square' | 'landscape'"""
    if not width or not height:
        return "unknown"
    r = width / height
    if r < 0.85:
        return "portrait"
    if r > 1.15:
        return "landscape"
    return "square"


def _text_overlay_level(title: str, description: str) -> str:
    combined = f"{title} {description}".lower()
    heavy_count = _count_tokens(combined, TEXT_HEAVY_TOKENS)

    # Simple heuristic: longer descriptions often imply text-heavy pins
    word_count = len(combined.split())

    if heavy_count >= 4 or word_count > 120:
        return "heavy"
    if heavy_count >= 2 or word_count > 60:
        return "moderate"
    if heavy_count >= 1 or word_count > 30:
        return "light"
    return "none"


def _visual_format(title: str, description: str, outbound: str | None) -> str:
    combined = f"{title} {description}".lower()

    if _has_token(combined, FLAT_LAY_TOKENS):
        return "flat_lay"
    if _has_token(combined, COLLAGE_TOKENS) and _count_tokens(combined, COLLAGE_TOKENS) >= 2:
        return "collage"
    if _has_token(combined, TEXT_HEAVY_TOKENS) and _count_tokens(combined, TEXT_HEAVY_TOKENS) >= 3:
        return "infographic"
    if _has_token(combined, TEXT_HEAVY_TOKENS):
        return "text_heavy"
    if _has_token(combined, PRODUCT_ONLY_TOKENS):
        return "product_only"
    if _has_token(combined, LIFESTYLE_TOKENS):
        return "lifestyle"

    return "unknown"


def _human_presence(title: str, description: str) -> str:
    combined = f"{title} {description}".lower()
    if any(w in combined for w in ("model", "person", "woman", "man", "girl", "boy", "people")):
        return "full"
    if any(w in combined for w in ("hand", "hands", "arm", "holding", "wear")):
        return "hands"
    if any(w in combined for w in ("partial", "crop", "face", "close up")):
        return "partial"
    return "none"


def _watermark_detected(
    domain: str | None,
    outbound: str | None,
    title: str,
    description: str,
) -> bool:
    combined = f"{title} {description}".lower()
    if _has_token(combined, WATERMARK_TITLE_TOKENS):
        return True
    outbound_lower = (outbound or "").lower()
    for wd in WATERMARK_DOMAINS:
        if wd in outbound_lower:
            return True
    return False


def _image_quality_band(
    width: int | None,
    height: int | None,
    save_velocity: float | None,
    domain: str | None,
) -> str:
    # Dimension proxy: larger originals tend to be higher quality
    area = (width or 0) * (height or 0)
    domain_lower = (domain or "").lower()

    quality_score = 0

    # Size signals
    if area >= 1_000_000:   # ~1MP
        quality_score += 3
    elif area >= 400_000:
        quality_score += 2
    elif area >= 100_000:
        quality_score += 1

    # High-quality source domains
    for hq in HIGH_QUALITY_DOMAINS:
        if hq in domain_lower:
            quality_score += 2
            break

    # Save velocity proxy (very high velocity often = viral quality visuals)
    if save_velocity and save_velocity >= 100:
        quality_score += 2
    elif save_velocity and save_velocity >= 20:
        quality_score += 1

    if quality_score >= 5:
        return "high"
    if quality_score >= 2:
        return "medium"
    return "low"


def _composition_type(
    visual_format: str,
    title: str,
    description: str,
) -> str:
    combined = f"{title} {description}".lower()

    if visual_format == "collage":
        return "multi_product"
    if visual_format in ("lifestyle", "flat_lay"):
        return "scene"
    if visual_format == "product_only":
        return "single_focal"
    if visual_format in ("infographic", "text_heavy"):
        return "abstract"

    # Fallback from tokens
    if _count_tokens(combined, COLLAGE_TOKENS) >= 2:
        return "multi_product"
    if _has_token(combined, LIFESTYLE_TOKENS):
        return "scene"

    return "single_focal"


def _reference_quality_score(
    save_count: int,
    image_quality_band: str,
    text_overlay_level: str,
    watermark_detected: bool,
    visual_format: str,
    is_portrait: bool,
) -> float:
    score = 50.0  # baseline

    # Save count signal (log scale, cap at 100k)
    import math
    if save_count > 0:
        score += min(math.log10(save_count) * 8, 20)  # up to +20

    # Image quality
    if image_quality_band == "high":
        score += 15
    elif image_quality_band == "medium":
        score += 5
    else:
        score -= 10

    # Text overlay penalty
    if text_overlay_level == "heavy":
        score -= 25
    elif text_overlay_level == "moderate":
        score -= 10
    elif text_overlay_level == "light":
        score -= 3

    # Watermark penalty
    if watermark_detected:
        score -= 30

    # Format bonuses
    if visual_format in ("lifestyle", "flat_lay"):
        score += 10
    elif visual_format in ("collage",):
        score += 5
    elif visual_format in ("infographic", "text_heavy"):
        score -= 15

    # Pinterest portrait orientation bonus
    if is_portrait:
        score += 5

    return round(max(0.0, min(score, 100.0)), 1)


def classify_pin(row: dict) -> PinClassification:
    title       = (row.get("title") or "")
    description = (row.get("description") or "")
    save_count  = int(row.get("save_count") or 0)
    save_vel    = row.get("save_velocity")
    width       = row.get("image_width")
    height      = row.get("image_height")
    outbound    = row.get("outbound_link")
    domain      = (outbound or "").split("/")[2] if outbound and "://" in outbound else None

    text_level     = _text_overlay_level(title, description)
    vis_format     = _visual_format(title, description, outbound)
    human          = _human_presence(title, description)
    watermark      = _watermark_detected(domain, outbound, title, description)
    qual_band      = _image_quality_band(width, height, save_vel, domain)
    composition    = _composition_type(vis_format, title, description)
    aspect_band    = _aspect_ratio_band(width, height)
    is_portrait    = aspect_band == "portrait"

    quality_score = _reference_quality_score(
        save_count, qual_band, text_level, watermark, vis_format, is_portrait
    )

    has_clear_subject = vis_format not in ("infographic", "text_heavy", "collage")

    content_decision = evaluate_pin_content(
        title=title,
        description=description,
        keyword=row.get("seed_keyword") or row.get("source_keyword"),
        category=row.get("category"),
    )

    # Eligibility gate
    eligible = (
        not content_decision.reject
        and not watermark
        and text_level != "heavy"
        and qual_band != "low"
        and has_clear_subject
        and save_count >= 500
    )

    return PinClassification(
        is_reference_eligible=eligible,
        reference_quality_score=quality_score,
        visual_format=vis_format,
        human_presence=human,
        text_overlay_level=text_level,
        watermark_detected=watermark,
        image_quality_band=qual_band,
        composition_type=composition,
        has_clear_subject=has_clear_subject,
    )


# ── DB helpers ────────────────────────────────────────────────────────────────

RECENT_CLASSIFY_DAYS = 7


def _load_pins(
    db: DB,
    reclassify_all: bool,
    min_saves: int,
    limit: int,
    since: str | None = None,
    categories: list[str] | None = None,
    require_dims: bool = False,
) -> list[dict]:
    filters: dict[str, str] = {
        "save_count": f"gte.{min_saves}",
        "image_url":  "not.is.null",
        "is_seed":    "is.false",
    }
    # require_dims is a targeted re-band of rows that now have real image
    # dimensions (e.g. after the scraper dimension fix). It reprocesses rows
    # regardless of prior classification so stale low-band rows get re-scored,
    # but ONLY those with non-NULL width AND height — never legacy NULL-dim rows.
    process_all = reclassify_all or require_dims
    if not process_all:
        # New crawled rows default is_reference_eligible=false; use reference_quality_score
        # (always written by this classifier) to detect unprocessed pins.
        filters["reference_quality_score"] = "is.null"
        # Explicit `since` (e.g. the bootstrap crawl window) overrides the default
        # rolling RECENT_CLASSIFY_DAYS cutoff so we classify ONLY recently-crawled
        # pins and never sweep older legacy rows.
        cutoff = since or (
            datetime.now(tz=timezone.utc) - timedelta(days=RECENT_CLASSIFY_DAYS)
        ).isoformat()
        filters["scraped_at"] = f"gte.{cutoff}"
    elif since:
        filters["scraped_at"] = f"gte.{since}"

    if require_dims:
        # Only rows with genuine, persisted dimensions. Both must be present so
        # the area/quality-band scoring has real input (never placeholder/NULL).
        filters["image_width"]  = "not.is.null"
        filters["image_height"] = "not.is.null"

    if categories:
        # Restrict to specific (e.g. P0) categories — never widen scope.
        filters["category"] = "in.(" + ",".join(categories) + ")"

    return db.select_many(
        "pin_samples",
        columns=(
            "id,title,description,save_count,save_velocity,"
            "image_width,image_height,outbound_link,trend_stage,scraped_at,category"
        ),
        filters=filters,
        order="scraped_at.desc,save_count.desc",
        limit=limit,
    ) or []


def _write_pin_classification(db: DB, pin_id: str, clf: PinClassification) -> None:
    db.update_where(
        "pin_samples",
        data={
            "is_reference_eligible":   clf.is_reference_eligible,
            "reference_quality_score": clf.reference_quality_score,
            "visual_format":           clf.visual_format,
            "human_presence":          clf.human_presence,
            "text_overlay_level":      clf.text_overlay_level,
            "watermark_detected":      clf.watermark_detected,
            "image_quality_band":      clf.image_quality_band,
            "composition_type":        clf.composition_type,
            "has_clear_subject":       clf.has_clear_subject,
        },
        filters={"id": f"eq.{pin_id}"},
    )


# ── Entry point ───────────────────────────────────────────────────────────────

def run(
    reclassify_all: bool = False,
    min_saves: int = 500,
    limit: int = 5000,
    dry_run: bool = False,
    verbose: bool = False,
    since: str | None = None,
    categories: list[str] | None = None,
    require_dims: bool = False,
) -> dict:
    db = DB()

    log.info(
        "Loading pin_samples (reclassify_all=%s, min_saves=%d, limit=%d, since=%s, categories=%s, require_dims=%s) …",
        reclassify_all, min_saves, limit, since, categories, require_dims,
    )
    rows = _load_pins(db, reclassify_all, min_saves, limit, since=since,
                      categories=categories, require_dims=require_dims)
    log.info("Loaded %d pin rows%s", len(rows), " (only-with-dims)" if require_dims else "")

    eligible_count   = 0
    ineligible_count = 0
    format_counts: dict[str, int] = {}
    eligible_by_category: dict[str, int] = {}
    rows_by_category: dict[str, int] = {}

    for row in rows:
        clf = classify_pin(row)

        cat = row.get("category") or "unknown"
        rows_by_category[cat] = rows_by_category.get(cat, 0) + 1
        format_counts[clf.visual_format] = format_counts.get(clf.visual_format, 0) + 1
        if clf.is_reference_eligible:
            eligible_count += 1
            eligible_by_category[cat] = eligible_by_category.get(cat, 0) + 1
        else:
            ineligible_count += 1

        if verbose:
            log.info(
                "  [%s] saves=%d → eligible=%s score=%.1f fmt=%s text=%s wm=%s",
                row["id"][:8],
                row.get("save_count", 0),
                clf.is_reference_eligible,
                clf.reference_quality_score,
                clf.visual_format,
                clf.text_overlay_level,
                clf.watermark_detected,
            )

        if not dry_run:
            _write_pin_classification(db, row["id"], clf)

    log.info(
        "Results: eligible=%d  ineligible=%d  total=%d",
        eligible_count, ineligible_count, len(rows),
    )
    log.info(
        "Visual formats: %s",
        "  ".join(f"{k}={v}" for k, v in sorted(format_counts.items(), key=lambda x: -x[1])),
    )
    log.info("dry_run=%s", dry_run)

    # Counts returned for execution-layer logging (no logic change).
    return {
        "reference_rows": len(rows),
        "eligible":       eligible_count,
        "ineligible":     ineligible_count,
        "updated_rows":   0 if dry_run else len(rows),
        "eligibleByCategory": eligible_by_category,
        "rowsByCategory":     rows_by_category,
        "visualFormats":      format_counts,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Classify pin_samples for reference eligibility")
    parser.add_argument("--all",       dest="reclassify_all", action="store_true")
    parser.add_argument("--min-saves", type=int, default=500)
    parser.add_argument("--limit",     type=int, default=5000)
    parser.add_argument("--dry-run",   action="store_true")
    parser.add_argument("--verbose",   action="store_true")
    parser.add_argument("--category",  default=None,
                        help="Comma-separated category scope, e.g. 'fashion' or 'fashion,beauty'.")
    parser.add_argument("--only-with-dims", action="store_true",
                        help="Targeted re-band of rows that have real image_width AND image_height "
                             "(reprocesses already-classified rows; ignores the recent-window filter).")
    args = parser.parse_args()

    cats = [c.strip() for c in args.category.split(",") if c.strip()] if args.category else None

    run(
        reclassify_all=args.reclassify_all,
        min_saves=args.min_saves,
        limit=args.limit,
        dry_run=args.dry_run,
        verbose=args.verbose,
        categories=cats,
        require_dims=args.only_with_dims,
    )
