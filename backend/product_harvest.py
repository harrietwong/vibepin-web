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
import time
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

# Amazon runs one marketplace per country on its own ccTLD (amazon.in, amazon.de,
# amazon.co.uk, amazon.com.br …). DOMAIN_RULES only carries the exact string
# "amazon.com" because that table ALSO drives platform classification, and adding
# entries there would change classification semantics for every consumer — so the
# TLD family is matched HERE, at the acceptance whitelist, and DOMAIN_RULES is left
# alone. Before this, a real product page such as
#     amazon.in/dp/B0H6Q163VC
# was rejected as `non_commerce_domain` even though the PDP gate (_PDP_RULES already
# matches `amazon\.` on ANY TLD) recognised it as a genuine ASIN page: the whitelist
# ran first and killed it before the gate could speak.
#
# The pattern anchors the TLD deliberately. The PDP rule's loose `(^|\.)amazon\.`
# is fine for a path-SHAPE rule but would whitelist `amazon.fakeshop.com` here.
# Matching this pattern is NOT a bypass of anything: the acceptance reason returned
# is not PDP-gate-exempt, so the URL must still pass is_product_detail_url().
_AMAZON_FAMILY_DOMAIN = re.compile(r"(?:^|\.)amazon\.[a-z]{2,3}(?:\.[a-z]{2})?$", re.I)


def is_amazon_family_domain(domain: str) -> bool:
    """True for Amazon's per-country marketplaces (amazon.in / .de / .co.uk / …).

    Excludes look-alikes (amazon.fakeshop.com) and shorteners (amzn.to), which
    carry no product-detail path evidence anyway.
    """
    return bool(_AMAZON_FAMILY_DOMAIN.search(domain or ""))


# The same per-country split, for the two other marketplaces measured in the
# 2026-08-17 run's `non_commerce_domain` bucket (514 rejections; 13 aliexpress.us
# and 16 shopee.* among them). AliExpress runs .us/.ru/.es/… and Shopee runs
# .com.br/.sg/.tw/.co.id/… — one company, one catalogue, one product page shape
# per family. DOMAIN_RULES carries the single string "aliexpress.com" and no
# Shopee row at all, so every other storefront fell off the whitelist.
#
# Matched HERE and not in DOMAIN_RULES for the reason given above: that table also
# drives platform classification. A family match is NOT a bypass — the reasons
# returned below stay out of _PDP_GATE_EXEMPT_REASONS, so every URL must still
# pass is_product_detail_url().
#
# The TLD is anchored (`aliexpress.fakeshop.com` does not match) but the leading
# `(?:^|\.)` intentionally admits subdomains, because real traffic uses them
# (he.aliexpress.com, www.aliexpress.us). That also means the Shopee link
# shortener `s.shopee.com.br` matches the FAMILY — it is stopped one step later
# by the PDP gate, which finds no product path in `/9pR7XyZ`. Shorteners are
# deliberately out of scope for this change (they need redirect-following, not a
# whitelist), and there is a test pinning that they stay rejected.
_ALIEXPRESS_FAMILY_DOMAIN = re.compile(r"(?:^|\.)aliexpress\.[a-z]{2,3}(?:\.[a-z]{2})?$", re.I)
_SHOPEE_FAMILY_DOMAIN = re.compile(r"(?:^|\.)shopee\.[a-z]{2,3}(?:\.[a-z]{2})?$", re.I)


def is_aliexpress_family_domain(domain: str) -> bool:
    """True for AliExpress' per-country storefronts (aliexpress.us / .ru / .es / …)."""
    return bool(_ALIEXPRESS_FAMILY_DOMAIN.search(domain or ""))


def is_shopee_family_domain(domain: str) -> bool:
    """True for Shopee's per-country marketplaces (shopee.com.br / .sg / .tw / …)."""
    return bool(_SHOPEE_FAMILY_DOMAIN.search(domain or ""))


