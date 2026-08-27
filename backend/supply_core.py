"""supply_core.py — the ONE reusable bounded product-supply core.

This module is the single, importable authority for turning a
``{pin, url}`` discovery candidate into an admissible, red-line-clean
``pin_products`` row and (optionally) writing it with PLAIN INSERT +
read-back verification + precise rollback.

WHY THIS EXISTS
───────────────
Two callers must behave IDENTICALLY:

  1. tools/t2_harvest.py    — the manual T2 Opportunity Discovery harvester.
  2. shop_the_look_expand.py — the AUTOMATIC production Product-Supply path
                               (run_worker --job product-supply-expand
                               --engine shop-the-look).

Before this extraction the automatic Shop-the-Look path had its OWN write
routine (``_apply_rows``) that inherited product_name / image / price /
merchant straight off the Pinterest product CARD — the exact fabrication the
T2 red lines were engineered to forbid, and the exact defect that produced the
798 dirty rows. It also wrote with ``ON CONFLICT DO NOTHING`` (silent swallow),
not the loud PLAIN INSERT the red-line design requires.

The fix is NOT a second copy of the rules. Both callers now import THIS module
and call the SAME functions:

    discover()  →  check_red_lines()  →  PLAIN INSERT  →  verify_written()  →  rollback

so there is exactly one candidate-admissibility gate, one enrichment path, one
red-line gate, one write semantics, and one rollback. A behaviour change here
changes BOTH callers at once — which is the whole point.

BYTE-EQUIVALENCE CONTRACT (tools/t2_harvest.py)
───────────────────────────────────────────────
Every symbol T2 or its tests reference — ``DISCOVERY_METHOD``, ``MAX_BATCH``,
the ``DETAIL_*`` vocabulary, ``ALLOWED_COLUMNS``, ``REQUIRED_EVIDENCE``,
``ENRICHMENT_FIELDS``, ``normalize_product_url``, ``url_hash``, ``enc_ts``,
``_require_list``, ``extract_details``, ``bucket_of``, ``assert_evidence``,
``polite_get``, ``discover``, ``check_red_lines``, ``build_metrics``,
``verify_written``, ``active_dedup_norms`` — is defined HERE and re-exported by
t2_harvest verbatim, so T2's existing behaviour and its existing tests are
unchanged.

── THE THREE RED LINES (hard-coded as assertions; violation = no write / rollback) ──
  1. A Pin title NEVER becomes product_name.       Name may remain NULL.
  2. A Product Opportunity MUST have a real merchant image. Pin/card image is rejected.
  3. NEVER guess a field. Absent on the merchant page → NULL. No inference, no default.
"""
from __future__ import annotations

import hashlib
import html as _html
import json
import os
import random
import re
import time
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

import httpx
from dotenv import dotenv_values

BACKEND = Path(__file__).resolve().parent
ROOT = BACKEND.parent

# product_harvest / product_lifecycle live under backend/ and backend/db.
import sys
for _p in (str(BACKEND), str(BACKEND / "db")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from product_lifecycle import NOT_RETIRED_OR_EXPR, is_retired          # noqa: E402
from product_harvest import (  # noqa: E402
    _is_pinterest_domain as _harvest_is_pinterest_domain,
    accept_link,
    get_domain,
    is_product_detail_url,
)

WEB_ENV = dotenv_values(ROOT / "web" / ".env.local")
BACKEND_ENV = dotenv_values(BACKEND / ".env")


def _resolve_supabase_config(environ: dict, backend_env: dict, web_env: dict) -> tuple[str, str]:
    """Resolve credentials for both VPS backend and local Web worktrees.

    run_worker loads ``backend/.env`` into os.environ on the VPS. Developer
    worktrees historically used ``web/.env.local``. Environment variables win;
    no value is logged here.
    """
    url = (
        environ.get("SUPABASE_URL")
        or environ.get("NEXT_PUBLIC_SUPABASE_URL")
        or backend_env.get("SUPABASE_URL")
        or backend_env.get("NEXT_PUBLIC_SUPABASE_URL")
        or web_env.get("NEXT_PUBLIC_SUPABASE_URL")
        or ""
    )
    key = (
        environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or backend_env.get("SUPABASE_SERVICE_ROLE_KEY")
        or web_env.get("SUPABASE_SERVICE_ROLE_KEY")
        or ""
    )
    return str(url).rstrip("/"), str(key)


SUPABASE_URL, SERVICE_KEY = _resolve_supabase_config(
    os.environ, BACKEND_ENV, WEB_ENV
)

DISCOVERY_METHOD = "outbound_link"
MAX_BATCH = 20
# Product Supply may keep up to 50 verified rows from one 100-Source-Pin run,
# but every individual PostgREST INSERT/readback/rollback transaction remains
# bounded by MAX_BATCH. Manual T2 continues to use MAX_BATCH directly.
MAX_RUN_ADMISSIONS = 50
MIN_INTERVAL = 0.55                       # seconds between outbound GETs (<= 2 req/s)
MAX_EXTRACTED_PRODUCT_TYPE_CHARS = 160

# ── ORIGIN — the lifecycle provenance of a candidate/row (fail-closed vocabulary) ──
# Every row carried through this core MUST declare exactly one of these origins. It is
# the input that decides whether RED LINE 4 (lifecycle coexistence) applies to the row:
#   net_new         — a URL never before written. RL4 is NOT applicable to it.
#   retired_reclaim — the RE-COLLECTION of a previously-retired URL. RL4 IS applicable:
#                     the written row must coexist (retired + active) on that URL.
# A missing / None / empty / misspelled / otherwise-unknown origin is NOT "RL4 not
# applicable" — it is an UNREVIEWED provenance claim, and the whole batch is refused
# BEFORE any write. Silently treating an unknown origin as net_new (RL4 skipped) is
# exactly the fail-OPEN hole this contract closes: it would let a mislabelled retired
# URL slip in without proving coexistence.
ALLOWED_ORIGINS = {"net_new", "retired_reclaim"}


def origin_of(item: dict) -> str:
    """The origin for a candidate/row item, or "" if absent — never guessed.

    Accepts the origin from the item's top level (the shape discover()/apply_rows()
    use: {"row", "rec", "origin"}) and falls back to row['origin'] for defensiveness.
    A non-string, None, or whitespace-only value normalizes to "" so that
    is_allowed_origin() rejects it — we never coerce an unknown claim into a known one.
    """
    o = item.get("origin")
    if o is None:
        o = (item.get("row") or {}).get("origin")
    return o.strip() if isinstance(o, str) else ""


def is_allowed_origin(origin) -> bool:
    """True ONLY for an exact, known origin string. Everything else (None, "", a typo,
    a non-string, an unreviewed value) is False → the batch fails closed."""
    return isinstance(origin, str) and origin in ALLOWED_ORIGINS

# detail_fetch_status vocabulary — must match the v48 CHECK constraint exactly.
DETAIL_AVAILABLE = "available"           # merchant page fetched + parsed; details present
DETAIL_BLOCKED = "blocked"               # WAF / 403 / bot-wall. URL + opportunity still valid.
DETAIL_NOT_FOUND = "not_found"           # 404 / delisted / no structured product data
DETAIL_NOT_ATTEMPTED = "not_attempted"   # enrichment never tried
DETAIL_STATES = (DETAIL_AVAILABLE, DETAIL_BLOCKED, DETAIL_NOT_FOUND, DETAIL_NOT_ATTEMPTED)

# HTTP statuses that mean "a bot wall stopped us", NOT "this product does not exist".
BLOCKED_STATUSES = {401, 403, 405, 406, 429, 503}

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
BROWSER_HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
}

