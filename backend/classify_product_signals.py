"""
classify_product_signals.py
────────────────────────────
Classifies every row in pin_products with:
  - product_type       : 'physical' | 'digital'
  - source_platform    : normalized platform slug
  - digital_format     : granular format for digital products
  - product_signal_confidence : 0.0–1.0
  - inspiration_only   : always True  (pin_products are NEVER user-owned assets)
  - is_user_ownable    : always False
  - is_mockup_like     : heuristic detection

Classification runs in two passes:
  1. Domain-based (high confidence) → deterministic
  2. Title-token-based (medium confidence) → probabilistic

Usage:
  python classify_product_signals.py                  # classify all unclassified rows
  python classify_product_signals.py --all            # reclassify all rows
  python classify_product_signals.py --dry-run        # print results, no writes
  python classify_product_signals.py --limit 500      # cap rows processed
  python classify_product_signals.py --verbose        # log each decision
"""

from __future__ import annotations

import argparse
import logging
import re
import sys
from pathlib import Path
from typing import NamedTuple

_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(_ROOT / "db"))
from db import DB

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


# ── Domain rules ──────────────────────────────────────────────────────────────

# Maps domain fragment → (product_type, source_platform, digital_format | None)
DOMAIN_RULES: list[tuple[str, str, str, str | None]] = [
    # Digital-only platforms (highest confidence)
    ("teacherspayteachers.com",  "digital", "tpt",            "printable"),
    ("tpt.com",                  "digital", "tpt",            "printable"),
    ("payhip.com",               "digital", "payhip",         None),
    ("gumroad.com",              "digital", "gumroad",        None),
    ("creativemarket.com",       "digital", "creativemarket", None),
    ("creativefabrica.com",      "digital", "creativefabrica",None),
    ("design.cuts.com",          "digital", "designcuts",     None),
    ("fontbundles.net",          "digital", "fontbundles",    "font"),
    ("canva.com",                "digital", "canva",          "template"),
    ("notion.so",                "digital", "notion",         "notion"),
    ("notion.site",              "digital", "notion",         "notion"),
    ("ko-fi.com",                "digital", "kofi",           None),
    ("selz.com",                 "digital", "selz",           None),
    ("sendowl.com",              "digital", "sendowl",        None),
    ("stan.store",               "digital", "stanstore",      None),
    ("beacons.ai",               "digital", "beacons",        None),
    # Physical-only platforms (high confidence)
    ("amazon.com",               "physical", "amazon",   None),
    ("target.com",               "physical", "target",   None),
    ("walmart.com",              "physical", "walmart",  None),
    ("wayfair.com",              "physical", "wayfair",  None),
    ("nordstrom.com",            "physical", "nordstrom",None),
    ("nordstromrack.com",        "physical", "nordstrom",None),
    ("poshmark.com",             "physical", "poshmark", None),
    ("depop.com",                "physical", "depop",    None),
    ("zara.com",                 "physical", "zara",     None),
    ("shein.com",                "physical", "shein",    None),
    ("asos.com",                 "physical", "asos",     None),
    ("aliexpress.com",           "physical", "aliexpress",None),
    ("lightinthebox.com",        "physical", "lightinthebox",None),
    ("homedepot.com",            "physical", "homedepot",None),
    ("ikea.com",                 "physical", "ikea",     None),
]

DIGITAL_PLATFORMS = {r[1] for r in DOMAIN_RULES if r[0] != "etsy.com" and r[1] not in (
    "amazon","target","walmart","wayfair","nordstrom","poshmark","depop",
    "zara","shein","asos","aliexpress","lightinthebox","homedepot","ikea",
)}


# ── Token rules ───────────────────────────────────────────────────────────────

DIGITAL_TITLE_TOKENS = {
    "printable", "printables", "template", "templates", "worksheet", "worksheets",
    "planner", "planners", "tracker", "trackers", "checklist", "spreadsheet",
    "notion", "canva", "editable", "fillable", "download", "downloads",
    "pdf", "svg", "png", "clipart", "clip art", "invitation", "invitations",
    "mockup", "mockups", "preset", "presets", "ebook", "e-book", "guide",
    "digital", "instant access", "instant download",
}

DIGITAL_URL_TOKENS = {
    "printable", "template", "digital", "download", "pdf", "svg",
    "worksheet", "planner", "ebook", "preset", "mockup",
}

MOCKUP_TITLE_TOKENS = {
    "mockup", "mock up", "scene creator", "branding kit", "frame",
    "styled stock", "stock photo", "scene", "psd",
}