# Never products
SOCIAL_DOMAINS = {
    "instagram.com", "tiktok.com", "youtube.com", "youtu.be", "facebook.com",
    "twitter.com", "x.com", "threads.net", "reddit.com", "linktr.ee",
}
_TRACKING_PARAMS = ("utm_", "fbclid", "gclid", "mc_eid", "mc_cid", "epik", "ref_src")
_DROP_PARAMS = {"ref", "ref_", "epik", "rs", "crt"}


# ── Commerce shortlink resolution ──────────────────────────────────────────
# MEASURED (2026-08-18 production run): `non_commerce_domain` refused 288 distinct
# URLs. 72 of them (25%) were not blogs at all — they were commerce SHORTENERS
# (amzn.to 30, tr.ee 14, a.co 12, amzlink.to 9, pin.it 3, myntr.it 2, liketk.it 2)
# whose target IS a real product page. A shortener carries no path evidence by
# construction, so no whitelist can rescue it: the only way to judge `amzn.to/3QYT1Ll`
# is to ask where it points. Probed the same day:
#     amzn.to/3QYT1Ll → 301 → amazon.com/ForeFair-…/dp/B0G2LSCLZY   (real PDP)
#     a.co/d/0XlEbMx  → 404, no Location                            (dead link)
# so resolution both recovers real supply AND filters dead links for free.
#
# THIS IS NOT A BYPASS. Resolution only REWRITES the URL; the resolved URL then runs
# the complete, unmodified judgement chain (social → domain rules → PDP gate). A
# shortener that lands on a homepage, a search page or a Pinterest pin is rejected on
# the target's own merits, exactly as if the target had been the outbound_link.
#
# THREE DELIBERATE LIMITS, each preventing a specific failure:
#   1. WHITELIST-ONLY. A network call is issued if and only if the host is in
#      SHORTLINK_DOMAINS. accept_link() is called on every candidate in every
#      harvester (six call sites); making it network-capable for arbitrary hosts
#      would turn a pure predicate into an SSRF surface and add a round-trip per
#      candidate. Non-shortener hosts are never touched.
#   2. ONE HOP. `follow_redirects=False` and a single request. Redirect chains cannot
#      loop, cannot be used to walk us onto an internal address, and cost a bounded
#      amount of time. A shortener that points at another shortener is left
#      unresolved (counted, not silently dropped).
#   3. OPT-IN. The default `accept_link(url)` stays a PURE function with no I/O — the
#      resolver must be passed in explicitly. Six call sites, unit tests, and the
#      red-line checker all keep their current no-network behaviour unchanged, and a
#      caller that wants resolution has to say so.
SHORTLINK_DOMAINS = frozenset({
    "amzn.to",        # Amazon official
    "a.co",           # Amazon official
    "amzlink.to",     # Amazon affiliate
    "tr.ee",          # Linktree short domain (NOT linktr.ee, which is a link-in-bio
                      # PAGE and stays in SOCIAL_DOMAINS)
    "myntr.it",       # Myntra (IN)
    "liketk.it",      # LikeToKnowIt
    "pin.it",         # Pinterest — resolves to a pin and is then rejected as
                      # `pinterest_internal`; included so that outcome is MEASURED
                      # rather than assumed.
    "s.shopee.com.br",  # Shopee link shortener
})

# 5s per PHASE: probed 2026-08-18 at 1.7-4.8s per hop against live shorteners.
# Anything slower is not worth blocking a harvest for — a timeout is recorded as an
# honest `shortlink_unresolved`, never retried, and never raised into the caller.
SHORTLINK_TIMEOUT_SEC = 5.0