# Columns this core is allowed to write. A stray key is a red-line violation: it means
# the writer is inventing a field that nobody reviewed.
ALLOWED_COLUMNS = {
    # A — required evidence
    "parent_pin_id", "source_pin_id", "source_pin_url", "source_pin_image_url",
    "source_pin_save_count", "source_pin_saves", "source_category", "seed_keyword",
    "source_url", "canonical_product_url", "product_url_hash",
    "normalized_product_url_hash", "domain", "discovery_method",
    # B — optional enrichment
    "product_name", "image_url", "price", "currency", "merchant", "availability",
    "detail_fetch_status",
    # invariants
    "product_pin_id", "inspiration_only", "is_user_ownable", "is_seed",
}

# A — the required Opportunity Evidence fields, enforced in code AND by the v47 CHECK.
REQUIRED_EVIDENCE = (
    "parent_pin_id", "source_pin_url", "source_url",
    "source_pin_save_count", "source_category", "seed_keyword", "discovery_method",
)
# B — the optional Product Detail fields. NULL is always a legal, honest value.
ENRICHMENT_FIELDS = ("product_name", "image_url", "price", "currency", "merchant", "availability")

PINTEREST_IMG_HOSTS = ("pinimg.com", "pinterest.com")


def is_pinterest_hosted_url(value: object) -> bool:
    """Use the PDP gate's complete Pinterest host family for image provenance.

    Substring checks both miss regional ``pinimg.*``/``pinterest.*`` hosts and
    falsely reject an unrelated merchant URL whose path happens to contain the
    text ``pinimg.com``. Host parsing keeps the writer, readback and audit gates
    on the same domain authority.
    """
    return bool(value) and _harvest_is_pinterest_domain(get_domain(str(value)))


# ── URL normalization (the approved dedup key) ───────────────────────────────

def normalize_product_url(url: str) -> str:
    if not url:
        return ""
    try:
        s = urlsplit(url.strip())
        host = (s.netloc or "").lower()
        if host.startswith("www."):
            host = host[4:]
        return urlunsplit(((s.scheme or "https").lower(), host, s.path.rstrip("/"), "", ""))
    except Exception:
        return url.strip().lower()


def url_hash(n: str) -> str:
    return hashlib.sha1(n.encode("utf-8")).hexdigest()


# ── Merchant-page extraction — the ONLY legal source of ENRICHMENT fields ────

_JSONLD = re.compile(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
                     re.I | re.S)
_META = re.compile(r'<meta\s+[^>]*>', re.I)
_TITLE = re.compile(r'<title[^>]*>(.*?)</title>', re.I | re.S)
_IMG_TAG = re.compile(r'<img\b[^>]*>', re.I | re.S)

_TITLE_CHROME = (
    re.compile(r"^\s*Amazon\.com\s*:?\s*", re.I),
    re.compile(r"\s*:\s*(?:Beauty & Personal Care|Home & Kitchen|Everything Else|"
               r"Handmade Products|Clothing, Shoes & Jewelry|Office Products|"
               r"Arts, Crafts & Sewing|Patio, Lawn & Garden|Toys & Games)\s*$", re.I),
    re.compile(r"\s*\|\s*TPT\s*$", re.I),
)


