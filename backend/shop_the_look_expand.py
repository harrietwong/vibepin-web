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

import httpx
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
# Single source of truth for the NULL-safe "not retired" dedup filter. Retired
# rows must never count as "already exists" — see product_lifecycle.py.
from product_lifecycle import with_not_retired  # type: ignore

DEFAULT_CATEGORY_MIX = {
    "fashion": 18,
    "womens-fashion": 14,
    "home-decor": 18,
}
EXCLUDED_DEFAULT = frozenset({"beauty", "digital-products"})

# Per-pin Playwright navigation budget. Default 15_000 ms = the previous
# hard-coded literal, so behaviour is UNCHANGED unless the env var is set.
# Made configurable because the 2026-08-06 VPS run lost 22/50 pins to
# goto_timeout at 15 s when navigating through the residential proxy (proxy
# hops add seconds that a datacenter-direct run never pays). Tuning the value
# is a SEPARATE decision — this change only makes it tunable without a deploy.
STL_GOTO_TIMEOUT_ENV = "STL_GOTO_TIMEOUT_MS"
STL_GOTO_TIMEOUT_DEFAULT_MS = 15_000


def _stl_goto_timeout_ms() -> int:
    """Read STL_GOTO_TIMEOUT_MS; fall back to the historical 15_000 ms.

    A malformed or non-positive value falls back to the default rather than
    disabling the timeout (timeout=0 means "wait forever" in Playwright, which
    would hang the crawl).
    """
    raw = (os.environ.get(STL_GOTO_TIMEOUT_ENV) or "").strip()
    if not raw:
        return STL_GOTO_TIMEOUT_DEFAULT_MS
    try:
        value = int(raw)
    except ValueError:
        return STL_GOTO_TIMEOUT_DEFAULT_MS
    return value if value > 0 else STL_GOTO_TIMEOUT_DEFAULT_MS


# Incremental-write batch size, counted in SOURCE PINS (not candidates).
#
# WHY THIS EXISTS (2026-08-06 VPS run): the writer used to run once, after
# `await browser.close()`, i.e. only when all 50 pins had been crawled. The
# 2026-08-06 23:02 timer run crawled 45/50 pins, found products on 31 of them,
# and was then tree-killed by the runner at VIBEPIN_TIMEOUT_SECONDS=2400. Every
# one of those 31 pins' products was discarded: the write line was never
# reached. Measured pace is ~53 s/pin, so 50 pins needs ~44 min — the run was
# structurally guaranteed to die before writing anything.
#
# Flushing every N pins bounds the loss to at most the last N pins' harvest.
STL_WRITE_BATCH_SIZE_ENV = "STL_WRITE_BATCH_SIZE"
STL_WRITE_BATCH_SIZE_DEFAULT = 10


def _stl_write_batch_size() -> int:
    """Read STL_WRITE_BATCH_SIZE (in source pins); fall back to 10.

    A malformed or non-positive value falls back to the default rather than
    disabling batching — a 0 would mean "never flush", which is precisely the
    all-or-nothing behaviour this setting exists to remove.
    """
    raw = (os.environ.get(STL_WRITE_BATCH_SIZE_ENV) or "").strip()
    if not raw:
        return STL_WRITE_BATCH_SIZE_DEFAULT
    try:
        value = int(raw)
    except ValueError:
        return STL_WRITE_BATCH_SIZE_DEFAULT
    return value if value > 0 else STL_WRITE_BATCH_SIZE_DEFAULT


DISCOVERY_METHOD = "stl"
DISCOVERY_DETAIL = "pinterest_product_card_bootstrap"
# Module wording drifts as Pinterest reships the shopping surface. "shop the pin"
# is the wording observed in the live UI on 2026-08-05; the older variants are
# kept because historical/regional renders still use them. Detection is a
# best-effort signal only — the authoritative evidence is product JSON.
STL_TEXT = re.compile(
    r"shop the look|shop the pin|shop similar|more to shop|shop this|"
    r"shop related|similar products|shoppable|buyable",
    re.I,
)
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


class ScrapedPinHistoryUnavailable(RuntimeError):
    """The set of already-scraped source pins could not be read from the database.

    Raised instead of returning an empty set. An empty set would silently
    disable the exclusion and send the crawler straight back onto the same
    highest-save pins it has already harvested — which is precisely the bug
    this loader exists to fix, only now invisible. The run refuses to select
    sources it cannot honestly say are new.
    """


