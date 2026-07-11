"""
shop_the_look.py — Scrape "Shop the Look" product cards from viral pins.

Covers ALL categories (not just home). Sources pins from:
  1. Supabase pin_samples table (preferred — always current)
  2. vibe_library/style_library_*/style_library.jsonl (local fallback)

Only pins with save_count >= STL_MIN_SAVES are processed (default 5 000).

Usage:
  py shop_the_look.py --db            # write products to Supabase
  py shop_the_look.py --limit 50      # process top 50 pins
  py shop_the_look.py --category home # one category only
  py shop_the_look.py --pin-file ids.txt --db
"""
import asyncio, hashlib, json, time, re, sys
from pathlib import Path
from urllib.parse import urlparse, parse_qs, urlencode, unquote
from playwright.async_api import async_playwright

# Force UTF-8 output so non-GBK characters (snowflakes, emoji, etc.) don't crash
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT        = Path(__file__).parent
LIB_ROOT    = ROOT / "vibe_library"
OUT_FILE    = ROOT / "shop_the_look_products.jsonl"
HTML_OUT    = ROOT / "shop_the_look.html"
PROFILE_DIR = Path.home() / "AppData/Local/PinterestScraper/profile"

MIN_PRODUCT_SAVE = 10      # minimum save_count for a PRODUCT card to be kept
STL_MIN_SAVES    = 5_000   # minimum save_count on SOURCE PIN to attempt STL scrape

# UTM + tracking params to strip from product URLs
_STRIP_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
    "utm_id", "fbclid", "gclid", "gclsrc", "dclid", "msclkid",
    "ref", "referrer", "tag", "affiliate", "aff_id", "aff_code",
    "epik", "ttclid", "li_fat_id", "igshid", "s_kwcid", "ef_id",
    # Pinterest-specific
    "e_t", "pin_source", "pin_id", "amp_user_id",
}

# Merchant domain → canonical brand name
_MERCHANT_ALIASES: dict[str, str] = {
    "etsy.com":          "Etsy",
    "amazon.com":        "Amazon",
    "amazon.co.uk":      "Amazon UK",
    "amazon.co.jp":      "Amazon JP",
    "target.com":        "Target",
    "walmart.com":       "Walmart",
    "wayfair.com":       "Wayfair",
    "westelm.com":       "West Elm",
    "cb2.com":           "CB2",
    "crateandbarrel.com": "Crate & Barrel",
    "homedepot.com":     "Home Depot",
    "ikea.com":          "IKEA",
    "zara.com":          "Zara",
    "h&m.com":           "H&M",
    "hm.com":            "H&M",
    "asos.com":          "ASOS",
    "shopify.com":       "Shopify Store",
}


# ── Product canonicalization ──────────────────────────────────────────────────

def canonicalize_url(url: str) -> str:
    """
    Strip tracking params, Pinterest redirects, and normalize scheme/host.
    Returns a stable canonical URL safe for dedup hashing.
    """
    if not url:
        return ""
    try:
        # Unwrap Pinterest redirect (pinterest.com/url?url=...)
        if "pinterest.com" in url and "url=" in url:
            parsed = urlparse(url)
            qs = parse_qs(parsed.query)
            inner = qs.get("url", [url])[0]
            url = unquote(inner)

        parsed = urlparse(url)
        qs = parse_qs(parsed.query, keep_blank_values=False)
        clean_qs = {k: v for k, v in qs.items() if k.lower() not in _STRIP_PARAMS}
        # Rebuild query string with sorted keys for stable output
        clean_query = urlencode(sorted(clean_qs.items()), doseq=True)
        canonical = parsed._replace(
            scheme   = parsed.scheme.lower(),
            netloc   = parsed.netloc.lower().removeprefix("www."),
            path     = parsed.path.rstrip("/") or "/",
            query    = clean_query,
            fragment = "",
        )
        return canonical.geturl()
    except Exception:
        return url


def url_hash(canonical: str) -> str | None:
    """MD5 of canonical URL for fast cross-pin dedup."""
    if not canonical:
        return None
    return hashlib.md5(canonical.encode("utf-8")).hexdigest()


def normalize_merchant(domain: str | None) -> str | None:
    """Resolve domain to canonical brand name."""
    if not domain:
        return None
    d = domain.lower().removeprefix("www.")
    return _MERCHANT_ALIASES.get(d) or d.split(".")[0].title()