def _metas(page: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for tag in _META.findall(page):
        k = re.search(r'(?:property|name|itemprop)\s*=\s*["\']([^"\']+)["\']', tag, re.I)
        v = re.search(r'content\s*=\s*["\']([^"\']*)["\']', tag, re.I)
        if k and v:
            out.setdefault(k.group(1).strip().lower(), _html.unescape(v.group(1)).strip())
    return out


def _walk_jsonld(node, acc: list[dict]) -> None:
    if isinstance(node, list):
        for n in node:
            _walk_jsonld(n, acc)
    elif isinstance(node, dict):
        t = node.get("@type")
        types = t if isinstance(t, list) else [t]
        if any(str(x).lower() == "product" for x in types if x):
            acc.append(node)
        for v in node.values():
            if isinstance(v, (dict, list)):
                _walk_jsonld(v, acc)


def _jsonld_products(page: str) -> list[dict]:
    acc: list[dict] = []
    for blob in _JSONLD.findall(page):
        try:
            _walk_jsonld(json.loads(blob.strip()), acc)
        except Exception:
            continue
    return acc


def _first_str(v) -> str | None:
    if isinstance(v, str):
        return v.strip() or None
    if isinstance(v, list):
        for x in v:
            s = _first_str(x)
            if s:
                return s
    if isinstance(v, dict):
        for k in ("url", "contentUrl", "@id", "name"):
            s = _first_str(v.get(k))
            if s:
                return s
    return None


def _tag_attr(tag: str, name: str) -> str | None:
    match = re.search(
        rf'\b{re.escape(name)}\s*=\s*(["\'])(.*?)\1', tag, re.I | re.S
    )
    if not match:
        return None
    return _html.unescape(match.group(2)).strip() or None


def _amazon_product_image(page: str, domain: str) -> tuple[str | None, str | None]:
    """Extract Amazon's literal primary-product image when metadata omits it.

    Amazon frequently returns a real PDP with ``#landingImage`` but no usable
    JSON-LD/OG image to non-browser HTTP clients. Only the explicitly identified
    primary image element is admissible; arbitrary page images, Pin/card data and
    inferred URLs remain unavailable to this function.
    """
    host = str(domain or "").lower().rstrip(".")
    if host != "amazon.com" and not host.endswith(".amazon.com"):
        return None, None

    for tag in _IMG_TAG.findall(page):
        image_id = (_tag_attr(tag, "id") or "").lower()
        if image_id not in {"landingimage", "imgblkfront"}:
            continue

        dynamic = _tag_attr(tag, "data-a-dynamic-image")
        if dynamic:
            try:
                candidates = json.loads(dynamic)
            except (TypeError, ValueError, json.JSONDecodeError):
                candidates = None
            if isinstance(candidates, dict):
                ranked: list[tuple[int, str]] = []
                for url, dimensions in candidates.items():
                    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
                        continue
                    area = 0
                    if (
                        isinstance(dimensions, list)
                        and len(dimensions) >= 2
                        and all(isinstance(v, (int, float)) for v in dimensions[:2])
                    ):
                        area = int(dimensions[0] * dimensions[1])
                    ranked.append((area, url))
                if ranked:
                    return max(ranked)[1], f"image:amazon#{image_id}.data-a-dynamic-image"

        for attr in ("data-old-hires", "src"):
            url = _tag_attr(tag, attr)
            if url and url.startswith(("http://", "https://")):
                return url, f"image:amazon#{image_id}.{attr}"

    return None, None


def _clean_title(t: str, domain: str) -> str:
    t = _html.unescape(re.sub(r"\s+", " ", t)).strip()
    for rx in _TITLE_CHROME:
        t = rx.sub("", t).strip()
    for sep in (" | ", " – ", " — ", " - "):
        if sep in t:
            head, _, tail = t.rpartition(sep)
            base = domain.split(".")[0].lower()
            if head and base and base in tail.lower().replace(" ", ""):
                t = head.strip()
    return t.strip(" -|–—:")


def extract_details(page: str, domain: str) -> dict:
    """Read ENRICHMENT fields FROM THE MERCHANT PAGE ONLY.

    RED LINE 3 (never guess) is structural here: every field starts as None and is only
    ever set from something the page literally said. There is no default, no inference,
    no fallback to Pin data — this function cannot even SEE the Pin.
    """
    ev: list[str] = []
    name = image = price = currency = merchant = availability = product_type = None

    for prod in _jsonld_products(page):
        if not name and (n := _first_str(prod.get("name"))):
            name = n
            ev.append("name:schema.org/Product.name")
        if not image and (i := _first_str(prod.get("image"))):
            image = i
            ev.append("image:schema.org/Product.image")
        if not merchant and (b := _first_str(prod.get("brand"))):
            merchant = b
            ev.append("merchant:schema.org/Product.brand")
        if not product_type and (category := _first_str(prod.get("category"))):
            candidate_type = _html.unescape(re.sub(r"\s+", " ", category)).strip()
            # Product Type is optional. Do not turn an overlong merchant value
            # into a different claim by truncating it mid-label.
            product_type = (
                candidate_type
                if 0 < len(candidate_type) <= MAX_EXTRACTED_PRODUCT_TYPE_CHARS
                else None
            )
            if product_type is not None:
                ev.append("product_type:schema.org/Product.category")
        offers = prod.get("offers")
        offers = offers[0] if isinstance(offers, list) and offers else offers
        if isinstance(offers, dict):
            if price is None and (p := offers.get("price")) not in (None, ""):
                try:
                    price = float(str(p).replace(",", ""))
                    ev.append("price:schema.org/Offer.price")
                except Exception:
                    pass
            if not currency and (c := offers.get("priceCurrency")):
                currency = str(c).strip()[:8]
                ev.append("currency:schema.org/Offer.priceCurrency")
            if not availability and (a := _first_str(offers.get("availability"))):
                # Store what the page said, minus the schema.org URL prefix. Not inferred.
                availability = a.rsplit("/", 1)[-1].strip()[:64]
                ev.append("availability:schema.org/Offer.availability")

    m = _metas(page)
    if not name and (n := m.get("og:title")):
        name = _clean_title(n, domain)
        ev.append("name:og:title")
    if not image:
        for k in ("og:image", "og:image:secure_url", "twitter:image", "twitter:image:src"):
            if m.get(k):
                image = m[k]
                ev.append(f"image:{k}")
                break
    if not image:
        image, image_evidence = _amazon_product_image(page, domain)
        if image_evidence:
            ev.append(image_evidence)
    if price is None:
        for k in ("product:price:amount", "og:price:amount"):
            if m.get(k):
                try:
                    price = float(m[k].replace(",", ""))
                    ev.append(f"price:{k}")
                    break
                except Exception:
                    pass
    if not currency:
        if c := (m.get("product:price:currency") or m.get("og:price:currency")):
            currency = c
            ev.append("currency:og/product:price:currency")
    if not merchant and (s := m.get("og:site_name")):
        merchant = s
        ev.append("merchant:og:site_name")
    if not availability and (a := m.get("product:availability")):
        availability = a.strip()[:64]
        ev.append("availability:product:availability")

    if not name and (t := _TITLE.search(page)):
        cand = _clean_title(t.group(1), domain)
        if cand and len(cand) > 3:
            name = cand
            ev.append("name:<title>")

    # RED LINE 2 — a Pinterest-hosted image is NOT a product image. Drop it. No fallback.
    if image and is_pinterest_hosted_url(image):
        ev.append("image:REJECTED_pinterest_hosted")
        image = None
    if image and not image.startswith("http"):
        ev.append("image:REJECTED_not_absolute")
        image = None

    return {
        "product_name": (name or None), "image_url": (image or None),
        "price": price, "currency": (currency or None),
        "merchant": (merchant or None), "availability": (availability or None),
        "product_type": product_type,
        "evidence": ev,
    }


# ── DB helpers ──────────────────────────────────────────────────────────────

def _headers(extra: dict | None = None) -> dict:
    h = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}",
         "Content-Type": "application/json"}
    if extra:
        h.update(extra)
    return h


def enc_ts(ts: str) -> str:
    """Percent-encode a timestamp so it is safe to interpolate into a PostgREST
    filter VALUE inside a URL query string.

    THE BUG THIS FIXES: an ISO-8601 timestamp ends in a '+00:00' UTC offset. In a URL
    query string a literal '+' decodes to a SPACE, so `created_at=gte.2026-07-19T04:22:21.88254+00:00`
    reached PostgREST as `...21.88254 00:00` → 'invalid input syntax for type timestamp
    with time zone' (HTTP 400). That 400 (a JSON error object, not a list) then crashed
    verify_written() with AttributeError, so the post-write red-line verification never
    ran; and the rollback window printed with the same raw timestamps could not match a
    single row. quote(safe="") encodes '+' → %2B (and ':' etc.), so the exact instant
    round-trips. Used for EVERY timestamp that enters a PostgREST filter value here:
    verify read-back, the generated rollback filter, and the rollback DELETE execution.
    """
    return quote(ts, safe="")