# MEASURED, and NOT what a reader assumes from the constant above: httpx interprets a
# bare `timeout=5.0` as FOUR independent 5s budgets (connect, read, write, pool), so a
# single call can legitimately run ~20s. Observed directly — one live amzn.to
# resolution took 7.57s and SUCCEEDED, i.e. the 5s figure was never a wall-clock cap.
# That silently multiplied the worst case per run by 4x (72 shortlinks: 6 min assumed,
# 24 min actual).
#
# So the per-phase timeout is kept as the fast path AND a total wall-clock budget is
# enforced on top, giving the resolver one honest, bounded cost. The budget is per
# CALL, not per run: a run's total is bounded by
# (distinct shortlinks) x SHORTLINK_TOTAL_BUDGET_SEC, which at the measured 72
# distinct shortlinks is 72 x 8s = 9.6 min worst case against a 105-min allowance.
SHORTLINK_TOTAL_BUDGET_SEC = 8.0

SHORTLINK_UNRESOLVED = "shortlink_unresolved"

# BLOCKING ANALYSIS (asked explicitly, answered by reading the call graph, not assumed):
# resolution is SERIAL and blocking, and that is fine HERE — but only here.
#
#   `harvest()` is reached from run_worker's `harvest-outbound-products` job, which is
#   a standalone job: it takes no `pinterest_network.lock`, performs no Pinterest
#   navigation, and its handler awaits `job_harvest_outbound` and returns. Nothing
#   else runs concurrently, so a blocking HEAD delays only this job. It is NOT inside
#   the ~70-minute crawl loop.
#
#   COST CEILING: one request per DISTINCT shortlink (the cache guarantees this,
#   including for failures), each bounded by SHORTLINK_TOTAL_BUDGET_SEC — NOT by
#   SHORTLINK_TIMEOUT_SEC, which is per-phase and therefore not a wall-clock cap
#   (see the constants above; measured, a 7.57s call succeeded under `timeout=5.0`).
#   At the measured 72 distinct shortlinks per run: 72 x 8s = 9.6 min worst case,
#   with the observed 1.7-4.8s per hop putting the realistic figure near 2-6 minutes.
#   Against a 105-minute allowance that is affordable, so no concurrency is introduced:
#   an executor or an async fan-out would add a failure mode (pool exhaustion — the
#   exact shape of the 2026-08-09 permanent hang) to buy minutes that are not needed.
#
#   THE LIMIT THIS DOES NOT COVER: `job_harvest_outbound` is `async def`, so a
#   blocking call inside it stalls the whole event loop for its duration. Harmless
#   while the harvest job runs alone. A future caller that resolves shortlinks from
#   inside an event loop that is ALSO driving Playwright or the crawler (e.g. wiring a
#   resolver into product_supply_expand or shop_the_look_expand, both of which call
#   accept_link from coroutines) would stall that loop for up to 5s per shortlink.
#   That is why resolution is opt-in per call site rather than switched on globally:
#   such a caller must either run this in a thread executor or accept the stall
#   deliberately. NOT MEASURED for those call sites — none of them pass a resolver today.

# Reason prefix carried by every verdict reached THROUGH a resolved shortlink, so the
# report can answer "how much supply did resolution recover, and what happened to the
# rest?" without a second pass. e.g. `shortlink:known_commerce_domain` (recovered) vs
# `shortlink:not_product_detail_page:not_a_pdp_path` (target was a homepage).
SHORTLINK_RESOLVED_PREFIX = "shortlink:"


def is_shortlink_domain(domain: str) -> bool:
    """True only for the explicit shortener whitelist.

    Exact match, no suffix matching: `amzn.to.evil.com` is NOT a shortener, and
    allowing suffixes would let an attacker-controlled host earn a network call.
    """
    return (domain or "").lower() in SHORTLINK_DOMAINS


