"""product_related_pins.py — resolve REAL target Product Pin save counts.

Goal
----
For a source main Pin that has a Shop-the-Look / Shop-similar module, find each
product card's TARGET Product Pin (another Pinterest pin reached by clicking the
card), visit that pin, and read its real, current save count.

The verifiable metric stored is ``target_product_pin_save_count``. It is the save
count of the target Product Pin — Pin-level data, NOT SKU-level product saves.

Save parsing reuses ``scraper_v2.extract_save_count`` so main-Pin and Product-Pin
saves are parsed identically. This module does NOT define a second save parser.

Dry-run is the default: it navigates Pinterest and prints a validation table but
writes nothing. ``apply=True`` requires the confirm token and writes to
pin_products (UPDATE matching row, else INSERT a related-pin row). Apply needs the
v30 columns (migrate_v30_target_product_pin_saves.sql).
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).parent
LOG_DIR = ROOT / "logs"
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "db"))

from scraper_v2 import extract_save_count, extract_reaction_count, find_pins  # type: ignore

APPLY_CONFIRM_TOKEN = "APPLY_TARGET_PRODUCT_PIN_SAVES"

STL_TEXT = re.compile(r"shop the look|shop similar|more to shop|shop this|buyable", re.I)
SHOP_SIMILAR_TEXT = re.compile(r"shop[_ ]similar|more[_ ]like[_ ]this|similar[_ ]ideas", re.I)
SHOPPING_RESP_KEYS = ("/resource/", "shopping", "product", "catalog",
                      "shop_the_look", "visual_search", "VisualSearch")

# Signals that a JSON object is a shoppable product card carrying a Pinterest pin id.
PRODUCT_SIGNAL_KEYS = {
    "is_shoppable", "shopping_flags", "rich_metadata", "product_pin_data",
    "catalog_object", "is_eligible_for_pdp", "dominant_color",
}
URL_KEYS = ("link", "url", "product_url", "outbound_link", "click_url",
            "clickthrough_url", "destination_url")
TITLE_KEYS = ("grid_title", "title", "product_title", "name", "closeup_description",
              "description")
MERCHANT_KEYS = ("merchant_name", "merchant", "store_name", "seller_name", "brand_name", "brand")
PRICE_KEYS = ("price_value", "price", "formatted_price", "display_price", "current_price")
PIN_ID_RE = re.compile(r"^\d{6,25}$")


def _scalar(value: Any) -> str | None:
    if isinstance(value, (str, int, float)) and str(value).strip():
        return str(value).strip()
    if isinstance(value, dict):
        for key in ("value", "amount", "text", "label", "name", "url", "display"):
            nested = _scalar(value.get(key))
            if nested:
                return nested
    return None


def _first(obj: dict, keys: tuple[str, ...]) -> str | None:
    lower = {str(k).lower(): v for k, v in obj.items()}
    for key in keys:
        v = _scalar(lower.get(key))
        if v:
            return v
    return None


def _image_of(obj: dict) -> str | None:
    images = obj.get("images")
    if isinstance(images, dict):
        for key in ("736x", "474x", "orig", "600x", "236x", "200x"):
            node = images.get(key)
            if isinstance(node, dict) and node.get("url"):
                return node["url"]
        for node in images.values():
            v = _scalar(node)
            if v and v.startswith("http"):
                return v
    return _first(obj, ("image_url", "image", "thumbnail_url"))


def _outbound_of(obj: dict) -> str | None:
    for key in URL_KEYS:
        v = _scalar(obj.get(key))
        if v and v.startswith("http") and "pinterest." not in (urlparse(v).netloc or ""):
            return v
    co = obj.get("catalog_object")
    if isinstance(co, dict):
        return _scalar(co.get("url") or co.get("link"))
    return None


def discover_product_cards(payload: Any) -> list[dict]:
    """Walk a Pinterest shopping JSON response for product cards that carry a
    Pinterest target pin id. Returns dicts with target_product_pin_id +
    outbound/merchant/title/image/price hints. Discovery only — no save count
    here (that comes from visiting the target pin)."""
    out: list[dict] = []
    seen_ids: set[str] = set()

    def walk(node: Any, ctx: str = "") -> None:
        if isinstance(node, list):
            for item in node:
                walk(item, ctx)
            return
        if not isinstance(node, dict):
            return
        lower = {str(k).lower(): v for k, v in node.items()}
        pin_id = str(lower.get("id") or lower.get("pin_id") or "").strip()
        signal = bool(PRODUCT_SIGNAL_KEYS & set(lower)) or "product" in ctx or "shop" in ctx
        if pin_id and PIN_ID_RE.match(pin_id) and signal and pin_id not in seen_ids:
            # Heuristic section: "shop similar" context vs default shop-the-look.
            section = "shop_similar" if SHOP_SIMILAR_TEXT.search(ctx) else "shop_the_look"
            out.append({
                "target_product_pin_id": pin_id,
                "outbound_url": _outbound_of(node),
                "product_title": _first(node, TITLE_KEYS),
                "image_url": _image_of(node),
                "price": _first(node, PRICE_KEYS),
                "merchant": _first(node, MERCHANT_KEYS),
                "section_type": section,
            })
            seen_ids.add(pin_id)
        for key, value in node.items():
            if isinstance(value, (dict, list)):
                walk(value, (ctx + " " + str(key)).lower()[-200:])

    walk(payload)
    return out


def _retailer_from(url: str | None, merchant: str | None) -> str | None:
    if merchant:
        return merchant
    if url:
        try:
            return urlparse(url).netloc or None
        except Exception:
            return None
    return None


async def _capture_json(page, state: dict, *, only_shopping: bool) -> None:
    """Attach a response listener that collects JSON payloads into state['json']."""
    async def on_resp(resp):
        try:
            url = resp.url
            if "pinterest.com" not in url:
                return
            if only_shopping and not any(k in url for k in SHOPPING_RESP_KEYS):
                return
            ctype = (resp.headers or {}).get("content-type", "")
            if "json" not in ctype:
                return
            body = await resp.json()
            state["json"].append(body)
        except Exception:
            return
    state["_listener"] = on_resp
    page.on("response", lambda r: asyncio.create_task(on_resp(r)))


async def _dismiss_modals(page) -> None:
    try:
        await page.evaluate("""() => {
            const sels = ['[data-test-id="fullPageSignupModal"]','[class*="SignupModal"]',
                          '[data-test-id="login-modal"]','[aria-modal="true"]'];
            sels.forEach(s => document.querySelectorAll(s).forEach(e => e.remove()));
            document.body.style.overflow = '';
        }""")
    except Exception:
        pass


async def _resolve_target_pin(page, target_pin_id: str) -> dict:
    """Navigate to the target Product Pin closeup and parse its save count
    via the shared scraper_v2.extract_save_count. Returns a status dict."""
    url = f"https://www.pinterest.com/pin/{target_pin_id}/"
    state: dict = {"json": []}
    started = time.monotonic()
    await _capture_json(page, state, only_shopping=False)
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=20_000)
    except Exception as exc:
        await asyncio.sleep(2.0)
        return {"status": "goto_timeout", "error": str(exc)[:160],
                "url": url, "elapsedSec": round(time.monotonic() - started, 2)}
    page_url = (page.url or "").lower()
    if "/login" in page_url or "/signup" in page_url:
        return {"status": "login_wall", "error": None, "url": url,
                "elapsedSec": round(time.monotonic() - started, 2)}
    await asyncio.sleep(1.8)
    await _dismiss_modals(page)
    try:
        body_text = ((await page.locator("body").inner_text()) or "")[:6000].lower()
        if "captcha" in body_text or "verify you are human" in body_text:
            return {"status": "captcha", "error": None, "url": url,
                    "elapsedSec": round(time.monotonic() - started, 2)}
    except Exception:
        pass

    # Find the pin object matching this id within captured JSON and parse saves.
    best: dict | None = None
    for payload in state["json"]:
        for pin in find_pins(payload):
            pid = str(pin.get("id") or pin.get("pin_id") or "")
            if pid == target_pin_id:
                best = pin
                break
        if best:
            break
    if best is None:
        # Fallback: any pin object in the closeup payloads (the primary pin).
        for payload in state["json"]:
            pins = find_pins(payload)
            if pins:
                best = pins[0]
                break

    if best is None:
        return {"status": "saves_not_found", "error": "no_pin_object_in_payloads",
                "url": url, "elapsedSec": round(time.monotonic() - started, 2)}

    saves = extract_save_count(best)
    reactions = extract_reaction_count(best)
    title = _first(best, TITLE_KEYS)
    image = _image_of(best)
    return {
        "status": "ok",
        "error": None,
        "url": url,
        "target_product_pin_save_count": saves,
        "target_product_pin_reaction_count": reactions,
        "target_product_pin_title": title,
        "target_product_pin_image_url": image,
        "elapsedSec": round(time.monotonic() - started, 2),
    }


def select_source_pins(category: str, *, limit: int, min_saves: int = 1000) -> list[dict]:
    """Recent high-save pins in `category` with an image — candidate source pins."""
    from db import select_many  # type: ignore
    rows = select_many(
        "pin_samples",
        filters={"category": f"eq.{category}", "save_count": f"gte.{min_saves}",
                 "image_url": "not.is.null"},
        order="save_count.desc",
        limit=limit,
    ) or []
    return [{"pin_id": str(r.get("pin_id") or ""), "category": category,
             "save_count": int(r.get("save_count") or 0),
             "seed_keyword": r.get("source_keyword") or r.get("seed_keyword")}
            for r in rows if r.get("pin_id")]


async def _scan_source_pin(page, source: dict, *, related_per_pin: int) -> dict:
    pid = str(source.get("pin_id") or "")
    source_url = f"https://www.pinterest.com/pin/{pid}/"
    state: dict = {"json": []}
    started = time.monotonic()
    await _capture_json(page, state, only_shopping=True)
    try:
        await page.goto(source_url, wait_until="domcontentloaded", timeout=20_000)
    except Exception as exc:
        await asyncio.sleep(2.0)
        return {"source": source, "issue": f"goto_timeout:{str(exc)[:80]}", "cards": []}
    if any(x in (page.url or "").lower() for x in ("/login", "/signup")):
        return {"source": source, "issue": "login_wall", "cards": []}
    await asyncio.sleep(1.8)
    await _dismiss_modals(page)
    for _ in range(6):
        try:
            await page.mouse.wheel(0, 1800)
        except Exception:
            break
        await asyncio.sleep(0.6)
    # Try to open a Shop-the-Look / Shop-similar surface to trigger its XHR.
    for txt in ("Shop the look", "Shop similar", "More to shop"):
        try:
            btn = await page.query_selector(f"text={txt}")
            if btn:
                await btn.click(timeout=2500)
                await asyncio.sleep(1.5)
        except Exception:
            pass
    try:
        html = await page.content()
    except Exception:
        html = ""
    shop_detected = bool(STL_TEXT.search(html))

    cards: list[dict] = []
    seen: set[str] = set()
    for payload in state["json"]:
        for c in discover_product_cards(payload):
            tid = c["target_product_pin_id"]
            if tid and tid != pid and tid not in seen:
                seen.add(tid)
                cards.append(c)
    return {
        "source": source,
        "issue": None,
        "shopModuleDetected": shop_detected or bool(cards),
        "cards": cards[:related_per_pin],
        "elapsedSec": round(time.monotonic() - started, 2),
    }


def _write_row(row: dict) -> str:
    """Apply path: UPDATE matching pin_products row (parent+product_pin_id), else
    INSERT a new related-pin row. Returns 'updated' | 'inserted' | 'skipped'."""
    from db import select_many, update_where, insert_rows  # type: ignore
    parent = row.get("source_main_pin_id")
    tpid = row.get("target_product_pin_id")
    updates = {
        "target_product_pin_id":         tpid,
        "target_product_pin_url":        row.get("target_product_pin_url"),
        "target_product_pin_save_count": row.get("target_product_pin_save_count"),
        "target_product_pin_title":      row.get("target_product_pin_title"),
        "target_product_pin_image_url":  row.get("target_product_pin_image_url"),
        "section_type":                  row.get("section_type"),
        "item_index":                    row.get("item_index"),
        "extraction_status":             row.get("extraction_status"),
        "error_reason":                  row.get("error_reason"),
        "target_product_pin_scraped_at": row.get("target_product_pin_scraped_at"),
    }
    existing = select_many("pin_products",
                           filters={"parent_pin_id": f"eq.{parent}",
                                    "product_pin_id": f"eq.{tpid}"},
                           limit=1)
    if existing:
        update_where("pin_products", updates,
                     {"parent_pin_id": parent, "product_pin_id": tpid})
        return "updated"
    payload = {
        "parent_pin_id": parent,
        "product_pin_id": tpid,
        "product_name": (row.get("target_product_pin_title")
                         or row.get("product_title") or "Pinterest product pin")[:500],
        "source_url": row.get("outbound_url"),
        "domain": row.get("retailer"),
        "merchant": row.get("merchant"),
        "image_url": row.get("target_product_pin_image_url") or row.get("image_url"),
        "save_count": row.get("target_product_pin_save_count") or 0,
        "source_pin_save_count": row.get("source_main_pin_save_count") or 0,
        "seed_keyword": row.get("seed_keyword"),
        "discovery_method": "stl",
        **updates,
    }
    try:
        insert_rows("pin_products", [payload], on_conflict="product_pin_id")
        return "inserted"
    except Exception:
        return "skipped"


async def run(*, category: str, limit: int = 10, related_per_pin: int = 6,
              apply: bool = False, confirm: str | None = None) -> dict:
    """Resolve target Product Pin saves for `limit` source pins in `category`."""
    from playwright.async_api import async_playwright  # type: ignore

    if apply and confirm != APPLY_CONFIRM_TOKEN:
        raise ValueError(f"apply requires confirm={APPLY_CONFIRM_TOKEN!r}")

    sources = select_source_pins(category, limit=limit)
    rows: list[dict] = []
    stats = {
        "category": category, "sourcePinsScanned": 0, "sourcePinsWithShop": 0,
        "productCardsFound": 0, "targetUrlsExtracted": 0, "targetPinsResolved": 0,
        "saveCountsExtracted": 0, "failedCards": 0, "rowsWritten": 0,
        "failureReasons": {},
    }
    started = time.monotonic()

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        )
        context = await browser.new_context(
            viewport={"width": 1380, "height": 1700}, locale="en-US",
            user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
        )
        page = await context.new_page()
        try:
            await page.goto("https://www.pinterest.com", wait_until="domcontentloaded", timeout=30_000)
            await asyncio.sleep(1.2)
        except Exception:
            pass

        for s_idx, source in enumerate(sources, 1):
            scan = await _scan_source_pin(page, source, related_per_pin=related_per_pin)
            stats["sourcePinsScanned"] += 1
            if scan.get("issue"):
                stats["failureReasons"][scan["issue"].split(":")[0]] = \
                    stats["failureReasons"].get(scan["issue"].split(":")[0], 0) + 1
            if scan.get("shopModuleDetected"):
                stats["sourcePinsWithShop"] += 1
            cards = scan.get("cards", [])
            stats["productCardsFound"] += len(cards)
            print(f"[product-related-pins] {s_idx}/{len(sources)} source={source['pin_id']} "
                  f"shop={scan.get('shopModuleDetected', False)} cards={len(cards)} "
                  f"issue={scan.get('issue')}", flush=True)

            for c_idx, card in enumerate(cards):
                tid = card["target_product_pin_id"]
                stats["targetUrlsExtracted"] += 1
                resolved = await _resolve_target_pin(page, tid)
                status = resolved.get("status")
                if status == "ok":
                    stats["targetPinsResolved"] += 1
                    stats["saveCountsExtracted"] += 1
                else:
                    stats["failedCards"] += 1
                    stats["failureReasons"][status] = stats["failureReasons"].get(status, 0) + 1
                row = {
                    "source_main_pin_id": source["pin_id"],
                    "source_main_pin_url": f"https://www.pinterest.com/pin/{source['pin_id']}/",
                    "source_main_pin_save_count": source.get("save_count"),
                    "source_category": category,
                    "seed_keyword": source.get("seed_keyword"),
                    "item_index": c_idx,
                    "section_type": card.get("section_type"),
                    "target_product_pin_id": tid,
                    "target_product_pin_url": resolved.get("url"),
                    "target_product_pin_save_count": resolved.get("target_product_pin_save_count"),
                    "target_product_pin_title": resolved.get("target_product_pin_title") or card.get("product_title"),
                    "target_product_pin_image_url": resolved.get("target_product_pin_image_url") or card.get("image_url"),
                    "product_title": card.get("product_title"),
                    "price": card.get("price"),
                    "merchant": card.get("merchant"),
                    "retailer": _retailer_from(card.get("outbound_url"), card.get("merchant")),
                    "outbound_url": card.get("outbound_url"),
                    "extraction_status": status,
                    "error_reason": resolved.get("error"),
                    "target_product_pin_scraped_at": datetime.now(tz=timezone.utc).isoformat(),
                }
                rows.append(row)
                if apply and status == "ok":
                    result = _write_row(row)
                    if result in ("updated", "inserted"):
                        stats["rowsWritten"] += 1
        await browser.close()

    stats["elapsedSec"] = round(time.monotonic() - started, 2)
    report = {
        "mode": "apply" if apply else "dry-run",
        "job": "product-related-pins",
        "generatedAt": datetime.now(tz=timezone.utc).isoformat(),
        "stats": stats,
        "rows": rows,
    }
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(tz=timezone.utc).strftime("%Y%m%d_%H%M%S")
    path = LOG_DIR / f"product_related_pins_{category}_{stamp}.json"
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    report["reportPath"] = str(path)
    _print_table(rows)
    _print_summary(stats)
    return report


def _trunc(v: Any, n: int) -> str:
    s = "" if v is None else str(v)
    return s if len(s) <= n else s[: n - 1] + "…"


def _print_table(rows: list[dict]) -> None:
    print("\n=== Target Product Pin validation table ===")
    hdr = ("idx", "section", "target_pin_url", "tgt_pin_id", "saves",
           "title", "price", "merchant", "status")
    print(" | ".join(hdr))
    for r in rows:
        print(" | ".join((
            str(r.get("item_index")),
            _trunc(r.get("section_type"), 12),
            _trunc(r.get("target_product_pin_url"), 48),
            _trunc(r.get("target_product_pin_id"), 20),
            str(r.get("target_product_pin_save_count")),
            _trunc(r.get("target_product_pin_title"), 24),
            _trunc(r.get("price"), 10),
            _trunc(r.get("retailer") or r.get("merchant"), 16),
            _trunc(r.get("extraction_status"), 16),
        )))


def _print_summary(stats: dict) -> None:
    print("\n=== Summary ===")
    for k in ("category", "sourcePinsScanned", "sourcePinsWithShop", "productCardsFound",
              "targetUrlsExtracted", "targetPinsResolved", "saveCountsExtracted",
              "failedCards", "rowsWritten", "elapsedSec"):
        print(f"  {k}: {stats.get(k)}")
    if stats.get("failureReasons"):
        print(f"  failureReasons: {stats['failureReasons']}")
