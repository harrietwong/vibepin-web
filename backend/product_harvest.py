"""
product_harvest.py — Scoped harvest of pin_samples.outbound_link → pin_products.

Converts product URLs ALREADY collected on crawled pins into product rows, with
zero new scraping (no Playwright). Scoped to the recent bootstrap crawl so it
never touches legacy pins. Reuses the existing domain classifier
(classify_product_signals) — does not invent metrics.

Honesty / guardrails:
  - Scope is enforced by source_interest (bootstrap) + scraped_at window.
  - Acceptance is restricted to KNOWN commerce domains (digital + physical
    marketplaces). Blogs/social/pinterest-internal links are rejected.
  - save_count is INHERITED from the source pin as evidence — never fabricated.
  - inspiration_only = True (platform signal, not user-owned).
  - Provenance is labeled discovery_method = "outbound_link_bootstrap".
  - Dry-run writes nothing; apply requires explicit apply=True.

CLI (run_worker):
  python run_worker.py --job harvest-outbound-products --since-hours 24 --source bootstrap --dry-run
  python run_worker.py --job harvest-outbound-products --since-hours 24 --source bootstrap --apply
"""

from __future__ import annotations

import hashlib
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "db"))

from classify_product_signals import DOMAIN_RULES, classify_product  # type: ignore
from content_filters import evaluate_pin_content  # type: ignore
from product_lifecycle import is_retired, with_not_retired  # type: ignore

PROVENANCE = "outbound_link_bootstrap"
BOOTSTRAP_SOURCES = ("manual_bootstrap", "csv_bootstrap")
P0_CATEGORIES = ("fashion", "womens-fashion", "home-decor", "beauty", "digital-products")

# Known commerce domains we accept (digital + physical marketplaces) — from the
# existing classifier's DOMAIN_RULES, plus Etsy (mixed) and Shopify storefronts.
KNOWN_COMMERCE_DOMAINS = {r[0] for r in DOMAIN_RULES} | {"etsy.com"}
SHOPIFY_MARKERS = ("myshopify.com",)

# Never products
SOCIAL_DOMAINS = {
    "instagram.com", "tiktok.com", "youtube.com", "youtu.be", "facebook.com",
    "twitter.com", "x.com", "threads.net", "reddit.com", "linktr.ee",
}
_TRACKING_PARAMS = ("utm_", "fbclid", "gclid", "mc_eid", "mc_cid", "epik", "ref_src")
_DROP_PARAMS = {"ref", "ref_", "epik", "rs", "crt"}


# ── URL helpers ────────────────────────────────────────────────────────────

def get_domain(url: str) -> str:
    try:
        host = (urlsplit(url).netloc or "").lower()
        return host[4:] if host.startswith("www.") else host
    except Exception:
        return ""


def normalize_product_url(url: str) -> str:
    """Canonicalize for dedup: drop scheme/host case, www, tracking params, trailing slash."""
    if not url:
        return ""
    try:
        s = urlsplit(url.strip())
        host = (s.netloc or "").lower()
        if host.startswith("www."):
            host = host[4:]
        q = [
            (k, v) for k, v in parse_qsl(s.query)
            if not any(k.lower().startswith(t) for t in _TRACKING_PARAMS)
            and k.lower() not in _DROP_PARAMS
        ]
        path = s.path.rstrip("/")
        scheme = (s.scheme or "https").lower()
        return urlunsplit((scheme, host, path, urlencode(sorted(q)), ""))
    except Exception:
        return url.strip().lower()


def url_hash(normalized_url: str) -> str:
    return hashlib.sha1(normalized_url.encode("utf-8")).hexdigest()


# ── Acceptance / classification ─────────────────────────────────────────────

