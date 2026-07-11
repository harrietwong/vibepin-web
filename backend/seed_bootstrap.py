"""
seed_bootstrap.py — Manual / CSV trend seed bootstrap.

Lets us seed production-quality crawl targets BEFORE Pinterest Trends API
(official_v5) access is approved.

Honesty guarantees:
  - Rows are scored with the SAME TrendSeedScore logic as automated seeds
    (compute_trend_seed_score / assign_crawl_priority). Scoring is never bypassed.
  - Rows are labeled source/source_layer = manual_bootstrap (or csv_bootstrap).
    They are NEVER labeled official_v5, and never carry an exact search_volume.
  - Growth/volume metrics are only used when the curator supplies them. Blank
    metrics stay blank — we do not fabricate authoritative numbers. A curated
    seed still becomes crawl-eligible via the documented manual trust floor.
  - Dry-run never writes to the DB. Writes require explicit apply=True (--apply).

CLI (via run_worker.py):
  python run_worker.py --job seed-bootstrap --file data/manual_trend_seeds.csv --dry-run
  python run_worker.py --job seed-bootstrap --file data/manual_trend_seeds.csv --apply
"""

from __future__ import annotations

import csv
import io
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from content_filters import evaluate_pin_content
from trend_seed_pipeline import (
    P0_CATEGORIES,
    TrendSeed,
    assign_crawl_priority,
    cluster_keywords,
    compute_trend_seed_score,
    crawl_priority_to_score,
    normalize_category,
)

REQUIRED_FIELDS = ("keyword", "category")

KNOWN_FIELDS = frozenset({
    "keyword", "category", "region", "source", "trend_type",
    "search_volume", "weekly_growth", "monthly_growth", "yearly_growth",
    "curator_priority", "curator_note",
    "seasonality_hint", "commercial_intent_hint", "product_potential_hint",
    "reference_potential_hint",
})

CURATOR_PRIORITIES = frozenset({"high", "medium", "low"})

ALLOWED_MANUAL_SOURCES = frozenset({"manual_bootstrap", "csv_bootstrap"})
DEFAULT_MANUAL_SOURCE = "manual_bootstrap"

# Manual trust floor — meaning: "a human approved this keyword for crawling"
# (= crawl eligibility). It is NOT trend strength, search volume, growth,
# official demand, or any Pinterest signal. Defined in trend_seed_pipeline.
MANUAL_TRUST_FLOOR_MEANING = (
    "human-approved crawl eligibility — NOT trend strength, search volume, "
    "growth, official demand, or any Pinterest signal"
)

# Sources we refuse to honor on a manual row (must never look authoritative).
FORBIDDEN_SOURCES = frozenset({
    "official_v5", "pinterest_trends_v5", "pinterest_v5_official",
    "pinterest_trends_api", "pinterest_trends_official",
})


# ── Parsing ──────────────────────────────────────────────────────────────

def _clean(val: Any) -> str:
    return ("" if val is None else str(val)).strip()


def _parse_float(val: Any) -> float | None:
    s = _clean(val)
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _parse_search_volume(val: Any) -> tuple[float | None, int, bool]:
    """
    search_volume is NUMERIC ONLY. Returns (numeric_value, volume_score, was_non_numeric).

    - blank            → (None, 0, False)
    - non-numeric text → (None, 0, True)   ← ignored for scoring; caller warns
    - numeric > 0      → (value, coarse_bin, False)

    The bins below are a COARSE internal crawl-ordering aid, not an authoritative
    volume scale (Pinterest does not publish absolute search volumes). A curator-
    supplied number is a falsifiable claim; a qualitative word is not, so words
    are never treated as volume.
    """
    s = _clean(val)
    if not s:
        return None, 0, False
    try:
        num = float(s.replace(",", ""))
    except ValueError:
        return None, 0, True
    if num <= 0:
        return None, 0, False
    if num >= 50000:
        vs = 4
    elif num >= 10000:
        vs = 3
    elif num >= 1000:
        vs = 2
    else:
        vs = 1
    return num, vs, False