DIGITAL_FORMAT_MAP: dict[str, str] = {
    "printable":    "printable",
    "printables":   "printable",
    "template":     "template",
    "templates":    "template",
    "worksheet":    "printable",
    "worksheets":   "printable",
    "planner":      "printable",
    "planners":     "printable",
    "tracker":      "printable",
    "spreadsheet":  "template",
    "notion":       "notion",
    "canva":        "canva",
    "svg":          "svg",
    "clipart":      "svg",
    "clip art":     "svg",
    "pdf":          "printable",
    "ebook":        "ebook",
    "e-book":       "ebook",
    "preset":       "preset",
    "presets":      "preset",
    "mockup":       "template",
    "invitation":   "printable",
    "font":         "font",
}

PLATFORM_FROM_DOMAIN: dict[str, str] = {
    r[0].split(".")[0]: r[1] for r in DOMAIN_RULES
}


# ── Classification logic ──────────────────────────────────────────────────────

class Classification(NamedTuple):
    product_type:              str
    source_platform:           str
    digital_format:            str | None
    product_signal_confidence: float
    inspiration_only:          bool
    is_user_ownable:           bool
    is_mockup_like:            bool


def _domain_key(domain: str | None) -> str:
    if not domain:
        return ""
    d = domain.lower().strip()
    if d.startswith("www."):
        d = d[4:]
    return d


def _classify_by_domain(domain: str | None) -> Classification | None:
    key = _domain_key(domain)
    if not key:
        return None
    for fragment, ptype, platform, dfmt in DOMAIN_RULES:
        if fragment in key or key.endswith(fragment):
            return Classification(
                product_type=ptype,
                source_platform=platform,
                digital_format=dfmt,
                product_signal_confidence=0.95,
                inspiration_only=True,
                is_user_ownable=False,
                is_mockup_like=False,
            )
    return None


def _classify_etsy(domain: str | None, title: str, url: str) -> Classification | None:
    """Etsy requires extra signal — either URL token or title token."""
    key = _domain_key(domain)
    if "etsy.com" not in key:
        return None

    title_lower = title.lower()
    url_lower   = (url or "").lower()

    # URL token check
    for token in DIGITAL_URL_TOKENS:
        if token in url_lower:
            fmt = DIGITAL_FORMAT_MAP.get(token)
            return Classification("digital", "etsy", fmt, 0.85, True, False, False)

    # Title token check
    for token in DIGITAL_TITLE_TOKENS:
        if token in title_lower:
            fmt = DIGITAL_FORMAT_MAP.get(token)
            return Classification("digital", "etsy", fmt, 0.80, True, False, False)

    # Default Etsy → physical
    return Classification("physical", "etsy", None, 0.75, True, False, False)


def _classify_by_tokens(title: str, url: str) -> Classification | None:
    title_lower = (title or "").lower()
    url_lower   = (url or "").lower()

    matched_digital: list[str] = []
    for token in DIGITAL_TITLE_TOKENS:
        if token in title_lower:
            matched_digital.append(token)
    for token in DIGITAL_URL_TOKENS:
        if token in url_lower and token not in matched_digital:
            matched_digital.append(token)

    if not matched_digital:
        return None

    # Best matching format
    dfmt: str | None = None
    for token in matched_digital:
        dfmt = DIGITAL_FORMAT_MAP.get(token)
        if dfmt:
            break

    # Mockup detection
    is_mockup = any(t in title_lower for t in MOCKUP_TITLE_TOKENS)

    confidence = 0.60 + min(len(matched_digital) * 0.05, 0.25)
    return Classification("digital", "other", dfmt, round(confidence, 2), True, False, is_mockup)


def _infer_platform_from_domain(domain: str | None) -> str:
    key = _domain_key(domain)
    if not key:
        return "other"
    # try first segment before first dot
    base = key.split(".")[0]
    return PLATFORM_FROM_DOMAIN.get(base, key.split(".")[0] if key else "other")