def _require_list(resp: httpx.Response, ctx: str) -> list:
    """PostgREST returns a JSON LIST on a successful read and a JSON OBJECT
    ({"code","message",...}) on error. Fail loudly with the server message instead of
    letting an error object flow into code that assumes rows — that is what turned the
    +00:00 encoding bug into an opaque AttributeError deep inside verify_written()."""
    body = resp.json()
    if not isinstance(body, list):
        raise RuntimeError(f"{ctx}: expected a row list, got {resp.status_code} {body}")
    return body


def _page_all(c: httpx.Client, table: str, select: str, filt: str, order: str) -> list[dict]:
    out, off = [], 0
    while True:
        r = c.get(f"{SUPABASE_URL}/rest/v1/{table}?select={select}&{filt}&order={order}",
                  headers=_headers({"Range": f"{off}-{off+999}"}))
        chunk = r.json()
        if not isinstance(chunk, list):
            raise RuntimeError(f"select {table} failed: {chunk}")
        out += chunk
        if len(chunk) < 1000:
            return out
        off += 1000


def active_dedup_norms(c: httpx.Client) -> set[str]:
    """normURLs held by NON-RETIRED rows. Retired rows are deliberately ABSENT: their
    URLs must stay re-collectable — that is what makes retirement 'soft'."""
    rows = _page_all(c, "pin_products", "source_url,canonical_product_url,lifecycle_status",
                     f"or=({NOT_RETIRED_OR_EXPR})", "id.asc")
    norms = set()
    for e in rows:
        if is_retired(e):
            raise RuntimeError("lifecycle filter leaked a retired row — aborting")
        n = normalize_product_url(e.get("source_url") or e.get("canonical_product_url") or "")
        if n:
            norms.add(n)
    return norms


# ── Bucketing (shared by candidate spread + metrics) ─────────────────────────

DOMAIN_BUCKETS = {
    "etsy":    lambda d: "etsy.com" in d,
    "amazon":  lambda d: "amazon." in d,
    "digital": lambda d: any(x in d for x in ("payhip", "gumroad", "teacherspayteachers",
                                              "canva.com", "teepublic", "ko-fi", "creativemarket")),
    "shopify": lambda d: True,   # catch-all: /products/-path merchants
}


def bucket_of(domain: str) -> str:
    for name, fn in DOMAIN_BUCKETS.items():
        if fn(domain):
            return name
    return "other"


# ── Discovery + enrichment ──────────────────────────────────────────────────

_last = 0.0


def polite_get(c: httpx.Client, url: str) -> tuple[int, str, str]:
    """<= 2 req/s. Plain GET. No JS, no rendering, no login, no WAF workaround."""
    global _last
    dt = time.monotonic() - _last
    if dt < MIN_INTERVAL:
        time.sleep(MIN_INTERVAL - dt)
    _last = time.monotonic()
    try:
        r = c.get(url, headers=BROWSER_HEADERS, follow_redirects=True, timeout=10)
        return r.status_code, (r.text or "")[:500_000], str(r.url)
    except Exception as e:
        return 0, "", f"{type(e).__name__}: {e}"


def assert_evidence(pin: dict, url: str) -> tuple[bool, str]:
    """A-fields gate. This — not product details — decides whether a row may exist.

    DISCOVERY SUCCESS = a real external product URL (PDP-gated) + verified Pinterest
    provenance (a real Pin with a real save count and real keyword/category context).
    """
    if not pin.get("pin_id"):
        return False, "missing_parent_pin_id"
    if not url or "pinterest.com" in (get_domain(url) or ""):
        return False, "external_product_url_missing_or_internal"
    ok, reason = accept_link(url)      # includes the PDP gate
    if not ok:
        return False, f"not_a_product_detail_url:{reason}"
    if pin.get("save_count") is None:
        return False, "missing_source_pin_save_count"
    if not pin.get("category"):
        return False, "missing_category"
    if not (pin.get("seed_keyword") or pin.get("source_keyword")):
        return False, "missing_seed_keyword"
    return True, "ok"


