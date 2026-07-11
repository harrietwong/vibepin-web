"""
digital_product_scraper.py — Pinterest digital product signal collector

Searches Pinterest for digital-product keywords and extracts pins that link to
digital platforms (TPT, Payhip, Gumroad, Creative Market, Creative Fabrica,
and Etsy digital listings). Results go directly into pin_products.

Unlike shop_the_look.py (which reads Pinterest's Shop The Look product cards from
viral physical-product pins), this scraper targets content creators who link their
digital products from Pinterest pins — the primary distribution channel for
printables, templates, planners, and worksheets.

Pipeline integration:
  py pipeline.py --step digital           # run digital collection
  py pipeline.py --step digital --group planners templates

Standalone:
  py digital_product_scraper.py --dry-run              # preview, no DB write
  py digital_product_scraper.py --db                   # full run, all groups
  py digital_product_scraper.py --db --group planners  # one group only
  py digital_product_scraper.py --list-groups          # show all keyword groups
"""

import argparse
import asyncio
import hashlib
import random
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent

# ── ANSI colors ────────────────────────────────────────────────────────────────
G = "\033[92m"; Y = "\033[93m"; C = "\033[96m"; R = "\033[91m"; X = "\033[0m"
def _ok(m):   print(f"{G}  ✓  {m}{X}")
def _info(m): print(f"{C}  ·  {m}{X}")
def _warn(m): print(f"{Y}  !  {m}{X}")
def _err(m):  print(f"{R}  ✗  {m}{X}")

# ── Keyword groups ─────────────────────────────────────────────────────────────
# Each group targets one digital product category. Keywords are Pinterest-idiomatic:
# they mirror what creators and shoppers search when looking for digital products.

KEYWORD_GROUPS: dict[str, list[str]] = {
    "planners": [
        "daily planner printable",
        "weekly planner printable free",
        "budget planner printable",
        "meal planner printable",
        "habit tracker printable",
        "adhd planner printable",
        "digital planner ipad",
    ],
    "templates": [
        "canva template free",
        "notion template aesthetic",
        "resume template canva",
        "social media template canva",
        "instagram post template canva",
        "business card template canva",
        "etsy shop template canva",
    ],
    "worksheets": [
        "classroom printable worksheet",
        "homeschool printable worksheet",
        "kids activity printable",
        "teachers pay teachers printable",
        "reading comprehension worksheet printable",
        "math worksheet printable free",
    ],
    "trackers": [
        "expense tracker printable",
        "debt payoff tracker printable",
        "savings challenge printable",
        "budget worksheet printable",
        "notion budget template free",
        "monthly spending tracker printable",
    ],
    "wall_art": [
        "printable wall art free",
        "downloadable art print etsy",
        "digital art print boho",
        "motivational quote printable",
        "nursery printable art",
    ],
    "kids_education": [
        "chore chart printable kids",
        "morning routine chart printable",
        "reward chart printable free",
        "potty training chart printable",
        "preschool printable activity",
        "abc printable worksheet kids",
    ],
    "business": [
        "client intake form canva",
        "invoice template canva free",
        "brand kit template canva",
        "photography contract template canva",
        "small business planner printable",
    ],
    "crafts_svg": [
        "svg cut file cricut free",
        "clipart digital download",
        "digital sticker pack printable",
        "watercolor clipart digital",
        "procreate stamp brush free",
    ],
}

# ── Digital platform detection ─────────────────────────────────────────────────

# Domains that sell exclusively or primarily digital products
DIGITAL_ONLY_DOMAINS = {
    "teacherspayteachers.com", "tpt.com",
    "payhip.com",
    "gumroad.com",
    "creativemarket.com",
    "creativefabrica.com",
    "ko-fi.com",
    "selz.com",
    "sendowl.com",
    "teachers.net",
    "tes.com",
    "teachermade.com",
}

# Etsy sells both physical and digital — require URL or title confirmation
ETSY_DOMAINS = {"etsy.com"}

# URL path fragments that suggest an Etsy listing is digital
ETSY_DIGITAL_URL_TOKENS = [
    "digital", "instant-download", "printable", "template",
    "svg", "pdf", "clipart", "download",
]

# Title/description tokens that confirm digital intent
DIGITAL_TITLE_TOKENS = [
    "printable", "printables",
    "template", "templates",
    "worksheet", "worksheets",
    "planner",
    "tracker",
    "checklist",
    "spreadsheet",
    "notion",
    "canva",
    "editable",
    "instant download",
    "digital download",
    "download",
    "pdf",
    "svg",
    "clipart",
    "ebook",
    "guide",
    "workbook",
    "sticker",
    "invitation",
    "art print",
    "wall art",
    "tpt",
    "teachers pay teachers",
    "payhip",
    "gumroad",
    "creative market",
    "creative fabrica",
]

