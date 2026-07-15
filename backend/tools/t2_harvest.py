"""
t2_harvest.py — the T2 Opportunity Discovery harvester.

Supersedes backend/tools/t2_pilot_harvest.py. That tool was built for the OLD product
positioning ("a row is only good if we scraped full product details"), and its central
rule — "no product_name → REJECT the row" — is now WRONG. It threw away real
opportunities (every Etsy listing behind a WAF) because it could not read a merchant
page it never needed to read.

════════════════════════════════════════════════════════════════════════════════
 VibePin is a Pinterest OPPORTUNITY DISCOVERY tool.
 It is NOT a product scraper, NOT a product database, NOT marketplace intelligence.
════════════════════════════════════════════════════════════════════════════════
The asset is the EVIDENCE:
    Pin → external product URL → verified Pinterest demand → Opportunity → user clicks
Product DETAILS are optional enrichment. Etsy at Discovery=100% / Detail=0% is a
COMPLETE SUCCESS, not a problem to solve.

── THE TWO-TIER FIELD MODEL (the whole design) ────────────────────────────────
A. REQUIRED — Opportunity Evidence. Missing any one → NOT an opportunity → no write.
     parent_pin_id, source_pin_url, source_url (the external product URL),
     source_pin_save_count, source_category, seed_keyword, discovery_method
   Enforced THREE times: assert_evidence() here, the DB CHECK
   pin_products_outbound_evidence_check (v47), and the red-line gate.

B. OPTIONAL — Product Details. Un-fetchable → NULL. NEVER blocks the opportunity.
     product_name, image_url, price, currency, merchant, availability
   Outcome recorded honestly in detail_fetch_status:
     available | blocked | not_found | not_attempted        (v48 vocabulary)

── THE THREE RED LINES (hard-coded as assertions; violation = no write / rollback) ──
  1. A Pin title NEVER becomes product_name.       Un-fetchable → NULL.
  2. A Pin image NEVER becomes image_url.          pinimg/pinterest host → REJECT → NULL.
  3. NEVER guess a field. Absent on the merchant page → NULL. No inference, no default.
These three are exactly the defects that produced the 798 dirty T10 rows: the old
product_harvest.build_product_row() wrote  product_name = pin["title"]  and
image_url = pin["image_url"] — Pin data masquerading as product data.

── PDP GATE ───────────────────────────────────────────────────────────────────
Candidate URLs must be PRODUCT DETAIL pages. The gate now lives in
product_harvest.is_product_detail_url() and is enforced inside accept_link() itself,
so EVERY harvester inherits it — not just this one. (Backfilled 2026-07-14: the pilot
proved the old accept_link let Amazon /s?k= search pages and TPT /browse pages through,
which then became fake "products".)

── WRITE SEMANTICS ────────────────────────────────────────────────────────────
PLAIN INSERT. No ON CONFLICT DO NOTHING, no resolution=ignore-duplicates. After v47 the
unique indexes are PARTIAL, which a bare conflict-target cannot even name — and more
importantly, silently swallowing rows is the exact failure mode we are engineering out.
A genuine collision must surface as a loud 23505.

FETCH ETIQUETTE: >= 0.55 s between outbound GETs (<= 2 req/s), real browser UA, 10 s
timeout, GET only, follow redirects, never log in, never render or execute JS. A WAF 403
is recorded honestly as detail_fetch_status='blocked' — we do NOT work around it.

USAGE
  py t2_harvest.py --dry-run                  # discover + enrich + validate; write nothing
  py t2_harvest.py --apply --confirm-write    # insert (<=20 rows), verify, auto-rollback on failure
  py t2_harvest.py --rollback-window LO HI    # delete a batch by its created_at window
"""
from __future__ import annotations

import argparse
import hashlib
import html as _html
import json
import random
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import httpx
from dotenv import dotenv_values

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND.parent
for p in (str(BACKEND), str(BACKEND / "db")):
    if p not in sys.path:
        sys.path.insert(0, p)

from product_lifecycle import NOT_RETIRED_OR_EXPR, is_retired          # noqa: E402
from product_harvest import accept_link, get_domain, is_product_detail_url  # noqa: E402

ENV = dotenv_values(ROOT / "web" / ".env.local")
SUPABASE_URL = ENV.get("NEXT_PUBLIC_SUPABASE_URL", "")
SERVICE_KEY = ENV.get("SUPABASE_SERVICE_ROLE_KEY", "")

DISCOVERY_METHOD = "outbound_link"
MAX_BATCH = 20
MIN_INTERVAL = 0.55                       # seconds between outbound GETs (<= 2 req/s)
OUT = Path(__file__).resolve().parent / "t2_harvest_evidence.json"

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