class ShortlinkResolver:
    """Single-hop, whitelist-only, cached HEAD resolver for commerce shorteners.

    httpx is the client, not curl_cffi and not requests:
      - it is already a declared runtime dep (requirements-cloud.txt) and is already
        imported by shop_the_look_expand, the biggest accept_link caller — no new
        dependency enters the VPS image;
      - `requests` is NOT in requirements-cloud.txt, so using it would work locally
        and fail on the worker;
      - curl_cffi's value is Chrome TLS impersonation for Pinterest's bot defences,
        which shorteners do not have. It is also the library whose connection-pool
        checkout has no timeout (the 2026-08-09 permanent-hang root cause), and this
        code runs inside the harvest loop. httpx's `timeout=` covers connect, read,
        write AND pool acquisition, so a saturated pool cannot hang the harvest.
      - httpx.Client is SYNC, matching accept_link's sync call sites. product_harvest
        has no event loop of its own, and making it async would force `await` on all
        six callers, two of which (product_supply_spike, shop_the_look_spike) call it
        from inside Playwright coroutines where a blocking client is the safer shape.

    CACHE: `dict[str, str | None]` keyed by the RAW shortlink URL, holding the
    resolved URL or None for "tried and failed". Both outcomes are memoised, so a
    dead shortener repeated 30x across source pins costs one request, not 30 — and
    the negative cache is what makes that true (caching only successes would leave
    failures re-requesting every time). The resolver is per-run, not a module global,
    so a long-lived process cannot pin a stale redirect forever.
    """

    def __init__(self, *, timeout: float = SHORTLINK_TIMEOUT_SEC,
                 total_budget: float = SHORTLINK_TOTAL_BUDGET_SEC,
                 client: Any = None) -> None:
        self.timeout = timeout
        self.total_budget = total_budget
        self._client = client            # injectable for tests; None -> build on demand
        self._cache: dict[str, str | None] = {}
        self.attempted = 0               # distinct shortlinks we issued a request for
        self.resolved = 0                # distinct shortlinks that yielded a target
        self.failed = 0                  # distinct shortlinks that did not
        self.cache_hits = 0              # repeat lookups served without a request
        # Answers arrived, but past the wall-clock budget. Counted separately from
        # `failed` totals in the report so "the shorteners are slow" is never
        # misdiagnosed as "the shorteners are broken".
        self.budget_exceeded = 0

    # ── stats ────────────────────────────────────────────────────────────
    def stats(self) -> dict[str, int]:
        return {
            "attempted": self.attempted,
            "resolved": self.resolved,
            "failed": self.failed,
            "cacheHits": self.cache_hits,
            "budgetExceeded": self.budget_exceeded,
        }

    # ── resolution ───────────────────────────────────────────────────────
    def resolve(self, url: str) -> str | None:
        """Return the single-hop redirect target, or None if it cannot be resolved.

        Never raises: any transport error, timeout, malformed Location or missing
        redirect becomes None, which the caller turns into an explicit
        `shortlink_unresolved` rejection. A shortener must never be able to abort a
        harvest run.
        """
        if not url:
            return None
        if url in self._cache:
            self.cache_hits += 1
            return self._cache[url]

        self.attempted += 1
        target = self._head_location(url)
        if target:
            self.resolved += 1
        else:
            self.failed += 1
        self._cache[url] = target
        return target

    def _head_location(self, url: str) -> str | None:
        started = time.monotonic()
        try:
            client = self._ensure_client()
            resp = client.head(url, follow_redirects=False, timeout=self.timeout)
        except Exception:
            # Timeout, DNS failure, TLS error, connection reset — all the same
            # answer to the only question we asked: we do not know the target.
            return None
        # Total wall-clock budget, checked AFTER the call returns because httpx's
        # per-phase timeouts cannot express one. A response that arrived too late is
        # discarded rather than used: the point of the budget is a predictable
        # per-run cost, and honouring a slow answer would defeat it. Recorded as
        # `shortlink_unresolved` like any other failure — never as an acceptance.
        if (time.monotonic() - started) > self.total_budget:
            self.budget_exceeded += 1
            return None
        try:
            status = int(getattr(resp, "status_code", 0) or 0)
        except Exception:
            return None
        if status < 300 or status >= 400:
            # 404 (dead shortlink) and 200 (shortener answering in-page) both mean
            # no single-hop target. Dead links being filtered out here is a feature.
            return None
        try:
            location = (resp.headers.get("location") or resp.headers.get("Location") or "")
        except Exception:
            return None
        location = (location or "").strip()
        # Only an absolute http(s) target is usable. A relative Location would have
        # to be joined against the SHORTENER's host, which can only ever produce
        # another shortener URL — that is a second hop, which we do not take.
        if not location.lower().startswith(("http://", "https://")):
            return None
        return location

    def _ensure_client(self):
        if self._client is None:
            import httpx  # local import: keeps the cost off runs that never resolve
            self._client = httpx.Client(
                follow_redirects=False,
                timeout=self.timeout,
                # Shorteners routinely 403 an unidentified client.
                headers={"User-Agent": "Mozilla/5.0 (compatible; VibePinBot/1.0)"},
            )
        return self._client

    def close(self) -> None:
        client, self._client = self._client, None
        try:
            if client is not None and hasattr(client, "close"):
                client.close()
        except Exception:
            pass