# Minimum saves for digital pins (much lower than physical 500+ threshold)
# Digital product pins rarely go viral but still carry strong intent signal
MIN_DIGITAL_SAVES = 20


def _get_domain(url: str) -> str:
    if not url:
        return ""
    try:
        return urlparse(url).netloc.lower().removeprefix("www.")
    except Exception:
        return ""


def _is_digital(outbound: str | None, title: str) -> tuple[bool, str]:
    """
    Classify a pin as digital or not. Returns (is_digital, reason).
    Checks: outbound domain, outbound URL path, pin title.
    """
    title_l = (title or "").lower()

    if not outbound:
        token = next((t for t in DIGITAL_TITLE_TOKENS if t in title_l), None)
        if token:
            return True, f"title_only:{token}"
        return False, "no_link_no_title_token"

    domain  = _get_domain(outbound)
    url_l   = outbound.lower()

    # 1. Known digital-only platform
    d_match = next((d for d in DIGITAL_ONLY_DOMAINS if domain == d or domain.endswith("." + d)), None)
    if d_match:
        return True, f"platform:{d_match}"

    # 2. Etsy — require URL path token OR title token
    if any(domain == ed or domain.endswith("." + ed) for ed in ETSY_DOMAINS):
        url_token   = next((t for t in ETSY_DIGITAL_URL_TOKENS if t in url_l), None)
        title_token = next((t for t in DIGITAL_TITLE_TOKENS    if t in title_l), None)
        if url_token:   return True,  f"etsy_url:{url_token}"
        if title_token: return True,  f"etsy_title:{title_token}"
        return False, "etsy_physical"

    # 3. Any domain — title token catch-all
    token = next((t for t in DIGITAL_TITLE_TOKENS if t in title_l), None)
    if token:
        return True, f"title:{token}"

    return False, f"no_signal:{domain or 'no_domain'}"


def _extract_pin_fields(pin: dict) -> dict:
    """Extract normalized fields from a raw Pinterest API pin object."""
    # Image
    images = pin.get("images") or {}
    image_url = None
    for size in ("orig", "originals", "736x", "564x", "474x"):
        img = images.get(size) or {}
        if isinstance(img, dict):
            image_url = img.get("url")
            if image_url:
                break
    if not image_url:
        image_url = pin.get("image_url") or ""

    # Outbound link
    outbound = None
    for key in ("link", "outbound_link", "product_url"):
        v = pin.get(key)
        if isinstance(v, str) and v.startswith("http") and "pinterest.com" not in v:
            outbound = v
            break

    # Title (try multiple fields)
    title = (pin.get("title") or pin.get("grid_title") or
             pin.get("closeup_description") or "").strip()[:500]

    save_count = int(pin.get("save_count") or pin.get("saves") or
                     pin.get("repin_count") or 0)

    pin_id = str(pin.get("id") or pin.get("pin_id") or "")

    return {
        "pin_id":    pin_id,
        "title":     title,
        "outbound":  outbound,
        "image_url": image_url,
        "saves":     save_count,
        "domain":    _get_domain(outbound) if outbound else None,
    }


def _build_pin_sample_row(fields: dict, keyword: str) -> dict | None:
    """Build a pin_samples row so Viral Pins page can show digital pins."""
    pin_id = fields.get("pin_id") or ""
    if not pin_id:
        return None
    from datetime import datetime, timezone
    return {
        "pin_id":        pin_id,
        "category":      "digital-products",
        "title":         fields["title"],
        "image_url":     fields["image_url"],
        "outbound_link": fields["outbound"],
        "save_count":    fields["saves"],
        "seed_keyword":  keyword,
        "source_keyword": keyword,
        "is_ecommerce":  bool(fields["outbound"]),
        "source_type":   "digital_scraper",
        "scraped_at":    datetime.now(timezone.utc).isoformat(),
    }