def normalize_product_name(name: str | None) -> str | None:
    """Lowercase, collapse whitespace, strip leading punctuation."""
    if not name:
        return None
    cleaned = re.sub(r"\s+", " ", name.strip().lower())
    cleaned = re.sub(r"^[^\w]+", "", cleaned)
    return cleaned[:500] or None


# ── DB helpers ────────────────────────────────────────────────────────────────

def _parse_price(raw) -> float | None:
    """Parse a price string like '$29.99', '298.00', '£45' → float, or None."""
    if not raw:
        return None
    s = str(raw).strip().lstrip("$£€¥₩")
    s = s.replace(",", "").split()[0]  # drop trailing text like "USD"
    try:
        v = float(s)
        return round(v, 2) if v > 0 else None
    except (ValueError, TypeError):
        return None


def _parse_currency(raw) -> str:
    """Infer ISO-4217 currency from a price string prefix."""
    if not raw:
        return "USD"
    s = str(raw).strip()
    if s.startswith("£"):  return "GBP"
    if s.startswith("€"):  return "EUR"
    if s.startswith("¥"):  return "JPY"
    if s.startswith("₩"):  return "KRW"
    return "USD"


def _build_product_row(p: dict) -> dict:
    """
    Map a shop_the_look product dict to the pin_products DB schema.
    Includes canonicalized URL, URL hash, and normalized fields for dedup.
    """
    raw_url   = p.get("link") or None
    canon_url = canonicalize_url(raw_url) if raw_url else None
    domain    = p.get("domain") or None
    return {
        "product_pin_id":         p.get("product_pin_id") or None,
        "parent_pin_id":          p.get("parent_pin_id", ""),
        "product_name":           (p.get("title") or "")[:500],
        "price":                  _parse_price(p.get("price")),
        "currency":               _parse_currency(p.get("price")),
        "source_url":             raw_url,
        "domain":                 domain,
        "merchant":               p.get("merchant") or None,
        "image_url":              p.get("image_url") or None,
        "save_count":             int(p.get("save_count") or 0),
        "reaction_count":         int(p.get("reaction_count") or 0),
        "source_pin_save_count":  int(p.get("source_pin_save_count") or 0),
        "seed_keyword":           p.get("seed_keyword") or None,
        # Canonicalization (migrate_v10)
        "canonical_product_url":  canon_url,
        "product_url_hash":       url_hash(canon_url),
        "normalized_merchant":    normalize_merchant(domain),
        "normalized_product_name": normalize_product_name(p.get("title")),
        # Provenance (migrate_v27) — STL visual-shop extraction.
        "discovery_method":       "stl",
    }


def _upsert_products(products: list[dict], dry_run: bool = False) -> int:
    """
    Upsert a list of product dicts into Supabase pin_products.
    Returns number of rows written. Silently skips if DB not configured.
    """
    if not products:
        return 0
    sys.path.insert(0, str(ROOT / "db"))
    try:
        from db import upsert  # type: ignore
    except ImportError as exc:
        print(f"  [db] cannot import db module: {exc}")
        return 0

    rows = [_build_product_row(p) for p in products if p.get("title")]
    # Rows with product_pin_id use that as the conflict key (fastest).
    # Rows without it fall back to (parent_pin_id, source_url); skip if both missing.
    keyed   = [r for r in rows if r.get("product_pin_id")]
    unkeyed = [r for r in rows if not r.get("product_pin_id")
               and r.get("parent_pin_id") and r.get("source_url")]

    written = 0
    try:
        if keyed:
            result = upsert("pin_products", keyed, on_conflict="product_pin_id")
            written += len(result)
        if unkeyed:
            # No product_pin_id: fall back to dedup on (parent_pin_id, source_url)
            result = upsert("pin_products", unkeyed, on_conflict="parent_pin_id,source_url")
            written += len(result)
    except Exception as exc:
        print(f"  [db] upsert error: {exc}")
    return written


# ── Load pins for STL processing ─────────────────────────────────────────────