# ═══ PDP GATE — "is this actually a PRODUCT DETAIL page?" ═════════════════════
# Backfilled here from the T2 pilot (2026-07-14). The pilot dry-run proved that the
# old accept_link() had a real PRECISION defect: it let through
#     amazon.com/Terrific-Patio-Garden-.../s?k=patio+garden        ← a SEARCH page
#     teacherspayteachers.com/browse/free?search=printable+pecs    ← a BROWSE page
# because those paths matched no explicit non-product rule and the domain was on the
# known-commerce list. A downstream fetcher then "extracted" a page title
# ("Amazon.com : patio garden") and it would have become a product row. A search /
# browse / category surface must NEVER become a product opportunity — that is a fake
# product, which is exactly the class of dirty data this whole workstream exists to
# eliminate. The gate lives in accept_link() so EVERY harvester inherits it
# (product_harvest, product_supply_expand, product_supply_spike, shop_the_look_*,
# t2_harvest) rather than only the one tool that discovered the bug.
#
# It FAILS CLOSED: a domain with no explicit PDP rule must still present a
# recognizable product-detail path shape to qualify.

# A search/keyword query string is strong evidence of a results page. BUT it is only
# decisive when the PATH itself is not already a proven product-detail page: real PDP
# links carry search/affiliate tracking noise all the time, e.g.
#   amazon.com/(New-Release)-Home-Wall-Decor/dp/B09QFWX7RL?dchild=1&keywords=home-wall
# is a genuine ASIN page. Path evidence therefore OUTRANKS query-string evidence.
_SEARCH_QUERY_PARAM = re.compile(r"(?:^|&)(?:k|q|s|search|keywords?|query)=", re.I)

# Per-domain-family canonical PDP path shapes. If the domain matches, the path MUST
# match, otherwise it is not a product detail page — no fallbacks.
_PDP_RULES: tuple[tuple[re.Pattern[str], re.Pattern[str]], ...] = (
    (re.compile(r"(^|\.)amazon\.", re.I),
     re.compile(r"/(?:dp|gp/product)/[A-Z0-9]{10}", re.I)),
    (re.compile(r"(^|\.)etsy\.com$", re.I),
     re.compile(r"/listing/\d+", re.I)),
    (re.compile(r"(^|\.)ebay\.", re.I),
     re.compile(r"/itm/", re.I)),
    (re.compile(r"(^|\.)teacherspayteachers\.com$", re.I),
     re.compile(r"/(?:Product|product)/", re.I)),
    (re.compile(r"(^|\.)canva\.com$", re.I),
     re.compile(r"/templates/[A-Za-z0-9_-]+", re.I)),
    (re.compile(r"(^|\.)payhip\.com$", re.I),
     re.compile(r"/b/[A-Za-z0-9]+", re.I)),
    (re.compile(r"(^|\.)gumroad\.com$", re.I),
     re.compile(r"/l/[A-Za-z0-9]+", re.I)),
    # Verified against the live corpus (2026-07-14): these are real PDP shapes that the
    # generic rules below would otherwise reject as false negatives. Each is written as
    # a DOMAIN rule (not a generic shape) so it stays precise: on these domains a URL
    # that does NOT match the shape is definitively not a product detail page.
    (re.compile(r"(^|\.)walmart\.com$", re.I),
     re.compile(r"/ip/[^/]+", re.I)),
    (re.compile(r"(^|\.)poshmark\.com$", re.I),
     re.compile(r"/listing/[^/]+", re.I)),
    (re.compile(r"(^|\.)wayfair\.", re.I),
     re.compile(r"/pdp/[^/]+|-pdp-[^/]+", re.I)),
    (re.compile(r"(^|\.)shein\.com$", re.I),
     re.compile(r"-p-\d+", re.I)),
    # Teepublic product pages are /<product-category>/<numeric-id>-<slug>
    # (e.g. /t-shirt/77625009-..., /poster-and-art/80640861-...). accept_link()
    # already accepts these via its own precise Teepublic rule and EXEMPTS them from
    # the generic PDP re-gate; without a matching rule here, check_red_lines()' raw
    # is_product_detail_url() call disagreed and failed the batch. The rule mirrors
    # accept_link: a real product carries a numeric listing id; /user/ and /stores/
    # profile pages (no leading id segment) correctly fall through to rejection.
    (re.compile(r"(^|\.)teepublic\.com$", re.I),
     re.compile(r"/[a-z0-9-]+/\d+-", re.I)),
)