def _build_product_row(fields: dict, keyword: str) -> dict:
    """Map extracted pin fields to the pin_products DB schema."""
    domain = fields["domain"] or ""
    outbound = fields["outbound"]
    pin_id   = fields["pin_id"]

    # Stable dedup key for on_conflict resolution
    dedup_source = outbound or f"pin:{pin_id}"
    url_hash = hashlib.md5(dedup_source.encode()).hexdigest()

    merchant = domain.split(".")[0].title() if domain else None

    return {
        "parent_pin_id":           pin_id,
        "product_name":            fields["title"],
        "price":                   None,
        "currency":                "USD",
        "source_url":              outbound,
        "domain":                  domain or None,
        "merchant":                merchant,
        "image_url":               fields["image_url"],
        "save_count":              fields["saves"],
        "reaction_count":          0,
        "source_pin_save_count":   fields["saves"],
        "seed_keyword":            keyword,
        "canonical_product_url":   outbound,
        "product_url_hash":        url_hash,
        "normalized_merchant":     merchant,
        "normalized_product_name": fields["title"].lower()[:500] if fields["title"] else None,
    }


# ── Per-keyword scrape ─────────────────────────────────────────────────────────

async def scrape_keyword(
    session,
    keyword: str,
    max_pins:  int  = 100,
    min_saves: int  = MIN_DIGITAL_SAVES,
    verbose:   bool = False,
) -> tuple[list[dict], list[dict]]:
    """Returns (product_rows, pin_sample_rows)."""
    from scraper_v2 import find_pins  # type: ignore

    _info(f"  searching: {keyword!r}")
    try:
        raw_pins = await session.search_pins(query=keyword, max_pins=max_pins)
    except Exception as exc:
        _warn(f"  search failed: {exc}")
        return [], []

    _info(f"  {len(raw_pins)} raw pins")

    products: list[dict] = []
    samples:  list[dict] = []
    n_skip_saves = n_skip_dig = n_ok = 0

    for pin in raw_pins:
        f = _extract_pin_fields(pin)

        # Save count filter
        if f["saves"] < min_saves:
            n_skip_saves += 1
            continue

        is_dig, reason = _is_digital(f["outbound"], f["title"])

        if verbose:
            flag = G + "✓" + X if is_dig else R + "✗" + X
            print(f"    {flag} saves={f['saves']:>5}  [{reason:<30}]  {f['title'][:45]}")

        if not is_dig:
            n_skip_dig += 1
            continue

        row = _build_product_row(f, keyword)
        if row["product_name"] or row["source_url"]:
            products.append(row)
            n_ok += 1

        # Also build pin_sample row for Viral Pins page
        sample = _build_pin_sample_row(f, keyword)
        if sample:
            samples.append(sample)

    _ok(f"  → {n_ok} digital  |  skipped: {n_skip_saves} low-saves  {n_skip_dig} non-digital")
    return products, samples


# ── Main run ───────────────────────────────────────────────────────────────────

async def run_scrape(
    groups:    list[str] | None = None,
    max_pins:  int  = 100,
    min_saves: int  = MIN_DIGITAL_SAVES,
    write_db:  bool = False,
    verbose:   bool = False,
    dry_run:   bool = False,
) -> dict[str, int]:
    """
    Public entry point (called by pipeline.py or directly).
    Returns stats dict.
    """
    from scraper_v2 import PinterestSession  # type: ignore

    target_groups = groups or list(KEYWORD_GROUPS.keys())
    kw_list: list[tuple[str, str]] = []
    for g in target_groups:
        if g not in KEYWORD_GROUPS:
            _warn(f"unknown group {g!r}  known: {list(KEYWORD_GROUPS)}")
            continue
        for kw in KEYWORD_GROUPS[g]:
            kw_list.append((kw, g))

    if not kw_list:
        _err("no keywords to process")
        return {}

    _info(f"groups:     {target_groups}")
    _info(f"keywords:   {len(kw_list)}")
    _info(f"max_pins:   {max_pins} per keyword")
    _info(f"min_saves:  {min_saves}")
    _info(f"write_db:   {write_db}")

    all_products: list[dict] = []
    all_samples:  list[dict] = []
    stats: dict[str, int] = {
        "keywords": 0, "digital_found": 0, "written_products": 0, "written_samples": 0,
    }

    async with PinterestSession(delay=1.5) as session:
        for keyword, group in kw_list:
            await asyncio.sleep(random.uniform(1.2, 2.5))
            products, samples = await scrape_keyword(
                session, keyword,
                max_pins=max_pins,
                min_saves=min_saves,
                verbose=verbose,
            )
            all_products.extend(products)
            all_samples.extend(samples)
            stats["keywords"]      += 1
            stats["digital_found"] += len(products)
            await asyncio.sleep(random.uniform(0.5, 1.0))

    print(f"\n{'─'*60}")
    _ok(f"Total digital product rows: {len(all_products)}")
    _ok(f"Total pin_sample rows:      {len(all_samples)}")

    if dry_run or not write_db:
        _info("Dry-run / no --db flag — not writing to DB")
        print("\nSample rows:")
        for row in all_products[:15]:
            d = row.get("domain") or ""
            s = row.get("save_count", 0)
            n = str(row.get("product_name", ""))[:55]
            print(f"  saves={s:>5}  [{d:<25}]  {n}")
        return stats

    written_p = _upsert_products(all_products)
    written_s = _upsert_pin_samples(all_samples)
    stats["written_products"] = written_p
    stats["written_samples"]  = written_s
    _ok(f"Written to pin_products: {written_p}")
    _ok(f"Written to pin_samples:  {written_s}")
    return stats