# ── URL helpers ────────────────────────────────────────────────────────────

def get_domain(url: str) -> str:
    try:
        host = (urlsplit(url).netloc or "").lower()
        return host[4:] if host.startswith("www.") else host
    except Exception:
        return ""


def _is_pinterest_domain(domain: str) -> bool:
    return (
        domain == "pinterest.com"
        or domain.endswith(".pinterest.com")
        or domain.startswith("pinterest.")
        or ".pinterest." in domain
        or domain == "pinimg.com"
        or domain.endswith(".pinimg.com")
        or domain.startswith("pinimg.")
        or ".pinimg." in domain
    )


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
    # Shopee's canonical product URL is /<slug>-i.<shopId>.<itemId> (the slug is
    # localised free text), with an older /product/<shopId>/<itemId> form still in
    # circulation. NEITHER matches the generic shapes below, so whitelisting the
    # domain family alone would have recovered nothing — measured: shopee.com.br
    # product links returned `no_recognizable_pdp_path` before this rule existed.
    # Writing it as a DOMAIN rule also makes the gate fail CLOSED for Shopee: the
    # homepage, /search, /shop/<id>, /mall and the s.shopee.* shortener codes have
    # no numeric shop/item pair and are therefore rejected as `not_a_pdp_path`
    # instead of being waved through by the loose generic /product/ shape.
    (re.compile(r"(^|\.)shopee\.", re.I),
     re.compile(r"-i\.\d+\.\d+|/product/\d+/\d+", re.I)),
    # AliExpress product pages are /item/<numericId>.html across every storefront.
    # The generic /item/ shape already accepted these, but only for domains that
    # reached the gate; pinning it as a domain rule keeps /store/, /category/ and
    # /w/wholesale-*.html rejected on their own merits rather than by luck.
    (re.compile(r"(^|\.)aliexpress\.", re.I),
     re.compile(r"/item/\d+", re.I)),
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
    # The amazon.com influencer-storefront rule applies to every Amazon marketplace
    # (amazon.in/shop/<influencer>/list/... is the same surface on a different TLD).
    # The PDP gate would reject those anyway; catching them here keeps the honest
    # `non_product_path` reason instead of a generic PDP miss.
    if is_amazon_family_domain(domain):
        return any(pattern.search(path) for pattern in _DOMAIN_NON_PRODUCT_PATHS["amazon.com"])
    for base, rules in _DOMAIN_NON_PRODUCT_PATHS.items():
        if domain == base or domain.endswith("." + base):
            return any(pattern.search(path) for pattern in rules)
    return False