# Listing / search / browse surfaces are never a PDP, on any domain.
_NON_PDP_PATH = re.compile(
    r"(?:^|/)(?:s|search|browse|shop|collections?|category|categories|deals|b|gp/browse)(?:/|$)",
    re.I)


def is_product_detail_url(url: str) -> tuple[bool, str]:
    """Domain-aware PDP gate. Returns (ok, reason).

    Answers only one question: does this URL point at ONE specific product's detail
    page? Search/browse/category pages are rejected outright. Unknown domains fail
    CLOSED — they must still show a product-detail path shape (Shopify /products/<h>,
    /p/<h>, /item/<h>, /dp/<h>) to qualify.
    """
    parts = urlsplit(url or "")
    domain = get_domain(url)
    path = parts.path or ""
    query = parts.query or ""

    # 1) Domain-specific rule wins outright when the domain has one. The path is the
    #    evidence — query-string noise (?keywords=…&dchild=1 affiliate tracking) does
    #    NOT demote a proven ASIN/listing path.
    for dom_re, pdp_re in _PDP_RULES:
        if dom_re.search(domain):
            if pdp_re.search(path):
                return True, "pdp_path"
            if _SEARCH_QUERY_PARAM.search(query):
                return False, "search_query_string"
            return False, "not_a_pdp_path"

    # 2) Affirmative generic product-detail path shapes, checked BEFORE the
    #    listing/browse rejection: a Shopify PDP is legitimately nested under a
    #    collection — /collections/mosaics/products/3x8-athens-gray is a real product
    #    page. Rejecting on the "collections" segment first would drop it as a browse
    #    page. The /products/<handle> segment is the specific signal; the surrounding
    #    collection path is just navigation context.
    if re.search(r"/products?/[^/]+", path, re.I):
        return True, "shopify_product_path"
    if re.search(r"/(?:p|pd|item|ip|dp|listing)/[^/]+", path, re.I):
        return True, "generic_product_path"

    # 3) No product-detail path evidence at all → a search query string or a
    #    listing/browse path segment is decisive.
    if _SEARCH_QUERY_PARAM.search(query):
        return False, "search_query_string"
    if _NON_PDP_PATH.search(path):
        return False, "listing_or_browse_path"
    return False, "no_recognizable_pdp_path"


# Domains whose accept_link() rules are ALREADY path-precise product-detail rules
# (RETAIL_PRODUCT_PATHS + teepublic). Re-gating them through the generic PDP shapes
# above would reject valid PDPs whose paths simply do not look like /p/ or /products/
# (e.g. flightclub.com/air-jordan-1-retro-high-og-dz5485-612,
#  anthropologie.com/shop/the-love-knot-slouchy-bag). The retailer rules are the
# stricter, domain-specific gate for these — the generic gate would only add false
# negatives, never catch a search page the retailer rule already rejects.
_PDP_GATE_EXEMPT_REASONS = frozenset({"retailer_product_path", "teepublic_product"})

# Shopify product URLs follow /products/<handle> (optionally under /collections/<c>/).
_SHOPIFY_PRODUCT_PATH = re.compile(r"/products/[^/]+")

# Retailers observed in the accepted Shop-the-Look spike. These are deliberately
# path-based: listing/search/category/store pages remain rejected.
RETAIL_PRODUCT_PATHS: dict[str, tuple[re.Pattern[str], ...]] = {
    "puma.com": (
        re.compile(r"/(?:[a-z]{2}/[a-z]{2}/)?pd/[^/]+/\d+", re.I),
    ),
    "ebay.com": (
        re.compile(r"/itm/(?:[^/]+/)?\d+", re.I),
    ),
    "anthropologie.com": (
        re.compile(r"/(?:[a-z]{2}-[a-z]{2}/)?shop/(?=[^/]*-)[a-z0-9][a-z0-9-]{5,}$", re.I),
    ),
    "flightclub.com": (
        re.compile(r"/(?=[^/]*\d)[a-z0-9][a-z0-9-]{12,}$", re.I),
    ),
    "dsw.com": (
        re.compile(r"/product/[a-z0-9][a-z0-9-]+/\d+", re.I),
    ),
    "quince.com": (
        re.compile(r"/(?:women|men|home|baby|kids)/[a-z0-9][a-z0-9-]{5,}$", re.I),
    ),
    "wconcept.com": (
        re.compile(r"/product/[a-z0-9][a-z0-9-]+/\d+\.html$", re.I),
    ),
}

