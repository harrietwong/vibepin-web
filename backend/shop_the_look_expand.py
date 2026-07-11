"""Production-safe Shop-the-Look product supply expansion.

Dry-run is the default. Database writes require ``apply=True`` and the reviewed
v28 provenance migration. This module intentionally does not crawl related pins.

Primary extraction is Pinterest XHR JSON. DOM/card destinations are a fallback
and are recorded with a distinct extraction_method.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urljoin, urlsplit

ROOT = Path(__file__).parent
LOG_DIR = ROOT / "logs"
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "db"))

from db import select_many  # type: ignore
from product_harvest import (  # type: ignore
    BOOTSTRAP_SOURCES,
    accept_link,
    classify_link,
    get_domain,
    normalize_product_url,
    url_hash,
)

DEFAULT_CATEGORY_MIX = {
    "fashion": 18,
    "womens-fashion": 14,
    "home-decor": 18,
}
EXCLUDED_DEFAULT = frozenset({"beauty", "digital-products"})
DISCOVERY_METHOD = "stl"
DISCOVERY_DETAIL = "pinterest_product_card_bootstrap"
STL_TEXT = re.compile(r"shop the look|shop similar|more to shop|shop this|buyable", re.I)
COMMERCIAL_HINTS = re.compile(
    r"outfit|dress|shoe|bag|jewelry|jewellery|furniture|decor|rug|lamp|mirror|"
    r"bedding|curtain|product|shop|style|wear|room|home",
    re.I,
)
NETWORK_URL_RE = re.compile(r'https?://[^\s"\'<>\\]+')
PRODUCT_SIGNAL_KEYS = {
    "productpin", "product_pin", "price_value", "shopping_flags", "merchant",
    "merchant_name", "store", "store_name", "product_url", "producturl",
    "product_title", "product_image", "product_image_url", "is_shoppable",
    "buyable_product", "shoppingnagdata",
}
URL_KEYS = {
    "product_url", "producturl", "outbound_link", "link", "click_url",
    "clickthrough_url", "destination_url", "merchant_url", "url",
}
REDIRECT_KEYS = {"redirect_url", "redirecturl", "redirect_uri", "target_url"}
TITLE_KEYS = ("product_title", "title", "name", "display_name", "grid_title")
MERCHANT_KEYS = ("merchant_name", "merchant", "store_name", "store", "seller_name", "retailer")
IMAGE_KEYS = ("product_image_url", "image_url", "image", "product_image", "thumbnail_url")
PRICE_KEYS = ("price_value", "price", "formatted_price", "sale_price", "current_price")
CURRENCY_KEYS = ("currency", "currency_code", "price_currency")


def load_and_validate_source_report(
    path: str | Path,
    *,
    category_mix: dict[str, int],
    limit: int,
) -> tuple[list[dict], dict]:
    """Load source pins from an approved dry-run report.

    Fails closed if the report is missing, malformed, wrong engine, or if the
    source pin count or category distribution does not match the requested mix.
    Returns (sources, validation_meta).
    """
    report_path = Path(path)
    if not report_path.exists():
        raise FileNotFoundError(f"Source report not found: {report_path}")
    try:
        data = json.loads(report_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"Source report is not valid JSON: {exc}") from exc

    engine = data.get("engine")
    if engine != "shop-the-look":
        raise ValueError(
            f"Source report engine mismatch: expected 'shop-the-look', got {engine!r}"
        )
    if data.get("mode") == "apply":
        raise ValueError(
            "Source report was produced by --apply; must use a dry-run report to preserve audit trail"
        )

    per_pin = data.get("perPin") or []
    if not per_pin:
        raise ValueError("Source report has no perPin entries")

    sources: list[dict] = []
    category_counts: Counter = Counter()
    for entry in per_pin:
        pid = str(entry.get("sourcePinId") or "").strip()
        category = entry.get("category")
        save_count = int(entry.get("saveCount") or 0)
        if not pid:
            continue
        sources.append({"pin_id": pid, "category": category, "save_count": save_count})
        if category:
            category_counts[category] += 1

    if len(sources) != limit:
        raise ValueError(
            f"Source report has {len(sources)} pins, expected {limit} "
            f"(--limit {limit})"
        )

    mismatches: list[str] = []
    for cat, expected in category_mix.items():
        actual = category_counts.get(cat, 0)
        if actual != expected:
            mismatches.append(f"{cat}: got {actual}, expected {expected}")
    if mismatches:
        raise ValueError(
            f"Category distribution mismatch in source report: {'; '.join(mismatches)}"
        )

    pin_ids = [s["pin_id"] for s in sources]
    validation: dict = {
        "sourceReportPath": str(report_path),
        "sourceSetFrozen": True,
        "sourcePinIds": pin_ids,
        "categoryMixFromSourceReport": dict(category_counts),
        "sourceCountValidated": True,
        "sourceOverlap": 0,
        "reportEngine": engine,
        "reportMode": data.get("mode"),
    }
    return sources, validation


def _allowed_excluded() -> set[str]:
    """Excluded categories the operator has explicitly opted back in via
    VIBEPIN_STL_ALLOW_EXCLUDED="beauty,...". Empty by default → fail-closed, so
    the standard EXCLUDED_DEFAULT policy is unchanged unless deliberately overridden.
    Reversible: unset the env var and the category is blocked again."""
    raw = os.environ.get("VIBEPIN_STL_ALLOW_EXCLUDED", "")
    return {c.strip() for c in raw.split(",") if c.strip()}


def parse_category_mix(raw: str | None) -> dict[str, int]:
    if not raw:
        return dict(DEFAULT_CATEGORY_MIX)
    mix: dict[str, int] = {}
    for part in raw.split(","):
        category, sep, count = part.strip().partition(":")
        if not sep or not category:
            raise ValueError(f"Invalid category mix entry: {part!r}")
        value = int(count)
        if value < 0:
            raise ValueError("Category allocation cannot be negative")
        mix[category] = value
    effective_excluded = EXCLUDED_DEFAULT - _allowed_excluded()
    forbidden = effective_excluded & {c for c, n in mix.items() if n > 0}
    if forbidden:
        raise ValueError(f"Excluded categories require explicit opt-in (VIBEPIN_STL_ALLOW_EXCLUDED): {sorted(forbidden)}")
    return mix


def _load_previous_spike_ids() -> set[str]:
    path = LOG_DIR / "shop_the_look_spike.json"
    if not path.exists():
        return set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return {str(r.get("sourcePinId")) for r in data.get("perPin", []) if r.get("sourcePinId")}
    except Exception:
        return set()


def _selection_score(row: dict) -> tuple:
    text = f"{row.get('title') or ''} {row.get('description') or ''}"
    likely_shop = int(bool(row.get("is_ecommerce"))) + int(bool(COMMERCIAL_HINTS.search(text)))
    return (-likely_shop, -int(row.get("save_count") or 0), str(row.get("pin_id") or ""))


def _query_sources(category: str, cutoff: str, *, bootstrap_only: bool, limit: int) -> list[dict]:
    filters = {
        "category": f"eq.{category}",
        "scraped_at": f"gte.{cutoff}",
        "image_url": "not.is.null",
    }
    if bootstrap_only:
        filters["source_interest"] = "in.(" + ",".join(BOOTSTRAP_SOURCES) + ")"
    return select_many("pin_samples", filters=filters, order="save_count.desc", limit=limit) or []


def select_source_pins(
    *,
    category_mix: dict[str, int],
    since_hours: int = 168,
    avoid_pin_ids: set[str] | None = None,
) -> tuple[list[dict], dict]:
    """Select balanced recent high-save pins, preferring bootstrap rows."""
    cutoff = (datetime.now(tz=timezone.utc) - timedelta(hours=since_hours)).isoformat()
    avoid = set(avoid_pin_ids or set())
    selected: list[dict] = []
    selected_ids: set[str] = set()
    breakdown: dict[str, dict[str, int]] = {}

    for category, wanted in category_mix.items():
        if wanted <= 0:
            breakdown[category] = {"requested": wanted, "selected": 0, "bootstrap": 0, "recentFallback": 0, "overlap": 0}
            continue
        pool = _query_sources(category, cutoff, bootstrap_only=True, limit=max(100, wanted * 8))
        fallback = _query_sources(category, cutoff, bootstrap_only=False, limit=max(100, wanted * 8))
        pool.sort(key=_selection_score)
        fallback.sort(key=_selection_score)
        cat_rows: list[dict] = []
        bootstrap_count = fallback_count = overlap_count = 0

        def take(rows: list[dict], source_kind: str, allow_overlap: bool = False) -> None:
            nonlocal bootstrap_count, fallback_count, overlap_count
            for row in rows:
                if len(cat_rows) >= wanted:
                    break
                pid = str(row.get("pin_id") or "")
                if not pid or pid in selected_ids:
                    continue
                if pid in avoid and not allow_overlap:
                    continue
                cat_rows.append(row)
                selected_ids.add(pid)
                if source_kind == "bootstrap":
                    bootstrap_count += 1
                else:
                    fallback_count += 1
                if pid in avoid:
                    overlap_count += 1

        take(pool, "bootstrap")
        if len(cat_rows) < wanted:
            take(fallback, "recent")
        if len(cat_rows) < wanted:
            take(pool + fallback, "recent", allow_overlap=True)

        selected.extend(cat_rows)
        breakdown[category] = {
            "requested": wanted,
            "selected": len(cat_rows),
            "bootstrap": bootstrap_count,
            "recentFallback": fallback_count,
            "overlap": overlap_count,
            "shortfall": max(0, wanted - len(cat_rows)),
        }

    return selected, {
        "sinceHours": since_hours,
        "requestedTotal": sum(category_mix.values()),
        "selectedTotal": len(selected),
        "avoidedPriorSpikePins": len(avoid),
        "overlapWithPriorSpike": sum(v["overlap"] for v in breakdown.values()),
        "byCategory": breakdown,
    }


def _scalar(value: Any) -> str | None:
    if isinstance(value, (str, int, float)) and str(value).strip():
        return str(value).strip()
    if isinstance(value, dict):
        for key in ("value", "amount", "text", "label", "name", "url"):
            nested = _scalar(value.get(key))
            if nested:
                return nested
    return None


def _first_value(obj: dict, keys: tuple[str, ...]) -> str | None:
    lowered = {str(k).lower(): v for k, v in obj.items()}
    for key in keys:
        value = _scalar(lowered.get(key))
        if value:
            return value
    return None


def _image_value(obj: dict) -> str | None:
    direct = _first_value(obj, IMAGE_KEYS)
    if direct and direct.startswith("http"):
        return direct
    images = obj.get("images")
    if isinstance(images, dict):
        for item in images.values():
            value = _scalar(item)
            if value and value.startswith("http"):
                return value
    return None


def _external_url(value: Any) -> str | None:
    url = _scalar(value)
    if not url or not url.startswith("http"):
        return None
    domain = get_domain(url)
    if (not domain or domain.startswith("*.") or "pinterest." in domain
            or domain.endswith("pinimg.com")):
        return None
    return url


def extract_network_candidates(payload: Any, *, response_url: str = "", chip_label: str | None = None) -> list[dict]:
    """Recursively extract product-like objects from Pinterest JSON responses."""
    out: list[dict] = []

    def walk(node: Any, path: tuple[str, ...] = ()) -> None:
        if isinstance(node, list):
            for index, item in enumerate(node):
                walk(item, path + (str(index),))
            return
        if not isinstance(node, dict):
            return

        lower = {str(k).lower(): v for k, v in node.items()}
        context = " ".join(path).lower()
        signal = bool(PRODUCT_SIGNAL_KEYS & set(lower)) or "product" in context or "shopping" in context
        if signal:
            for key in URL_KEYS | REDIRECT_KEYS:
                url = _external_url(lower.get(key))
                if not url:
                    continue
                method = "redirect" if key in REDIRECT_KEYS else "network_json"
                out.append({
                    "product_url": url,
                    "product_title": _first_value(node, TITLE_KEYS),
                    "merchant": _first_value(node, MERCHANT_KEYS),
                    "image_url": _image_value(node),
                    "price": _first_value(node, PRICE_KEYS),
                    "currency": _first_value(node, CURRENCY_KEYS),
                    "extraction_method": method,
                    "chip_label": chip_label,
                    "response_url": response_url,
                    "json_path": ".".join(path + (key,))[-300:],
                })

        for key, value in node.items():
            if isinstance(value, (dict, list)):
                walk(value, path + (str(key),))

    walk(payload)
    # Pinterest sometimes embeds product destinations in opaque nested strings
    # rather than named product_url fields. This remains network JSON evidence;
    # accept_link performs the product-page gate later.
    try:
        blob = json.dumps(payload, ensure_ascii=False)
    except Exception:
        blob = ""
    seen_urls = {row.get("product_url") for row in out}
    for raw_url in NETWORK_URL_RE.findall(blob):
        url = raw_url.rstrip('\\",')
        path = urlsplit(url).path.lower()
        if path.endswith((".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif")):
            continue
        if url in seen_urls or not _external_url(url):
            continue
        seen_urls.add(url)
        out.append({
            "product_url": url,
            "product_title": None,
            "merchant": None,
            "image_url": None,
            "price": None,
            "currency": None,
            "extraction_method": "network_json",
            "chip_label": chip_label,
            "response_url": response_url,
            "json_path": "network_text_fallback",
        })
    return out


def _fallback_key(candidate: dict) -> str:
    payload = "|".join((
        str(candidate.get("product_title") or "").strip().lower(),
        str(candidate.get("merchant") or "").strip().lower(),
        str(candidate.get("image_url") or "").strip().lower(),
    ))
    return "fallback:" + hashlib.sha1(payload.encode("utf-8")).hexdigest()


def _dedup_key(candidate: dict) -> str:
    normalized = normalize_product_url(candidate.get("product_url") or "")
    return "url:" + url_hash(normalized) if normalized else _fallback_key(candidate)


def _prepare_candidate(candidate: dict, source: dict, *, index: int, shop_detected: bool, shop_tab_clicked: bool) -> dict:
    url = candidate.get("product_url") or ""
    normalized = normalize_product_url(url)
    title = (candidate.get("product_title") or "").strip()
    merchant = (candidate.get("merchant") or "").strip()
    classification = classify_link(url, title or None) if url else {
        "domain": "", "source_platform": "unknown", "product_type": None,
        "type_bucket": "unknown", "digital_format": None, "confidence": 0,
        "is_mockup_like": False,
    }
    merchant_source = "network_json" if merchant else "domain_fallback"
    merchant = merchant or classification.get("source_platform") or classification.get("domain") or get_domain(url)
    return {
        "source_pin_id": str(source.get("pin_id") or ""),
        "source_pin_url": f"https://www.pinterest.com/pin/{source.get('pin_id')}/",
        "source_category": source.get("category"),
        "source_pin_save_count": int(source.get("save_count") or 0),
        "product_title": title or None,
        "merchant": merchant or None,
        "merchant_source": merchant_source,
        "product_url": url or None,
        "normalized_product_url": normalized or None,
        "normalized_product_url_hash": url_hash(normalized) if normalized else None,
        "image_url": candidate.get("image_url"),
        "price": candidate.get("price"),
        "currency": candidate.get("currency"),
        "platform": classification.get("source_platform"),
        "domain": classification.get("domain") or get_domain(url),
        "product_type": classification.get("product_type"),
        "digital_format": classification.get("digital_format"),
        "extraction_method": candidate.get("extraction_method") or "network_json",
        "shop_module_detected": bool(shop_detected),
        "product_card_index": index,
        "shop_tab_clicked": bool(shop_tab_clicked),
        "chip_label": candidate.get("chip_label"),
        "discovery_method": DISCOVERY_METHOD,
        "discovery_method_detail": DISCOVERY_DETAIL,
        "discovery_depth": 0,
        "discovery_path": f"{source.get('pin_id')} -> product_card[{index}] -> {normalized or 'missing_url'}",
    }


async def _extract_source_pin(page, source: dict, state: dict) -> dict:
    pid = str(source.get("pin_id") or "")
    source_url = f"https://www.pinterest.com/pin/{pid}/"
    state["pin_id"] = pid
    state["chip_label"] = None
    state["network"] = []
    issue = None
    shop_tab_clicked = False
    chip_labels: list[str] = []
    started = time.monotonic()

    try:
        await page.goto(source_url, wait_until="domcontentloaded", timeout=15_000)
    except Exception as exc:
        # Pause after a navigation failure to avoid rapid-fire retries against a
        # throttling Pinterest CDN. Does not retry — just paces the next pin.
        await asyncio.sleep(3.0)
        return {"source": source, "issue": f"goto_timeout:{str(exc)[:100]}", "candidates": [], "elapsedSec": round(time.monotonic()-started, 2)}

    page_url = page.url.lower()
    if "/login" in page_url or "/signup" in page_url:
        return {"source": source, "issue": "login_wall", "candidates": [], "elapsedSec": round(time.monotonic()-started, 2)}
    await asyncio.sleep(2.2)
    try:
        body_text = ((await page.locator("body").inner_text()) or "")[:10_000].lower()
        if "captcha" in body_text or "verify you are human" in body_text:
            return {"source": source, "issue": "captcha", "candidates": [], "elapsedSec": round(time.monotonic()-started, 2)}
    except Exception:
        body_text = ""
    try:
        await page.evaluate("""() => { document.querySelectorAll('[data-test-id*=Signup i],[class*=SignupModal],[aria-modal=true]').forEach(e=>e.remove()); document.body.style.overflow=''; }""")
    except Exception:
        pass
    for _ in range(5):
        await page.mouse.wheel(0, 2200)
        await asyncio.sleep(0.8)

    try:
        html = await page.content()
    except Exception:
        html = ""
    shop_detected = bool(STL_TEXT.search(html))

    try:
        tabs = await page.query_selector_all('[data-test-id="shopping-tab"], [data-test-id*="shopping-tab" i], [role="tab"]')
        for tab in tabs[:10]:
            try:
                label = ((await tab.inner_text()) or "").strip()[:80]
            except Exception:
                label = ""
            state["chip_label"] = label or None
            if label:
                chip_labels.append(label)
            try:
                await tab.click(timeout=2500)
                shop_tab_clicked = True
                await asyncio.sleep(1.0)
            except Exception:
                continue
    except Exception:
        pass
    state["chip_label"] = None
    await asyncio.sleep(1.0)

    try:
        dom_cards = await page.evaluate(r"""() => {
          const nodes = Array.from(document.querySelectorAll(
            '[data-test-id*="product" i], [data-test-id*="shop" i], [data-test-id*="lockup" i]'
          )).slice(0, 100);
          return nodes.map((n, index) => {
            const a = n.querySelector('a[href]') || (n.tagName === 'A' ? n : null);
            const img = n.querySelector('img[src]');
            const text = (n.getAttribute('aria-label') || n.title || n.innerText || '').trim().slice(0, 500);
            const price = (text.match(/(?:[$£€¥]|USD|GBP|EUR)\s?\d[\d,.]*/) || [null])[0];
            return {index, href: a ? a.href : null, title: text || null,
                    image_url: img ? img.src : null, price};
          });
        }""")
    except Exception:
        dom_cards = []

    raw_candidates = list(state.get("network") or [])
    for card in dom_cards:
        href = card.get("href")
        if href:
            href = urljoin(page.url, href)
        if _external_url(href):
            raw_candidates.append({
                "product_url": href,
                "product_title": card.get("title"),
                "merchant": None,
                "image_url": card.get("image_url"),
                "price": card.get("price"),
                "currency": None,
                "extraction_method": "product_card_click",
                "chip_label": None,
            })

    prepared = [
        _prepare_candidate(c, source, index=i, shop_detected=shop_detected or bool(state.get("network")), shop_tab_clicked=shop_tab_clicked)
        for i, c in enumerate(raw_candidates)
    ]
    return {
        "source": source,
        "issue": issue,
        "shopModuleDetected": shop_detected or bool(state.get("network")),
        "shopTabClicked": shop_tab_clicked,
        "chipLabels": sorted(set(chip_labels)),
        "visibleCardCount": len(dom_cards),
        "candidates": prepared,
        "elapsedSec": round(time.monotonic() - started, 2),
    }


def _previous_spike_delta() -> dict:
    path = LOG_DIR / "shop_the_look_spike.json"
    if not path.exists():
        return {"reportFound": False}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"reportFound": False, "error": "invalid_json"}
    rejected = [r for pin in data.get("perPin", []) for r in pin.get("rejectedLinks", [])]
    newly = []
    for item in rejected:
        ok, reason = accept_link(item.get("url") or "")
        if ok:
            newly.append({"url": item.get("url"), "domain": get_domain(item.get("url") or ""), "reason": reason})
    return {
        "reportFound": True,
        "baselineAccepted": (data.get("aggregate") or {}).get("acceptedProductLinks"),
        "baselineRejected": len(rejected),
        "newlyAcceptedFromPriorRejects": len(newly),
        "newlyAcceptedByDomain": dict(Counter(x["domain"] for x in newly)),
        "sample": newly[:10],
    }


V28_REQUIRED_COLUMNS = (
    "discovery_method_detail",
    "source_category",
    "seed_keyword",
    "normalized_product_url_hash",
)


def _check_v28_schema() -> tuple[bool, list[str]]:
    """Verify every v28 column required for STL bootstrap apply exists in pin_products.

    Uses PostgREST filter params — if a column is absent the API returns 400.
    Returns (all_present: bool, missing_columns: list[str]).

    Note: cannot verify the unique index on normalized_product_url_hash via
    PostgREST. Column existence is a necessary but not sufficient pre-condition;
    the unique index must also exist before apply (part of v28).
    """
    missing: list[str] = []
    for col in V28_REQUIRED_COLUMNS:
        try:
            select_many("pin_products", filters={col: "is.null"}, limit=0)
        except RuntimeError as exc:
            err = str(exc)
            if ("does not exist" in err or "column" in err.lower()
                    or "[400]" in err or "[404]" in err):
                missing.append(col)
            else:
                # Network or auth error — re-raise; don't silently pass
                raise
        except Exception:
            missing.append(col)
    return len(missing) == 0, missing


def _preflight_existing(unique: list[dict]) -> dict:
    """Query DB for existing rows by normalized_product_url_hash (read-only).

    Returns projected insert/skip counts and the filtered insert-only candidate
    list under key 'insertCandidates'. projectedUpdateCount is always 0 — the
    apply path is insert-only; existing rows are skipped, never updated.
    """
    hashes = [c["normalized_product_url_hash"] for c in unique
               if c.get("normalized_product_url_hash")]
    if not hashes:
        return {
            "projectedInsertCount": len(unique),
            "projectedSkipExistingCount": 0,
            "projectedUpdateCount": 0,
            "legacyTouchedProjected": 0,
            "conflictKeysChecked": ["normalized_product_url_hash"],
            "skippedDuplicateExamples": [],
            "insertCandidates": unique,
            "checked": False,
            "reason": "no_hashes_available",
        }

    existing_hashes: set[str] = set()
    try:
        batch_size = 400
        for i in range(0, len(hashes), batch_size):
            batch = hashes[i : i + batch_size]
            rows = select_many(
                "pin_products",
                filters={"normalized_product_url_hash": f"in.({','.join(batch)})"},
                limit=len(batch) + 10,
            ) or []
            for r in rows:
                h = r.get("normalized_product_url_hash")
                if h:
                    existing_hashes.add(str(h))
    except Exception as exc:
        return {
            "projectedInsertCount": len(unique),
            "projectedSkipExistingCount": 0,
            "projectedUpdateCount": 0,
            "legacyTouchedProjected": 0,
            "conflictKeysChecked": ["normalized_product_url_hash"],
            "skippedDuplicateExamples": [],
            "insertCandidates": unique,
            "checked": False,
            "error": str(exc)[:300],
        }

    skips: list[dict] = []
    inserts: list[dict] = []
    for c in unique:
        h = c.get("normalized_product_url_hash")
        if h and str(h) in existing_hashes:
            skips.append(c)
        else:
            inserts.append(c)

    return {
        "projectedInsertCount": len(inserts),
        "projectedSkipExistingCount": len(skips),
        "projectedUpdateCount": 0,
        "legacyTouchedProjected": 0,
        "conflictKeysChecked": ["normalized_product_url_hash"],
        "skippedDuplicateExamples": [
            {
                "hash": c.get("normalized_product_url_hash"),
                "url": c.get("product_url"),
                "sourcePin": c.get("source_pin_id"),
            }
            for c in skips[:5]
        ],
        "insertCandidates": inserts,
        "checked": True,
        "existingHashMatches": len(existing_hashes),
    }


def _build_report(
    per_pin: list[dict],
    selection: dict,
    *,
    elapsed: float,
    apply: bool,
    source_report_validation: dict | None = None,
) -> tuple[dict, list[dict]]:
    raw = [c for pin in per_pin for c in pin.get("candidates", [])]
    rejected: list[dict] = []
    accepted_raw: list[dict] = []
    for candidate in raw:
        url = candidate.get("product_url") or ""
        if not url:
            rejected.append({**candidate, "rejection_reason": "missing_product_url"})
            continue
        ok, reason = accept_link(url)
        if not ok:
            rejected.append({**candidate, "rejection_reason": reason})
            continue
        accepted_raw.append(candidate)

    unique: list[dict] = []
    seen: dict[str, dict] = {}
    duplicate_examples: list[dict] = []
    for candidate in accepted_raw:
        key = _dedup_key(candidate)
        if key in seen:
            if len(duplicate_examples) < 20:
                duplicate_examples.append({
                    "key": key,
                    "kept": seen[key].get("product_url"),
                    "skipped": candidate.get("product_url"),
                    "sourcePin": candidate.get("source_pin_id"),
                })
            continue
        seen[key] = candidate
        unique.append(candidate)

    # Preflight: check DB for existing rows by normalized_product_url_hash.
    # Read-only — runs in both dry-run and apply paths so the report always
    # shows projected insert/skip counts before any write occurs.
    preflight = _preflight_existing(unique)

    issues = Counter(pin.get("issue") for pin in per_pin if pin.get("issue"))
    aggregate = {
        "sourcePinsScanned": len(per_pin),
        "shopModulesDetected": sum(1 for pin in per_pin if pin.get("shopModuleDetected")),
        "rawProductCandidates": len(raw),
        "acceptedBeforeDedup": len(accepted_raw),
        "uniqueAcceptedProducts": len(unique),
        "duplicatesSkipped": len(accepted_raw) - len(unique),
        "rejectedProducts": len(rejected),
        "rejectedByReason": dict(Counter(r["rejection_reason"] for r in rejected)),
        "acceptedByCategory": dict(Counter(c.get("source_category") for c in unique)),
        "acceptedByPlatform": dict(Counter(c.get("platform") for c in unique)),
        "acceptedByDomain": dict(Counter(c.get("domain") for c in unique)),
        "acceptedBySourcePin": dict(Counter(c.get("source_pin_id") for c in unique)),
        "acceptedByExtractionMethod": dict(Counter(c.get("extraction_method") for c in unique)),
        "runtimePer100Min": round(elapsed / max(1, len(per_pin)) * 100 / 60, 2),
        "elapsedSec": round(elapsed, 2),
        "issues": dict(issues),
        "captchaCount": issues.get("captcha", 0),
        "loginWallCount": issues.get("login_wall", 0),
        "timeoutCount": sum(v for k, v in issues.items() if str(k).startswith("goto_timeout")),
        "blockCount": sum(v for k, v in issues.items() if "block" in str(k)),
        # Write-plan projections (always present; projectedUpdateCount must be 0)
        "projectedInsertCount": preflight["projectedInsertCount"],
        "projectedSkipExistingCount": preflight["projectedSkipExistingCount"],
        "projectedUpdateCount": 0,
        "legacyTouchedProjected": 0,
        "conflictKeysChecked": preflight["conflictKeysChecked"],
    }
    report = {
        "mode": "apply" if apply else "dry-run",
        "engine": "shop-the-look",
        "generatedAt": datetime.now(tz=timezone.utc).isoformat(),
        "discoveryMethod": DISCOVERY_DETAIL,
        "provenanceStrategy": "B",
        "discoveryMethodBase": DISCOVERY_METHOD,
        "discoveryMethodDetail": DISCOVERY_DETAIL,
        "sourceSelection": selection,
        "sourceReportValidation": source_report_validation,
        "preflight": {k: v for k, v in preflight.items() if k != "insertCandidates"},
        "aggregate": aggregate,
        "previous20PinAcceptLinkDelta": _previous_spike_delta(),
        "duplicateExamples": duplicate_examples,
        "acceptedSamples": unique[:30],
        "rejectedSamples": rejected[:30],
        "acceptedProducts": unique,
        "rejectedProductDetails": rejected,
        "perPin": [{
            "sourcePinId": str(pin.get("source", {}).get("pin_id") or ""),
            "category": pin.get("source", {}).get("category"),
            "saveCount": pin.get("source", {}).get("save_count"),
            "shopModuleDetected": pin.get("shopModuleDetected", False),
            "shopTabClicked": pin.get("shopTabClicked", False),
            "chipLabels": pin.get("chipLabels", []),
            "visibleCardCount": pin.get("visibleCardCount", 0),
            "rawCandidates": len(pin.get("candidates", [])),
            "issue": pin.get("issue"),
            "elapsedSec": pin.get("elapsedSec"),
        } for pin in per_pin],
        "writes": {"pin_products": 0},
        "legacyRowsTouched": 0,
    }
    # Return insert-only candidates (pre-filtered by preflight) alongside full unique list.
    # Callers use unique for reporting, insert_candidates for the actual write.
    report["_insertCandidates"] = preflight.get("insertCandidates", unique)
    return report, unique


def _apply_rows(rows: list[dict]) -> int:
    """INSERT-only write to pin_products. Never updates existing rows.

    Uses db.insert_rows with on_conflict=normalized_product_url_hash:
        Prefer: resolution=ignore-duplicates  (ON CONFLICT DO NOTHING)

    A late hash conflict (row arrived between preflight and write) is silently
    skipped. The existing row is NEVER touched. resolution=merge-duplicates is
    NOT used here.

    Caller must have already run _preflight_existing() and must pass only the
    insertCandidates list (rows not already in DB). This function is the last
    safety net — not the primary dedup mechanism.

    Requires v28 migration (unique index on normalized_product_url_hash).
    Call _check_v28_schema() before this in apply path.
    """
    from db import insert_rows  # type: ignore

    payload = []
    for c in rows:
        title = (c.get("product_title") or c.get("merchant") or
                 c.get("domain") or "Pinterest product")
        payload.append({
            "parent_pin_id":            c.get("source_pin_id"),
            "product_name":             title[:500],
            "source_url":               c.get("product_url"),
            "canonical_product_url":    c.get("normalized_product_url"),
            "product_url_hash":         c.get("normalized_product_url_hash"),
            "domain":                   c.get("domain"),
            "merchant":                 c.get("merchant"),
            "image_url":                c.get("image_url"),
            "price":                    c.get("price"),
            # NULL when price/currency evidence is absent — never default to USD.
            "currency":                 c.get("currency") or None,
            "source_pin_save_count":    c.get("source_pin_save_count", 0),
            "source_platform":          c.get("platform"),
            "product_type":             c.get("product_type"),
            "digital_format":           c.get("digital_format"),
            "inspiration_only":         True,
            "is_user_ownable":          False,
            "discovery_method":         DISCOVERY_METHOD,
            "discovery_method_detail":  DISCOVERY_DETAIL,
            "discovery_depth":          0,
            "discovery_path":           c.get("discovery_path"),
            "source_pin_id":            c.get("source_pin_id"),
            "source_pin_url":           c.get("source_pin_url"),
            # Persisted so Product Ideas category filters work correctly.
            # womens-fashion must not collapse into generic fashion.
            "source_category":          c.get("source_category"),
            "seed_keyword":             c.get("seed_keyword"),
            "product_card_title":       c.get("product_title"),
            "product_card_merchant":    c.get("merchant"),
            "product_card_price":       c.get("price"),
            "product_card_image_url":   c.get("image_url"),
            "product_card_position":    c.get("product_card_index"),
            "extraction_method":        c.get("extraction_method"),
            "shop_module_detected":     c.get("shop_module_detected"),
            "shop_tab_clicked":         c.get("shop_tab_clicked"),
            "product_source_domain":    c.get("domain"),
            "normalized_product_url_hash": c.get("normalized_product_url_hash"),
        })
    if not payload:
        return 0
    # INSERT ... ON CONFLICT (normalized_product_url_hash) DO NOTHING
    # Requires v28 unique index idx_pin_products_normalized_product_url_hash.
    # Late conflicts are skipped; the existing row is unchanged.
    result = insert_rows("pin_products", payload, on_conflict="normalized_product_url_hash")
    return len(result) if result else 0


# Residential-proxy support for the Shop-the-Look Playwright navigation. Reuses the
# SAME env var already validated for pin-crawl (PINTEREST_CRAWL_PROXY_URL). When it is
# absent/blank, STL navigation falls back to the current direct-from-datacenter-IP
# behaviour unchanged. The URL/credentials are NEVER logged (only presence + used flag).
CRAWL_PROXY_ENV = "PINTEREST_CRAWL_PROXY_URL"


def _stl_proxy_option() -> dict | None:
    """Build a Playwright proxy option dict from PINTEREST_CRAWL_PROXY_URL, or None
    when unset/blank (→ direct). Playwright wants {server, username, password} with
    credentials split out of the URL, so parse rather than passing the raw URL."""
    raw = (os.environ.get(CRAWL_PROXY_ENV) or "").strip()
    if not raw:
        return None
    parts = urlsplit(raw)
    if not parts.hostname:
        return None
    server = f"{parts.scheme or 'http'}://{parts.hostname}"
    if parts.port:
        server += f":{parts.port}"
    opt: dict = {"server": server}
    if parts.username:
        opt["username"] = unquote(parts.username)
    if parts.password:
        opt["password"] = unquote(parts.password)
    return opt


async def run_shop_the_look_expand(
    *,
    limit: int = 50,
    category_mix: dict[str, int] | None = None,
    since_hours: int = 168,
    apply: bool = False,
    source_report_path: str | Path | None = None,
) -> dict:
    """Run the bounded Shop-the-Look extraction and save a JSON report.

    When source_report_path is given the source pins are loaded from the
    approved dry-run report instead of being reselected. The report is
    validated (engine, mode, count, category distribution) before any crawling
    begins. Fails closed if validation fails.
    """
    from playwright.async_api import async_playwright  # type: ignore

    mix = dict(category_mix or DEFAULT_CATEGORY_MIX)
    if sum(mix.values()) != limit:
        raise ValueError(f"category mix totals {sum(mix.values())}, expected limit={limit}")

    source_report_validation: dict | None = None
    if source_report_path is not None:
        sources, source_report_validation = load_and_validate_source_report(
            source_report_path, category_mix=mix, limit=limit
        )
        selection: dict = {
            "sourceSetFrozen": True,
            "sourceReportPath": source_report_validation["sourceReportPath"],
            "selectedTotal": len(sources),
            "requestedTotal": limit,
            "categoryMixFromSourceReport": source_report_validation["categoryMixFromSourceReport"],
            "avoidedPriorSpikePins": 0,
            "overlapWithPriorSpike": 0,
        }
    else:
        prior_ids = _load_previous_spike_ids()
        sources, selection = select_source_pins(
            category_mix=mix, since_hours=since_hours, avoid_pin_ids=prior_ids
        )
        if len(sources) != limit:
            selection["warning"] = f"selected {len(sources)} of requested {limit} source pins"

    state: dict[str, Any] = {"pin_id": None, "chip_label": None, "network": []}
    per_pin: list[dict] = []
    started = time.monotonic()

    # Route STL navigation through the residential proxy when configured (same env
    # var as pin-crawl). Presence + used flag only — never the URL or credentials.
    proxy_opt = _stl_proxy_option()
    print(f"[stl] proxy present={bool((os.environ.get(CRAWL_PROXY_ENV) or '').strip())} "
          f"| STL proxy used={proxy_opt is not None}")

    async with async_playwright() as pw:
        launch_kwargs: dict[str, Any] = {
            "headless": True,
            "args": ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        }
        if proxy_opt is not None:
            launch_kwargs["proxy"] = proxy_opt
        browser = await pw.chromium.launch(**launch_kwargs)
        context = await browser.new_context(
            viewport={"width": 1380, "height": 1700},
            locale="en-US",
            user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/124.0.0.0 Safari/537.36"),
        )
        page = await context.new_page()

        async def on_response(response) -> None:
            pin_id = state.get("pin_id")
            if not pin_id:
                return
            try:
                content_type = (response.headers or {}).get("content-type", "")
                if "json" not in content_type and not any(k in response.url.lower() for k in ("resource", "graphql", "shop", "product")):
                    return
                payload = await response.json()
                candidates = extract_network_candidates(
                    payload,
                    response_url=response.url,
                    chip_label=state.get("chip_label"),
                )
                if state.get("pin_id") == pin_id and candidates:
                    state["network"].extend(candidates[:500])
            except Exception:
                return

        page.on("response", lambda response: asyncio.create_task(on_response(response)))
        try:
            await page.goto("https://www.pinterest.com", wait_until="domcontentloaded", timeout=30_000)
            await asyncio.sleep(1.5)
        except Exception:
            pass

        for index, source in enumerate(sources, 1):
            result = await _extract_source_pin(page, source, state)
            per_pin.append(result)
            print(
                f"[product-supply-expand] {index}/{len(sources)} pin={source.get('pin_id')} "
                f"category={source.get('category')} shop={result.get('shopModuleDetected', False)} "
                f"candidates={len(result.get('candidates', []))} issue={result.get('issue')}",
                flush=True,
            )
        await browser.close()

    elapsed = time.monotonic() - started

    # v28 schema check — always run (read-only); result included in report.
    # In apply mode: fail closed if any required column is missing.
    # In dry-run mode: include result as a warning, do not block.
    v28_ok, v28_missing = _check_v28_schema()
    v28_status = {
        "columnsChecked": list(V28_REQUIRED_COLUMNS),
        "allPresent": v28_ok,
        "missingColumns": v28_missing,
        "noteIndexNotChecked": "unique index on normalized_product_url_hash cannot be verified via PostgREST; must confirm manually before apply",
    }

    if apply and not v28_ok:
        raise RuntimeError(
            f"v28 migration has not been applied — missing columns: {v28_missing}. "
            "Run migrate_v28_product_supply_expansion.sql before --apply."
        )

    report, unique = _build_report(
        per_pin, selection,
        elapsed=elapsed,
        apply=apply,
        source_report_validation=source_report_validation,
    )
    report["v28SchemaCheck"] = v28_status

    if apply:
        # Use pre-filtered insert-only candidates from preflight, not the full unique list.
        insert_candidates = report.pop("_insertCandidates", unique)
        report["writes"]["pin_products"] = _apply_rows(insert_candidates)
    else:
        # Remove the internal field from dry-run reports (not useful in JSON output).
        report.pop("_insertCandidates", None)

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(tz=timezone.utc).strftime("%Y%m%d_%H%M%S")
    path = LOG_DIR / f"product_supply_expand_shop_the_look_{stamp}.json"
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    latest = LOG_DIR / "product_supply_expand_shop_the_look_latest.json"
    latest.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    report["reportPath"] = str(path)
    return report