def parse_seed_csv(text: str) -> tuple[list[dict], list[dict]]:
    """
    Parse CSV text → (valid_rows, invalid_rows).

    valid_rows: normalized dicts ready for scoring.
    invalid_rows: {"row": <raw>, "reasons": [...], "line": <n>}.
    Unknown columns are tolerated (recorded as a non-fatal warning on the row).
    """
    reader = csv.DictReader(io.StringIO(text))
    valid: list[dict] = []
    invalid: list[dict] = []

    for idx, raw in enumerate(reader, start=2):  # line 1 is the header
        reasons: list[str] = []
        warnings: list[str] = []

        keyword = _clean(raw.get("keyword"))
        category_in = _clean(raw.get("category"))
        if not keyword:
            reasons.append("missing keyword")
        if not category_in:
            reasons.append("missing category")

        normalized_cat = normalize_category(category_in) if category_in else ""
        if category_in and not normalized_cat:
            reasons.append("category did not normalize to a known id")

        unknown_cols = {k for k in raw if k and k not in KNOWN_FIELDS}
        if unknown_cols:
            warnings.append(f"ignored unknown columns: {sorted(unknown_cols)}")

        # Source coercion — never honor an authoritative source on a manual row.
        src_in = _clean(raw.get("source")).lower()
        if src_in in FORBIDDEN_SOURCES:
            warnings.append(f"source {src_in!r} forced to manual_bootstrap (cannot be authoritative)")
            source = DEFAULT_MANUAL_SOURCE
        elif src_in in ALLOWED_MANUAL_SOURCES:
            source = src_in
        else:
            source = DEFAULT_MANUAL_SOURCE

        if reasons:
            invalid.append({"row": dict(raw), "reasons": reasons, "line": idx})
            continue

        numeric_volume, vol_score, non_numeric_volume = _parse_search_volume(raw.get("search_volume"))
        if non_numeric_volume:
            warnings.append(
                "non-numeric search_volume ignored — search_volume is numeric only; "
                "use curator_priority for qualitative intent"
            )

        curator_priority = _clean(raw.get("curator_priority")).lower() or None
        if curator_priority and curator_priority not in CURATOR_PRIORITIES:
            warnings.append(f"unknown curator_priority {curator_priority!r} ignored (use high/medium/low)")
            curator_priority = None

        valid.append({
            "keyword": keyword,
            "category_input": category_in,
            "normalized_category": normalized_cat,
            "region": _clean(raw.get("region")) or "US",
            "source": source,
            "origin": src_in or None,
            "trend_type": _clean(raw.get("trend_type")) or None,
            "numeric_search_volume": numeric_volume,
            "volume_score": vol_score,
            "yoy": _parse_float(raw.get("yearly_growth")),
            "wow": _parse_float(raw.get("weekly_growth")),
            "mom": _parse_float(raw.get("monthly_growth")),
            "curator_priority": curator_priority,
            "curator_note": _clean(raw.get("curator_note")) or None,
            "seasonality_hint": _clean(raw.get("seasonality_hint")) or None,
            "commercial_intent_hint": _clean(raw.get("commercial_intent_hint")) or None,
            "product_potential_hint": _clean(raw.get("product_potential_hint")) or None,
            "reference_potential_hint": _clean(raw.get("reference_potential_hint")) or None,
            "warnings": warnings,
            "line": idx,
        })

    return valid, invalid


# ── Scoring ──────────────────────────────────────────────────────────────