_NON_PRODUCT_PATHS = (
    re.compile(r"^/?$"),
    re.compile(r"/(?:search|category|categories|collections?|user|users|profile|profiles|store|stores)(?:/|$)", re.I),
    re.compile(r"/(?:cart|checkout|login|signin|signup|account|help|blog|blogs)(?:/|$)", re.I),
)

# Domain-specific navigation/list pages that do not fit the generic path gate.
# Amazon influencer storefront lists are commerce-adjacent, but are not product
# detail pages and must not enter the product supply dataset.
_DOMAIN_NON_PRODUCT_PATHS: dict[str, tuple[re.Pattern[str], ...]] = {
    "amazon.com": (
        re.compile(r"/shop(?:/|$)", re.I),
    ),
}


def _matching_retail_rule(domain: str) -> tuple[re.Pattern[str], ...] | None:
    for base, rules in RETAIL_PRODUCT_PATHS.items():
        if domain == base or domain.endswith("." + base):
            return rules
    return None


def _matches_domain_non_product_path(domain: str, path: str) -> bool:
    for base, rules in _DOMAIN_NON_PRODUCT_PATHS.items():
        if domain == base or domain.endswith("." + base):
            return any(pattern.search(path) for pattern in rules)
    return False


def accept_link(url: str) -> tuple[bool, str]:
    """Return (accepted, reason). Accepts known commerce marketplaces + a few safe,
    path-based product patterns (Shopify /products/, Teepublic product pages).

    Every acceptance is then re-checked by the PDP gate (is_product_detail_url), so a
    search/browse/category page on an otherwise-legitimate commerce domain can never be
    accepted as a product. Domains that already have a path-precise product rule
    (RETAIL_PRODUCT_PATHS, Teepublic) are exempt — their own rule IS the PDP gate."""
    if not url or not url.startswith("http"):
        return False, "empty_or_relative"
    parts = urlsplit(url)
    domain = get_domain(url)
    path = (parts.path or "").rstrip("/") or "/"
    if not domain:
        return False, "no_domain"
    if "pinterest.com" in domain:
        return False, "pinterest_internal"
    if domain in SOCIAL_DOMAINS or any(domain.endswith("." + s) for s in SOCIAL_DOMAINS):
        return False, "social_media"

    accepted, reason = _accept_link_domain_rules(url, domain, path)
    if not accepted:
        return False, reason
    # ── PDP GATE (the P1 backfill) ───────────────────────────────────────────
    # The domain rules answer "is this a commerce domain / plausible product path?".
    # They do NOT answer "is this ONE product's detail page?" — which is how Amazon
    # /s?k=… search pages and TPT /browse pages slipped through into the supply set.
    if reason in _PDP_GATE_EXEMPT_REASONS:
        return True, reason
    is_pdp, pdp_reason = is_product_detail_url(url)
    if not is_pdp:
        return False, f"not_product_detail_page:{pdp_reason}"
    return True, reason


def _accept_link_domain_rules(url: str, domain: str, path: str) -> tuple[bool, str]:
    """The original domain/path acceptance rules (commerce-domain + path shape)."""
    # Teepublic: accept true product/listing pages, reject user/profile/store pages.
    if domain == "teepublic.com" or domain.endswith(".teepublic.com"):
        if path in ("", "/") or path.startswith("/user/") or path.startswith("/stores/"):
            return False, "marketplace_profile"
        return True, "teepublic_product"
    # Shopify-convention product page on an unlisted merchant domain (low-risk path match).
    if _SHOPIFY_PRODUCT_PATH.search(path):
        return True, "shopify_product_path"
    if any(m in domain for m in SHOPIFY_MARKERS):
        return False, "shopify_non_product_path"
    retail_rules = _matching_retail_rule(domain)
    if retail_rules is not None:
        if any(pattern.search(path) for pattern in retail_rules):
            return True, "retailer_product_path"
        return False, "retailer_non_product_path"
    if _matches_domain_non_product_path(domain, path):
        return False, "non_product_path"
    if any(pattern.search(path) for pattern in _NON_PRODUCT_PATHS):
        return False, "non_product_path"
    if domain in KNOWN_COMMERCE_DOMAINS or any(domain == d or domain.endswith("." + d) for d in KNOWN_COMMERCE_DOMAINS):
        return True, "known_commerce_domain"
    return False, "non_commerce_domain"