def _load_scraped_source_pin_ids() -> set[str]:
    """Every source pin we have ALREADY scraped products from, read from the DB.

    WHY THE DATABASE AND NOT A LOG FILE: the historical exclusion list came from
    ``logs/shop_the_look_spike.json`` (_load_previous_spike_ids). That file is
    per-machine — the VPS and a laptop each keep their own, deleting it erases
    the memory, and a fresh host starts with none. Meanwhile the crawler kept
    re-selecting the same top-save pins run after run: measured 2026-08-07, the
    pin_samples pool held 26,124 pins of which only 260 had ever been scraped
    (1%), yet consecutive runs kept landing on the same pin ids and produced
    single-digit new rows out of dozens of candidates. ``pin_products`` is the
    only record that survives a host change, so it is the source of truth.

    PAGINATION: PostgREST caps a single response at 1000 rows and pin_products
    already holds 3700+. ``DB().select_many`` (backend/db/db.py) pages in
    blocks of 1000 when ``limit is None``; the module-level ``select_many`` has
    no offset support and would silently truncate at the cap. Using the paging
    helper is therefore load-bearing, not a style choice.

    Not lifecycle-scoped on purpose: a retired PRODUCT row is still proof that
    its source PIN was visited. Retirement is about the product, re-scraping is
    about the pin.

    Raises ScrapedPinHistoryUnavailable if the read fails — never returns an
    empty set to paper over an error.
    """
    from db import DB  # type: ignore

    try:
        rows = DB().select_many(
            "pin_products",
            columns="source_pin_id",
            filters={"source_pin_id": "not.is.null"},
            limit=None,
        ) or []
    except Exception as exc:  # noqa: BLE001 — re-raised as a typed, loud failure
        raise ScrapedPinHistoryUnavailable(
            "could not read the already-scraped source pins from pin_products: "
            f"{type(exc).__name__}: {str(exc)[:200]}. Refusing to select source "
            "pins without the exclusion list — running without it would silently "
            "re-scrape pins whose products are already in the database."
        ) from exc

    return {str(r.get("source_pin_id")) for r in rows if r.get("source_pin_id")}


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
    avoid_sources: dict[str, int] | None = None,
) -> tuple[list[dict], dict]:
    """Select balanced recent high-save pins, preferring bootstrap rows.

    ``avoid_pin_ids`` is a HARD exclusion. There is deliberately no fallback
    that re-admits an avoided pin when a category runs short: re-scraping a pin
    whose products are already in the database costs ~53 s and yields nothing,
    and a fallback that quietly re-admits them makes the exclusion look like it
    works while the crawler goes right back to the same pins. When a category
    cannot be filled, we under-select and say so — in the log and in
    ``selectionExhaustion`` — rather than fill the quota with known-spent pins.

    ``avoid_sources`` is optional provenance for the report (e.g. how many ids
    came from the spike log vs the database); it never affects selection.
    """
    cutoff = (datetime.now(tz=timezone.utc) - timedelta(hours=since_hours)).isoformat()
    avoid = set(avoid_pin_ids or set())
    selected: list[dict] = []
    selected_ids: set[str] = set()
    breakdown: dict[str, dict[str, int]] = {}
    exhaustion: dict[str, dict[str, int]] = {}

    for category, wanted in category_mix.items():
        if wanted <= 0:
            breakdown[category] = {"requested": wanted, "selected": 0, "bootstrap": 0, "recentFallback": 0, "overlap": 0}
            exhaustion[category] = {
                "requested": wanted,
                "candidatesBeforeExclusion": 0,
                "candidatesAfterExclusion": 0,
                "excludedAlreadyScraped": 0,
                "selected": 0,
                "shortfall": 0,
            }
            continue
        pool = _query_sources(category, cutoff, bootstrap_only=True, limit=max(100, wanted * 8))
        fallback = _query_sources(category, cutoff, bootstrap_only=False, limit=max(100, wanted * 8))
        pool.sort(key=_selection_score)
        fallback.sort(key=_selection_score)

        # Distinct candidate pins this category could draw from. pool and
        # fallback overlap heavily (fallback is the same query without the
        # bootstrap filter), so count the UNION by pin_id or the "before"
        # number double-counts and the exhaustion report lies.
        distinct_candidates = {
            str(row.get("pin_id") or "")
            for row in (pool + fallback)
            if str(row.get("pin_id") or "")
        }
        available_candidates = distinct_candidates - avoid

        cat_rows: list[dict] = []
        bootstrap_count = fallback_count = overlap_count = 0

        def take(rows: list[dict], source_kind: str) -> None:
            nonlocal bootstrap_count, fallback_count, overlap_count
            for row in rows:
                if len(cat_rows) >= wanted:
                    break
                pid = str(row.get("pin_id") or "")
                if not pid or pid in selected_ids:
                    continue
                if pid in avoid:
                    continue
                cat_rows.append(row)
                selected_ids.add(pid)
                if source_kind == "bootstrap":
                    bootstrap_count += 1
                else:
                    fallback_count += 1

        take(pool, "bootstrap")
        if len(cat_rows) < wanted:
            take(fallback, "recent")

        selected.extend(cat_rows)
        shortfall = max(0, wanted - len(cat_rows))
        breakdown[category] = {
            "requested": wanted,
            "selected": len(cat_rows),
            "bootstrap": bootstrap_count,
            "recentFallback": fallback_count,
            # Always 0 now that the exclusion is hard — kept so existing report
            # consumers do not KeyError, and so a non-zero value would be a
            # visible alarm that something re-admitted an avoided pin.
            "overlap": overlap_count,
            "shortfall": shortfall,
        }
        exhaustion[category] = {
            "requested": wanted,
            "candidatesBeforeExclusion": len(distinct_candidates),
            "candidatesAfterExclusion": len(available_candidates),
            "excludedAlreadyScraped": len(distinct_candidates) - len(available_candidates),
            "selected": len(cat_rows),
            "shortfall": shortfall,
        }
        if shortfall:
            # LOUD: under-selecting is a legitimate outcome, but it must never
            # be silent — a quiet short run looks exactly like a healthy one.
            print(
                f"[product-supply-expand] category {category}: requested {wanted}, "
                f"{len(distinct_candidates)} candidates in the freshness window, "
                f"only {len(available_candidates)} left after excluding "
                f"already-scraped pins -> selected {len(cat_rows)} "
                f"(shortfall {shortfall}). NOT falling back to re-scraping "
                "already-harvested pins; widen --since-hours or crawl more "
                "pin_samples for this category.",
                flush=True,
            )

    exhausted_categories = sorted(c for c, v in exhaustion.items() if v["shortfall"] > 0)
    return selected, {
        "sinceHours": since_hours,
        "requestedTotal": sum(category_mix.values()),
        "selectedTotal": len(selected),
        "avoidedPriorSpikePins": len(avoid),
        "overlapWithPriorSpike": sum(v["overlap"] for v in breakdown.values()),
        "avoidSources": dict(avoid_sources or {}),
        "byCategory": breakdown,
        "selectionExhaustion": {
            "byCategory": exhaustion,
            "totalShortfall": sum(v["shortfall"] for v in exhaustion.values()),
            "exhaustedCategories": exhausted_categories,
            "repeatScrapeFallbackUsed": False,
            "note": (
                "Already-scraped source pins are excluded using pin_products "
                "(the database), not a local log file. When a category cannot "
                "be filled the run selects fewer pins and reports the shortfall "
                "here; it never re-admits an already-scraped pin to hit the quota."
            ),
        },
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
        # Carried through for REPORTING only (never written to pin_products).
        # Without it, a candidate's provenance — structured product object vs.
        # extract_network_candidates' regex `network_text_fallback` branch — is
        # lost before any accounting happens, which is why the question "has the
        # text fallback ever produced a real product?" cannot be answered from
        # existing rows or existing reports. Keeping it makes the next run's
        # report answer it.
        "json_path": candidate.get("json_path"),
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
    dom_eval_error: str | None = None
    started = time.monotonic()
    # Count product JSON responses seen for THIS pin only.
    network_before = len(state.get("network") or [])
    responses_before = int(state.get("productJsonResponses") or 0)

    try:
        await page.goto(source_url, wait_until="domcontentloaded",
                        timeout=_stl_goto_timeout_ms())
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

    tab_count = 0
    try:
        tabs = await page.query_selector_all('[data-test-id="shopping-tab"], [data-test-id*="shopping-tab" i], [role="tab"]')
        tab_count = len(tabs)
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
    except Exception as exc:
        # Never swallow this: an evaluate() failure means we did NOT look for
        # cards, which is not the same as "there are no cards".
        dom_cards = []
        dom_eval_error = f"dom_eval_failed:{type(exc).__name__}:{str(exc)[:120]}"

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

    product_json_responses = int(state.get("productJsonResponses") or 0) - responses_before
    network_candidates = len(state.get("network") or []) - network_before

    # Distinguish "the page never gave us a usable shell" from "this pin genuinely
    # has no products". A rendered-but-empty pin still produces a real interactive
    # shell (cards, tabs, or product JSON); a skeleton/blocked/unauthenticated page
    # produces none of the three. Conflating the two is what previously produced a
    # false 'data source exhausted' conclusion — keep them separable forever.
    page_skeleton = (
        len(dom_cards) <= 1
        and tab_count == 0
        and product_json_responses == 0
    )
    render_failure = bool(page_skeleton and not shop_detected)
    if render_failure and not issue:
        issue = "render_failure_or_unauthenticated"

    return {
        "source": source,
        "issue": issue,
        "shopModuleDetected": shop_detected or bool(state.get("network")),
        "shopTabClicked": shop_tab_clicked,
        "chipLabels": sorted(set(chip_labels)),
        "visibleCardCount": len(dom_cards),
        "tabCount": tab_count,
        "productJsonResponses": product_json_responses,
        "networkCandidates": network_candidates,
        "domEvalError": dom_eval_error,
        "pageSkeleton": page_skeleton,
        "renderFailure": render_failure,
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


class SchemaCheckUnavailable(RuntimeError):
    """The v28 schema could not be determined because the probe never got an answer.

    This is NOT evidence that any column is missing. It is the absence of
    evidence — the database did not respond (connection reset, timeout, DNS,
    TLS, 5xx). Raised so the caller can report "unknown" instead of asserting
    a schema defect that was never observed.
    """


def _classify_probe_failure(exc: BaseException) -> str:
    """Classify a failed column probe as 'missing' | 'unavailable'.

    The distinction is the whole point of this module: only a probe that
    ACTUALLY REACHED PostgREST and got a structured "no such column" answer is
    evidence of a missing column. Anything that never reached the server, or
    that the server failed to answer, is evidence of nothing.

    'missing'      — PostgREST answered and the answer names a schema defect:
                     a 400/404 with PostgREST's undefined-column signature
                     (PGRST202/PGRST204, Postgres 42703, "does not exist").
    'unavailable'  — the probe got no usable answer:
                       * httpx.TransportError subclasses (ConnectError,
                         ConnectTimeout, ReadTimeout, ReadError, WriteError,
                         PoolTimeout, RemoteProtocolError, ProxyError) — these
                         are what db._request re-raises after exhausting its 4
                         retries, and they are NOT RuntimeError, which is how
                         they used to fall through to a bare `except Exception`
                         and get mislabelled as a missing column.
                       * ssl.SSLError / socket.timeout / OSError — transport.
                       * a RuntimeError carrying a 5xx or a transport word.
                       * anything unrecognised — we default to 'unavailable'
                         because an unknown failure is by definition not an
                         observation of a missing column. Fail LOUD, not WRONG.
    """
    import ssl
    import socket

    # Transport-level: the request never completed. httpx.TransportError is the
    # base class db._request retries on and re-raises verbatim on exhaustion.
    if isinstance(exc, (httpx.TransportError, ssl.SSLError, socket.timeout)):
        return "unavailable"
    # httpx.HTTPError covers InvalidURL/CookieConflict etc.; still not a schema answer.
    if isinstance(exc, httpx.HTTPError):
        return "unavailable"

    if isinstance(exc, RuntimeError):
        err = str(exc)
        low = err.lower()
        # PostgREST answered with an explicit undefined-column verdict.
        # 42703 = Postgres undefined_column; PGRST202/204 = PostgREST schema-cache miss.
        undefined_column_signature = (
            "does not exist" in low
            or "42703" in err
            or "pgrst204" in low
            or "pgrst202" in low
            or "undefined column" in low
        )
        got_client_error_status = "[400]" in err or "[404]" in err
        if undefined_column_signature and got_client_error_status:
            return "missing"
        # A 400/404 whose body we could not match to a column verdict is
        # ambiguous (could be a malformed filter, a gateway page, an auth
        # rejection). Ambiguous is not evidence of a missing column.
        if got_client_error_status:
            return "unavailable"
        # Server-side failure or a transport error someone wrapped in RuntimeError.
        return "unavailable"

    # OSError catches lower-level socket failures not wrapped by httpx.
    if isinstance(exc, OSError):
        return "unavailable"

    return "unavailable"


def _check_v28_schema() -> tuple[bool, list[str]]:
    """Verify every v28 column required for STL bootstrap apply exists in pin_products.

    Uses PostgREST filter params — if a column is absent the API returns 400.
    Returns (all_present: bool, missing_columns: list[str]).

    Raises SchemaCheckUnavailable if any probe failed to get an answer from the
    database. A column is reported missing ONLY when PostgREST explicitly said
    so; a probe that timed out proves nothing and must never be rendered as a
    schema defect (that misdiagnosis sends operators to run a migration that
    was already applied).

    Note: only COLUMNS are checked. The write path no longer depends on any
    particular unique index: v47 made the pin_products unique indexes PARTIAL
    (lifecycle-aware), so the writer uses a plain INSERT and treats a genuine
    23505 as a duplicate. See _apply_rows.
    """
    missing: list[str] = []
    unavailable: list[str] = []
    causes: list[str] = []
    for col in V28_REQUIRED_COLUMNS:
        try:
            select_many("pin_products", filters={col: "is.null"}, limit=0)
        except Exception as exc:  # noqa: BLE001 — classified, never swallowed
            verdict = _classify_probe_failure(exc)
            if verdict == "missing":
                missing.append(col)
            else:
                unavailable.append(col)
                causes.append(f"{col}: {type(exc).__name__}: {str(exc)[:160]}")

    if unavailable:
        raise SchemaCheckUnavailable(
            "could not verify the pin_products schema — the database did not "
            f"answer the column probe for: {unavailable}. "
            "This is NOT evidence that any column is missing; the check never "
            "completed. Probe failures: " + " | ".join(causes)
        )
    return len(missing) == 0, missing


def _preflight_existing(unique: list[dict]) -> dict:
    """Query DB for existing ACTIVE rows by normalized_product_url_hash (read-only).

    Returns projected insert/skip counts and the filtered insert-only candidate
    list under key 'insertCandidates'. projectedUpdateCount is always 0 — the
    apply path is insert-only; existing rows are skipped, never updated.

    LIFECYCLE COEXISTENCE: the existence check is scoped to NON-RETIRED rows via
    product_lifecycle.with_not_retired(). A retired row is evidence, not a
    blacklist — its URL must stay re-collectable as a new active row, which is
    exactly what the partial unique index permits. An unscoped check would treat
    retired hashes as "already exists" and silently make retirement permanent
    (see product_lifecycle.py, and the NULL trap documented there: the filter
    must be the NULL-safe OR form, since NULL means active).
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
                # NOT_RETIRED-scoped: a retired row's hash must stay re-collectable.
                filters=with_not_retired(
                    {"normalized_product_url_hash": f"in.({','.join(batch)})"}
                ),
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


#: Rejection reason emitted by _evidence_rejection_reason. Shared by the
#: dry-run report path and the incremental write path so both agree.
NO_PRODUCT_EVIDENCE = "no_product_evidence"


def _evidence_rejection_reason(candidate: dict) -> str | None:
    """Return a rejection reason when a candidate is not product EVIDENCE.

    THE FAILURE THIS REMOVES (2026-08-08): a bare external link was being
    written to pin_products as if it were a product. Measured on production:
    of 2758 STL rows, 35 had no image_url, 0 of those had a price, and every
    one of their product_name values was a bare domain/merchant token — quay,
    ebay, etsy, shein, jluxlabel, bylabelle, revolutionboutique. One row's
    name was the Pin's caption ("OMG OMG OMG CPL"). Those are not products;
    they are URLs that were dressed up to look like products.

    Two code paths produced them and BOTH are addressed:
      1. extract_network_candidates' `network_text_fallback` branch regexes
         every external URL out of the raw JSON blob and emits it with
         product_title/image_url/price all hard-coded to None — a link, with
         no evidence attached.
      2. _apply_rows' old title chain
             product_title or merchant or domain or "Pinterest product"
         turned "we don't know what this is" into something that reads like a
         product name.

    THE RULE: a candidate must carry at least ONE piece of first-hand product
    evidence — a real title, or an image. Either alone is sufficient:
      * image but no title  -> ACCEPTED. The image IS the product evidence;
        product_name stays NULL (v47 made the column nullable precisely so
        "抓不到就 NULL，绝不猜测" is expressible).
      * title but no image  -> ACCEPTED. The title is first-hand evidence.
      * NEITHER             -> REJECTED. A URL on its own is a link, not a
        product, no matter how product-shaped the path looks.

    Deliberately NOT part of the rule: price, merchant, domain and URL shape.
    merchant/domain are derived from the URL itself (see _prepare_candidate's
    domain_fallback), so admitting them as "evidence" would re-admit exactly
    the 35 bad rows. URL-shape allowlisting (/dp/, /listing/) would be
    guessing, which is the red line this gate exists to hold.

    Rejections are COUNTED AND REPORTED by both callers, never dropped quietly.
    """
    title = (candidate.get("product_title") or "").strip()
    image = (candidate.get("image_url") or "").strip()
    if not title and not image:
        return NO_PRODUCT_EVIDENCE
    return None


def _rejected_candidates_report(rejected: list[dict]) -> dict:
    """Explicit accounting for everything this run refused to write.

    A discard that does not appear in the report is a silent data loss, so
    every rejection is counted here by reason, with samples that keep the URL
    intact so the decision can be audited (or reversed) from the report alone.
    """
    no_evidence = [r for r in rejected if r.get("rejection_reason") == NO_PRODUCT_EVIDENCE]
    # If a gate-rejected candidate ever carries a price, that is real evidence
    # we threw away and the rule needs revisiting. Measured 0/35 in production
    # today; surfaced so it cannot change unnoticed.
    priced = [r for r in no_evidence if r.get("price")]
    return {
        "total": len(rejected),
        "byReason": dict(Counter(r.get("rejection_reason") for r in rejected)),
        "noProductEvidence": {
            "count": len(no_evidence),
            "rule": (
                "A candidate must carry a real product_title OR an image_url. "
                "A bare external URL is a link, not a product. merchant/domain "
                "are derived from the URL and never count as evidence."
            ),
            "withPriceAnyway": len(priced),
            "samples": [
                {
                    "url": r.get("product_url"),
                    "domain": r.get("domain"),
                    "merchant": r.get("merchant"),
                    "sourcePin": r.get("source_pin_id"),
                    "extractionMethod": r.get("extraction_method"),
                    "jsonPath": r.get("json_path"),
                }
                for r in no_evidence[:30]
            ],
        },
    }


def _build_funnel(report: dict) -> dict:
    """One block that shows the whole raw → written chain, without re-deriving it.

    Why this exists: the numbers were already all in the report, but split across
    `aggregate` (an end-of-run recount over every candidate) and `incrementalWrite`
    (per-batch accumulation by the writer). Reading the run therefore meant hand-
    stitching five fields from two places, and on 2026-08-14 that stitching produced
    a wrong conclusion about where supply was being lost. Every value here is COPIED
    from an existing field — nothing is recomputed — and each step names its source
    field so this block can never become a second, disagreeing source of truth.

    The two halves are genuinely two accounting systems (see `stepsNote`): the
    writer's own dedup/preflight counters are cumulative across batches, while the
    aggregate is a single pass at the end. They are presented in sequence, not
    reconciled arithmetically.
    """
    aggregate = report.get("aggregate") or {}
    incremental = report.get("incrementalWrite")
    preflight = report.get("preflight") or {}
    has_writer = isinstance(incremental, dict) and incremental.get("enabled")

    def step(label: str, value: Any, source: str, **extra: Any) -> dict:
        return {"step": label, "count": value, "source": source, **extra}

    rejected_by_reason = dict(aggregate.get("rejectedByReason") or {})
    steps = [
        step("rawCandidates", aggregate.get("rawProductCandidates"),
             "aggregate.rawProductCandidates"),
        step("rejected", aggregate.get("rejectedProducts"),
             "aggregate.rejectedProducts", byReason=rejected_by_reason),
        step("acceptedBeforeDedup", aggregate.get("acceptedBeforeDedup"),
             "aggregate.acceptedBeforeDedup"),
        step("duplicatesSkippedWithinRun", aggregate.get("duplicatesSkipped"),
             "aggregate.duplicatesSkipped"),
        step("uniqueAccepted", aggregate.get("uniqueAcceptedProducts"),
             "aggregate.uniqueAcceptedProducts"),
    ]
    if has_writer:
        steps.extend([
            step("alreadyInDb", incremental.get("rowsSkippedAlreadyInDb"),
                 "incrementalWrite.rowsSkippedAlreadyInDb"),
            step("crossBatchDuplicates", incremental.get("rowsSkippedCrossBatchDuplicate"),
                 "incrementalWrite.rowsSkippedCrossBatchDuplicate"),
            step("written", incremental.get("rowsInserted"),
                 "incrementalWrite.rowsInserted"),
        ])
    else:
        steps.extend([
            step("alreadyInDb", preflight.get("projectedSkipExistingCount"),
                 "preflight.projectedSkipExistingCount", projection=True),
            step("written", preflight.get("projectedInsertCount"),
                 "preflight.projectedInsertCount", projection=True),
        ])
    return {
        "mode": report.get("mode"),
        "steps": steps,
        "stepsNote": (
            "Every count is copied verbatim from the field named in `source`; "
            "nothing here is recomputed. Steps 1-5 come from the end-of-run "
            "aggregate pass, the write steps from the incremental writer's "
            "per-batch counters (dry-run substitutes preflight PROJECTIONS, "
            "marked projection:true). The two halves are separate accounting "
            "systems and are not expected to reconcile by subtraction."
        ),
    }


def _build_report(
    per_pin: list[dict],
    selection: dict,
    *,
    elapsed: float,
    apply: bool,
    source_report_validation: dict | None = None,
    session_health: dict | None = None,
    response_errors: dict | None = None,
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
        # Evidence gate. Runs BEFORE dedup on purpose: an evidence-less
        # candidate must not claim the dedup key and shadow a later candidate
        # for the same URL that DOES carry a title or image.
        evidence_reason = _evidence_rejection_reason(candidate)
        if evidence_reason:
            rejected.append({**candidate, "rejection_reason": evidence_reason})
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
        "rejectedNoProductEvidence": sum(
            1 for r in rejected if r["rejection_reason"] == NO_PRODUCT_EVIDENCE
        ),
        "acceptedByCategory": dict(Counter(c.get("source_category") for c in unique)),
        "acceptedByPlatform": dict(Counter(c.get("platform") for c in unique)),
        "acceptedByDomain": dict(Counter(c.get("domain") for c in unique)),
        "acceptedBySourcePin": dict(Counter(c.get("source_pin_id") for c in unique)),
        "acceptedByExtractionMethod": dict(Counter(c.get("extraction_method") for c in unique)),
        # Provenance split: did the regex text-fallback branch of
        # extract_network_candidates ever yield a candidate that passed the
        # evidence gate? By construction it emits title=None and image=None,
        # so the expected answer is 0 — but it is now MEASURED, not assumed.
        "acceptedFromNetworkTextFallback": sum(
            1 for c in unique if c.get("json_path") == "network_text_fallback"
        ),
        "rejectedFromNetworkTextFallback": sum(
            1 for r in rejected if r.get("json_path") == "network_text_fallback"
        ),
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
        # Honest-failure accounting. A pin with zero products is only meaningful
        # when the page actually rendered and we were authenticated.
        "renderFailureCount": sum(1 for pin in per_pin if pin.get("renderFailure")),
        "pageSkeletonCount": sum(1 for pin in per_pin if pin.get("pageSkeleton")),
        "domEvalErrorCount": sum(1 for pin in per_pin if pin.get("domEvalError")),
        "productJsonResponses": sum(int(pin.get("productJsonResponses") or 0) for pin in per_pin),
        "pinsWithZeroProductJson": sum(
            1 for pin in per_pin if not int(pin.get("productJsonResponses") or 0)
        ),
    }

    health = dict(session_health or {})
    authenticated_run = health.get("authValid") is True
    render_failures = aggregate["renderFailureCount"]
    # Verdict: is this run's product count trustworthy as evidence about supply?
    if health.get("issue") in ("session_expired",):
        trust = "untrusted:session_expired"
    elif health and not health.get("sessionFileLoaded"):
        trust = "untrusted:unauthenticated"
    elif health.get("authValid") is False:
        trust = "untrusted:not_logged_in"
    elif per_pin and render_failures == len(per_pin):
        trust = "untrusted:all_pins_failed_to_render"
    elif render_failures:
        trust = "partial:some_pins_failed_to_render"
    elif health.get("authValid") is None and health:
        trust = "unverified:auth_state_unknown"
    else:
        trust = "trusted"
    data_quality = {
        "resultTrust": trust,
        "authenticatedRun": authenticated_run,
        "zeroProductsIsEvidenceOfNoSupply": trust == "trusted",
        "note": (
            "Zero products from an unauthenticated, expired-session, or "
            "non-rendering run is NOT evidence that these pins have no products. "
            "The Shop-the-Look module is auth-gated."
        ),
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
        "sessionHealth": health or None,
        "responseErrors": response_errors or None,
        "dataQuality": data_quality,
        "preflight": {k: v for k, v in preflight.items() if k != "insertCandidates"},
        "aggregate": aggregate,
        "previous20PinAcceptLinkDelta": _previous_spike_delta(),
        "duplicateExamples": duplicate_examples,
        "acceptedSamples": unique[:30],
        "rejectedSamples": rejected[:30],
        # Explicit, top-level rejection accounting. Nothing this run declined
        # to write is allowed to be invisible.
        "rejectedCandidates": _rejected_candidates_report(rejected),
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
            "tabCount": pin.get("tabCount", 0),
            "productJsonResponses": pin.get("productJsonResponses", 0),
            "rawCandidates": len(pin.get("candidates", [])),
            "issue": pin.get("issue"),
            "domEvalError": pin.get("domEvalError"),
            "pageSkeleton": pin.get("pageSkeleton", False),
            "renderFailure": pin.get("renderFailure", False),
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

    WRITE SEMANTICS: PLAIN INSERT (no on_conflict, no resolution=ignore-duplicates).

    WHY NOT ON CONFLICT (fixed 2026-08-06 — this call silently destroyed every
    scraped product for weeks):
        v47 replaced the TOTAL unique index on normalized_product_url_hash with a
        PARTIAL one:
            idx_pin_products_active_normalized_url_hash
              UNIQUE (normalized_product_url_hash)
              WHERE lifecycle_status IS DISTINCT FROM 'retired'
                AND normalized_product_url_hash IS NOT NULL
        Postgres cannot infer a PARTIAL unique index from a bare column list, so
        `on_conflict=normalized_product_url_hash` has no matching arbiter and the
        whole batch dies with
            42P10: there is no unique or exclusion constraint matching the
                   ON CONFLICT specification
        A real 2026-08-06 VPS run scraped 28/50 pins successfully and then lost
        100% of it at this line. Same for `parent_pin_id,source_url` — that index
        (idx_pin_products_active_parent_source_url) is partial too. There is NO
        plain unique on any business key of this table, so no conflict target
        can be named without a schema change.

    Precedent followed: backend/tools/t2_harvest.py "WRITE SEMANTICS" (lines
    46-50) and the v47 COMMENT ON INDEX writer warning both mandate exactly this
    — plain INSERT, and let a genuine collision surface as a loud 23505 rather
    than swallow rows.

    Dedup is _preflight_existing() (lifecycle-aware; retired rows are not treated
    as existing). A late collision — a row that landed between preflight and this
    write — is a genuine 23505 and is retried per-row so one duplicate cannot
    discard the other N-1 good rows. Rows that still fail are reported, never
    silently dropped.

    Requires v28 columns. Call _check_v28_schema() before this in apply path.
    """
    from db import insert_rows  # type: ignore

    payload = []
    for c in rows:
        # product_name is EVIDENCE, not a label we are obliged to fill.
        # It used to fall back to merchant -> domain -> "Pinterest product",
        # which is how 35 production rows ended up named "etsy" / "shein" /
        # "quay" with no image and no price. merchant and domain already have
        # their own columns; copying them into product_name only disguised a
        # missing title as a product. v47 dropped the NOT NULL constraint on
        # this column (verified live: 68 rows currently hold NULL) exactly so
        # an unknown name can be recorded as unknown.
        # The evidence gate guarantees every row here has a title or an image,
        # so a NULL name always means "image-backed product, name unknown".
        title = (c.get("product_title") or "").strip()
        payload.append({
            "parent_pin_id":            c.get("source_pin_id"),
            "product_name":             title[:500] if title else None,
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
    outcome = _insert_with_duplicate_fallback(insert_rows, payload)
    _LAST_WRITE_OUTCOME.clear()
    _LAST_WRITE_OUTCOME.update(outcome)
    if outcome["failed"]:
        # LOUD: a write we could not complete must never look like a quiet success.
        print(
            f"[product-supply-expand] WRITE FAILURES: {outcome['failed']} of "
            f"{outcome['attempted']} rows did not land "
            f"(duplicates={outcome['duplicates']}, errors={outcome['failed']}). "
            f"firstError={outcome['errors'][0] if outcome['errors'] else ''}",
            flush=True,
        )
    return outcome["inserted"]


# Populated by _apply_rows so the caller can put honest write accounting into the
# JSON report. Never swallow: every non-inserted row is counted here.
_LAST_WRITE_OUTCOME: dict = {}

# 23505 = unique_violation. The ONLY error we treat as a benign late collision.
_PG_UNIQUE_VIOLATION = "23505"


def _is_duplicate_error(exc: Exception) -> bool:
    """True only for a genuine Postgres unique violation (23505).

    Deliberately narrow: 42P10 (no matching ON CONFLICT arbiter), 23514 (CHECK),
    permission and network errors are NOT duplicates and must stay loud.
    """
    return _PG_UNIQUE_VIOLATION in str(exc)


def _insert_with_duplicate_fallback(insert_rows, payload: list[dict]) -> dict:
    """Plain-INSERT the batch; on a genuine 23505 retry row-by-row.

    A single duplicate in a 200-row batch would otherwise abort the whole
    statement and discard 199 good rows — the data-loss shape we are fixing.
    Row-by-row retry keeps the good rows and attributes each failure honestly.

    Returns {attempted, inserted, duplicates, failed, errors}. `failed` counts
    rows lost to NON-duplicate errors; those also re-raise when nothing landed at
    all, so a broken write can never masquerade as an empty harvest.
    """
    attempted = len(payload)
    try:
        result = insert_rows("pin_products", payload)
        inserted = len(result) if result else attempted
        return {"attempted": attempted, "inserted": inserted,
                "duplicates": 0, "failed": 0, "errors": []}
    except Exception as batch_exc:
        if not _is_duplicate_error(batch_exc):
            # Not a duplicate (e.g. 42P10, CHECK violation, auth, network).
            # Fail closed and loud — never degrade to a silent partial write.
            raise
        print(
            f"[product-supply-expand] batch insert hit a duplicate (23505); "
            f"retrying {attempted} rows individually to preserve the non-duplicate rows",
            flush=True,
        )

    inserted = 0
    duplicates = 0
    failed = 0
    errors: list[str] = []
    for row in payload:
        try:
            result = insert_rows("pin_products", [row])
            inserted += len(result) if result else 1
        except Exception as row_exc:
            if _is_duplicate_error(row_exc):
                duplicates += 1
            else:
                failed += 1
                if len(errors) < 5:
                    errors.append(str(row_exc)[:300])

    if inserted == 0 and failed:
        # Nothing landed and it was not merely duplicates → surface the real error.
        raise RuntimeError(
            f"insert pin_products failed for all {attempted} rows "
            f"({failed} errors, {duplicates} duplicates); first error: "
            f"{errors[0] if errors else 'unknown'}"
        )
    return {"attempted": attempted, "inserted": inserted,
            "duplicates": duplicates, "failed": failed, "errors": errors}


class _IncrementalWriter:
    """Flush scraped candidates to pin_products every N source pins.

    THE FAILURE THIS REMOVES: the apply path used to write once, after the
    crawl loop and after `await browser.close()`. A run killed at 45/50 pins
    (2026-08-06, runner timeout) lost 100% of the 31 pins' products it had
    already scraped, because the write line was never reached.

    Each flush repeats the SAME filter chain the end-of-run write uses, in the
    same order, so an incremental write can never admit a row the old path
    would have rejected:

        accept_link()          → drops non-product / blocked URLs
        _dedup_key()           → in-batch AND cross-batch dedup (see below)
        _preflight_existing()  → lifecycle-aware DB existence check, unchanged
        _apply_rows()          → plain INSERT with per-row duplicate fallback

    CROSS-BATCH DEDUP: `self._seen_keys` is a process-lifetime set of
    `_dedup_key(candidate)` values — the exact key `_build_report` uses, which
    falls back to a title/merchant/image hash when a candidate has no usable
    URL. A key is added the moment its candidate is handed to `_apply_rows`,
    so a URL first seen in batch 1 is skipped in batch 3 without another DB
    round-trip. Using raw `normalized_product_url_hash` instead would let
    hash-less candidates duplicate across batches.

    ACCOUNTING: every flush's outcome is ADDED to running totals. Nothing is
    ever assigned, so no batch can overwrite an earlier batch's numbers — the
    exact way `_LAST_WRITE_OUTCOME` (cleared+rewritten per call) would lie if
    it were read once at the end.

    ONE BAD FLUSH DOES NOT END THE RUN: `_apply_rows` re-raises non-duplicate
    errors, and raises when nothing at all landed. A raised flush is caught,
    counted as `failed += attempted` for that batch, recorded in `errors` and
    `failedBatches`, logged loudly, and the crawl continues to the next pin.
    The failure is therefore always visible in the report — never swallowed.
    """

    # Cap stored error strings so a systematically failing DB cannot grow the
    # report unboundedly. The COUNTS stay exact; only the samples are capped.
    MAX_ERROR_SAMPLES = 10

    def __init__(self, *, batch_size: int, enabled: bool = True) -> None:
        self.batch_size = max(1, int(batch_size))
        self.enabled = enabled
        self._pending: list[dict] = []
        self._pins_since_flush = 0
        self._seen_keys: set[str] = set()
        self.batches_written = 0
        self.batches_failed = 0
        self.pins_flushed = 0
        self.totals: dict[str, Any] = {
            "attempted": 0,
            "inserted": 0,
            "duplicates": 0,
            "failed": 0,
            "errors": [],
        }
        self.failed_batches: list[dict] = []
        self.rejected_count = 0
        # Candidates refused by the product-evidence gate (no title AND no
        # image). Counted separately from accept_link rejections so an
        # operator can tell "not a product page" from "not product evidence".
        self.evidence_rejected_count = 0
        self.evidence_rejected_with_price = 0
        self.dedup_skipped_count = 0
        self.preflight_skipped_count = 0
        # Monotonic label for the log line ONLY. It counts flushes, including
        # those with nothing new to write, so journalctl never shows the same
        # "write batch N" twice — an operator reading a killed run's log has to
        # be able to tell two flushes apart. Report counters below deliberately
        # count only real write ATTEMPTS, which is a different question.
        self._flush_seq = 0
        self.empty_flushes = 0

    # ── intake ────────────────────────────────────────────────────────────
    def add_pin(self, per_pin_result: dict) -> None:
        """Queue one crawled pin's candidates; flush when the batch is full."""
        if not self.enabled:
            return
        self._pending.extend(per_pin_result.get("candidates") or [])
        self._pins_since_flush += 1
        if self._pins_since_flush >= self.batch_size:
            self.flush(reason="batch_full")

    def flush(self, *, reason: str) -> None:
        """Write whatever is queued. Safe to call with an empty queue.

        Log-field naming: the two lines below report `batchCandidates=`, NOT
        `candidates=`. The per-pin progress line ("12/100 pin=… candidates=15")
        already owns `candidates=`, and a batch line covers batchSizePins pins —
        so the batch number is a SUM of the per-pin numbers it follows. When both
        lines used the same field name, a grep-and-sum over the log counted every
        candidate exactly twice (a real 2026-08-14 misdiagnosis: 1077 + 1077 =
        2154). Distinct names make that addition impossible to perform by
        accident.
        """
        if not self.enabled:
            return
        pins_in_batch = self._pins_since_flush
        pending = self._pending
        self._pending = []
        self._pins_since_flush = 0
        if pins_in_batch == 0 and not pending:
            return
        self.pins_flushed += pins_in_batch
        self._flush_seq += 1
        batch_no = self._flush_seq

        evidence_rejected_before = self.evidence_rejected_count
        rows = self._filter_batch(pending)
        # Per-flush delta, so the operator sees what THIS batch discarded
        # rather than a running total that looks like it repeats.
        no_evidence = self.evidence_rejected_count - evidence_rejected_before
        evidence_note = (
            f" noProductEvidence={no_evidence} (bare links: no title, no image)"
            if no_evidence else ""
        )
        if not rows:
            self.empty_flushes += 1
            print(
                f"[product-supply-expand] write batch {batch_no} "
                f"({reason}): pins={pins_in_batch} batchCandidates={len(pending)} "
                f"newRows=0 written=0 cumulativeWritten={self.totals['inserted']}"
                f"{evidence_note}",
                flush=True,
            )
            return

        try:
            _apply_rows(rows)
        except Exception as exc:  # noqa: BLE001 — counted + reported, never swallowed
            self.batches_failed += 1
            attempted = len(rows)
            self.totals["attempted"] += attempted
            self.totals["failed"] += attempted
            detail = f"batch {batch_no}: {type(exc).__name__}: {str(exc)[:300]}"
            self._record_error(detail)
            self.failed_batches.append({
                "batch": batch_no,
                "reason": reason,
                "attemptedRows": attempted,
                "error": detail,
            })
            print(
                f"[product-supply-expand] WRITE BATCH {batch_no} FAILED ({reason}): "
                f"{attempted} rows did not land — {detail}. Crawl continues; this "
                f"failure IS counted in the report (cumulativeWritten="
                f"{self.totals['inserted']}).",
                flush=True,
            )
            return

        # _apply_rows just repopulated _LAST_WRITE_OUTCOME. Snapshot it NOW —
        # the next flush clears it. Accumulate, never assign.
        outcome = dict(_LAST_WRITE_OUTCOME)
        self.batches_written += 1
        self.totals["attempted"] += int(outcome.get("attempted") or 0)
        self.totals["inserted"] += int(outcome.get("inserted") or 0)
        self.totals["duplicates"] += int(outcome.get("duplicates") or 0)
        self.totals["failed"] += int(outcome.get("failed") or 0)
        for err in (outcome.get("errors") or []):
            self._record_error(f"batch {batch_no}: {err}")

        print(
            f"[product-supply-expand] write batch {batch_no} ({reason}): "
            f"pins={pins_in_batch} batchCandidates={len(pending)} newRows={len(rows)} "
            f"written={int(outcome.get('inserted') or 0)} "
            f"duplicates={int(outcome.get('duplicates') or 0)} "
            f"failed={int(outcome.get('failed') or 0)} "
            f"cumulativeWritten={self.totals['inserted']}"
            f"{evidence_note}",
            flush=True,
        )

    # ── internals ─────────────────────────────────────────────────────────
    def _record_error(self, message: str) -> None:
        if len(self.totals["errors"]) < self.MAX_ERROR_SAMPLES:
            self.totals["errors"].append(message)

    def _filter_batch(self, pending: list[dict]) -> list[dict]:
        """accept_link → in-batch/cross-batch dedup → DB preflight.

        Mirrors _build_report + _preflight_existing so the incremental path and
        the historical single write agree on what is writable.
        """
        accepted: list[dict] = []
        for candidate in pending:
            url = candidate.get("product_url") or ""
            if not url:
                self.rejected_count += 1
                continue
            ok, _reason = accept_link(url)
            if not ok:
                self.rejected_count += 1
                continue
            # Evidence gate — same predicate as _build_report, applied BEFORE
            # dedup so an evidence-less candidate cannot burn the _seen_keys
            # entry that a later, better candidate for the same URL needs.
            if _evidence_rejection_reason(candidate):
                self.evidence_rejected_count += 1
                if candidate.get("price"):
                    self.evidence_rejected_with_price += 1
                continue
            accepted.append(candidate)

        fresh: list[dict] = []
        for candidate in accepted:
            key = _dedup_key(candidate)
            if key in self._seen_keys:
                # Already written (or already attempted) earlier in this run.
                self.dedup_skipped_count += 1
                continue
            self._seen_keys.add(key)
            fresh.append(candidate)

        if not fresh:
            return []

        preflight = _preflight_existing(fresh)
        rows = preflight.get("insertCandidates", fresh)
        self.preflight_skipped_count += len(fresh) - len(rows)
        return rows

    # ── reporting ─────────────────────────────────────────────────────────
    def write_outcome(self) -> dict:
        """The accumulated equivalent of a single _apply_rows outcome."""
        return {
            "attempted": self.totals["attempted"],
            "inserted": self.totals["inserted"],
            "duplicates": self.totals["duplicates"],
            "failed": self.totals["failed"],
            "errors": list(self.totals["errors"]),
        }

    def batching_report(self) -> dict:
        """Per-run batching accounting for report['incrementalWrite']."""
        return {
            "enabled": self.enabled,
            "batchSizePins": self.batch_size,
            "flushes": self._flush_seq,
            "batchesAttempted": self.batches_written + self.batches_failed,
            "batchesWritten": self.batches_written,
            "batchesFailed": self.batches_failed,
            # Flushes where nothing survived accept_link/dedup/preflight, so no
            # write was attempted. Counted separately so `flushes` reconciles:
            # flushes == batchesAttempted + batchesWithNothingNewToWrite.
            "batchesWithNothingNewToWrite": self.empty_flushes,
            "pinsFlushed": self.pins_flushed,
            "rowsInserted": self.totals["inserted"],
            "rowsRejectedByAcceptLink": self.rejected_count,
            # Bare external links (no title AND no image). These are NOT
            # products and are never written; the count is surfaced so the
            # discard is visible in the report, not silent.
            "rowsRejectedNoProductEvidence": self.evidence_rejected_count,
            "rowsRejectedNoProductEvidenceWithPrice": self.evidence_rejected_with_price,
            "rowsSkippedCrossBatchDuplicate": self.dedup_skipped_count,
            "rowsSkippedAlreadyInDb": self.preflight_skipped_count,
            "failedBatches": list(self.failed_batches),
            "note": (
                "Rows are written every batchSizePins source pins, so a run "
                "killed mid-crawl keeps everything already flushed. Counts are "
                "cumulative across batches."
            ),
        }


# Residential-proxy support for the Shop-the-Look Playwright navigation. Reuses the
# SAME env var already validated for pin-crawl (PINTEREST_CRAWL_PROXY_URL). When it is
# absent/blank, STL navigation falls back to the current direct-from-datacenter-IP
# behaviour unchanged. The URL/credentials are NEVER logged (only presence + used flag).
CRAWL_PROXY_ENV = "PINTEREST_CRAWL_PROXY_URL"

# ---------------------------------------------------------------------------
# Authenticated session support.
#
# The Shop-the-Look module is auth-gated: measured on the same 3 pins with the
# same code path, an anonymous context yields 0 shop-keyword matches and 0
# product JSON responses, while an authenticated context yields 42-45 product
# JSON responses per pin. Running anonymously therefore reports "no products"
# for pins that DO have products — which is exactly how a rendering/auth failure
# once got mistaken for "the data source is exhausted".
#
# The session is a Playwright storage_state JSON captured from a real login. It
# holds live cookies and must never be committed or logged (see backend/.gitignore).
# ---------------------------------------------------------------------------
SESSION_PATH_ENV = "PINTEREST_SESSION_PATH"
DEFAULT_SESSION_FILENAME = "pinterest_session.json"
# Cookies that only exist for a logged-in Pinterest session.
AUTH_COOKIE_NAMES = frozenset({"_auth", "_pinterest_sess"})
# HTML markers of a logged-in Pinterest shell (checked in _verify_session_logged_in).
LOGGED_IN_MARKERS = (
    "header-profile",
    "headeraccountswitcher",
    '"is_authenticated":true',
    "user-menu",
)
# Markers that only appear on a logged-OUT shell.
LOGGED_OUT_MARKERS = ("unauth-header", "unauthhomepage")


def _stl_session_path() -> Path:
    """Resolve the storage_state path: PINTEREST_SESSION_PATH, else backend/pinterest_session.json."""
    raw = (os.environ.get(SESSION_PATH_ENV) or "").strip()
    return Path(raw) if raw else (ROOT / DEFAULT_SESSION_FILENAME)


def _load_session_state() -> dict:
    """Load the saved storage_state, returning a status dict — never raises.

    Returns keys:
      storageState : dict|None  -> pass to browser.new_context(storage_state=...)
      authenticated: bool       -> a session file with auth cookies was loaded
      sessionPath  : str        -> path we looked at (no cookie values, ever)
      issue        : str|None   -> session_file_missing / session_file_unreadable
                                   / session_file_no_auth_cookies
      cookieCount  : int
      authCookiesPresent: list[str]  (names only)

    A missing or unreadable file is NOT fatal: the run continues anonymously and
    the report records that it did, so a degraded run can never look like a
    clean "no products found" result.
    """
    path = _stl_session_path()
    status: dict[str, Any] = {
        "storageState": None,
        "authenticated": False,
        "sessionPath": str(path),
        "issue": None,
        "cookieCount": 0,
        "authCookiesPresent": [],
    }
    if not path.exists():
        status["issue"] = "session_file_missing"
        return status
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        # Record the exception TYPE only — the file content is secret material.
        status["issue"] = f"session_file_unreadable:{type(exc).__name__}"
        return status
    if not isinstance(data, dict) or not isinstance(data.get("cookies"), list):
        status["issue"] = "session_file_unreadable:malformed_storage_state"
        return status

    cookies = data["cookies"]
    names = {str(c.get("name") or "") for c in cookies if isinstance(c, dict)}
    present = sorted(AUTH_COOKIE_NAMES & names)
    status["cookieCount"] = len(cookies)
    status["authCookiesPresent"] = present
    status["storageState"] = data
    if not present:
        # File exists but carries no login cookies — treat as unauthenticated.
        status["issue"] = "session_file_no_auth_cookies"
        return status
    status["authenticated"] = True
    return status


async def _verify_session_logged_in(page) -> dict:
    """Check that the loaded session is actually still logged in.

    Must be called after a Pinterest page load. An expired session still has
    cookies on disk, so file-level checks are not sufficient — only the served
    page can tell us. Returns {"authValid": bool|None, "signal": str}.
    authValid is None when the check itself could not run (unknown, not "false").
    """
    try:
        url = (page.url or "").lower()
        if "/login" in url or "/signup" in url or "business/convert" in url:
            return {"authValid": False, "signal": "redirected_to_login"}
        html = ((await page.content()) or "").lower()
    except Exception as exc:
        return {"authValid": None, "signal": f"probe_failed:{type(exc).__name__}"}

    if not html:
        return {"authValid": None, "signal": "empty_html"}
    # Logged-out shells advertise themselves loudly.
    if any(marker in html for marker in LOGGED_OUT_MARKERS):
        return {"authValid": False, "signal": "unauth_header_present"}
    for marker in LOGGED_IN_MARKERS:
        if marker in html:
            return {"authValid": True, "signal": f"marker:{marker}"}
    if "log in" in html and "sign up" in html and "createpinbutton" not in html:
        return {"authValid": False, "signal": "login_signup_cta_present"}
    return {"authValid": None, "signal": "no_conclusive_marker"}


def _build_v28_status() -> dict:
    """Run _check_v28_schema() and assemble the report's v28SchemaCheck dict.

    Read-only probe; never raises (SchemaCheckUnavailable is caught here and
    folded into the "unknown_db_unreachable" verdict). Callers that need to
    fail closed on a bad verdict do so themselves — this function only reports.
    """
    v28_unavailable_reason: str | None = None
    try:
        v28_ok, v28_missing = _check_v28_schema()
    except SchemaCheckUnavailable as exc:
        v28_ok, v28_missing = False, []
        v28_unavailable_reason = str(exc)

    return {
        "columnsChecked": list(V28_REQUIRED_COLUMNS),
        "allPresent": v28_ok,
        "missingColumns": v28_missing,
        # None = the probe answered. A string = we never found out.
        "schemaCheckUnavailable": v28_unavailable_reason,
        "verdict": (
            "unknown_db_unreachable" if v28_unavailable_reason
            else ("all_present" if v28_ok else "columns_missing")
        ),
        "noteIndexNotChecked": "unique index on normalized_product_url_hash cannot be verified via PostgREST; must confirm manually before apply",
    }


def _enforce_v28_status(v28_status: dict) -> None:
    """Raise the apply-mode fail-closed errors implied by an already-built v28_status.

    Kept byte-for-byte identical to the historical inline checks so error
    messages/types are unaffected by when the schema probe ran.
    """
    if v28_status["schemaCheckUnavailable"]:
        # Deliberately does NOT say "migration has not been applied" and does
        # NOT tell anyone to run a migration: we have no evidence for either.
        raise SchemaCheckUnavailable(
            "unable to confirm schema (database connection failed) — the "
            "pin_products column probe never completed, so this run cannot "
            "safely write. The schema was NOT determined to be wrong; retry "
            f"when the database is reachable. Details: {v28_status['schemaCheckUnavailable']}"
        )

    if not v28_status["allPresent"]:
        raise RuntimeError(
            f"v28 migration has not been applied — missing columns: {v28_status['missingColumns']}. "
            "Run migrate_v28_product_supply_expansion.sql before --apply."
        )


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
        # Two independent memories of "we already scraped this pin", UNIONED:
        #   spike log  — the historical local JSON. Kept: it is still valid on
        #                the host that produced it, and dropping it would lose
        #                whatever that host knows.
        #   pin_products — the database. The only record that survives a host
        #                change, and the one that was missing (260 already
        #                scraped pins were being re-offered every run).
        # A DB failure raises ScrapedPinHistoryUnavailable and aborts BEFORE the
        # browser starts: selecting without the exclusion list would just
        # re-scrape spent pins for ~25 minutes and call it a run.
        prior_ids = _load_previous_spike_ids()
        scraped_ids = _load_scraped_source_pin_ids()
        avoid_ids = prior_ids | scraped_ids
        print(
            f"[product-supply-expand] excluding {len(avoid_ids)} already-scraped "
            f"source pins (spikeLog={len(prior_ids)}, database={len(scraped_ids)}, "
            f"overlap={len(prior_ids & scraped_ids)})",
            flush=True,
        )
        sources, selection = select_source_pins(
            category_mix=mix,
            since_hours=since_hours,
            avoid_pin_ids=avoid_ids,
            avoid_sources={
                "spikeLog": len(prior_ids),
                "database": len(scraped_ids),
                "overlap": len(prior_ids & scraped_ids),
                "union": len(avoid_ids),
            },
        )
        if len(sources) != limit:
            selection["warning"] = f"selected {len(sources)} of requested {limit} source pins"

    state: dict[str, Any] = {
        "pin_id": None,
        "chip_label": None,
        "network": [],
        "productJsonResponses": 0,
        "responseErrors": 0,
        "responseErrorSamples": [],
    }
    per_pin: list[dict] = []
    started = time.monotonic()

    # v28 schema check — a pure read-only preflight (probes column presence).
    # In apply mode it must run BEFORE any browser/crawl work starts: crawling
    # is ~25 minutes for 50 pins, and finding out afterwards that the schema
    # probe failed (or the migration is missing) means that entire run is
    # discarded for nothing. In dry-run mode nothing is written, so the check
    # stays where it always ran (after the crawl, informational only) — see
    # below near report assembly.
    v28_status: dict | None = None
    if apply:
        v28_status = _build_v28_status()
        _enforce_v28_status(v28_status)

    # Incremental writer: flushes every N source pins in apply mode, disabled in
    # dry-run (which must remain a strict read-only path). Constructed here so
    # the batch size is fixed for the whole run and appears in the report even
    # when the crawl produces nothing.
    writer = _IncrementalWriter(batch_size=_stl_write_batch_size(), enabled=apply)
    if apply:
        print(
            f"[product-supply-expand] incremental write ON — flushing every "
            f"{writer.batch_size} source pins (env {STL_WRITE_BATCH_SIZE_ENV}). "
            "A timeout kill now costs at most one unflushed batch.",
            flush=True,
        )

    # Route STL navigation through the residential proxy when configured (same env
    # var as pin-crawl). Presence + used flag only — never the URL or credentials.
    proxy_opt = _stl_proxy_option()
    print(f"[stl] proxy present={bool((os.environ.get(CRAWL_PROXY_ENV) or '').strip())} "
          f"| STL proxy used={proxy_opt is not None}")

    # Load the authenticated Pinterest session. The shopping module is auth-gated,
    # so an anonymous run systematically under-reports products. Never fatal: we
    # continue anonymously but flag the run so the numbers are not read as truth.
    session = _load_session_state()
    if session["authenticated"]:
        print(f"[stl] session loaded from {session['sessionPath']} "
              f"| cookies={session['cookieCount']} "
              f"| auth cookies={','.join(session['authCookiesPresent'])}")
    else:
        print("[stl] !! WARNING: running UNAUTHENTICATED "
              f"({session['issue']}) at {session['sessionPath']} — the Shop-the-Look "
              "module is auth-gated, so product counts from this run are NOT "
              "evidence that these pins have no products.", flush=True)

    async with async_playwright() as pw:
        launch_kwargs: dict[str, Any] = {
            "headless": True,
            "args": ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        }
        if proxy_opt is not None:
            launch_kwargs["proxy"] = proxy_opt
        browser = await pw.chromium.launch(**launch_kwargs)
        context_kwargs: dict[str, Any] = {
            "viewport": {"width": 1380, "height": 1700},
            "locale": "en-US",
            "user_agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                           "AppleWebKit/537.36 (KHTML, like Gecko) "
                           "Chrome/124.0.0.0 Safari/537.36"),
        }
        if session.get("storageState") is not None:
            context_kwargs["storage_state"] = session["storageState"]
        context = await browser.new_context(**context_kwargs)
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
                if state.get("pin_id") == pin_id:
                    state["productJsonResponses"] = int(state.get("productJsonResponses") or 0) + 1
                    if candidates:
                        state["network"].extend(candidates[:500])
            except Exception as exc:
                # Do not swallow: a run where every response failed to parse looks
                # identical to a run with no products unless we count these.
                state["responseErrors"] = int(state.get("responseErrors") or 0) + 1
                samples = state.setdefault("responseErrorSamples", [])
                if len(samples) < 10:
                    # Type + message only; never the response body or any cookie/token.
                    samples.append(f"{type(exc).__name__}:{str(exc)[:120]}")
                return

        page.on("response", lambda response: asyncio.create_task(on_response(response)))
        auth_check: dict = {"authValid": None, "signal": "not_checked"}
        try:
            await page.goto("https://www.pinterest.com", wait_until="domcontentloaded", timeout=30_000)
            await asyncio.sleep(1.5)
            auth_check = await _verify_session_logged_in(page)
        except Exception as exc:
            auth_check = {"authValid": None, "signal": f"landing_load_failed:{type(exc).__name__}"}

        session_health = {
            "sessionFileLoaded": session.get("storageState") is not None,
            "sessionPath": session.get("sessionPath"),
            "cookieCount": session.get("cookieCount", 0),
            "authCookiesPresent": session.get("authCookiesPresent", []),
            "authValid": auth_check.get("authValid"),
            "authSignal": auth_check.get("signal"),
            "issue": session.get("issue"),
        }
        # An EXPIRED session must never masquerade as "no products found".
        if session["authenticated"] and auth_check.get("authValid") is False:
            session_health["issue"] = "session_expired"
            print("[stl] !!!! SESSION EXPIRED !!!! the saved Pinterest session is no "
                  f"longer logged in (signal={auth_check.get('signal')}). The "
                  "Shop-the-Look module is auth-gated: every pin in this run will "
                  "look empty REGARDLESS of whether it has products. Re-capture "
                  f"{session.get('sessionPath')} before trusting any result below.",
                  flush=True)
        elif not session["authenticated"]:
            session_health["issue"] = session.get("issue") or "unauthenticated"

        for index, source in enumerate(sources, 1):
            result = await _extract_source_pin(page, source, state)
            per_pin.append(result)
            print(
                f"[product-supply-expand] {index}/{len(sources)} pin={source.get('pin_id')} "
                f"category={source.get('category')} shop={result.get('shopModuleDetected', False)} "
                f"candidates={len(result.get('candidates', []))} "
                f"productJson={result.get('productJsonResponses', 0)} "
                f"tabs={result.get('tabCount', 0)} cards={result.get('visibleCardCount', 0)} "
                f"renderFailure={result.get('renderFailure', False)} "
                f"issue={result.get('issue')}",
                flush=True,
            )
            # Write INSIDE the loop (apply mode only). A tree-kill at pin 45/50
            # must not discard the 44 pins already harvested — which is exactly
            # what happened on 2026-08-06 when the only write lived below
            # browser.close(). Never raises: a failed batch is counted and the
            # crawl continues.
            writer.add_pin(result)
        # Tail batch: whatever is left below batch_size still has to land.
        writer.flush(reason="final")
        await browser.close()

    elapsed = time.monotonic() - started

    # v28 schema check — result included in report either way.
    # apply mode already ran this (and fail-closed on a bad verdict) before the
    # crawl started, above; reuse that result rather than probing twice.
    # dry-run mode never writes, so the check runs here instead: informational
    # only, never blocks.
    # Three outcomes, never conflated:
    #   verified present  -> proceed
    #   verified missing  -> real schema defect; naming the migration is correct
    #   unverifiable      -> say so; NEVER assert a defect we did not observe
    if v28_status is None:
        v28_status = _build_v28_status()

    # `unique` is reporting-only now: the apply path no longer writes from it
    # (the incremental writer already did, batch by batch, during the crawl).
    report, _unique = _build_report(
        per_pin, selection,
        elapsed=elapsed,
        apply=apply,
        source_report_validation=source_report_validation,
        session_health=session_health,
        response_errors={
            "count": int(state.get("responseErrors") or 0),
            "samples": list(state.get("responseErrorSamples") or []),
        },
    )
    report["v28SchemaCheck"] = v28_status

    report.pop("_insertCandidates", None)
    if apply:
        # All writing already happened inside the crawl loop (see writer.add_pin
        # / writer.flush). Nothing is written here — a second write at this point
        # would re-attempt the whole run and make the report lie about volume.
        #
        # Honest write accounting: totals are SUMMED across every batch, so a
        # later batch can never overwrite an earlier one's numbers. Every row we
        # attempted is inserted / duplicate / failed; a silent shortfall is not
        # possible, and a batch that raised is counted in failed + failedBatches.
        report["writes"]["pin_products"] = writer.totals["inserted"]
        report["writeOutcome"] = writer.write_outcome()
        report["incrementalWrite"] = writer.batching_report()
        # The preflight block above was computed AFTER those writes landed, so
        # it sees this run's own rows as pre-existing. Say so, loudly, rather
        # than let "projectedInsertCount: 0" sit next to "writes: 31" as an
        # apparent contradiction.
        if isinstance(report.get("preflight"), dict):
            report["preflight"]["note"] = (
                "apply mode: computed AFTER the incremental writes completed, so "
                "rows this run just inserted are counted as already-existing. "
                "Use writeOutcome/incrementalWrite for what this run actually "
                "wrote; these projections are not a pre-write plan in apply mode."
            )

    # Built LAST, after incrementalWrite is attached: the write half of the funnel
    # does not exist until the apply block above has run.
    report["funnel"] = _build_funnel(report)

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(tz=timezone.utc).strftime("%Y%m%d_%H%M%S")
    path = LOG_DIR / f"product_supply_expand_shop_the_look_{stamp}.json"
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    latest = LOG_DIR / "product_supply_expand_shop_the_look_latest.json"
    latest.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    report["reportPath"] = str(path)
    return report