def discover(c: httpx.Client, cands: list[dict], want: int = MAX_BATCH,
             max_attempts: int = 60, enrich: bool = True) -> tuple[list[dict], list[dict]]:
    """The product-supply chain, in the ONLY correct order:

        1. DISCOVERY  — required Pinterest/PDP evidence complete?
        2. MERCHANT IMAGE — fetch a real, non-Pinterest product image. This is
                        mandatory for Product Opportunity admission.
        3. OTHER DETAILS — name/price/merchant remain optional and may stay NULL.

    A candidate is a dict with at least {"pin", "url", "domain", "origin"}. `pin` carries
    ONLY discovery/provenance evidence (pin_id, save_count, category, seed/source keyword,
    pinterest_url, image_url). Product CARD fields (a card's name/price/merchant/image) are
    NEVER read here: enrichment comes from the merchant page alone.
    """
    rows: list[dict] = []
    failures: list[dict] = []
    min_attempts_per_bucket = 3
    attempts: dict[str, int] = defaultdict(int)

    # Hard ceiling so the batch can NEVER exceed the write cap: the min-attempts-per-
    # bucket floor below can otherwise push discovery past `want` (a bucket with <3
    # attempts keeps going), producing 21 rows for want=20 and tripping the pre-write
    # MAX_BATCH assert. Enforcing MAX_BATCH here keeps every batch <= 20 without raising
    # the cap.
    hard_cap = min(want, MAX_BATCH)

    for x in cands[:max_attempts]:
        if len(rows) >= hard_cap:
            break
        pin, url, dom = x["pin"], x["url"], x["domain"]
        b = bucket_of(dom)
        if len(rows) >= want and attempts[b] >= min_attempts_per_bucket:
            continue
        attempts[b] += 1

        rec = {"url": url, "domain": dom, "bucket": b, "origin": x["origin"],
               "pinId": pin.get("pin_id"), "pinTitle": pin.get("title"),
               "sourcePinImage": pin.get("image_url")}

        # ── STEP 1: DISCOVERY (the only thing that can reject a row) ─────────
        ok, why = assert_evidence(pin, url)
        rec["discovery"] = "success" if ok else "failed"
        if not ok:
            rec["discoveryFailReason"] = why
            rec["action"] = f"REJECTED at DISCOVERY — {why}. Not an opportunity."
            failures.append(rec)
            continue

        # ── STEP 2: ENRICHMENT (optional; can only affect B-fields) ─────────
        det = {k: None for k in ENRICHMENT_FIELDS}
        det_status = DETAIL_NOT_ATTEMPTED
        rec["evidence"] = []

        if enrich:
            status, page, final = polite_get(c, url)
            rec["httpStatus"] = status
            if status == 200 and page:
                ext = extract_details(page, dom)
                rec["evidence"] = ext["evidence"]
                # RED LINE 2 — belt-and-braces: the merchant image may never be the Pin's.
                pin_img = (pin.get("image_url") or "").strip()
                if ext["image_url"] and pin_img and ext["image_url"].strip() == pin_img:
                    ext["image_url"] = None
                    rec["evidence"].append("image:REJECTED_equals_source_pin_image")
                for k in ENRICHMENT_FIELDS:
                    det[k] = ext[k]
                # 200 but no structured product data at all → the page is not usable.
                if any(det[k] is not None for k in ENRICHMENT_FIELDS):
                    det_status = DETAIL_AVAILABLE
                    # RED LINE 1 proof: the name must literally occur in the fetched bytes.
                    nm = det["product_name"] or ""
                    rec["nameFoundInPage"] = bool(nm) and (
                        nm[:40] in page
                        or _html.escape(nm)[:40] in page
                        or _html.unescape(nm)[:40] in _html.unescape(page[:400_000]))
                else:
                    det_status = DETAIL_NOT_FOUND
                    rec["detailNote"] = "HTTP 200 but no structured product data"
            elif status in BLOCKED_STATUSES:
                det_status = DETAIL_BLOCKED
                rec["detailNote"] = f"HTTP {status} — WAF/bot-wall. Not bypassed (by policy)."
            elif status == 404 or status == 410:
                det_status = DETAIL_NOT_FOUND
                rec["detailNote"] = f"HTTP {status} — delisted/not found"
            elif status == 0:
                det_status = DETAIL_BLOCKED
                rec["detailNote"] = f"transport failure: {final[:120]}"
            else:
                det_status = DETAIL_NOT_FOUND
                rec["detailNote"] = f"HTTP {status}"

        assert det_status in DETAIL_STATES, f"illegal detail_fetch_status {det_status!r}"
        rec["detailFetchStatus"] = det_status
        rec["extracted"] = {k: det[k] for k in ENRICHMENT_FIELDS}

        # Product Opportunities are visual inventory. A valid PDP plus Pinterest
        # evidence is not enough to admit a row when the merchant page provides no
        # independently verifiable product image. Reject here (rather than letting a
        # batch-wide red-line gate reject clean siblings), and repeat the invariant in
        # check_red_lines/apply_rows so direct callers cannot bypass it.
        if not det["image_url"]:
            rec["admission"] = "failed"
            rec["admissionFailReason"] = "missing_verified_merchant_image"
            rec["discoveryFailReason"] = "missing_verified_merchant_image"
            rec["action"] = (
                "REJECTED at ADMISSION — no verified merchant product image. "
                "Pinterest/card imagery is never used as a fallback."
            )
            failures.append(rec)
            continue
        rec["admission"] = "success"

        n = normalize_product_url(url)
        row = {
            # ── A: REQUIRED Opportunity Evidence ───────────────────────────
            "parent_pin_id":            pin["pin_id"],
            "source_pin_id":            pin["pin_id"],
            "source_pin_url":           (pin.get("pinterest_url")
                                         or f"https://www.pinterest.com/pin/{pin['pin_id']}/"),
            "source_pin_image_url":     pin.get("image_url"),     # Pin image, LABELLED as Pin data
            "source_pin_save_count":    int(pin.get("save_count") or 0),
            "source_pin_saves":         int(pin.get("save_count") or 0),
            "source_category":          pin.get("category"),
            "seed_keyword":             pin.get("seed_keyword") or pin.get("source_keyword"),
            "source_url":               url,                      # the EXTERNAL product URL
            "canonical_product_url":    n,
            "product_url_hash":         url_hash(n),
            "normalized_product_url_hash": url_hash(n),
            "domain":                   dom,
            "discovery_method":         DISCOVERY_METHOD,
            # ── B: OPTIONAL Product Details (merchant page ONLY, or NULL) ──
            "product_name":             (det["product_name"] or None),
            "image_url":                (det["image_url"] or None),
            "price":                    det["price"],
            "currency":                 (det["currency"] or None),
            "merchant":                 (det["merchant"] or None),
            "availability":             (det["availability"] or None),
            "detail_fetch_status":      det_status,
            # ── invariants ─────────────────────────────────────────────────
            "product_pin_id":           None,     # outbound → there IS no Product Pin
            "inspiration_only":         True,
            "is_user_ownable":          False,
            "is_seed":                  False,
        }
        if row["product_name"]:
            row["product_name"] = row["product_name"][:500]

        rec["result"] = "ok"
        rows.append({"row": row, "rec": rec, "origin": x["origin"]})

    return rows, failures


# ── RED LINES — hard gate. Any violation → do not write / roll back. ─────────