def _to_kw(row: dict) -> dict:
    """Build the keyword dict consumed by compute_trend_seed_score / writers.

    Only real, falsifiable metrics (numeric search_volume → volume_score, and any
    supplied growth %) feed the score. Curator priority/notes and the qualitative
    *_hint fields are metadata only — they never inflate trend_seed_score.
    """
    has_numeric_volume = row.get("numeric_search_volume") is not None
    return {
        "keyword": row["keyword"],
        "trend_source": row["source"],
        "region": row["region"],
        "pct_growth_yoy": row.get("yoy") or 0.0,
        "pct_growth_wow": row.get("wow") or 0.0,
        "pct_growth_mom": row.get("mom") or 0.0,
        "volume_score": row.get("volume_score") or 0,
        "search_volume_level": "manual_numeric" if has_numeric_volume else "unscored",
        "volume_signal": "manual_numeric" if has_numeric_volume else "unscored",
        "_curator_priority": row.get("curator_priority"),
        "_bootstrap_hints": {
            "curatorPriority": row.get("curator_priority"),
            "curatorNote": row.get("curator_note"),
            "curatorAssertedVolume": row.get("numeric_search_volume"),
            "seasonality": row.get("seasonality_hint"),
            "commercialIntent": row.get("commercial_intent_hint"),
            "productPotential": row.get("product_potential_hint"),
            "referencePotential": row.get("reference_potential_hint"),
            "trendType": row.get("trend_type"),
            "origin": row.get("origin"),
        },
    }


def score_seed_rows(valid_rows: list[dict]) -> tuple[list[TrendSeed], list[dict]]:
    """
    Score + dedup valid rows. Returns (seeds, duplicates).

    Dedup key is (keyword.lower, normalized_category). Negative content filter is
    applied (same as the automated pipeline); commercial growth filter is NOT —
    curated seeds are deliberately kept regardless of growth.
    """
    seeds: list[TrendSeed] = []
    duplicates: list[dict] = []
    rejected: list[dict] = []
    seen: set[tuple[str, str]] = set()

    for row in valid_rows:
        cat = row["normalized_category"]
        key = (row["keyword"].lower(), cat)
        if key in seen:
            duplicates.append({"keyword": row["keyword"], "category": cat, "line": row.get("line")})
            continue

        decision = evaluate_pin_content(title=row["keyword"], category=cat)
        if decision.reject:
            rejected.append({
                "keyword": row["keyword"],
                "category": cat,
                "reason": decision.reason or "negative_term",
                "matched_term": decision.matched_term,
                "line": row.get("line"),
            })
            continue

        seen.add(key)
        kw = _to_kw(row)
        score = compute_trend_seed_score(kw)
        crawl_pri, refresh, queue_ok = assign_crawl_priority(score, kw)
        # Curator priority is a transparent, conservative CADENCE-ONLY override
        # (human judgment). It does NOT change trend_seed_score or the tier. We
        # cap it at every_3_days: without real trend data we never crawl daily.
        if row.get("curator_priority") == "high" and queue_ok:
            refresh = "every_3_days"
        disposition = "accepted" if crawl_pri in ("high", "medium", "low") else "watchlist"
        seeds.append(TrendSeed(
            keyword=row["keyword"],
            normalized_category=cat,
            trend_seed_score=score,
            crawl_priority=crawl_pri,
            refresh_cadence=refresh,
            seed_disposition=disposition,
            crawl_queue_eligible=queue_ok,
            priority_score=crawl_priority_to_score(crawl_pri, score),
            raw=kw,
        ))

    cluster_keywords(seeds)  # assigns cluster_id in place
    return seeds, duplicates + rejected


# ── Reporting ────────────────────────────────────────────────────────────

# P0 categories are DISTINCT canonical ids (verified against CATEGORY_ALIASES):
# "fashion" and "womens-fashion" are NOT aliases — womens-fashion is a separate
# subcategory. Coverage counts each id once; aliases are never double-counted.
_FASHION_FAMILY = ("fashion", "womens-fashion")