def accept_link(url: str, resolver: "ShortlinkResolver | None" = None) -> tuple[bool, str]:
    """Return (accepted, reason). Accepts known commerce marketplaces + a few safe,
    path-based product patterns (Shopify /products/, Teepublic product pages).

    Every acceptance is then re-checked by the PDP gate (is_product_detail_url), so a
    search/browse/category page on an otherwise-legitimate commerce domain can never be
    accepted as a product. Domains that already have a path-precise product rule
    (RETAIL_PRODUCT_PATHS, Teepublic) are exempt — their own rule IS the PDP gate.

    `resolver` is OPTIONAL and defaults to None, which keeps this function PURE — no
    I/O, no network, byte-for-byte the behaviour every existing caller and test relies
    on. Pass a ShortlinkResolver to additionally resolve commerce shorteners
    (SHORTLINK_DOMAINS); see that class for why resolution is whitelist-only,
    single-hop and opt-in. Resolution rewrites the URL and nothing else: the resolved
    URL is judged by this same function, so the PDP gate is never bypassed.
    """
    if not url or not url.startswith("http"):
        return False, "empty_or_relative"
    parts = urlsplit(url)
    domain = get_domain(url)
    path = (parts.path or "").rstrip("/") or "/"
    if not domain:
        return False, "no_domain"
    # ── SHORTLINK RESOLUTION ─────────────────────────────────────────────────
    # Placed here — after the cheap structural guards, before every judgement rule —
    # because a shortener's own host and path say nothing about the destination, so
    # judging them is meaningless. Deciding the target instead means `pin.it/abc` is
    # reported as `pinterest_internal` and a dead `a.co` link as `shortlink_unresolved`,
    # rather than both being filed under the misleading `non_commerce_domain`.
    #
    # The recursive call passes resolver=None, which is what makes ONE HOP structural
    # rather than a rule someone must remember: a target that is itself a shortener
    # reaches this branch with no resolver and stops.
    if resolver is not None and is_shortlink_domain(domain):
        target = resolver.resolve(url)
        if not target:
            return False, SHORTLINK_UNRESOLVED
        ok, reason = accept_link(target, resolver=None)
        # Tag the reason so the report can separate supply RECOVERED by resolution
        # from supply that arrived as a direct link, and so a resolved-but-still-bad
        # target keeps its real cause visible instead of hiding behind the shortener.
        return ok, f"{SHORTLINK_RESOLVED_PREFIX}{reason}"

    # Keep the stricter regional-host guard from the v3.7 evidence work. A
    # resolved pin.it target may be pinterest.co.uk (or another ccTLD), and a
    # direct pinimg.* host is also Pinterest evidence rather than a product PDP.
    if _is_pinterest_domain((parts.hostname or "").lower()):
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


def resolve_link(url: str, resolver: "ShortlinkResolver | None") -> str:
    """Return the URL a harvester should STORE for `url`.

    accept_link() decides the resolved target but returns only a verdict, so a caller
    that accepts a shortlink would otherwise persist `amzn.to/3QYT1Ll` as source_url —
    an opaque, expiring redirect instead of the product page it proved. This returns
    the resolved target for accepted shortlinks (served from the resolver's cache, so
    it costs no extra request) and the original URL for everything else.
    """
    if resolver is None or not url:
        return url
    if not is_shortlink_domain(get_domain(url)):
        return url
    return resolver.resolve(url) or url


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
    # Amazon's non-US marketplaces. Checked AFTER the set so amazon.com keeps its
    # existing `known_commerce_domain` reason unchanged. The distinct reason makes
    # the recovered supply attributable in rejectedByReason/acceptedByDomain, and it
    # is deliberately absent from _PDP_GATE_EXEMPT_REASONS: accept_link() still puts
    # every one of these through is_product_detail_url(), so only /dp/<ASIN> and
    # /gp/product/<ASIN> pages actually get in.
    if is_amazon_family_domain(domain):
        return True, "amazon_family_domain"
    # AliExpress / Shopee per-country storefronts. Same shape as the Amazon branch
    # directly above and for the same measured reason: aliexpress.com was on the
    # whitelist while aliexpress.us was rejected as `non_commerce_domain`, and Shopee
    # was absent entirely. Distinct reasons keep the recovered supply attributable in
    # rejectedByReason/acceptedByDomain, and neither is PDP-gate-exempt: accept_link()
    # still runs is_product_detail_url() on every one of these, so homepages, /search,
    # store and category surfaces stay rejected.
    if is_aliexpress_family_domain(domain):
        return True, "aliexpress_family_domain"
    if is_shopee_family_domain(domain):
        return True, "shopee_family_domain"
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