def load_pins_from_db(category: str | None = None,
                      min_saves: int = STL_MIN_SAVES,
                      limit: int = 0,
                      since_hours: int = 0,
                      source: str | None = None) -> list[dict]:
    """
    Load premium pins from Supabase pin_samples.
    Covers all categories unless category is specified.

    Optional scope (used for the bootstrap-only STL pass):
      since_hours — only pins scraped within the last N hours (never legacy)
      source      — pin_samples.source_interest filter; "bootstrap" maps to
                    (manual_bootstrap, csv_bootstrap)
      category    — single id or comma-separated list (→ PostgREST in.())

    Falls back silently to [] if DB is unavailable.
    """
    from datetime import datetime, timedelta, timezone
    sys.path.insert(0, str(ROOT / "db"))
    try:
        from db import select_many  # type: ignore
    except ImportError:
        return []

    filters: dict = {"save_count": f"gte.{min_saves}", "trend_keyword_id": "not.is.null"}
    if category:
        filters["category"] = f"in.({category})" if "," in category else category
    if since_hours:
        cutoff = (datetime.now(tz=timezone.utc) - timedelta(hours=since_hours)).isoformat()
        filters["scraped_at"] = f"gte.{cutoff}"
    if source:
        if source.lower() in ("bootstrap", "manual_bootstrap", "csv_bootstrap"):
            filters["source_interest"] = "in.(manual_bootstrap,csv_bootstrap)"
        else:
            filters["source_interest"] = f"eq.{source}"

    try:
        rows = select_many(
            "pin_samples",
            filters=filters,
            order="save_count.desc",
            limit=limit or None,
        )
        return [
            {"pin_id": r["pin_id"], "save_count": r.get("save_count", 0),
             "title": r.get("title", ""), "category": r.get("category", ""),
             "seed_keyword": r.get("seed_keyword") or r.get("source_keyword") or "",
             "source_interest": r.get("source_interest"),
             "trend_keyword_id": r.get("trend_keyword_id")}
            for r in (rows or [])
            if r.get("pin_id")
        ]
    except Exception as exc:
        print(f"[stl] DB load error: {exc}")
        return []


def load_pins_from_jsonl(category: str | None = None,
                         min_saves: int = STL_MIN_SAVES) -> list[dict]:
    """
    Load pins from local vibe_library JSONL files.
    Used as fallback when DB is unavailable or for offline runs.
    All categories included unless category is specified.
    """
    seen: dict[str, dict] = {}
    for folder in sorted(LIB_ROOT.glob("style_library_*")):
        f = folder / "style_library.jsonl"
        if not f.exists():
            continue
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                p = json.loads(line)
                if category and p.get("category") != category:
                    continue
                if (p.get("save_count") or 0) < min_saves:
                    continue
                pid = p.get("pin_id")
                if not pid:
                    continue
                cur = seen.get(pid)
                if not cur or (p.get("save_count") or 0) > (cur.get("save_count") or 0):
                    seen[pid] = p
            except Exception:
                pass
    return sorted(seen.values(), key=lambda x: x.get("save_count") or 0, reverse=True)


def load_pins(category: str | None = None,
              min_saves: int = STL_MIN_SAVES,
              limit: int = 0,
              since_hours: int = 0,
              source: str | None = None) -> list[dict]:
    """Primary loader: DB first, JSONL fallback."""
    pins = load_pins_from_db(category=category, min_saves=min_saves, limit=limit,
                             since_hours=since_hours, source=source)
    if pins:
        print(f"[stl] Loaded {len(pins)} pins from DB (category={category or 'all'}, "
              f"min_saves={min_saves})")
        return pins

    print("[stl] DB returned no pins — falling back to local JSONL")
    pins = load_pins_from_jsonl(category=category, min_saves=min_saves)
    if limit:
        pins = pins[:limit]
    print(f"[stl] Loaded {len(pins)} pins from JSONL")
    return pins


# ── Extract product data from API responses ───────────────────────────────────

def extract_products_from_body(body: dict, parent_pin_id: str) -> list[dict]:
    """Try to extract product cards from any Pinterest API response."""
    products = []

    def walk(obj, depth=0):
        if depth > 8 or not isinstance(obj, (dict, list)):
            return
        if isinstance(obj, list):
            for item in obj:
                walk(item, depth + 1)
            return
        # Check if this dict looks like a product
        keys = set(obj.keys())
        has_price  = any(k in keys for k in ["price", "price_value", "formatted_price",
                                               "min_price", "max_price"])
        has_link   = any(k in keys for k in ["link", "url", "product_url",
                                               "catalog_object", "catalog"])
        has_img    = any(k in keys for k in ["image", "image_url", "images",
                                               "dominant_color"])
        is_product = has_price or (has_link and has_img)

        if is_product:
            prod = extract_single_product(obj, parent_pin_id)
            if prod:
                products.append(prod)
                return  # don't recurse into what we already extracted

        for v in obj.values():
            walk(v, depth + 1)

    walk(body)
    return products