def check_red_lines(rows: list[dict]) -> tuple[bool, list[str]]:
    v: list[str] = []
    for item in rows:
        r, rec = item["row"], item["rec"]
        u = r["source_url"]

        # ── ORIGIN GATE (fail-closed): an unknown origin is a HARD violation, not a
        # reason to skip RED LINE 4. A missing / None / empty / misspelled origin means
        # the row's lifecycle provenance was never reviewed, so we cannot know whether
        # coexistence must be proven — the only safe answer is to refuse the batch. This
        # runs BEFORE any per-field check so a mislabelled row can never reach the write.
        origin = origin_of(item)
        if not is_allowed_origin(origin):
            shown = origin if origin else "<missing>"
            v.append(f"[{u}] RED LINE 4: unknown origin {shown!r} — must be one of "
                     f"{sorted(ALLOWED_ORIGINS)}; batch refused before write")

        stray = set(r) - ALLOWED_COLUMNS
        if stray:
            v.append(f"[{u}] stray columns (invented fields): {sorted(stray)}")

        # ── RED LINE ①: source authenticity — both URLs must exist and be distinct kinds
        for f in REQUIRED_EVIDENCE:
            if r.get(f) in (None, ""):
                v.append(f"[{u}] REQUIRED evidence field '{f}' is missing")
        if not (r.get("source_pin_url") or "").startswith("https://www.pinterest.com/pin/"):
            v.append(f"[{u}] RED LINE 1: source_pin_url is not a real Pin URL")
        if "pinterest.com" in (r.get("source_url") or ""):
            v.append(f"[{u}] RED LINE 1: source_url must be the EXTERNAL product URL")
        # PDP check must use the SAME authority as the harvester's acceptance:
        # accept_link() runs the domain rules AND the PDP gate, and treats a domain's
        # own path-precise rule (retailer paths, Teepublic) as the PDP gate itself
        # (see product_harvest._PDP_GATE_EXEMPT_REASONS). Calling the raw
        # is_product_detail_url() here instead re-judged those exempt domains and
        # rejected legitimately-accepted PDPs (anthropologie /shop/<slug>, flightclub,
        # quince /women/<slug>, teepublic /<cat>/<id>-<slug>) — a false red-line that
        # a row which passed discovery could never be. accept_link is the single source
        # of truth: if it accepted the URL as a product link, it IS a product page here.
        pdp_ok, pdp_why = accept_link(r.get("source_url") or "")
        if not pdp_ok:
            v.append(f"[{u}] RED LINE 1: source_url is not a product-detail page ({pdp_why})")

        # ── RED LINE ②: no fabricated product data ──────────────────────────
        img = r.get("image_url")
        if not img:
            v.append(f"[{u}] RED LINE 2: verified merchant product image is required")
        else:
            img_text = str(img)
            if not img_text.startswith(("http://", "https://")):
                v.append(f"[{u}] RED LINE 2: product image must be an absolute HTTP(S) URL")
            if is_pinterest_hosted_url(img_text):
                v.append(f"[{u}] RED LINE 2: product image is Pinterest-hosted: {img_text[:60]}")
            if (r.get("source_pin_image_url")
                    and img_text.strip() == str(r["source_pin_image_url"]).strip()):
                v.append(f"[{u}] RED LINE 2: product image == source_pin_image_url")
            image_evidence = [
                e for e in rec.get("evidence", [])
                if e.startswith("image:") and "REJECTED_" not in e
            ]
            if not image_evidence:
                v.append(f"[{u}] RED LINE 2: product image has no merchant-page provenance tag")
            if rec.get("detailFetchStatus") != DETAIL_AVAILABLE:
                v.append(f"[{u}] RED LINE 2: product image present but merchant page was not read")
        name = r.get("product_name")
        if name:
            # A NULL name is always fine. A PRESENT name must be provably page-sourced.
            # (Not "differs from the Pin title": a pinner who typed the real product name
            # is not a data defect. The invariant is PROVENANCE, not difference.)
            if not [e for e in rec.get("evidence", []) if e.startswith("name:")]:
                v.append(f"[{u}] RED LINE 2: product_name has no merchant-page provenance tag")
            if not rec.get("nameFoundInPage"):
                v.append(f"[{u}] RED LINE 2: product_name not found in the fetched merchant "
                         f"page — cannot prove it is not Pin-derived")
            if rec.get("detailFetchStatus") != DETAIL_AVAILABLE:
                v.append(f"[{u}] RED LINE 2: product_name present but detail_fetch_status="
                         f"{rec.get('detailFetchStatus')} — a name can only exist if a page was read")
        # RED LINE 3 (never guess): if no page was successfully read, EVERY enrichment
        # field must be NULL. Any value here would necessarily be invented.
        if r.get("detail_fetch_status") != DETAIL_AVAILABLE:
            for f in ENRICHMENT_FIELDS:
                if r.get(f) not in (None, ""):
                    v.append(f"[{u}] RED LINE 3: '{f}' populated without a successful "
                             f"detail fetch (status={r.get('detail_fetch_status')}) — guessed value")

        # ── RED LINE ③: provenance separation ───────────────────────────────
        if r.get("product_pin_id") is not None:
            v.append(f"[{u}] RED LINE 3: product_pin_id must be NULL for outbound discovery")
        if r.get("discovery_method") != DISCOVERY_METHOD:
            v.append(f"[{u}] discovery_method must be '{DISCOVERY_METHOD}'")
        if r.get("detail_fetch_status") not in DETAIL_STATES:
            v.append(f"[{u}] illegal detail_fetch_status: {r.get('detail_fetch_status')!r}")

    return (not v), v


# ── Metrics: the TWO rates, reported SEPARATELY (never merged) ───────────────

def build_metrics(rows: list[dict], failures: list[dict]) -> dict:
    """Discovery success rate and Detail enrichment rate are DIFFERENT questions and are
    never combined into one "completeness" number:

      Discovery success rate = valid product links discovered / attempted
          → measures the PRODUCT (can we find opportunities?)
      Detail enrichment rate = details successfully fetched / links discovered
          → measures a NICE-TO-HAVE (can we also show a price?)

    Etsy at Discovery 100% / Detail 0% is a SUCCESS. The old single "product detail
    completeness" metric would have scored that same reality as a 0% failure, and that
    mis-measurement is what drove the harvester to fabricate data.
    """
    per_dom: dict[str, dict] = defaultdict(
        lambda: {"attempted": 0, "discovered": 0, "detail_by_status": Counter(),
                 "discoveryFailReasons": Counter()})

    for i in rows:
        d = per_dom[i["rec"]["domain"]]
        d["attempted"] += 1
        d["discovered"] += 1
        d["detail_by_status"][i["row"]["detail_fetch_status"]] += 1
    for f in failures:
        d = per_dom[f["domain"]]
        d["attempted"] += 1
        d["discoveryFailReasons"][f.get("discoveryFailReason") or f.get("result") or "?"] += 1

    by_domain = {}
    for dom, d in sorted(per_dom.items()):
        enriched = d["detail_by_status"][DETAIL_AVAILABLE]
        by_domain[dom] = {
            "bucket": bucket_of(dom),
            "attempted": d["attempted"],
            "discovered": d["discovered"],
            "discoverySuccessRate":
                f"{100.0 * d['discovered'] / max(1, d['attempted']):.0f}%",
            "detailEnriched": enriched,
            "detailEnrichmentRate":
                (f"{100.0 * enriched / d['discovered']:.0f}%" if d["discovered"] else "n/a"),
            "detailFetchStatus": dict(d["detail_by_status"]),
            "discoveryFailReasons": dict(d["discoveryFailReasons"]),
        }

    att = len(rows) + len(failures)
    disc = len(rows)
    enr = sum(1 for i in rows if i["row"]["detail_fetch_status"] == DETAIL_AVAILABLE)
    return {
        "overall": {
            "attempted": att,
            "discovered": disc,
            "discoverySuccessRate": f"{100.0 * disc / max(1, att):.0f}%",
            "detailEnriched": enr,
            "detailEnrichmentRate": (f"{100.0 * enr / disc:.0f}%" if disc else "n/a"),
            "detailFetchStatus": dict(Counter(i["row"]["detail_fetch_status"] for i in rows)),
        },
        "byDomain": by_domain,
    }


# ── Post-write verification of the four red lines, against the DB itself ─────