def classify_link(url: str, title: str | None) -> dict[str, Any]:
    """Classify an accepted product link via the existing classifier (no overclassify).
    type_bucket ∈ physical | digital | unknown."""
    domain = get_domain(url)
    clf = classify_product(domain=domain, title=title, source_url=url, normalized_merchant=None)
    plat = (clf.source_platform or "").lower()
    bucket = clf.product_type
    if plat in ("", "unknown", "other") and float(clf.product_signal_confidence or 0) < 0.5:
        bucket = "unknown"
    return {
        "product_type": clf.product_type,
        "type_bucket": bucket,
        "source_platform": clf.source_platform,
        "digital_format": clf.digital_format,
        "confidence": float(clf.product_signal_confidence or 0),
        "is_mockup_like": clf.is_mockup_like,
        "domain": domain,
    }


def build_product_row(pin: dict, url: str, clf: dict) -> dict:
    """Build a pin_products-shaped row from a source pin + its outbound link.
    Metrics are inherited from the pin; nothing fabricated."""
    normalized = normalize_product_url(url)
    return {
        "parent_pin_id":            pin.get("pin_id"),
        # Populate source_pin_url at insert time (was previously only backfilled).
        # Same canonical format the STL path + the prior backfill use, derived from the
        # source pin id — so harvested rows don't regress source_pin_url coverage.
        "source_pin_url":           (f"https://www.pinterest.com/pin/{pin.get('pin_id')}/"
                                     if pin.get("pin_id") else None),
        "product_pin_id":           None,  # not a product pin — the pin's own outbound link
        # product_name is NOT NULL in pin_products (migrate_v5); fall back to a
        # non-null label when the source pin has no title (mirrors the STL path).
        "product_name":             ((pin.get("title") or "").strip()
                                     or clf.get("source_platform") or clf.get("domain") or "Product"),
        "source_url":               url,
        "canonical_product_url":    normalized,
        "product_url_hash":         url_hash(normalized),
        "domain":                   clf["domain"],
        "source_platform":          clf["source_platform"],
        "product_type":             clf["product_type"],
        "digital_format":           clf["digital_format"],
        "product_signal_confidence": clf["confidence"],
        "is_mockup_like":           clf["is_mockup_like"],
        "inspiration_only":         True,
        "is_user_ownable":          False,
        "is_seed":                  False,
        "save_count":               int(pin.get("save_count") or 0),         # inherited evidence
        "source_pin_save_count":    int(pin.get("save_count") or 0),         # inherited evidence
        "seed_keyword":             pin.get("seed_keyword") or pin.get("source_keyword"),
        "image_url":                pin.get("image_url"),
        "discovery_method":         PROVENANCE,
    }


# ── Selection ──────────────────────────────────────────────────────────────

def build_pin_filters(since_iso: str, source: str | None, categories: list[str] | None) -> dict[str, str]:
    # NOTE: we deliberately do NOT filter on is_ecommerce. That crawler flag uses a
    # narrow physical-retailer domain list and would exclude digital marketplaces
    # (payhip/gumroad/teepublic). Selection is outbound_link-not-null; precision is
    # enforced by accept_link() using the richer DOMAIN_RULES classifier.
    f: dict[str, str] = {
        "scraped_at":    f"gte.{since_iso}",
        "outbound_link": "not.is.null",
    }
    if source:
        if source.lower() in ("bootstrap", *BOOTSTRAP_SOURCES):
            f["source_interest"] = "in.(" + ",".join(BOOTSTRAP_SOURCES) + ")"
        else:
            f["source_interest"] = f"eq.{source}"
    if categories:
        f["category"] = "in.(" + ",".join(categories) + ")"
    return f