def classify_product(
    domain: str | None,
    title: str | None,
    source_url: str | None,
    normalized_merchant: str | None = None,
) -> Classification:
    title = (title or "").strip()
    url   = (source_url or "").strip()

    # 1. Etsy (special case — mixed physical/digital)
    etsy_result = _classify_etsy(domain, title, url)
    if etsy_result:
        is_mockup = any(t in title.lower() for t in MOCKUP_TITLE_TOKENS)
        return etsy_result._replace(is_mockup_like=is_mockup)

    # 2. Domain-based rules (deterministic)
    domain_result = _classify_by_domain(domain)
    if domain_result:
        is_mockup = any(t in title.lower() for t in MOCKUP_TITLE_TOKENS)
        return domain_result._replace(is_mockup_like=is_mockup)

    # 3. Title / URL tokens (probabilistic)
    token_result = _classify_by_tokens(title, url)
    if token_result:
        platform = _infer_platform_from_domain(domain)
        return token_result._replace(source_platform=platform)

    # 4. Default → physical, unknown platform
    platform = _infer_platform_from_domain(domain)
    is_mockup = any(t in title.lower() for t in MOCKUP_TITLE_TOKENS)
    return Classification(
        product_type="physical",
        source_platform=platform,
        digital_format=None,
        product_signal_confidence=0.50,
        inspiration_only=True,
        is_user_ownable=False,
        is_mockup_like=is_mockup,
    )


# ── DB operations ─────────────────────────────────────────────────────────────

def _load_products(db: DB, reclassify_all: bool, limit: int, since: str | None = None) -> list[dict]:
    filters: dict[str, str] = {"is_seed": "is.false"}
    if not reclassify_all:
        filters["product_type"] = "is.null"
    if since:
        # Scope to products created within the window (e.g. the bootstrap STL pass)
        # so we never touch the legacy product table.
        filters["created_at"] = f"gte.{since}"

    return db.select_many(
        "pin_products",
        columns="id,domain,product_name,source_url,normalized_merchant,parent_pin_id,created_at",
        filters=filters,
        order="created_at.desc",
        limit=limit,
    ) or []


def _write_classification(db: DB, product_id: str, clf: Classification) -> None:
    db.update_where(
        "pin_products",
        data={
            "product_type":              clf.product_type,
            "source_platform":           clf.source_platform,
            "digital_format":            clf.digital_format,
            "product_signal_confidence": clf.product_signal_confidence,
            "inspiration_only":          clf.inspiration_only,
            "is_user_ownable":           clf.is_user_ownable,
            "is_mockup_like":            clf.is_mockup_like,
        },
        filters={"id": f"eq.{product_id}"},
    )


# ── Entry point ───────────────────────────────────────────────────────────────

def run(
    reclassify_all: bool = False,
    limit: int = 5000,
    dry_run: bool = False,
    verbose: bool = False,
    since: str | None = None,
) -> dict:
    db = DB()

    log.info("Loading pin_products (reclassify_all=%s, limit=%d, since=%s) …", reclassify_all, limit, since)
    rows = _load_products(db, reclassify_all, limit, since=since)
    log.info("Loaded %d product rows", len(rows))

    counts: dict[str, int] = {"physical": 0, "digital": 0}
    platform_counts: dict[str, int] = {}

    for row in rows:
        clf = classify_product(
            domain=row.get("domain"),
            title=row.get("product_name"),
            source_url=row.get("source_url"),
            normalized_merchant=row.get("normalized_merchant"),
        )

        counts[clf.product_type] = counts.get(clf.product_type, 0) + 1
        platform_counts[clf.source_platform] = platform_counts.get(clf.source_platform, 0) + 1

        if verbose:
            log.info(
                "  [%s] %s → type=%s platform=%s fmt=%s conf=%.2f mockup=%s",
                row["id"][:8],
                (row.get("product_name") or "")[:40],
                clf.product_type,
                clf.source_platform,
                clf.digital_format or "-",
                clf.product_signal_confidence,
                clf.is_mockup_like,
            )

        if not dry_run:
            _write_classification(db, row["id"], clf)

    log.info("Results: physical=%d  digital=%d", counts.get("physical", 0), counts.get("digital", 0))
    top_platforms = sorted(platform_counts.items(), key=lambda x: -x[1])[:10]
    log.info("Top platforms: %s", "  ".join(f"{k}={v}" for k, v in top_platforms))
    log.info("dry_run=%s", dry_run)

    # Counts returned for execution-layer logging (no logic change).
    return {
        "product_rows": len(rows),
        "physical":     counts.get("physical", 0),
        "digital":      counts.get("digital", 0),
        "platformDistribution": dict(platform_counts),
        "updated_rows": 0 if dry_run else len(rows),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Classify pin_products physical/digital")
    parser.add_argument("--all",     dest="reclassify_all", action="store_true",
                        help="Reclassify all rows (not just unclassified)")
    parser.add_argument("--limit",   type=int, default=5000)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    run(
        reclassify_all=args.reclassify_all,
        limit=args.limit,
        dry_run=args.dry_run,
        verbose=args.verbose,
    )