def _evaluate(pins: list[dict],
              resolver: "ShortlinkResolver | None" = None,
              ) -> tuple[list[dict], list[dict], list[dict]]:
    """Return (accepted_rows, rejected, accepted_via_shortlink).

    When `resolver` is supplied, a commerce shortlink is resolved and the row is built
    from the RESOLVED url — so `domain`, `canonical_product_url`, `product_url_hash`
    and `source_url` all describe the actual product page. Storing the shortener
    instead would leave the row's domain as `amzn.to`, break dedup against the same
    product arriving as a direct link, and persist a redirect that can expire.
    The `url` recorded on a REJECTION stays the original shortlink, because that is
    what the source pin contained and what an operator has to look up.
    """
    accepted: list[dict] = []
    rejected: list[dict] = []
    # Audit trail for accepted shortlinks, kept OUT of the row dicts on purpose:
    # every key in a row is written to pin_products, so an extra bookkeeping field
    # would become a phantom column (or an insert error). Parallel list instead.
    accepted_via_shortlink: list[dict] = []
    for pin in pins:
        url = (pin.get("outbound_link") or "").strip()
        ok, reason = accept_link(url, resolver=resolver)
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
        stored_url = resolve_link(url, resolver)
        clf = classify_link(stored_url, pin.get("title"))
        row = build_product_row(pin, stored_url, clf)
        accepted.append(row)
        if str(reason).startswith(SHORTLINK_RESOLVED_PREFIX):
            accepted_via_shortlink.append(
                {"shortlink": url[:120], "resolved": stored_url[:160],
                 "canonical": row["canonical_product_url"],
                 "reason": str(reason)[len(SHORTLINK_RESOLVED_PREFIX):]})
    return accepted, rejected, accepted_via_shortlink