def _coverage(categories: list[str]) -> dict[str, Any]:
    present = set(categories) & P0_CATEGORIES
    cat_set = set(categories)
    return {
        "present": sorted(present),
        "missing": sorted(P0_CATEGORIES - present),
        "note": (
            "P0 categories are distinct canonical ids; fashion and womens-fashion "
            "are separate (not aliases) and are never double-counted."
        ),
        "fashionFamily": {
            "fashionPresent": "fashion" in cat_set,
            "womensFashionSubcategoryPresent": "womens-fashion" in cat_set,
        },
    }


def _top_seeds(seeds: list[TrendSeed], n: int = 20) -> list[dict]:
    ranked = sorted(seeds, key=lambda s: -s.trend_seed_score)
    return [{
        "keyword": s.keyword,
        "category": s.normalized_category,
        "trendSeedScore": s.trend_seed_score,
        "crawlPriority": s.crawl_priority,
        "refreshCadence": s.refresh_cadence,
        "sourceLayer": s.raw.get("trend_source"),
        "clusterId": s.cluster_id,
    } for s in ranked[:n]]


def build_dry_run_report(
    *,
    file: str,
    total_loaded: int,
    valid_rows: list[dict],
    invalid_rows: list[dict],
    seeds: list[TrendSeed],
    duplicates: list[dict],
) -> dict[str, Any]:
    eligible = [s for s in seeds if s.crawl_queue_eligible]
    cats = [s.normalized_category for s in seeds]
    numeric_vol_rows = [r for r in valid_rows if r.get("numeric_search_volume") is not None]
    return {
        "mode": "dry-run",
        "file": file,
        "sourceLabel": DEFAULT_MANUAL_SOURCE,
        "totalRowsLoaded": total_loaded,
        "validRows": len(valid_rows),
        "invalidRowCount": len(invalid_rows),
        "invalidRows": [
            {"line": r["line"], "reasons": r["reasons"], "keyword": r["row"].get("keyword")}
            for r in invalid_rows
        ],
        "duplicatesSkipped": len(duplicates),
        "seedsScored": len(seeds),
        "seedsPassingThreshold": len(eligible),
        "projectedCrawlQueueEntries": len(eligible),
        "searchVolumeNumericCount": len(numeric_vol_rows),
        "searchVolumeNullCount": len(valid_rows) - len(numeric_vol_rows),
        "categoryDistribution": dict(Counter(cats)),
        "p0CategoryCoverage": _coverage(cats),
        "refreshCadenceDistribution": dict(Counter(s.refresh_cadence for s in seeds)),
        "crawlPriorityDistribution": dict(Counter(s.crawl_priority for s in seeds)),
        "curatorPriorityDistribution": dict(Counter(
            (r.get("curator_priority") or "unset") for r in valid_rows
        )),
        "scoreInputsLegend": {
            "officialNumericVolume": (
                "real numeric search_volume only → coarse internal volume_score bins; "
                "never an authoritative Pinterest volume; exact value never written to DB"
            ),
            "manualTrustFloor": MANUAL_TRUST_FLOOR_MEANING,
            "growthMetrics": "used only when curator supplies real weekly/monthly/yearly_growth",
            "commercialBonus": "keyword-token bonus (existing TrendSeedScore logic)",
            "curatorPriority": "human judgment — CADENCE ONLY (high → every_3_days), never affects trend_seed_score",
            "qualitativeHints": "commercial/product/reference/seasonality — metadata only, never scored",
        },
        "top20Seeds": _top_seeds(seeds),
        "skippedRows": {
            "invalid": [
                {"line": r["line"], "reasons": r["reasons"], "keyword": r["row"].get("keyword")}
                for r in invalid_rows
            ],
            "duplicatesOrFiltered": duplicates,
        },
    }


# ── Apply (DB writes — only when apply=True) ────────────────────────────────