def _upsert_products(rows: list[dict]) -> int:
    """Upsert rows into Supabase pin_products. Returns written count."""
    if not rows:
        return 0
    sys.path.insert(0, str(ROOT / "db"))
    try:
        from db import upsert  # type: ignore
    except ImportError as exc:
        _err(f"cannot import db: {exc}")
        return 0

    # Intra-batch dedup on product_url_hash
    seen: set[str] = set()
    deduped: list[dict] = []
    for r in rows:
        h = r.get("product_url_hash") or ""
        if not h or h not in seen:
            if h:
                seen.add(h)
            deduped.append(r)

    _info(f"Dedup: {len(rows)} → {len(deduped)}")

    # Rows with both parent_pin_id + source_url use that conflict key
    keyed   = [r for r in deduped if r.get("parent_pin_id") and r.get("source_url")]
    # Rows with only parent_pin_id (no outbound link captured)
    pin_only = [r for r in deduped if r.get("parent_pin_id") and not r.get("source_url")]

    written = 0
    try:
        if keyed:
            result = upsert("pin_products", keyed, on_conflict="parent_pin_id,source_url")
            written += len(result)
            _info(f"  keyed upsert: {len(result)}")
        if pin_only:
            # Best-effort: use product_url_hash as conflict key
            try:
                result = upsert("pin_products", pin_only, on_conflict="product_url_hash")
                written += len(result)
                _info(f"  pin_only upsert: {len(result)}")
            except Exception as exc:
                _warn(f"  pin_only upsert skipped: {exc}")
    except Exception as exc:
        _err(f"upsert error: {exc}")
    return written


def _upsert_pin_samples(rows: list[dict]) -> int:
    """Upsert rows into pin_samples so Viral Pins page shows digital content."""
    if not rows:
        return 0
    sys.path.insert(0, str(ROOT / "db"))
    try:
        from db import upsert  # type: ignore
    except ImportError as exc:
        _err(f"cannot import db: {exc}")
        return 0

    # Dedup by pin_id within this batch
    seen: set[str] = set()
    deduped = []
    for r in rows:
        pid = r.get("pin_id") or ""
        if pid and pid not in seen:
            seen.add(pid)
            deduped.append(r)

    _info(f"pin_samples dedup: {len(rows)} → {len(deduped)}")
    try:
        result = upsert("pin_samples", deduped, on_conflict="pin_id")
        _info(f"  pin_samples upsert: {len(result)}")
        return len(result)
    except Exception as exc:
        _err(f"pin_samples upsert error: {exc}")
        return 0


# ── CLI ────────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(
        description="Scrape Pinterest digital product signals → pin_products"
    )
    ap.add_argument("--group", nargs="+", metavar="GROUP",
                    help="Keyword groups to run (default: all)")
    ap.add_argument("--limit",     type=int, default=100,
                    help="Max pins per keyword (default 100)")
    ap.add_argument("--min-saves", type=int, default=MIN_DIGITAL_SAVES,
                    help=f"Min save count (default {MIN_DIGITAL_SAVES})")
    ap.add_argument("--db",        action="store_true",
                    help="Write results to Supabase pin_products")
    ap.add_argument("--dry-run",   action="store_true",
                    help="Scan and preview, no DB write")
    ap.add_argument("--verbose",   action="store_true",
                    help="Print every pin's include/exclude decision")
    ap.add_argument("--list-groups", action="store_true",
                    help="List keyword groups and exit")
    args = ap.parse_args()

    if args.list_groups:
        print("Keyword groups:")
        for g, kws in KEYWORD_GROUPS.items():
            print(f"  {g:<20} ({len(kws)} keywords)")
            for kw in kws:
                print(f"    · {kw}")
        return

    asyncio.run(run_scrape(
        groups=args.group,
        max_pins=args.limit,
        min_saves=args.min_saves,
        write_db=args.db,
        verbose=args.verbose,
        dry_run=args.dry_run,
    ))


if __name__ == "__main__":
    main()