def extract_single_product(obj: dict, parent_pin_id: str) -> dict | None:
    """Extract standardized product fields from a raw API object."""
    # title
    title = (obj.get("title") or obj.get("name") or obj.get("display_name")
             or obj.get("description", "")[:80] or "")
    if not title:
        return None

    # price
    price_raw = (obj.get("price") or obj.get("price_value")
                 or obj.get("formatted_price") or obj.get("min_price") or "")
    price_str = str(price_raw) if price_raw else ""

    # link
    link = (obj.get("link") or obj.get("url") or obj.get("product_url") or
            obj.get("outbound_link") or "")
    if not link and "catalog_object" in obj:
        co = obj["catalog_object"] or {}
        link = co.get("url") or co.get("link") or ""

    # image
    images = obj.get("images") or {}
    if isinstance(images, dict):
        # Pinterest image dict: {"736x": {"url": ...}}
        for key in ["736x", "474x", "orig", "600x", "200x"]:
            if key in images:
                img_url = (images[key] or {}).get("url", "")
                if img_url:
                    break
        else:
            img_url = obj.get("image_url") or obj.get("image") or ""
    elif isinstance(images, str):
        img_url = images
    else:
        img_url = obj.get("image_url") or obj.get("image") or ""

    # save / reaction counts (might be repin_count or save_count)
    saves = (obj.get("save_count") or obj.get("repin_count")
             or obj.get("saves") or 0)
    reactions = obj.get("reaction_count") or obj.get("reactions") or 0

    # pin_id
    pin_id = str(obj.get("id") or obj.get("pin_id") or "")

    # domain
    domain = ""
    if link:
        try:
            domain = urlparse(link).netloc
        except Exception:
            pass

    # merchant
    merchant = (obj.get("merchant_name") or obj.get("merchant")
                or obj.get("seller") or domain or "")

    if not img_url and not link:
        return None

    return {
        "product_pin_id": pin_id,
        "parent_pin_id":  parent_pin_id,
        "title":          title,
        "price":          price_str,
        "link":           link,
        "domain":         domain,
        "merchant":       merchant,
        "image_url":      img_url,
        "save_count":     int(saves) if saves else 0,
        "reaction_count": int(reactions) if reactions else 0,
    }


# ── Main scraper ──────────────────────────────────────────────────────────────