def _apply_writes(seeds: list[TrendSeed]) -> dict[str, Any]:
    """Write scored seeds to trend_keywords + crawl_queue. Reuses the existing
    retry-safe writers. Classifies insert vs update by a pre-write existence check."""
    from trend_fetcher import (  # noqa: E402
        CRAWL_QUEUE_LAST_STATS,
        upsert_crawl_queue,
        upsert_trend_keywords,
        _db,
    )

    _, _, select_one, _ = _db()

    inserted = 0
    updated = 0
    for s in seeds:
        try:
            existing = select_one("trend_keywords", {"keyword": s.keyword, "category": s.normalized_category})
        except Exception:
            existing = None
        if existing:
            updated += 1
        else:
            inserted += 1

    kw_dicts = [s.to_keyword_dict() for s in seeds]
    # Group by category for the writers' fallback category param (each kw still
    # carries its own normalized_category, so mixed categories are safe).
    kw_written = upsert_trend_keywords(kw_dicts, "manual_bootstrap", "manual_bootstrap")
    queue_written = upsert_crawl_queue(kw_dicts, "manual_bootstrap", "manual_bootstrap")
    queue_stats = dict(CRAWL_QUEUE_LAST_STATS)

    return {
        "trendKeywordsWritten": kw_written,
        "insertedSeeds": inserted,
        "updatedSeeds": updated,
        "crawlQueueEntriesCreated": queue_written,
        "crawlQueueStats": queue_stats,
    }


def build_apply_report(
    *,
    file: str,
    total_loaded: int,
    valid_rows: list[dict],
    invalid_rows: list[dict],
    seeds: list[TrendSeed],
    duplicates: list[dict],
    write_result: dict[str, Any],
) -> dict[str, Any]:
    written_cats = [s.normalized_category for s in seeds if s.crawl_queue_eligible]
    return {
        "mode": "apply",
        "file": file,
        "sourceLabel": DEFAULT_MANUAL_SOURCE,
        "totalRowsLoaded": total_loaded,
        "validRows": len(valid_rows),
        "invalidRowCount": len(invalid_rows),
        "duplicatesSkipped": len(duplicates),
        "seedsScored": len(seeds),
        "insertedSeeds": write_result["insertedSeeds"],
        "updatedSeeds": write_result["updatedSeeds"],
        "skippedDuplicates": len(duplicates),
        "crawlQueueEntriesCreated": write_result["crawlQueueEntriesCreated"],
        "crawlQueueStats": write_result["crawlQueueStats"],
        "categoryCoverageAfterWrite": dict(Counter(written_cats)),
        "p0CoverageAfterWrite": _coverage(written_cats),
    }


# ── Orchestration ──────────────────────────────────────────────────────────

def run_bootstrap(file: str, *, apply: bool = False) -> dict[str, Any]:
    """
    Load a CSV, score every row, and either report (dry-run) or write (apply).
    Raises FileNotFoundError if the file is missing, RuntimeError if apply has
    zero usable seeds (never report a vacuous success).
    """
    path = Path(file)
    if not path.exists():
        raise FileNotFoundError(f"seed bootstrap file not found: {file}")

    text = path.read_text(encoding="utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(text)))
    total_loaded = len(rows)

    valid_rows, invalid_rows = parse_seed_csv(text)
    seeds, duplicates = score_seed_rows(valid_rows)

    if not apply:
        report = build_dry_run_report(
            file=file, total_loaded=total_loaded, valid_rows=valid_rows,
            invalid_rows=invalid_rows, seeds=seeds, duplicates=duplicates,
        )
        report["jobTimestamp"] = datetime.now(tz=timezone.utc).isoformat()
        return report

    if not seeds:
        raise RuntimeError(
            "seed-bootstrap --apply produced 0 usable seeds "
            f"({len(invalid_rows)} invalid, {len(duplicates)} skipped) — nothing written"
        )

    write_result = _apply_writes(seeds)
    report = build_apply_report(
        file=file, total_loaded=total_loaded, valid_rows=valid_rows,
        invalid_rows=invalid_rows, seeds=seeds, duplicates=duplicates,
        write_result=write_result,
    )
    report["jobTimestamp"] = datetime.now(tz=timezone.utc).isoformat()
    return report