def _db_select():
    """Return a paginating select callable with signature (table, filters=, order=, limit=).

    The module-level ``db.select_many`` issues a SINGLE PostgREST request, which the
    server caps at 1000 rows regardless of the requested ``limit`` — so a harvest scan
    with ``--limit 2000`` silently saw only the first 1000 pins. The ``DB()`` wrapper
    pages through in 1000-row offset windows and honors the full limit. Callers MUST
    pass a deterministic TOTAL ``order`` (e.g. "save_count.desc,pin_id.asc") so offset
    paging cannot skip or duplicate rows where the sort key ties across a page boundary.
    Kept as a factory so tests can still monkeypatch it with a fake select.
    """
    from db import DB  # type: ignore
    _db = DB()

    def _paged(table, filters=None, order=None, limit=None):
        return _db.select_many(table, filters=filters, order=order, limit=limit)

    return _paged


# ── Orchestration ──────────────────────────────────────────────────────────

def _evaluate(pins: list[dict]) -> tuple[list[dict], list[dict]]:
    """Return (accepted_rows, rejected) after acceptance + content + classify."""
    accepted: list[dict] = []
    rejected: list[dict] = []
    for pin in pins:
        url = (pin.get("outbound_link") or "").strip()
        ok, reason = accept_link(url)
        if not ok:
            rejected.append({"pin_id": pin.get("pin_id"), "category": pin.get("category"),
                             "url": url[:120], "reason": reason})
            continue
        # content gate (reject wallpaper/quote/meme/etc. by pin title+category)
        decision = evaluate_pin_content(title=pin.get("title"), category=pin.get("category"))
        if decision.reject:
            rejected.append({"pin_id": pin.get("pin_id"), "category": pin.get("category"),
                             "url": url[:120], "reason": f"content:{decision.reason or 'negative'}"})
            continue
        clf = classify_link(url, pin.get("title"))
        accepted.append(build_product_row(pin, url, clf))
    return accepted, rejected


def _dedup(rows: list[dict]) -> tuple[list[dict], int]:
    """Dedup accepted rows by normalized URL (keep highest source save_count)."""
    best: dict[str, dict] = {}
    dups = 0
    for r in rows:
        key = r["product_url_hash"]
        cur = best.get(key)
        if cur is None:
            best[key] = r
        else:
            dups += 1
            if int(r.get("save_count") or 0) > int(cur.get("save_count") or 0):
                best[key] = r
    return list(best.values()), dups