def verify_written(db: httpx.Client, rows: list[dict], lo: str,
                   inserted_ids: list[str] | None = None) -> dict:
    """Re-read what actually landed and prove the four red lines HOLD IN THE DATABASE —
    not merely in the in-memory rows we intended to write."""
    post: dict = {}
    if inserted_ids:
        # The INSERT response gives us the authoritative primary keys. Re-read
        # exactly those rows: a time window can include another concurrent run
        # and either create a false red-line failure or conceal a missing row.
        id_filter = ",".join(quote(str(i), safe="-") for i in inserted_ids)
        written_url = (
            f"{SUPABASE_URL}/rest/v1/pin_products?select=*"
            f"&discovery_method=eq.{DISCOVERY_METHOD}&id=in.({id_filter})"
        )
    else:
        # Backwards-compatible audit path for old receipts that predate exact
        # inserted IDs. New writes always pass inserted_ids.
        written_url = (
            f"{SUPABASE_URL}/rest/v1/pin_products?select=*"
            f"&discovery_method=eq.{DISCOVERY_METHOD}&created_at=gte.{enc_ts(lo)}"
        )
    written = db.get(written_url, headers=_headers())
    written = _require_list(written, "verify_written read-back")
    post["rowsReadBack"] = len(written)
    expected_ids = sorted(str(i) for i in (inserted_ids or []) if i)
    actual_ids = sorted(str(r.get("id")) for r in written if r.get("id"))
    post["exactWriteReadback"] = {
        "expectedIds": expected_ids,
        "actualIds": actual_ids,
        "pass": bool(expected_ids) and actual_ids == expected_ids,
        "applicable": bool(inserted_ids),
    }

    # ① source authenticity
    bad_src = [r["source_url"] for r in written
               if not r.get("source_pin_url") or not r.get("source_url")
               or "pinterest.com" in (r.get("source_url") or "")]
    post["redLine1_sourceAuthenticity"] = {"violations": bad_src, "pass": not bad_src}

    # ② no fabricated product data
    bad_fab = []
    for r in written:
        img = r.get("image_url") or ""
        if not img:
            bad_fab.append(f"{r['source_url']}: verified merchant product image missing")
        if img and is_pinterest_hosted_url(img):
            bad_fab.append(f"{r['source_url']}: pinterest-hosted product image")
        if img and r.get("source_pin_image_url") and img.strip() == r["source_pin_image_url"].strip():
            bad_fab.append(f"{r['source_url']}: product image == source pin image")
        if r.get("product_name") and r.get("detail_fetch_status") != DETAIL_AVAILABLE:
            bad_fab.append(f"{r['source_url']}: product_name without a successful detail fetch")
    post["redLine2_noFabrication"] = {"violations": bad_fab, "pass": not bad_fab}

    # ③ provenance separation
    bad_prov = [r["source_url"] for r in written
                if r.get("product_pin_id") is not None
                or not (r.get("source_pin_url") or "").startswith("https://www.pinterest.com/pin/")]
    post["redLine3_provenanceSeparation"] = {"violations": bad_prov, "pass": not bad_prov}

    # ④ lifecycle coexistence: retired + active rows on the same URL
    coexist = []
    for i in rows:
        if i["origin"] != "retired_reclaim":
            continue
        both = _require_list(
            db.get(f"{SUPABASE_URL}/rest/v1/pin_products"
                   f"?select=id,lifecycle_status,discovery_method,source_url"
                   f"&source_url=eq.{quote(i['row']['source_url'], safe='')}",
                   headers=_headers()),
            "coexistence read-back")
        states = sorted({(r.get("lifecycle_status") or "active") for r in both})
        coexist.append({"url": i["row"]["source_url"], "rows": len(both),
                        "lifecycleStates": states,
                        "coexists": ("retired" in states and "active" in states)})
    # RED LINE 4 is a POSITIVE proof for retired-URL RE-COLLECTION: every retired_reclaim
    # pair we wrote must now coexist (retired + active on the same URL). It is VACUOUSLY
    # satisfied when the batch contains no retired_reclaim rows at all — the automatic
    # Shop-the-Look path only ever emits origin='net_new', so it has nothing to prove here
    # and must NOT be forced to roll back for the absence of a proof it never claimed.
    # (The manual T2 harvester always seeds retired_reclaim candidates, so `coexist` is
    # non-empty there and the proof is exercised exactly as before.)
    post["redLine4_lifecycleCoexistence"] = {
        "pairs": coexist,
        "pass": all(c["coexists"] for c in coexist),
        "applicable": bool(coexist),
    }
    post["allRedLinesPass"] = post["exactWriteReadback"]["pass"] and all(
        post[k]["pass"] for k in
        ("redLine1_sourceAuthenticity", "redLine2_noFabrication",
         "redLine3_provenanceSeparation", "redLine4_lifecycleCoexistence"))
    return post


# ── Write path: PLAIN INSERT + read-back + precise, DB-derived rollback ──────

