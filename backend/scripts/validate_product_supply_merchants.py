#!/usr/bin/env python3
"""Read-only merchant validation for one frozen Product Supply dry-run.

This closes the gap between Pinterest-card discovery and Product Opportunity
admission without re-crawling Pinterest and without touching the database:

1. Load an immutable dry-run report and its exact 100 Source Pin IDs.
2. Read those Source Pins from ``pin_samples`` to restore real provenance that
   older reports did not persist (keyword/title/image only; never inferred).
3. Re-run URL admission and active-row preflight.
4. Revisit at most 100 merchant PDPs through ``supply_core.discover`` in atomic
   chunks of at most 20, then run the same red-line gate used by apply.
5. Write JSON evidence files only. No database mutation function is imported or
   called by this script.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import httpx

BACKEND = Path(__file__).resolve().parents[1]
for _p in (str(BACKEND), str(BACKEND / "db")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import shop_the_look_expand as stl  # noqa: E402
import supply_core  # noqa: E402
from db import DB  # noqa: E402

MAX_SOURCE_PINS = 100
MAX_MERCHANT_CANDIDATES = 100
MAX_PROJECTED_ADMISSIONS = supply_core.MAX_RUN_ADMISSIONS
_SAFE_PIN_ID = re.compile(r"^[A-Za-z0-9_-]+$")


def _load_report(path: Path) -> tuple[dict, str]:
    raw = path.read_bytes()
    report = json.loads(raw.decode("utf-8"))
    if report.get("engine") != "shop-the-look":
        raise ValueError("source report engine must be shop-the-look")
    if report.get("mode") != "dry-run":
        raise ValueError("source report must be a zero-write dry-run")
    per_pin = report.get("perPin") or []
    if not per_pin or len(per_pin) > MAX_SOURCE_PINS:
        raise ValueError(
            f"source report must contain 1..{MAX_SOURCE_PINS} perPin rows"
        )
    if (report.get("writes") or {}).get("pin_products") not in (None, 0):
        raise ValueError("source report is not zero-write")
    return report, hashlib.sha256(raw).hexdigest()


def _report_source_ids(report: dict) -> list[str]:
    ids: list[str] = []
    seen: set[str] = set()
    for entry in report.get("perPin") or []:
        pin_id = str(entry.get("sourcePinId") or "").strip()
        if not pin_id or not _SAFE_PIN_ID.fullmatch(pin_id):
            raise ValueError(f"invalid or missing sourcePinId: {pin_id!r}")
        if pin_id in seen:
            raise ValueError(f"duplicate sourcePinId in report: {pin_id}")
        seen.add(pin_id)
        ids.append(pin_id)
    return ids


def load_source_rows(pin_ids: list[str], *, db: DB | None = None) -> dict[str, dict]:
    """Read the exact frozen Source Pins. Every requested ID must exist."""
    database = db or DB()
    rows: list[dict] = []
    for start in range(0, len(pin_ids), 50):
        chunk = pin_ids[start : start + 50]
        rows.extend(database.select_many(
            "pin_samples",
            columns=(
                "pin_id,category,save_count,seed_keyword,source_keyword,title,image_url"
            ),
            filters={"pin_id": f"in.({','.join(chunk)})"},
            limit=len(chunk),
        ))
    by_id = {str(row.get("pin_id")): row for row in rows if row.get("pin_id")}
    missing = [pin_id for pin_id in pin_ids if pin_id not in by_id]
    if missing:
        raise RuntimeError(f"pin_samples readback missing {len(missing)} frozen Source Pins")
    return by_id


def enrich_frozen_report(report: dict, source_rows: dict[str, dict], source_sha256: str) -> dict:
    """Return a derived report; never mutate or overwrite the source report."""
    out = copy.deepcopy(report)
    missing_keyword: list[str] = []
    for entry in out.get("perPin") or []:
        pin_id = str(entry["sourcePinId"])
        source = source_rows[pin_id]
        report_category = entry.get("category")
        if report_category != source.get("category"):
            raise RuntimeError(
                f"Source Pin {pin_id} category changed: report={report_category!r}, "
                f"database={source.get('category')!r}"
            )
        keyword = str(
            source.get("seed_keyword") or source.get("source_keyword") or ""
        ).strip() or None
        if not keyword:
            missing_keyword.append(pin_id)
        entry["seedKeyword"] = keyword
        entry["sourcePinTitle"] = source.get("title")
        entry["sourcePinImageUrl"] = source.get("image_url")
    out["merchantValidationSourceEnrichment"] = {
        "derivedFromSha256": source_sha256,
        "derivedAt": datetime.now(timezone.utc).isoformat(),
        "sourcePinsReadBack": len(source_rows),
        "missingKeywordCount": len(missing_keyword),
        "missingKeywordPinIds": missing_keyword[:20],
        "databaseWrites": 0,
    }
    return out


def _candidate_pool(report: dict, source_rows: dict[str, dict]) -> list[dict]:
    """Build URL-only candidates, including card-bare links accepted by e534f51."""
    raw = list(report.get("acceptedProducts") or [])
    raw.extend(
        row for row in (report.get("rejectedProductDetails") or [])
        if row.get("rejection_reason") == stl.NO_PRODUCT_EVIDENCE
    )

    pool: list[dict] = []
    seen_urls: set[str] = set()
    resolver = stl.ShortlinkResolver()
    for row in raw:
        pin_id = str(row.get("source_pin_id") or "").strip()
        source = source_rows.get(pin_id)
        if not source:
            continue
        url = str(row.get("product_url") or "").strip()
        ok, _reason = stl.accept_link(url, resolver=resolver)
        if not ok:
            continue
        url = stl.resolve_link(url, resolver)
        normalized = supply_core.normalize_product_url(url)
        if not normalized or normalized in seen_urls:
            continue
        seen_urls.add(normalized)
        keyword = str(
            source.get("seed_keyword") or source.get("source_keyword") or ""
        ).strip() or None
        pool.append({
            "source_pin_id": pin_id,
            "source_pin_url": f"https://www.pinterest.com/pin/{pin_id}/",
            "source_pin_image_url": source.get("image_url"),
            "source_pin_title": source.get("title"),
            "source_category": source.get("category"),
            "source_pin_save_count": source.get("save_count"),
            "seed_keyword": keyword,
            "product_url": url,
            "normalized_product_url": normalized,
            "normalized_product_url_hash": supply_core.url_hash(normalized),
            "domain": supply_core.get_domain(url),
        })
    return pool


def validate_merchants(
    report: dict,
    source_rows: dict[str, dict],
    *,
    web: httpx.Client,
    preflight: Callable[[list[dict]], dict] = stl._preflight_existing,
) -> dict:
    pool = _candidate_pool(report, source_rows)
    pre = preflight(pool)
    if pre.get("checked") is not True:
        raise RuntimeError(
            "active duplicate preflight did not complete; refusing merchant validation"
        )
    eligible = list(pre.get("insertCandidates") or [])[:MAX_MERCHANT_CANDIDATES]
    core_candidates = stl._stl_candidates(eligible)

    discovered: list[dict] = []
    failures: list[dict] = []
    for start in range(0, len(core_candidates), supply_core.MAX_BATCH):
        chunk = core_candidates[start : start + supply_core.MAX_BATCH]
        rows, failed = supply_core.discover(
            web, chunk, want=len(chunk), max_attempts=len(chunk)
        )
        discovered.extend(rows)
        failures.extend(failed)

    red_lines_pass, violations = supply_core.check_red_lines(discovered)
    safe = discovered[:MAX_PROJECTED_ADMISSIONS] if red_lines_pass else []
    merchant_images = [item["row"].get("image_url") for item in safe]
    pinterest_images = [
        image for image in merchant_images
        if image and any(host in image.lower() for host in supply_core.PINTEREST_IMG_HOSTS)
    ]
    validation_pass = (
        red_lines_pass
        and bool(safe)
        and not pinterest_images
        and len(core_candidates) <= MAX_MERCHANT_CANDIDATES
    )
    return {
        "readOnly": True,
        "databaseWrites": 0,
        "sourcePins": len(report.get("perPin") or []),
        "reportCandidates": len(pool),
        "activeDuplicatesSkipped": int(pre.get("projectedSkipExistingCount") or 0),
        "merchantCandidatesAttempted": len(core_candidates),
        "merchantCandidateCap": MAX_MERCHANT_CANDIDATES,
        "atomicChunkCap": supply_core.MAX_BATCH,
        "merchantDiscovered": len(discovered),
        "merchantFailures": len(failures),
        "failureReasons": dict(Counter(
            str(item.get("discoveryFailReason") or item.get("result") or "unknown")
            for item in failures
        )),
        "failureSamples": failures[:10],
        "redLinesPass": red_lines_pass,
        "redLineViolations": violations[:20],
        "projectedSafeAdmissions": len(safe),
        "projectedAdmissionCap": MAX_PROJECTED_ADMISSIONS,
        "verifiedMerchantImages": sum(1 for image in merchant_images if image),
        "pinterestHostedProductImages": len(pinterest_images),
        "projectedRows": [item["row"] for item in safe],
        "validationPass": validation_pass,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-report", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--enriched-source-report", required=True, type=Path)
    args = parser.parse_args()

    report, source_sha256 = _load_report(args.source_report)
    pin_ids = _report_source_ids(report)
    if len(pin_ids) != MAX_SOURCE_PINS:
        raise RuntimeError(
            f"production merchant validation requires exactly {MAX_SOURCE_PINS} "
            f"frozen Source Pins, got {len(pin_ids)}"
        )
    source_rows = load_source_rows(pin_ids)
    enriched = enrich_frozen_report(report, source_rows, source_sha256)
    with httpx.Client(timeout=15) as web:
        result = validate_merchants(enriched, source_rows, web=web)
    result.update({
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceReport": str(args.source_report),
        "sourceReportSha256": source_sha256,
        "enrichedSourceReport": str(args.enriched_source_report),
    })

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.enriched_source_report.parent.mkdir(parents=True, exist_ok=True)
    args.enriched_source_report.write_text(
        json.dumps(enriched, indent=2, ensure_ascii=False, default=str),
        encoding="utf-8",
    )
    args.output.write_text(
        json.dumps(result, indent=2, ensure_ascii=False, default=str),
        encoding="utf-8",
    )
    print(json.dumps({
        "sourcePins": result["sourcePins"],
        "merchantCandidatesAttempted": result["merchantCandidatesAttempted"],
        "merchantDiscovered": result["merchantDiscovered"],
        "projectedSafeAdmissions": result["projectedSafeAdmissions"],
        "redLinesPass": result["redLinesPass"],
        "validationPass": result["validationPass"],
        "databaseWrites": 0,
    }))
    return 0 if result["validationPass"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