def _shortlink_report(rejected: list[dict], accepted_via_shortlink: list[dict],
                      resolver: "ShortlinkResolver | None") -> dict[str, Any]:
    """Explicit accounting for shortlink resolution — records AND distinct URLs.

    The two counts answer different questions and are both reported for the reason
    _rejected_candidates_report gives: a single popular shortlink repeats across many
    source pins, so a RECORD count overstates how much distinct supply is involved,
    while a DISTINCT count understates the processing work. `attempted/resolved/failed`
    come from the resolver and are inherently per-distinct-URL (the cache guarantees
    one request per URL), so they line up with the `*Unique` numbers, not the record
    numbers — stated here so the two families are not read as disagreeing.
    """
    if resolver is None:
        return {"enabled": False}

    def _uniq(rows: list[dict], key: str) -> int:
        return len({r.get(key) for r in rows if r.get(key)})

    unresolved = [r for r in rejected if r.get("reason") == SHORTLINK_UNRESOLVED]
    rejected_after = [r for r in rejected
                      if str(r.get("reason") or "").startswith(SHORTLINK_RESOLVED_PREFIX)]
    accepted_after = accepted_via_shortlink

    return {
        "enabled": True,
        "domains": sorted(SHORTLINK_DOMAINS),
        "timeoutSec": SHORTLINK_TIMEOUT_SEC,
        # Per-distinct-URL by construction (one request per URL, negative cache included).
        "requests": resolver.stats(),
        # Records: how many candidate rows went down each path this run.
        "unresolvedRecords": len(unresolved),
        "rejectedAfterResolutionRecords": len(rejected_after),
        # Distinct URLs: how much supply is actually involved.
        "unresolvedUniqueUrls": _uniq(unresolved, "url"),
        "rejectedAfterResolutionUniqueUrls": _uniq(rejected_after, "url"),
        "acceptedAfterResolutionRecords": len(accepted_after),
        "acceptedAfterResolutionUniqueUrls": _uniq(accepted_after, "canonical"),
        "acceptedAfterResolutionByReason": dict(Counter(
            r.get("reason") for r in accepted_after)),
        "acceptedSamples": [{"from": r.get("shortlink"), "to": r.get("resolved")}
                            for r in accepted_after[:10]],
        "rejectedAfterResolutionByReason": dict(Counter(
            str(r.get("reason") or "")[len(SHORTLINK_RESOLVED_PREFIX):] for r in rejected_after)),
        "unresolvedSamples": [r.get("url") for r in unresolved[:10]],
        "countsNote": (
            "*Records count candidate rows (a shortlink repeats across source pins); "
            "*UniqueUrls count distinct URLs — use those to judge real supply. "
            "requests.* are already per-distinct-URL because the resolver caches "
            "both successes and failures, so requests.attempted == the number of "
            "distinct shortlinks seen, not the number of records."
        ),
    }


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
            apply: bool = False, resolve_shortlinks: bool = True,
            resolver: "ShortlinkResolver | None" = None) -> dict[str, Any]:
    """Select → accept → classify → dedup. Dry-run reports; apply writes pin_products.

    `resolve_shortlinks` defaults to True because the 2026-08-18 run showed 25% of the
    `non_commerce_domain` bucket was commerce shorteners hiding real product pages —
    leaving it off by default would keep discarding that supply silently. It stays a
    parameter so an operator can turn the network off for a purely offline dry run,
    and `resolver` is injectable for tests. Constructing a ShortlinkResolver opens NO
    connection: its httpx client is built on the first actual shortlink, so a run
    containing none is byte-for-byte the old offline behaviour.
    """
    select_many = _db_select()
    since_iso = (datetime.now(tz=timezone.utc) - timedelta(hours=since_hours)).isoformat()
    cats = categories or list(P0_CATEGORIES)
    filters = build_pin_filters(since_iso, source, cats)

    # Deterministic TOTAL order (pin_id tiebreaker) so offset pagination up to `limit`
    # cannot skip/duplicate rows where save_count ties span a 1000-row page boundary.
    pins = select_many("pin_samples", filters=filters,
                       order="save_count.desc,pin_id.asc", limit=limit or None) or []
    with_outbound = [p for p in pins if (p.get("outbound_link") or "").strip()]

    if resolver is None and resolve_shortlinks:
        resolver = ShortlinkResolver()
    try:
        accepted, rejected, accepted_via_shortlink = _evaluate(with_outbound, resolver=resolver)
    finally:
        # Release the httpx connection pool even if evaluation raises. A leaked pool
        # keeps sockets (and on Windows, the event loop's selector) alive for the life
        # of the process, which matters because the harvest runs inside a long-lived
        # worker, not a one-shot script.
        if resolver is not None:
            resolver.close()
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
        # Distinct-URL twin of the line above. A single URL repeats across source pins,
        # so the record count above measures WORK while this one measures actual LOSS;
        # reading the first as the second overstated loss ~30x in a measured STL run
        # (see shop_the_look_expand._unique_urls). Both are reported so neither
        # reading happens by accident.
        "rejectReasonDistributionUnique": {
            reason: len({r.get("url") for r in rejected
                         if r.get("reason") == reason and r.get("url")})
            for reason in {r["reason"] for r in rejected}
        },
        "shortlinkResolution": _shortlink_report(rejected, accepted_via_shortlink, resolver),
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