def apply_rows(db: httpx.Client, rows: list[dict]) -> dict:
    """PLAIN INSERT the red-line-clean rows, verify the four red lines against the DB,
    and roll back the exact batch on any post-write failure.

    FAIL-CLOSED PRE-WRITE GATE: this function does NOT trust a caller's claim that it
    already ran check_red_lines(). It re-runs the full red-line gate ITSELF and, on ANY
    violation (including an unknown/missing origin), refuses the batch BEFORE contacting
    the database: no POST is issued, ``written`` is 0, the violations are returned as
    ``preWriteViolations``, and nothing is rolled back (there is nothing to roll back).
    A row can therefore never reach pin_products by calling apply_rows() directly and
    skipping check_red_lines().

    No ON CONFLICT DO NOTHING — a real collision must surface as a loud 23505 rather
    than be silently swallowed. Returns an outcome dict; never raises for a normal
    insert error (records it and returns).
    """
    assert len(rows) <= MAX_BATCH, f"batch {len(rows)} exceeds MAX_BATCH {MAX_BATCH}"
    from datetime import datetime, timezone
    out: dict = {
        "attempted": len(rows),
        "duplicates": 0,
        "failed": 0,
        "errors": [],
    }

    if not rows:
        out["written"] = 0
        return out

    # ── PRE-WRITE RED-LINE GATE (self-executed; never trust the caller) ──────────
    # This is the load-bearing fail-closed step: the origin gate + all three field red
    # lines are evaluated here, and a single violation stops the batch before any DB
    # POST. written=0, no rollback (nothing was written), explicit preWriteViolations.
    ok, pre_v = check_red_lines(rows)
    if not ok:
        out["preWriteViolations"] = pre_v
        out["written"] = 0
        return out

    lo = datetime.now(timezone.utc).isoformat()
    resp = db.post(f"{SUPABASE_URL}/rest/v1/pin_products",
                   headers=_headers({"Prefer": "return=representation"}),
                   json=[i["row"] for i in rows])
    hi = datetime.now(timezone.utc).isoformat()
    inserted_items = list(rows)
    if resp.status_code in (200, 201):
        inserted = resp.json()
    elif resp.status_code == 409 and "23505" in (resp.text or ""):
        # A late active-row race must not discard unrelated clean rows. The
        # batch INSERT is atomic, so after its 23505 no row landed; retry each
        # reviewed item with the same plain-INSERT semantics and account for
        # every outcome explicitly.
        inserted = []
        inserted_items = []
        for item in rows:
            one = db.post(
                f"{SUPABASE_URL}/rest/v1/pin_products",
                headers=_headers({"Prefer": "return=representation"}),
                json=[item["row"]],
            )
            if one.status_code in (200, 201):
                inserted.extend(one.json())
                inserted_items.append(item)
            elif one.status_code == 409 and "23505" in (one.text or ""):
                out["duplicates"] += 1
            else:
                out["failed"] += 1
                if len(out["errors"]) < 5:
                    out["errors"].append(
                        f"HTTP {one.status_code}: {(one.text or '')[:300]}"
                    )
        out["insertStatus"] = 207
        out["insertError"] = "batch 23505; retried each reviewed row"
    else:
        out["insertError"] = resp.text[:600]
        out["insertStatus"] = resp.status_code
        out["failed"] = len(rows)
        out["written"] = 0
        return out

    if not inserted:
        out["written"] = 0
        return out
    # Derive the rollback window from the ACTUAL DB-assigned created_at values, not the
    # client clocks lo/hi: created_at is the server's now() at INSERT and can differ from
    # this process's clock by seconds, so a client-clock window can miss the very rows we
    # just wrote. The real min/max created_at bounds them exactly.
    db_cas = sorted(r.get("created_at") for r in inserted if r.get("created_at"))
    ca_lo = db_cas[0] if db_cas else lo
    ca_hi = db_cas[-1] if db_cas else hi
    inserted_ids = [str(r.get("id")) for r in inserted if r.get("id")]
    exact_id_receipt_complete = (
        len(inserted_ids) == len(inserted)
        and len(set(inserted_ids)) == len(inserted_ids)
    )
    sql_ids = ", ".join("'" + i.replace("'", "''") + "'" for i in inserted_ids)
    rollback_cmd = (
        f"DELETE FROM pin_products WHERE discovery_method='{DISCOVERY_METHOD}' "
        f"AND id IN ({sql_ids});"
    )
    out.update({"written": len(inserted),
                "insertedIds": inserted_ids,
                "exactIdReceiptComplete": exact_id_receipt_complete,
                "createdAtWindow": [ca_lo, ca_hi],
                "rollback": rollback_cmd})

    post = verify_written(db, inserted_items, ca_lo, inserted_ids)
    out["postWriteVerification"] = post

    if not post["allRedLinesPass"]:
        rollback_result = rollback_ids(db, inserted_ids)
        out["rolledBack"] = True
        out["rollbackStatus"] = rollback_result["status"]
        out["rollbackRemoved"] = rollback_result["removed"]
        out["rollbackRemovedIds"] = rollback_result["removedIds"]
        out["rollbackRemainingIds"] = rollback_result["remainingIds"]
        out["rollbackReadbackStatus"] = rollback_result["readbackStatus"]
        out["rollbackComplete"] = (
            rollback_result["complete"]
            and exact_id_receipt_complete
            and rollback_result["removed"] == len(inserted)
        )
        # `written` means rows still landed after all safety handling, not the
        # transient count returned by the INSERT before a verified rollback.
        if out["rollbackComplete"]:
            out["written"] = 0
        else:
            out["rollbackError"] = (
                f"rollback removed {rollback_result['removed']!r} of "
                f"{len(inserted)} inserted rows; remaining IDs="
                f"{rollback_result['remainingIds']!r}"
            )
    return out


def rollback_ids(db: httpx.Client, inserted_ids: list[str]) -> dict:
    """Delete and prove removal of exactly the IDs returned by one INSERT.

    This is the authoritative rollback for every new Product-Supply write. It
    cannot touch a concurrent batch merely because both batches share a
    discovery method and overlapping timestamps.
    """
    expected = list(dict.fromkeys(str(i) for i in inserted_ids if i))
    if not expected:
        return {
            "status": 200, "removed": 0, "removedIds": [],
            "readbackStatus": 200, "remainingIds": [], "complete": True,
        }

    id_filter = f"in.({','.join(expected)})"
    d = db.request(
        "DELETE", f"{SUPABASE_URL}/rest/v1/pin_products",
        headers=_headers({"Prefer": "return=representation"}),
        params={"discovery_method": f"eq.{DISCOVERY_METHOD}", "id": id_filter},
    )
    removed_rows = d.json() if d.status_code < 300 else []
    removed_ids = sorted(
        str(r.get("id")) for r in removed_rows
        if isinstance(r, dict) and r.get("id")
    )

    id_url = ",".join(quote(i, safe="-") for i in expected)
    check = db.get(
        f"{SUPABASE_URL}/rest/v1/pin_products?select=id"
        f"&discovery_method=eq.{DISCOVERY_METHOD}&id=in.({id_url})",
        headers=_headers(),
    )
    remaining_rows = check.json() if check.status_code < 300 else []
    remaining_ids = sorted(
        str(r.get("id")) for r in remaining_rows
        if isinstance(r, dict) and r.get("id")
    )
    expected_sorted = sorted(expected)
    complete = (
        d.status_code < 300
        and check.status_code < 300
        and removed_ids == expected_sorted
        and not remaining_ids
    )
    return {
        "status": d.status_code,
        "removed": len(removed_ids) if d.status_code < 300 else None,
        "removedIds": removed_ids,
        "readbackStatus": check.status_code,
        "remainingIds": remaining_ids,
        "complete": complete,
    }


def rollback_window(db: httpx.Client, lo: str, hi: str) -> dict:
    """Delete an outbound_link batch by its created_at window. Same encoding/authority
    as the automatic rollback so a human-runnable window and the code delete the SAME
    rows."""
    d = db.request("DELETE", f"{SUPABASE_URL}/rest/v1/pin_products",
                   headers=_headers({"Prefer": "return=representation"}),
                   params={"discovery_method": f"eq.{DISCOVERY_METHOD}",
                           "created_at": [f"gte.{lo}", f"lte.{hi}"]})
    return {"status": d.status_code,
            "removed": len(d.json()) if d.status_code < 300 else None}
