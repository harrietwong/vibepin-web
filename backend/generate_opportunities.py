"""
generate_opportunities.py
─────────────────────────
Populates the `opportunities` table from `trend_keywords` + `trend_opportunities_view`,
then builds the three relation tables:
  - opportunity_keywords  (keyword → opportunity)
  - opportunity_pins      (top evidence pins)
  - opportunity_products  (top product signals)

Usage:
  python generate_opportunities.py                      # process all active keywords
  python generate_opportunities.py --category fashion   # single category
  python generate_opportunities.py --dry-run            # compute + print, no DB writes
  python generate_opportunities.py --limit 50           # cap keywords processed
  python generate_opportunities.py --verbose            # detailed logging

Label mapping (replaces old blue_ocean / hot_red_sea / etc.):
  primary_label  → Best Bet | Steady | Competitive
  trend_state    → Rising   | Evergreen | Seasonal

Internal reason codes written to internal_reason_codes JSONB (not shown in UI):
  blue_ocean, early_trend, hot_red_sea, hidden_supply, new_account_friendly,
  oversaturated, low_volume
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(_ROOT))
sys.path.insert(0, str(_ROOT / "db"))
from category_percentiles import CategoryPercentileIndex  # noqa: E402
from content_filters import get_filter_stats  # noqa: E402
from opportunity_readiness import (  # noqa: E402
    adjust_primary_label,
    adjust_trend_state_display,
    availability_tier,
    build_readiness_payload,
    effective_product_count,
    readiness_score_adjustment,
)
from db import DB

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ── Thresholds ────────────────────────────────────────────────────────────────

VOLUME_RANK = {"very_high": 4, "high": 3, "medium": 2, "low": 1, None: 0}

TOP_PINS_PER_OPP     = 3  # opportunity_pins rows per opportunity
TOP_PRODUCTS_PER_OPP = 3  # opportunity_products rows per opportunity

# primary_label thresholds
BEST_BET_YOY    = 150   # % YoY growth
BEST_BET_VOLUME = 2     # VOLUME_RANK >= medium
COMPETITIVE_PIN_THRESHOLD = 80  # linked_pins_count above which = competitive

# trend_state thresholds
RISING_YOY_MIN    = 80    # % — anything above is "Rising"
EVERGREEN_WEEKS   = 8     # consecutive weeks within ±20 of baseline → Evergreen
SEASONAL_PEAK_MIN = 40    # peak/trough diff in 52w timeseries → Seasonal


# ── Helpers ───────────────────────────────────────────────────────────────────

def _volume_rank(level: str | None) -> int:
    return VOLUME_RANK.get(level, 0)


def _demand_score(row: dict) -> float:
    """0–100 raw demand signal."""
    vol   = _volume_rank(row.get("search_volume_level")) * 20       # 0–80
    yoy   = min(float(row.get("yearly_change") or 0), 500) / 500 * 15  # 0–15
    wow   = max(0.0, min(float(row.get("weekly_change") or 0), 50)) / 50 * 5  # 0–5
    return round(vol + yoy + wow, 2)


def _competition_band(linked_pins: int, competition_level: str | None) -> str:
    """Low | Medium | High — uses both pin count and explicit competition_level."""
    if competition_level in ("Low", "low"):
        return "Low"
    if competition_level in ("High", "high"):
        return "High"
    # fallback from pin count
    if linked_pins >= COMPETITIVE_PIN_THRESHOLD:
        return "High"
    if linked_pins >= 20:
        return "Medium"
    return "Low"


def _shop_signal_band(linked_products: int) -> str:
    if linked_products >= 5:
        return "Strong"
    if linked_products >= 2:
        return "Moderate"
    if linked_products >= 1:
        return "Weak"
    return "None"


def _reference_signal_band(linked_pins: int) -> str:
    if linked_pins >= 30:
        return "Strong"
    if linked_pins >= 10:
        return "Moderate"
    if linked_pins >= 3:
        return "Weak"
    return "None"


def _primary_label(
    yoy: float,
    volume_level: str | None,
    linked_pins: int,
    linked_products: int,
    competition_level: str | None,
) -> str:
    """Best Bet | Steady | Competitive."""
    comp = _competition_band(linked_pins, competition_level)

    # Competitive first — high competition overrides everything
    if comp == "High" and linked_pins >= COMPETITIVE_PIN_THRESHOLD:
        return "Competitive"

    # Best Bet: strong demand + not overrun
    if (
        yoy >= BEST_BET_YOY
        and _volume_rank(volume_level) >= BEST_BET_VOLUME
        and comp != "High"
    ):
        return "Best Bet"

    # Steady: everything else with at least some signal
    return "Steady"


def _trend_state(
    yoy: float,
    weekly_change: float,
    trend_lifecycle: str | None,
    trend_history: list | None,
) -> str:
    """Rising | Evergreen | Seasonal — in priority order."""
    # 1. Prefer explicit lifecycle classification if available and confident
    lifecycle = (trend_lifecycle or "").lower()
    if lifecycle == "rising":
        return "Rising"
    if lifecycle == "seasonal":
        return "Seasonal"
    if lifecycle == "evergreen":
        return "Evergreen"

    # 2. Derive from numeric signals when lifecycle is unclear / missing
    if yoy >= RISING_YOY_MIN and weekly_change > 0:
        return "Rising"

    # trend_history formats:
    #   list of dicts: [{"date": "2025-06-09", "value": 36}, ...]  ← Pinterest API
    #   list of numbers: [36, 40, ...]
    #   dict: {"1": 36, "2": 40, ...}
    def _extract_numeric(th: list | dict) -> list[float]:
        if isinstance(th, dict):
            return [float(v) for v in th.values() if v is not None]
        result = []
        for item in th:
            if isinstance(item, dict):
                v = item.get("value")
            else:
                v = item
            if v is not None:
                result.append(float(v))
        return result

    hist_values = _extract_numeric(trend_history) if trend_history else []
    if hist_values and len(hist_values) >= EVERGREEN_WEEKS:
        values = hist_values
        if values:
            peak   = max(values)
            trough = min(values)
            if peak - trough >= SEASONAL_PEAK_MIN:
                return "Seasonal"

            baseline = sum(values) / len(values)
            in_range = sum(1 for v in values if abs(v - baseline) <= 20)
            if in_range >= EVERGREEN_WEEKS:
                return "Evergreen"

    return "Evergreen"  # safe default when evidence is thin


def _evidence_sentence(
    keyword: str,
    yoy: float,
    weekly_change: float,
    linked_pins: int,
    linked_products: int,
    volume_level: str | None,
    total_saves: int,
) -> str:
    parts: list[str] = []
    if volume_level in ("very_high", "high"):
        parts.append(f"high Pinterest search interest")
    if yoy >= 50:
        parts.append(f"{int(yoy)}% year-over-year growth")
    if weekly_change > 5:
        parts.append(f"rising {int(weekly_change)}% this week")
    if total_saves >= 10_000:
        parts.append(f"{total_saves:,} saves across linked Pins")
    elif total_saves >= 1_000:
        parts.append(f"{total_saves:,} saves")
    if linked_products >= 5:
        parts.append(f"{linked_products} verified products")
    elif linked_products >= 1:
        parts.append(f"{linked_products} product signal")
    if linked_pins >= 20:
        parts.append(f"{linked_pins} high-save Pins")

    if not parts:
        return f"Emerging opportunity in {keyword}."

    return f"{keyword.title()} shows {', '.join(parts[:3])}."


def _internal_reason_codes(
    yoy: float,
    linked_pins: int,
    linked_products: int,
    total_saves: int,
    volume_level: str | None,
    competition_level: str | None,
) -> dict:
    comp     = _competition_band(linked_pins, competition_level)
    vol_rank = _volume_rank(volume_level)

    blue_ocean = (
        yoy >= 200
        and (total_saves >= 5000 or vol_rank >= 4)
        and linked_pins <= 30
    )
    early_trend  = not blue_ocean and yoy >= 100 and linked_pins <= 100
    hot_red_sea  = comp == "High" and linked_pins >= COMPETITIVE_PIN_THRESHOLD
    hidden_supply = linked_products == 0 and linked_pins >= 5 and yoy >= 50
    new_account_friendly = vol_rank <= 2 and comp == "Low" and yoy >= 20
    oversaturated = linked_pins > 200 or comp == "High"
    low_volume    = vol_rank <= 1 and total_saves < 500

    return {
        "blue_ocean":            blue_ocean,
        "early_trend":           early_trend,
        "hot_red_sea":           hot_red_sea,
        "hidden_supply":         hidden_supply,
        "new_account_friendly":  new_account_friendly,
        "oversaturated":         oversaturated,
        "low_volume":            low_volume,
    }


def _confidence_score(
    linked_pins: int,
    linked_products: int,
    total_saves: int,
    has_trend_history: bool,
) -> float:
    """0.0–1.0 overall data confidence."""
    score = 0.0
    if has_trend_history:
        score += 0.25
    if total_saves >= 5000:
        score += 0.30
    elif total_saves >= 500:
        score += 0.15
    if linked_products >= 5:
        score += 0.25
    elif linked_products >= 1:
        score += 0.10
    if linked_pins >= 10:
        score += 0.20
    elif linked_pins >= 3:
        score += 0.10
    return round(min(score, 1.0), 3)


def _normalize_keyword(kw: str) -> str:
    import unicodedata
    nfd = unicodedata.normalize("NFD", kw.lower().strip())
    return "".join(c for c in nfd if unicodedata.category(c) != "Mn")


# ── Main build logic ──────────────────────────────────────────────────────────

def _load_view_rows(db: DB, category: str | None) -> dict[str, dict]:
    """Return view rows keyed by keyword_id (uuid string)."""
    filters: dict[str, Any] = {}
    if category:
        filters["category"] = f"eq.{category}"

    rows = db.select_many(
        "trend_opportunities_view",
        columns=(
            "keyword_id,keyword,category,pct_growth_yoy,weekly_change,"
            "search_volume_level,linked_pins_count,linked_products_count,"
            "total_source_saves,opportunity_score,avg_velocity_score,"
            "trend_lifecycle,top_product_ids"
        ),
        filters=filters,
        limit=5000,
    )
    return {r["keyword_id"]: r for r in (rows or [])}


def _load_keyword_rows(db: DB, category: str | None, limit: int) -> list[dict]:
    """trend_keywords rows with useful volume / history data."""
    filters: dict[str, Any] = {"status": "eq.active"}
    if category:
        filters["category"] = f"eq.{category}"

    rows = db.select_many(
        "trend_keywords",
        columns=(
            "id,keyword,category,subcategory,yearly_change,weekly_change,"
            "search_volume_level,trend_lifecycle,trend_history,"
            "competition_level,priority_score,is_seed"
        ),
        filters=filters,
        order="priority_score.desc.nullslast",
        limit=limit,
    )
    return [r for r in (rows or []) if not r.get("is_seed")]


_BATCH = 50  # max keyword IDs per in.() query (keeps URLs under ~4KB)


def _load_pins_for_keywords(db: DB, keyword_ids: list[str]) -> dict[str, list[dict]]:
    """Top evidence pins keyed by trend_keyword_id. Batched to avoid URI-too-long."""
    if not keyword_ids:
        return {}

    pin_map: dict[str, list[dict]] = {}
    for i in range(0, len(keyword_ids), _BATCH):
        chunk = keyword_ids[i : i + _BATCH]
        id_list = ",".join(f'"{kid}"' for kid in chunk)
        rows = db.select_many(
            "pin_samples",
            columns="id,trend_keyword_id,image_url,save_count,save_velocity,is_reference_eligible",
            filters={
                "trend_keyword_id": f"in.({id_list})",
                "save_count":       "gte.100",
                "image_url":        "not.is.null",
            },
            order="save_count.desc",
            limit=min(len(chunk) * 20, 500),
        )
        for r in (rows or []):
            kid = r.get("trend_keyword_id")
            if kid:
                pin_map.setdefault(kid, []).append(r)

    return pin_map


def _load_products_for_keywords(db: DB, keyword_ids: list[str]) -> dict[str, list[dict]]:
    """Top product signals keyed by keyword_id (via keyword_product_map)."""
    if not keyword_ids:
        return {}

    # Batch keyword_product_map lookup to avoid URI-too-long
    all_kpm_rows: list[dict] = []
    for i in range(0, len(keyword_ids), _BATCH):
        chunk = keyword_ids[i : i + _BATCH]
        id_list = ",".join(f'"{kid}"' for kid in chunk)
        rows = db.select_many(
            "keyword_product_map",
            columns="keyword_id,product_id,relevance_score",
            filters={"keyword_id": f"in.({id_list})"},
            order="relevance_score.desc",
            limit=min(len(chunk) * 20, 1000),
        )
        all_kpm_rows.extend(rows or [])

    if not all_kpm_rows:
        return {}

    # Fetch product details in batches
    product_ids = list({r["product_id"] for r in all_kpm_rows})
    prod_map: dict[str, dict] = {}
    for i in range(0, len(product_ids), _BATCH):
        chunk_pids = product_ids[i : i + _BATCH]
        pid_list = ",".join(f'"{pid}"' for pid in chunk_pids)
        prods = db.select_many(
            "pin_products",
            columns="id,product_name,domain,image_url,source_url,save_count,product_type,seed_keyword",
            filters={"id": f"in.({pid_list})"},
        )
        for p in (prods or []):
            prod_map[p["id"]] = p

    result: dict[str, list[dict]] = {}
    for row in all_kpm_rows:
        kid = row["keyword_id"]
        pid = row["product_id"]
        prod = prod_map.get(pid)
        if prod:
            entry = {**prod, "relevance_score": row["relevance_score"]}
            result.setdefault(kid, []).append(entry)
    return result


def _build_opportunity(
    kw_row: dict,
    view_row: dict | None,
    pins: list[dict],
    products: list[dict],
    *,
    keyword_id: str,
    percentile_index: CategoryPercentileIndex | None = None,
) -> dict:
    keyword   = kw_row["keyword"]
    yoy       = float(kw_row.get("yearly_change") or 0)
    wow       = float(kw_row.get("weekly_change") or 0)
    vol_level = kw_row.get("search_volume_level")
    lifecycle = kw_row.get("trend_lifecycle")
    category  = kw_row.get("category")
    subcategory = kw_row.get("subcategory")
    comp_level  = kw_row.get("competition_level")

    history_raw = kw_row.get("trend_history")
    trend_history: list | None = None
    if isinstance(history_raw, str):
        try:
            trend_history = json.loads(history_raw)
        except Exception:
            trend_history = None
    elif isinstance(history_raw, list):
        trend_history = history_raw

    # prefer view aggregates where available
    linked_pins     = int((view_row or {}).get("linked_pins_count")     or 0)
    linked_products = int((view_row or {}).get("linked_products_count") or len(products))
    total_saves     = int((view_row or {}).get("total_source_saves")    or 0)
    opp_score       = float((view_row or {}).get("opportunity_score")   or _demand_score(kw_row))

    primary_label = _primary_label(yoy, vol_level, linked_pins, linked_products, comp_level)
    trend_state   = _trend_state(yoy, wow, lifecycle, trend_history)
    rising = trend_state == "Rising" or (yoy >= RISING_YOY_MIN and wow > 0)

    pin_evidence_count = len(pins) if pins else linked_pins
    reference_eligible_count = sum(1 for p in pins if p.get("is_reference_eligible"))
    if not pins and linked_pins:
        pin_evidence_count = linked_pins

    velocities = [float(p["save_velocity"]) for p in pins if p.get("save_velocity") is not None]
    avg_velocity = round(sum(velocities) / len(velocities), 2) if velocities else None
    trend_score = float((view_row or {}).get("avg_trend_score") or min(yoy, 500) / 500 * 100)
    freshness_score = float((view_row or {}).get("avg_freshness_score") or 0)

    percentile_metrics = None
    if percentile_index and pins:
        top = pins[0]
        percentile_metrics = percentile_index.metrics_for_pin(top)

    readiness = build_readiness_payload(
        opportunity_id=None,
        keyword_id=keyword_id,
        category=category,
        pin_evidence_count=pin_evidence_count,
        reference_eligible_count=reference_eligible_count,
        total_saves=total_saves,
        avg_save_velocity=avg_velocity,
        trend_score=trend_score,
        freshness_score=freshness_score,
        products=products,
        percentile_metrics=percentile_metrics,
        rising=rising,
    )

    product_tier = readiness["productAvailabilityTier"]
    reference_tier = readiness["referenceAvailabilityTier"]
    readiness_status = readiness["readinessStatus"]

    primary_label = adjust_primary_label(primary_label, readiness_status, product_tier)
    trend_state = adjust_trend_state_display(trend_state, readiness_status, rising)

    opp_score = readiness_score_adjustment(
        opp_score,
        product_tier=product_tier,
        reference_tier=reference_tier,
        products_with_url=readiness["productsWithUrlCount"],
        products_with_image=readiness["productsWithImageCount"],
        category_match=readiness["productCategoryMatchCount"],
    )

    internal = _internal_reason_codes(
        yoy, linked_pins, linked_products, total_saves, vol_level, comp_level
    )
    internal["readiness"] = readiness
    internal["effectiveProductCount"] = readiness["effectiveProductCount"]

    return {
        "title":                 keyword,
        "canonical_keyword":     keyword,
        "normalized_keyword":    _normalize_keyword(keyword),
        "category":              category,
        "subcategory":           subcategory,
        "primary_label":         primary_label,
        "trend_state":           trend_state,
        "evidence_sentence":     _evidence_sentence(
            keyword, yoy, wow, linked_pins, linked_products, vol_level, total_saves
        ),
        "score":                 round(opp_score, 2),
        "confidence_score":      _confidence_score(
            linked_pins, linked_products, total_saves, bool(trend_history)
        ),
        "search_interest_band":  {4: "Very High", 3: "High", 2: "Medium", 1: "Low"}.get(
            _volume_rank(vol_level), "Low"
        ),
        "competition_band":      _competition_band(linked_pins, comp_level),
        "shop_signal_band":      _shop_signal_band(linked_products),
        "reference_signal_band": _reference_signal_band(linked_pins),
        "why_this_opportunity":  None,   # reserved for GPT enrichment pass
        "created_from":          "trend_keywords",
        "internal_reason_codes": json.dumps(internal),
        "last_computed_at":      datetime.now(timezone.utc).isoformat(),
        "is_seed":               False,
    }


def _upsert_opportunity(db: DB, opp: dict) -> str | None:
    """Upsert by (canonical_keyword, category), return id."""
    existing = db.select_one(
        "opportunities",
        columns="id",
        filters={
            "canonical_keyword": f"eq.{opp['canonical_keyword']}",
            "category":          f"eq.{opp['category'] or ''}",
        },
    )
    if existing:
        opp_id = existing["id"]
        db.update_where(
            "opportunities",
            data={k: v for k, v in opp.items() if k not in ("created_from",)},
            filters={"id": f"eq.{opp_id}"},
        )
        return opp_id

    try:
        result = db.upsert("opportunities", opp, on_conflict="canonical_keyword,category", returning="id")
    except RuntimeError as e:
        if "[400]" in str(e) or "42P10" in str(e):
            # No unique constraint on the view alias — plain insert
            result = db.upsert("opportunities", opp, on_conflict="", returning="id")
        else:
            raise
    if result and isinstance(result, list) and result:
        return result[0].get("id")
    return None


def _safe_insert(db: DB, table: str, data: dict, on_conflict: str) -> None:
    """Insert with graceful conflict handling.

    Tries upsert with on_conflict first (requires unique constraint).
    Falls back to plain insert; swallows 409 duplicate-key errors silently.
    Swallows 400 'no constraint' errors (schema not fully migrated).
    """
    import httpx
    try:
        db.upsert(table, data, on_conflict=on_conflict)
        return
    except RuntimeError as e:
        msg = str(e)
        # 400 = no matching unique constraint, 409 = duplicate key — both are safe to skip
        if "[400]" in msg or "[409]" in msg or "42P10" in msg or "23505" in msg:
            pass  # fall through to plain insert
        else:
            raise

    # Plain insert (no on_conflict resolution)
    try:
        db.upsert(table, data, on_conflict="")
    except RuntimeError as e:
        msg = str(e)
        if "[409]" in msg or "23505" in msg:
            pass  # already exists — skip
        else:
            raise


def _upsert_relations(
    db: DB,
    opp_id: str,
    kw_id: str,
    pins: list[dict],
    products: list[dict],
) -> None:
    # opportunity_keywords
    _safe_insert(db, "opportunity_keywords", {
        "opportunity_id":  opp_id,
        "keyword_id":      kw_id,
        "relevance_score": 1.0,
    }, on_conflict="opportunity_id,keyword_id")

    # opportunity_pins — top N by save_count
    for rank, pin in enumerate(pins[:TOP_PINS_PER_OPP]):
        role = "reference_candidate" if pin.get("is_reference_eligible") else "evidence"
        _safe_insert(db, "opportunity_pins", {
            "opportunity_id":  opp_id,
            "pin_id":          pin["id"],
            "role":            role,
            "relevance_score": round(1.0 - rank * 0.1, 2),
        }, on_conflict="opportunity_id,pin_id")

    # opportunity_products — top N by relevance_score
    for rank, prod in enumerate(products[:TOP_PRODUCTS_PER_OPP]):
        _safe_insert(db, "opportunity_products", {
            "opportunity_id":  opp_id,
            "product_id":      prod["id"],
            "role":            "signal",
            "relevance_score": prod.get("relevance_score", round(1.0 - rank * 0.1, 2)),
        }, on_conflict="opportunity_id,product_id")


# ── Entry point ───────────────────────────────────────────────────────────────

def run(
    category: str | None = None,
    limit: int = 2000,
    dry_run: bool = False,
    verbose: bool = False,
) -> None:
    db = DB()

    log.info("Loading keyword rows (limit=%d, category=%s) …", limit, category or "all")
    kw_rows = _load_keyword_rows(db, category, limit)
    log.info("Loaded %d keyword rows", len(kw_rows))

    keyword_ids = [r["id"] for r in kw_rows]
    kw_seed_cat = {r["keyword"]: r.get("category") for r in kw_rows}

    log.info("Loading trend_opportunities_view …")
    view_map = _load_view_rows(db, category)
    log.info("View rows available: %d", len(view_map))

    log.info("Loading pin evidence …")
    pin_map = _load_pins_for_keywords(db, keyword_ids)

    log.info("Loading product signals …")
    prod_map = _load_products_for_keywords(db, keyword_ids)

    log.info("Building category percentile index …")
    sample_pins = db.select_many(
        "pin_samples",
        columns="category,save_count,save_velocity",
        filters={"save_count": "gte.500"},
        limit=15000,
    )
    percentile_index = CategoryPercentileIndex.from_pins(sample_pins or [])

    inserted = updated = skipped = 0

    for kw_row in kw_rows:
        kid     = kw_row["id"]
        keyword = kw_row["keyword"]

        view_row = view_map.get(kid)
        pins     = pin_map.get(kid, [])
        products = prod_map.get(kid, [])
        for p in products:
            sk = p.get("seed_keyword")
            if sk and sk in kw_seed_cat:
                p["seed_category"] = kw_seed_cat[sk]
            elif category := kw_row.get("category"):
                p.setdefault("seed_category", category)

        # Skip keywords with no evidence at all
        yoy = float(kw_row.get("yearly_change") or 0)
        vol = _volume_rank(kw_row.get("search_volume_level"))
        if yoy <= 0 and vol < 2 and not pins and not products:
            if verbose:
                log.debug("SKIP %s (no signal)", keyword)
            skipped += 1
            continue

        opp = _build_opportunity(
            kw_row, view_row, pins, products,
            keyword_id=kid,
            percentile_index=percentile_index,
        )

        if verbose:
            rd = json.loads(opp["internal_reason_codes"]).get("readiness", {})
            log.info(
                "  %s → label=%s state=%s score=%.1f pins=%d prods=%d readiness=%s product_tier=%s",
                keyword,
                opp["primary_label"],
                opp["trend_state"],
                opp["score"],
                len(pins),
                len(products),
                rd.get("readinessStatus"),
                rd.get("productAvailabilityTier"),
            )

        if dry_run:
            inserted += 1
            continue

        opp_id = _upsert_opportunity(db, opp)
        if not opp_id:
            log.warning("Failed to upsert opportunity for %s", keyword)
            continue

        _upsert_relations(db, opp_id, kid, pins, products)
        inserted += 1

    log.info(
        "Done — processed=%d  skipped=%d  dry_run=%s",
        inserted, skipped, dry_run,
    )
    stats = get_filter_stats()
    if stats.get("negative_term") or stats.get("skipped_digital"):
        log.info(
            "Content filter stats (session): negative_term=%d skipped_digital=%d",
            stats.get("negative_term", 0),
            stats.get("skipped_digital", 0),
        )

    # Counts returned for execution-layer logging (no logic change).
    return {
        "processed":          inserted + skipped,
        "created_or_updated": inserted,
        "skipped":            skipped,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate opportunities from trend_keywords")
    parser.add_argument("--category", help="Filter to single category (e.g. fashion)")
    parser.add_argument("--limit",    type=int, default=2000, help="Max keywords to process")
    parser.add_argument("--dry-run",  action="store_true", help="Compute but do not write to DB")
    parser.add_argument("--verbose",  action="store_true", help="Log every keyword result")
    args = parser.parse_args()

    run(
        category=args.category,
        limit=args.limit,
        dry_run=args.dry_run,
        verbose=args.verbose,
    )