def harvest(*, since_hours: int, source: str | None = None,
            categories: list[str] | None = None, limit: int = 600,
            apply: bool = False) -> dict[str, Any]:
    """Select → accept → classify → dedup. Dry-run reports; apply writes pin_products."""
    select_many = _db_select()
    since_iso = (datetime.now(tz=timezone.utc) - timedelta(hours=since_hours)).isoformat()
    cats = categories or list(P0_CATEGORIES)
    filters = build_pin_filters(since_iso, source, cats)

    # Deterministic TOTAL order (pin_id tiebreaker) so offset pagination up to `limit`
    # cannot skip/duplicate rows where save_count ties span a 1000-row page boundary.
    pins = select_many("pin_samples", filters=filters,
                       order="save_count.desc,pin_id.asc", limit=limit or None) or []
    with_outbound = [p for p in pins if (p.get("outbound_link") or "").strip()]

    accepted, rejected = _evaluate(with_outbound)
    deduped, dup_count = _dedup(accepted)

    # legacy guard: any selected pin not from a bootstrap source?
    legacy = [p for p in pins if p.get("source_interest") not in BOOTSTRAP_SOURCES]

    # projected inserts vs updates: existing pin_products by (parent_pin_id, normalized URL).
    #
    # LIFECYCLE (migrate_v46 / T10): only NON-RETIRED rows count as "already exists".
    # A soft-retired row must never (a) block re-collection of its source_url, nor
    # (b) be classified as an "update" target — updating it would overwrite the retired
    # evidence row in place. Retired rows are excluded server-side with the NULL-safe
    # `or=(lifecycle_status.is.null,lifecycle_status.neq.retired)` filter (a bare
    # neq.retired would NOT match the NULL rows that make up the whole active corpus)
    # and re-asserted client-side below.
    parent_ids = [p["parent_pin_id"] for p in deduped if p.get("parent_pin_id")]
    existing_keys: set = set()
    if parent_ids:
        # order="id" gives a deterministic total order so the paginated read of all
        # existing rows for these parents cannot skip/duplicate across page boundaries.
        existing = select_many("pin_products",
                               filters=with_not_retired(
                                   {"parent_pin_id": "in.(" + ",".join(parent_ids) + ")"}),
                               order="id", limit=20000) or []
        for e in existing:
            if is_retired(e):
                continue  # belt-and-braces; the server filter should already exclude these
            existing_keys.add((e.get("parent_pin_id"), normalize_product_url(e.get("source_url") or "")))
    inserts = [r for r in deduped if (r["parent_pin_id"], r["canonical_product_url"]) not in existing_keys]
    updates = [r for r in deduped if (r["parent_pin_id"], r["canonical_product_url"]) in existing_keys]

    report = {
        "mode": "apply" if apply else "dry-run",
        "scope": {"sinceHours": since_hours, "source": source, "categories": cats, "limit": limit},
        "pinsScanned": len(pins),
        "pinsWithOutboundLink": len(with_outbound),
        "ecommerceProductLinksAccepted": len(accepted),
        "linksRejected": len(rejected),
        "rejectReasonDistribution": dict(Counter(r["reason"] for r in rejected)),
        "duplicatesByNormalizedUrl": dup_count,
        "projectedInserts": len(inserts),
        "projectedUpdates": len(updates),
        "categoryDistribution": dict(Counter(_pin_cat(p, with_outbound) for p in deduped)),
        "platformDistribution": dict(Counter(r.get("source_platform") for r in deduped)),
        "productTypeEstimate": dict(Counter(classify_link(r["source_url"], r["product_name"])["type_bucket"] for r in deduped)),
        "parentPinIdCoverage": f"{sum(1 for r in deduped if r.get('parent_pin_id'))}/{len(deduped)}",
        "parentKeywordCoverage": f"{sum(1 for r in deduped if r.get('seed_keyword'))}/{len(deduped)}",
        "legacyPinsTouched": len(legacy),
        "provenanceLabel": PROVENANCE,
        "sampleAccepted": [
            {"category": _pin_cat_by_id(r['parent_pin_id'], with_outbound), "keyword": r.get("seed_keyword"),
             "title": (r.get("product_name") or "")[:50], "domain": r.get("domain"),
             "type": r.get("product_type"), "platform": r.get("source_platform"),
             "url": (r.get("source_url") or "")[:60]}
            for r in deduped[:30]
        ],
        "sampleRejected": rejected[:30],
        "writes": {"pin_products": (len(inserts) + len(updates)) if apply else 0, "otherTables": "none"},
    }

    if apply:
        report["applied"] = _apply_rows(inserts + updates)

    return report


def _pin_cat_by_id(pin_id: str | None, pins: list[dict]) -> str | None:
    for p in pins:
        if p.get("pin_id") == pin_id:
            return p.get("category")
    return None


def _pin_cat(row: dict, pins: list[dict]) -> str:
    return _pin_cat_by_id(row.get("parent_pin_id"), pins) or "unknown"


def _apply_rows(rows: list[dict]) -> dict[str, Any]:
    """Write harvested rows to pin_products (dedup on parent_pin_id,source_url).
    NOTE: requires the additive `discovery_method` column; see proposal."""
    from db import upsert  # type: ignore
    if not rows:
        return {"written": 0}
    written = upsert("pin_products", rows, "parent_pin_id,source_url")
    return {"written": len(written) if written else len(rows)}