# Columns this tool is allowed to write. A stray key is a red-line violation: it means
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
    name = image = price = currency = merchant = availability = None

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
    if image and any(h in image.lower() for h in PINTEREST_IMG_HOSTS):
        ev.append("image:REJECTED_pinterest_hosted")
        image = None
    if image and not image.startswith("http"):
        ev.append("image:REJECTED_not_absolute")
        image = None

    return {
        "product_name": (name or None), "image_url": (image or None),
        "price": price, "currency": (currency or None),
        "merchant": (merchant or None), "availability": (availability or None),
        "evidence": ev,
    }


# ── DB helpers ──────────────────────────────────────────────────────────────

def _headers(extra: dict | None = None) -> dict:
    h = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}",
         "Content-Type": "application/json"}
    if extra:
        h.update(extra)
    return h


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


# ── Candidate selection ─────────────────────────────────────────────────────

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


def build_candidates(c: httpx.Client, want: int) -> tuple[list[dict], dict]:
    """Two sources:
       (A) RETIRED-URL re-collection — the lifecycle-coexistence proof;
       (B) net-new outbound pins never present in pin_products.
    Bucket-balanced across shopify / digital / amazon / etsy. Etsy is INCLUDED: a WAF is
    an enrichment problem, never a discovery problem."""
    active = active_dedup_norms(c)

    retired = _page_all(c, "pin_products",
                        "parent_pin_id,source_url,domain,product_name,image_url,source_pin_save_count",
                        "lifecycle_status=eq.retired", "id.asc")
    # accept_link() now embeds the PDP gate, so this single call enforces both.
    reclaim = [r for r in retired
               if r.get("source_url")
               and normalize_product_url(r["source_url"]) not in active
               and accept_link(r["source_url"])[0]]

    pins_by_id: dict[str, dict] = {}
    ids = [r["parent_pin_id"] for r in reclaim if r.get("parent_pin_id")]
    for i in range(0, len(ids), 100):
        chunk = ids[i:i + 100]
        for p in _page_all(c, "pin_samples",
                           "pin_id,title,outbound_link,image_url,save_count,category,"
                           "seed_keyword,source_keyword,pinterest_url",
                           "pin_id=in.(" + ",".join(chunk) + ")", "pin_id.asc"):
            pins_by_id[p["pin_id"]] = p

    cands: list[dict] = []
    for r in reclaim:
        p = pins_by_id.get(r.get("parent_pin_id") or "")
        if not p:
            continue
        cands.append({"pin": p, "url": r["source_url"], "origin": "retired_reclaim",
                      "domain": get_domain(r["source_url"])})

    seen = {normalize_product_url(x["url"]) for x in cands}
    fresh = _page_all(c, "pin_samples",
                      "pin_id,title,outbound_link,image_url,save_count,category,"
                      "seed_keyword,source_keyword,pinterest_url",
                      "outbound_link=not.is.null", "save_count.desc,pin_id.asc")
    for p in fresh:
        u = (p.get("outbound_link") or "").strip()
        if not u or not accept_link(u)[0]:
            continue
        n = normalize_product_url(u)
        if n in active or n in seen:
            continue
        seen.add(n)
        cands.append({"pin": p, "url": u, "origin": "net_new", "domain": get_domain(u)})

    by_bucket: dict[str, list[dict]] = defaultdict(list)
    for x in cands:
        by_bucket[bucket_of(x["domain"])].append(x)

    rng = random.Random(20260714)

    def _spread(pool: list[dict]) -> list[dict]:
        """Round-robin across DISTINCT merchant domains so one hostile host cannot
        monopolise a bucket and make the whole bucket look incapable."""
        by_dom: dict[str, list[dict]] = defaultdict(list)
        for x in pool:
            by_dom[x["domain"]].append(x)
        for v in by_dom.values():
            rng.shuffle(v)
        doms = sorted(by_dom, key=lambda d: -len(by_dom[d]))
        rng.shuffle(doms)
        out: list[dict] = []
        while any(by_dom[d] for d in doms):
            for d in doms:
                if by_dom[d]:
                    out.append(by_dom[d].pop())
        return out

    picked: list[dict] = []
    reclaims = _spread([x for x in cands if x["origin"] == "retired_reclaim"])
    picked += reclaims[:max(6, want // 2)]
    for b in ("shopify", "digital", "amazon", "etsy"):
        pool = _spread([x for x in by_bucket.get(b, []) if x not in picked])
        picked += pool[:8]
    rng.shuffle(picked)

    stats = {
        "activeNormUrls": len(active),
        "retiredRows": len(retired),
        "retiredUrlsReCollectable": len(reclaim),
        "retiredWithSourcePin": sum(1 for x in cands if x["origin"] == "retired_reclaim"),
        "netNewCandidates": sum(1 for x in cands if x["origin"] == "net_new"),
    }
    return picked, stats


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
    """The T2 chain, in the ONLY correct order:

        1. DISCOVERY  — required evidence complete?   → yes: this IS an opportunity.
        2. ENRICHMENT — try to read the merchant page → optional; failure is recorded,
                        never fatal. A blocked Etsy listing is still a written row.

    The old pilot inverted these: it made step 2 a precondition of step 1, which is why
    it silently discarded every legitimate WAF-protected merchant.
    """
    rows: list[dict] = []
    failures: list[dict] = []
    min_attempts_per_bucket = 3
    attempts: dict[str, int] = defaultdict(int)

    for x in cands[:max_attempts]:
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
        pdp_ok, pdp_why = is_product_detail_url(r.get("source_url") or "")
        if not pdp_ok:
            v.append(f"[{u}] RED LINE 1: source_url is not a product-detail page ({pdp_why})")

        # ── RED LINE ②: no fabricated product data ──────────────────────────
        img = r.get("image_url")
        if img:
            if any(h in img.lower() for h in PINTEREST_IMG_HOSTS):
                v.append(f"[{u}] RED LINE 2: product image is Pinterest-hosted: {img[:60]}")
            if r.get("source_pin_image_url") and img.strip() == r["source_pin_image_url"].strip():
                v.append(f"[{u}] RED LINE 2: product image == source_pin_image_url")
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

def verify_written(db: httpx.Client, rows: list[dict], lo: str) -> dict:
    """Re-read what actually landed and prove the four red lines HOLD IN THE DATABASE —
    not merely in the in-memory rows we intended to write."""
    post: dict = {}
    written = db.get(f"{SUPABASE_URL}/rest/v1/pin_products?select=*"
                     f"&discovery_method=eq.{DISCOVERY_METHOD}&created_at=gte.{lo}",
                     headers=_headers()).json()
    post["rowsReadBack"] = len(written)

    # ① source authenticity
    bad_src = [r["source_url"] for r in written
               if not r.get("source_pin_url") or not r.get("source_url")
               or "pinterest.com" in (r.get("source_url") or "")]
    post["redLine1_sourceAuthenticity"] = {"violations": bad_src, "pass": not bad_src}

    # ② no fabricated product data
    bad_fab = []
    for r in written:
        img = r.get("image_url") or ""
        if img and any(h in img.lower() for h in PINTEREST_IMG_HOSTS):
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
        both = db.get(f"{SUPABASE_URL}/rest/v1/pin_products"
                      f"?select=id,lifecycle_status,discovery_method,source_url"
                      f"&source_url=eq.{httpx.URL(i['row']['source_url'])}",
                      headers=_headers()).json()
        states = sorted({(r.get("lifecycle_status") or "active") for r in both})
        coexist.append({"url": i["row"]["source_url"], "rows": len(both),
                        "lifecycleStates": states,
                        "coexists": ("retired" in states and "active" in states)})
    post["redLine4_lifecycleCoexistence"] = {
        "pairs": coexist,
        "pass": bool(coexist) and all(c["coexists"] for c in coexist),
    }
    post["allRedLinesPass"] = all(
        post[k]["pass"] for k in
        ("redLine1_sourceAuthenticity", "redLine2_noFabrication",
         "redLine3_provenanceSeparation", "redLine4_lifecycleCoexistence"))
    return post


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--confirm-write", action="store_true")
    ap.add_argument("--limit", type=int, default=18)
    ap.add_argument("--rollback-window", nargs=2, metavar=("LO", "HI"))
    args = ap.parse_args()

    assert args.limit <= MAX_BATCH, f"limit {args.limit} > MAX_BATCH {MAX_BATCH}"

    with httpx.Client(timeout=60) as db:
        if args.rollback_window:
            lo, hi = args.rollback_window
            d = db.request("DELETE", f"{SUPABASE_URL}/rest/v1/pin_products",
                           headers=_headers({"Prefer": "return=representation"}),
                           params={"discovery_method": f"eq.{DISCOVERY_METHOD}",
                                   "created_at": [f"gte.{lo}", f"lte.{hi}"]})
            print(f"rollback → HTTP {d.status_code}, removed "
                  f"{len(d.json()) if d.status_code < 300 else '?'} rows")
            return 0 if d.status_code < 300 else 1

        cands, stats = build_candidates(db, args.limit)
        print(f"candidate pool: {json.dumps(stats)}")
        print("picked buckets: " + json.dumps(
            {b: sum(1 for x in cands if bucket_of(x["domain"]) == b)
             for b in ("shopify", "digital", "amazon", "etsy", "other")}))
        print("        origins: " + json.dumps(
            {o: sum(1 for x in cands if x["origin"] == o)
             for o in ("retired_reclaim", "net_new")}))

        with httpx.Client(timeout=15) as web:
            rows, failures = discover(web, cands, want=args.limit)

        assert len(rows) <= MAX_BATCH, f"batch {len(rows)} exceeds MAX_BATCH {MAX_BATCH}"

        metrics = build_metrics(rows, failures)
        ok, violations = check_red_lines(rows)

        print(f"\n── DISCOVERY: {len(rows)} opportunities, {len(failures)} rejected ──")
        print("OVERALL   ", json.dumps(metrics["overall"], ensure_ascii=False))
        print("\nBY DOMAIN — Discovery rate vs Detail enrichment rate (SEPARATE metrics):")
        print(f"  {'domain':<32} {'bkt':<8} {'disc':>10} {'detail':>10}  detail_fetch_status")
        for dom, m in metrics["byDomain"].items():
            print(f"  {dom:<32} {m['bucket']:<8} "
                  f"{m['discovered']}/{m['attempted']:<2} {m['discoverySuccessRate']:>5} "
                  f"{m['detailEnriched']}/{m['discovered']:<2} {m['detailEnrichmentRate']:>5}  "
                  f"{json.dumps(m['detailFetchStatus'])}")
        print(f"\nRED LINES (pre-write): {'PASS' if ok else 'FAIL'}")
        for x in violations:
            print("  VIOLATION:", x)

        evidence = {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "mode": "apply" if (args.apply and args.confirm_write) else "dry-run",
            "positioning": "Pinterest Opportunity Discovery — product details are OPTIONAL enrichment",
            "candidatePool": stats,
            "metrics": metrics,
            "redLinesPassPreWrite": ok,
            "violations": violations,
            "discovered": [i["rec"] for i in rows],
            "discoveryFailures": failures,
        }

        if not (args.apply and args.confirm_write) or not ok:
            evidence["written"] = 0
            OUT.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"\nDRY-RUN (or red-line FAIL): nothing written. evidence → {OUT.name}")
            return 0 if ok else 1

        # ── WRITE: PLAIN INSERT. No ON CONFLICT DO NOTHING — a real collision must
        #    surface as a loud 23505 rather than be silently swallowed. ──────────
        lo = datetime.now(timezone.utc).isoformat()
        resp = db.post(f"{SUPABASE_URL}/rest/v1/pin_products",
                       headers=_headers({"Prefer": "return=representation"}),
                       json=[i["row"] for i in rows])
        hi = datetime.now(timezone.utc).isoformat()
        if resp.status_code not in (200, 201):
            print(f"INSERT FAILED [{resp.status_code}]: {resp.text[:600]}")
            evidence["insertError"] = resp.text[:600]
            OUT.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
            return 1

        inserted = resp.json()
        rollback = (f"py t2_harvest.py --rollback-window '{lo}' '{hi}'   # or SQL:\n  "
                    f"DELETE FROM pin_products WHERE discovery_method='{DISCOVERY_METHOD}' "
                    f"AND created_at BETWEEN '{lo}' AND '{hi}';")
        evidence.update({"written": len(inserted),
                         "insertedIds": [r.get("id") for r in inserted],
                         "createdAtWindow": [lo, hi], "rollback": rollback})
        print(f"\nINSERTED {len(inserted)} / {len(rows)} rows")
        print("ROLLBACK:\n ", rollback)

        post = verify_written(db, rows, lo)
        evidence["postWriteVerification"] = post
        OUT.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")

        print("\n── POST-WRITE RED-LINE VERIFICATION (read back from the DB) ──")
        for k in ("redLine1_sourceAuthenticity", "redLine2_noFabrication",
                  "redLine3_provenanceSeparation", "redLine4_lifecycleCoexistence"):
            print(f"  {'PASS' if post[k]['pass'] else 'FAIL'}  {k}")
            for x in post[k].get("violations", []):
                print("        violation:", x)
        for c in post["redLine4_lifecycleCoexistence"]["pairs"]:
            print(f"        {'OK ' if c['coexists'] else 'NO '} {c['lifecycleStates']} "
                  f"rows={c['rows']}  {c['url'][:70]}")

        if not post["allRedLinesPass"]:
            print("\n!! POST-WRITE RED LINE FAILED — ROLLING BACK NOW")
            d = db.request("DELETE", f"{SUPABASE_URL}/rest/v1/pin_products",
                           headers=_headers({"Prefer": "return=representation"}),
                           params={"discovery_method": f"eq.{DISCOVERY_METHOD}",
                                   "created_at": f"gte.{lo}"})
            print(f"  rollback → HTTP {d.status_code}, removed "
                  f"{len(d.json()) if d.status_code < 300 else '?'} rows")
            evidence["rolledBack"] = True
            OUT.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
            return 1

        print("\nALL FOUR RED LINES PASS POST-WRITE. evidence →", OUT.name)
        return 0


if __name__ == "__main__":
    sys.exit(main())