async def scrape_pin_stl(page, pin: dict) -> list[dict]:
    pin_id = pin["pin_id"]
    captured: list[dict] = []

    async def on_resp(resp):
        url = resp.url
        if "pinterest.com" not in url:
            return
        if not any(k in url for k in [
            "/resource/", "shopping", "product", "catalog",
            "shop_the_look", "visual_search",
        ]):
            return
        try:
            body = await resp.json()
            prods = extract_products_from_body(body, pin_id)
            if prods:
                for p in prods:
                    if p["save_count"] >= MIN_PRODUCT_SAVE or p.get("price"):
                        captured.append(p)
                        print(f"    product: {p['title'][:50]}  "
                              f"save={p['save_count']}  price={p['price']}  {p['domain']}")
        except Exception:
            pass

    page.on("response", on_resp)

    try:
        # 1. Navigate to pin detail page
        detail_url = f"https://www.pinterest.com/pin/{pin_id}/"
        print(f"  detail: {detail_url}")
        await page.goto(detail_url, wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(2)

        # Dismiss modal
        await page.evaluate("""() => {
            const sels = ['[data-test-id="fullPageSignupModal"]',
                          '[class*="SignupModal"]','[data-test-id="login-modal"]'];
            sels.forEach(s => document.querySelectorAll(s).forEach(e => e.remove()));
            document.body.style.overflow = '';
        }""")

        # Scroll to load shop-the-look section
        for _ in range(10):
            await page.mouse.wheel(0, 400)
            await asyncio.sleep(0.6)
        await asyncio.sleep(2)

        # 2. Check if "Shop the look" button exists and click it
        stl_texts = ["Shop the look", "Shop this look", "Einkaufen"]
        for txt in stl_texts:
            try:
                btn = await page.query_selector(f"text={txt}")
                if btn:
                    print(f"    Found '{txt}' button, clicking...")
                    await btn.click(timeout=5000)
                    await asyncio.sleep(3)
                    # scroll the new page
                    for _ in range(5):
                        await page.mouse.wheel(0, 400)
                        await asyncio.sleep(0.6)
                    break
            except Exception:
                pass

        # 3. Try navigating to visual-shop URL directly
        vs_url = (f"https://www.pinterest.com/pin/{pin_id}/visual-shop/"
                  f"?entry_source=shopping&is_shopping=true")
        print(f"  visual-shop: {vs_url}")
        _vs_loaded = False
        try:
            await page.goto(vs_url, wait_until="domcontentloaded", timeout=45000)
            _vs_loaded = True
        except Exception as vs_err:
            print(f"    visual-shop skipped: {vs_err}")
        if _vs_loaded:
            await asyncio.sleep(3)
            await page.evaluate("""() => {
                const sels = ['[data-test-id="fullPageSignupModal"]','[class*="SignupModal"]'];
                sels.forEach(s => document.querySelectorAll(s).forEach(e => e.remove()));
                document.body.style.overflow = '';
            }""")
            for _ in range(6):
                await page.mouse.wheel(0, 400)
                await asyncio.sleep(0.7)
            await asyncio.sleep(2)

    except Exception as e:
        print(f"    Error: {e}")
    finally:
        page.remove_listener("response", on_resp)

    # Deduplicate by product_pin_id + link
    seen_keys: set[str] = set()
    unique = []
    for p in captured:
        k = p.get("product_pin_id") or p.get("link") or p.get("title")
        if k and k not in seen_keys:
            seen_keys.add(k)
            unique.append(p)
    return unique


def _stl_preflight(args) -> int:
    """Read-only STL preflight: select pins with the same scope the real run uses,
    report coverage + legacy/already-processed checks. No scrape, no writes."""
    from collections import Counter
    sys.path.insert(0, str(ROOT / "db"))
    try:
        from db import select_many  # type: ignore
    except ImportError:
        print("[stl-preflight] DB unavailable")
        return 2

    pins = load_pins_from_db(category=args.category, min_saves=args.min_saves,
                             limit=args.limit, since_hours=args.since_hours, source=args.source)
    bootstrap_sources = {"manual_bootstrap", "csv_bootstrap"}
    legacy = [p for p in pins if (p.get("source_interest") not in bootstrap_sources)]
    pin_ids = [p["pin_id"] for p in pins if p.get("pin_id")]

    # already-processed = source pins that already have pin_products rows
    already = 0
    if pin_ids:
        try:
            existing = select_many("pin_products",
                                   filters={"parent_pin_id": "in.(" + ",".join(pin_ids) + ")"},
                                   limit=20000) or []
            already = len({r.get("parent_pin_id") for r in existing if r.get("parent_pin_id")})
        except Exception as exc:
            print(f"[stl-preflight] already-processed check failed: {exc}")

    saves = [int(p.get("save_count") or 0) for p in pins]
    report = {
        "mode": "dry-run",
        "scope": {"sinceHours": args.since_hours, "source": args.source,
                  "category": args.category, "minSaves": args.min_saves, "limit": args.limit},
        "pinsSelected": len(pins),
        "byCategory": dict(Counter(p.get("category") for p in pins)),
        "bySourceInterest": dict(Counter(p.get("source_interest") for p in pins)),
        "legacyPinsTouched": len(legacy),
        "legacyPinSample": [p.get("pin_id") for p in legacy[:10]],
        "alreadyProcessedPins": already,
        "wouldScrape": len(pin_ids) - (already if not getattr(args, "reprocess", False) else 0),
        "saveCountRange": {"min": min(saves) if saves else 0, "max": max(saves) if saves else 0},
        "expectedWrites": {"pin_products": "1+ per pin with shoppable products (unknown until scrape)",
                           "otherTables": "none"},
        "estimatedProductCandidates": "unknown pre-scrape (Playwright STL extraction required)",
        "errorRisks": ["playwright/network timeout per pin", "pins with no shop-the-look products yield 0"],
    }
    print(json.dumps(report, indent=2, ensure_ascii=False, default=str))
    if legacy:
        print(f"[stl-preflight] WARNING: {len(legacy)} non-bootstrap (legacy) pins in scope — tighten --source/--since-hours")
    return 0


def _legacy_db_write_allowed(args) -> bool:
    """Retired-writer opt-in gate.

    Legacy STL is no longer a production pin_products writer (it re-scrapes the
    saturated global Top-N daily, emits legacy provenance — discovery_method='stl'
    with NULL discovery_method_detail / normalized_product_url_hash / source_category
    — and uses merge-upsert which can mutate existing rows). The supported writer is
    the bootstrap v28 path (run_worker.py --job product-supply-expand).

    Normal operation MUST refuse --db. An operator can override for emergency /
    manual use only, via an explicit flag or env var.
    """
    import os
    if getattr(args, "allow_legacy_db_write", False):
        return True
    return os.environ.get("VIBEPIN_ALLOW_LEGACY_STL_DB", "") == "1"


async def main():
    import argparse, webbrowser
    ap = argparse.ArgumentParser(
        description="Scrape Shop-the-Look products from viral pins (all categories)"
    )
    ap.add_argument("--open",      action="store_true",
                    help="Open HTML viewer after run")
    ap.add_argument("--limit",     type=int, default=0,
                    help="Max pins to process (0=all)")
    ap.add_argument("--start",     type=int, default=1,
                    help="Skip to Nth pin (1-based, for resume)")
    ap.add_argument("--category",  default=None,
                    help="Filter by category (e.g. home, fashion). Default: all.")
    ap.add_argument("--min-saves", type=int, default=STL_MIN_SAVES,
                    help=f"Min source pin save_count (default {STL_MIN_SAVES})")
    ap.add_argument("--pin-file",  default=None,
                    help="Text file with one pin_id per line (overrides DB/JSONL load)")
    ap.add_argument("--db",        action="store_true",
                    help="Write products to Supabase pin_products table")
    ap.add_argument("--since-hours", type=int, default=0,
                    help="Only pins scraped within the last N hours (scoped/bootstrap STL; never legacy)")
    ap.add_argument("--source",    default=None,
                    help="pin_samples.source_interest filter; 'bootstrap' = manual/csv bootstrap pins")
    ap.add_argument("--dry-run",   action="store_true",
                    help="Read-only preflight: select pins + report scope, no scrape, no writes")
    ap.add_argument("--allow-legacy-db-write", action="store_true",
                    help="Emergency/manual opt-in to the RETIRED legacy STL pin_products "
                         "writer. Without this flag (or VIBEPIN_ALLOW_LEGACY_STL_DB=1), "
                         "--db refuses before any Pinterest navigation or DB write.")
    args = ap.parse_args()

    if args.dry_run:
        return _stl_preflight(args)

    # ── Retired-writer guard ──────────────────────────────────────────────────
    # Refuse legacy pin_products writes BEFORE loading pins, navigating Pinterest,
    # or acquiring the pin_products_writer lock. Dry-run (read-only preflight)
    # returns above and is unaffected. Runs without --db never write, so they are
    # also unaffected.
    if args.db and not _legacy_db_write_allowed(args):
        print("Legacy STL DB writes are retired. "
              "Use product-supply-expand / bootstrap v28 path.")
        print("  Supported writer:  py run_worker.py --job product-supply-expand")
        print("  See:               backend/docs/product_supply_migration.md")
        print("  Emergency override: --allow-legacy-db-write  "
              "(or set VIBEPIN_ALLOW_LEGACY_STL_DB=1)")
        return 2

    if args.pin_file:
        pin_file = Path(args.pin_file)
        if not pin_file.exists():
            print(f"[stl] --pin-file not found: {pin_file}")
            return
        priority_ids = [l.strip() for l in pin_file.read_text(encoding="utf-8").splitlines() if l.strip()]
        # Try to enrich with metadata from DB/JSONL
        all_known = load_pins(category=None, min_saves=0, limit=0)
        known = {p["pin_id"]: p for p in all_known}
        home_pins = []
        for pid in priority_ids:
            home_pins.append(known.get(pid) or {"pin_id": pid, "save_count": 0, "title": f"pin {pid}"})
        print(f"[stl] pin-file mode: {len(home_pins)} pins to scan")
    else:
        home_pins = load_pins(category=args.category,
                              min_saves=args.min_saves,
                              limit=args.limit,
                              since_hours=args.since_hours,
                              source=args.source)
        if args.start > 1:
            home_pins = home_pins[args.start - 1:]
            print(f"[stl] Resuming from pin #{args.start}")
        elif args.limit and len(home_pins) > args.limit:
            home_pins = home_pins[:args.limit]

    all_products: list[dict] = []

    # ── concurrency guard (shared with bootstrap path; same canonical lock dir) ──
    # Hold the cross-job Pinterest lock for the duration of Playwright navigation,
    # and the pin_products writer lock when --db is set, so this legacy STL run
    # cannot collide with the daily crawl or the manual STL bootstrap.
    import joblock  # noqa: E402
    _plock = joblock.pinterest_lock(job="legacy-shop-the-look")
    if not _plock.acquire():
        print(f"[stl] skipped — pinterest_network.lock held by {_plock.read_holder()}", flush=True)
        return
    _wlock = None
    if args.db:
        _wlock = joblock.pin_products_writer_lock(job="legacy-shop-the-look")
        if not _wlock.acquire():
            _plock.release()
            print(f"[stl] skipped — pin_products_writer.lock held by {_wlock.read_holder()}", flush=True)
            return

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        )
        ctx = await browser.new_context(
            viewport={"width": 1280, "height": 900},
            locale="en-US",
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()

        # Warm-up
        await page.goto("https://www.pinterest.com", wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(3)
        await page.evaluate("""() => {
            const sels = ['[data-test-id="fullPageSignupModal"]','[class*="SignupModal"]'];
            sels.forEach(s => document.querySelectorAll(s).forEach(e => e.remove()));
            document.body.style.overflow = '';
        }""")

        total_pins = len(home_pins)
        start_idx  = 1 if args.pin_file else args.start
        for i, pin in enumerate(home_pins, start_idx):
            print(f"\n[{i}/{total_pins}] pin={pin['pin_id']}  "
                  f"save={pin.get('save_count')}  {(pin.get('title') or '')[:40]}")
            prods = await scrape_pin_stl(page, pin)
            print(f"  -> {len(prods)} products found")
            for p in prods:
                p["source_pin_save_count"] = pin.get("save_count")
                p["seed_keyword"] = pin.get("seed_keyword")
                all_products.append(p)

            # Write per-pin to Supabase immediately (crash-safe)
            if args.db and prods:
                written = _upsert_products(prods)
                print(f"  [db] {written}/{len(prods)} products upserted")

        await ctx.close()

    # Pinterest navigation + pin_products writes complete — release shared locks.
    # (If an exception aborts the run above, the process exits and the lock is
    #  reclaimed as stale on the next run via PID-liveness detection.)
    if _wlock:
        _wlock.release()
    _plock.release()

    # Write JSONL — always append in pin-file mode; otherwise overwrite on fresh run
    write_mode = "a" if (args.pin_file or args.start > 1) else "w"
    with OUT_FILE.open(write_mode, encoding="utf-8") as fh:
        for p in all_products:
            fh.write(json.dumps(p, ensure_ascii=False, default=str) + "\n")
    print(f"\nSaved {len(all_products)} products -> {OUT_FILE} (mode={write_mode})")

    # Generate HTML from ALL products in the JSONL (not just this run)
    all_from_file = []
    if OUT_FILE.exists():
        for line in OUT_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                try:
                    all_from_file.append(json.loads(line))
                except Exception:
                    pass
    # Deduplicate by (product_pin_id or link)
    seen_keys: set[str] = set()
    deduped = []
    for p in all_from_file:
        k = p.get("product_pin_id") or p.get("link") or p.get("title")
        if k and k not in seen_keys:
            seen_keys.add(k)
            deduped.append(p)
    generate_html(deduped)
    print(f"Generated: {HTML_OUT} ({len(deduped)} total products)")
    if args.db:
        print(f"[db] All products written to Supabase pin_products during run")
    if args.open:
        import webbrowser
        webbrowser.open(HTML_OUT.as_uri())


def generate_html(products: list[dict]):
    def fmt(n):
        if not n:
            return "0"
        n = int(n)
        if n >= 10000:
            return f"{n//1000}k"
        if n >= 1000:
            return f"{n/1000:.1f}k"
        return str(n)

    cards_html = []
    for p in products:
        img    = p.get("image_url", "")
        title  = p.get("title", "(无标题)").replace('"', "&quot;")
        price  = p.get("price", "")
        link   = p.get("link", "#") or "#"
        domain = p.get("domain", "")
        saves  = fmt(p.get("save_count", 0))
        reacts = fmt(p.get("reaction_count", 0))
        kw     = p.get("seed_keyword", "")
        src_sv = fmt(p.get("source_pin_save_count", 0))
        parent = p.get("parent_pin_id", "")
        pin_pg = f"https://www.pinterest.com/pin/{parent}/" if parent else "#"

        img_tag = f'<img src="{img}" alt="" loading="lazy" onerror="this.style.display=\'none\'">' if img else ""
        price_tag = f'<span class="price">{price}</span>' if price else ""

        cards_html.append(f"""
<div class="card" onclick="window.open('{link}','_blank')">
  {img_tag}
  <div class="body">
    <div class="title">{title}</div>
    <div class="meta">
      {price_tag}
      <span class="kw">{kw}</span>
    </div>
    <div class="stats">
      <span title="Product saves">&#128278; {saves}</span>
      <span title="Reactions">&#10084; {reacts}</span>
      <span title="Source pin saves">Pin: {src_sv}</span>
    </div>
    <div class="links">
      <a href="{link}" target="_blank" onclick="event.stopPropagation()">商品链接</a>
      <a href="{pin_pg}" target="_blank" onclick="event.stopPropagation()">来源 Pin</a>
    </div>
    <div class="domain">{domain}</div>
  </div>
</div>""")

    html = f"""<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shop the Look — Home</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f7f7;color:#333}}
.bar{{position:sticky;top:0;z-index:100;background:#fff;border-bottom:1px solid #ddd;
      padding:12px 20px;display:flex;align-items:center;gap:14px}}
.bar h1{{font-size:17px;font-weight:700;color:#e60023}}
.bar span{{font-size:13px;color:#888}}
#grid{{column-count:5;column-gap:12px;padding:16px 20px}}
@media(max-width:1400px){{#grid{{column-count:4}}}}
@media(max-width:1100px){{#grid{{column-count:3}}}}
@media(max-width:750px){{#grid{{column-count:2}}}}
.card{{break-inside:avoid;margin-bottom:12px;background:#fff;border-radius:12px;
       overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);cursor:pointer;
       transition:transform .15s,box-shadow .15s}}
.card:hover{{transform:translateY(-3px);box-shadow:0 6px 16px rgba(0,0,0,.14)}}
.card img{{width:100%;display:block;background:#eee}}
.body{{padding:10px 12px 12px}}
.title{{font-size:13px;font-weight:600;line-height:1.4;max-height:2.8em;overflow:hidden;margin-bottom:5px}}
.meta{{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px;align-items:center}}
.price{{font-size:14px;font-weight:700;color:#e60023}}
.kw{{font-size:11px;padding:2px 8px;border-radius:10px;background:#f5f5f5;color:#555}}
.stats{{display:flex;gap:10px;font-size:11px;color:#666;margin-bottom:6px}}
.links{{display:flex;gap:6px}}
.links a{{font-size:11px;padding:2px 10px;border-radius:10px;text-decoration:none;font-weight:500}}
.links a:first-child{{background:#fff0f0;color:#e60023}}
.links a:last-child{{background:#f5f5f5;color:#555}}
.domain{{font-size:11px;color:#aaa;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.empty{{text-align:center;padding:80px 20px;color:#aaa;font-size:16px}}
</style>
</head>
<body>
<div class="bar">
  <h1>Shop the Look — Home</h1>
  <span>{len(products)} products  (save_count &gt; {STL_MIN_SAVES})</span>
</div>
{"".join(cards_html) and f'<div id="grid">{"".join(cards_html)}</div>' or '<p class="empty">暂未找到商品数据，请先运行爬虫采集。</p>'}
</body>
</html>"""

    HTML_OUT.write_text(html, encoding="utf-8")


if __name__ == "__main__":
    # Propagate main()'s return code as the process exit code so the retired-writer
    # guard (return 2) and dry-run preflight codes surface to callers / schedulers.
    raise SystemExit(asyncio.run(main()))
