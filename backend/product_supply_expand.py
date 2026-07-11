"""
product_supply_expand.py — Bounded product-supply expansion from high-save bootstrap pins.

Concept: start from recent high-save bootstrap pins, take each pin's own product
outbound link (depth 0), fetch its RELATED high-save pins and take their product
outbound links (depth 1). No Playwright, no global crawl, no legacy rows.

Reuses existing primitives:
  - scraper_v2.PinterestSession.fetch_related_pins (RelatedPinFeedResource + pin detail)
  - scraper_v2.extract_outbound_link / extract_save_count / get_domain
  - product_harvest.accept_link / classify_link / normalize_product_url / url_hash

Guardrails: depth defaults to 1 (depth 2 behind an explicit future flag, unused now);
dedup by pin id + normalized product URL; conservative sequential seed loop reusing
the session's built-in rate limiting; reads only bootstrap pins (source_interest).

Dry-run reports candidates; apply writes pin_products only (gated; see migrate_v28 for
the provenance columns/values it needs).
"""

from __future__ import annotations

import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "db"))

from product_harvest import (  # type: ignore
    accept_link, classify_link, normalize_product_url, url_hash, BOOTSTRAP_SOURCES,
)

P0_DEFAULT = ("fashion", "womens-fashion", "home-decor", "digital-products")
HIGH_SAVE_RELATED = 500          # "high-save" threshold for related pins (reporting/priority)
MAX_DEPTH = 1                    # depth 2 is intentionally NOT enabled here

# Provenance values (granular). NOTE: applying these requires migrate_v28 (adds them to
# the discovery_method CHECK + adds discovery_depth / discovery_path columns). The dry-run
# uses them in-memory only.
DM_PIN_DETAIL = "pin_detail_outbound_bootstrap"
DM_RELATED = "related_pin_outbound_bootstrap"


def _db_select():
    from db import select_many  # type: ignore
    return select_many


def select_source_pins(*, since_hours: int, source: str | None, categories: list[str],
                       seed_pin_limit: int) -> list[dict]:
    """Recent bootstrap pins in the target categories, high-save first, balanced per category."""
    select_many = _db_select()
    cutoff = (datetime.now(tz=timezone.utc) - timedelta(hours=since_hours)).isoformat()
    filters: dict[str, str] = {
        "scraped_at": f"gte.{cutoff}",
        "image_url": "not.is.null",
        "category": "in.(" + ",".join(categories) + ")",
    }
    if source and source.lower() in ("bootstrap", *BOOTSTRAP_SOURCES):
        filters["source_interest"] = "in.(" + ",".join(BOOTSTRAP_SOURCES) + ")"
    elif source:
        filters["source_interest"] = f"eq.{source}"
    rows = select_many("pin_samples", filters=filters, order="save_count.desc", limit=5000) or []

    # Balance: take top-save pins per category up to an even share of seed_pin_limit.
    per_cat = max(1, seed_pin_limit // max(1, len(categories)))
    by_cat: dict[str, list[dict]] = {c: [] for c in categories}
    for r in rows:
        c = r.get("category")
        if c in by_cat and len(by_cat[c]) < per_cat:
            by_cat[c].append(r)
    selected: list[dict] = []
    for c in categories:
        selected.extend(by_cat[c])
    # Fill any remaining headroom with the next highest-save pins regardless of category cap.
    if len(selected) < seed_pin_limit:
        chosen_ids = {r.get("pin_id") for r in selected}
        for r in rows:
            if len(selected) >= seed_pin_limit:
                break
            if r.get("pin_id") not in chosen_ids and r.get("category") in by_cat:
                selected.append(r)
                chosen_ids.add(r.get("pin_id"))
    return selected[:seed_pin_limit]


def _candidate(*, source_pin: dict, url: str, title: str | None, save_count: int,
               depth: int, related_pin_id: str | None) -> dict | None:
    ok, _reason = accept_link(url)
    if not ok:
        return None
    clf = classify_link(url, title)
    normalized = normalize_product_url(url)
    spid = source_pin.get("pin_id")
    cat = source_pin.get("category")
    kw = source_pin.get("seed_keyword") or source_pin.get("source_keyword")
    if depth == 0:
        path = f"{spid} -> {normalized}"
        dm = DM_PIN_DETAIL
    else:
        path = f"{spid} -> {related_pin_id} -> {normalized}"
        dm = DM_RELATED
    return {
        "parent_pin_id": spid,
        "source_pin_id": spid,
        "related_pin_id": related_pin_id,
        "discovery_depth": depth,
        "discovery_path": path,
        "discovery_method": dm,
        "product_name": (title or "").strip() or None,
        "source_url": url,
        "canonical_product_url": normalized,
        "product_url_hash": url_hash(normalized),
        "domain": clf["domain"],
        "source_platform": clf["source_platform"],
        "product_type": clf["product_type"],
        "type_bucket": clf["type_bucket"],
        "digital_format": clf["digital_format"],
        "product_signal_confidence": clf["confidence"],
        "is_mockup_like": clf["is_mockup_like"],
        "inspiration_only": True,
        "is_user_ownable": False,
        "is_seed": False,
        "save_count": int(save_count or 0),
        "source_pin_save_count": int(save_count or 0),
        "seed_keyword": kw,
        "category_hint": cat,   # for reporting; pin_products has no category column
    }


async def expand(*, since_hours: int = 24, source: str | None = "bootstrap",
                 categories: list[str] | None = None, seed_pin_limit: int = 100,
                 related_per_pin: int = 8, depth: int = 1, apply: bool = False) -> dict[str, Any]:
    from scraper_v2 import (  # type: ignore
        PinterestSession, extract_outbound_link, extract_save_count,
    )
    depth = min(max(0, depth), MAX_DEPTH)   # never recurse past MAX_DEPTH here
    cats = categories or list(P0_DEFAULT)
    source_pins = select_source_pins(since_hours=since_hours, source=source,
                                     categories=cats, seed_pin_limit=seed_pin_limit)

    accepted: list[dict] = []
    rejected: list[dict] = []
    related_discovered = 0
    related_inspected = 0
    related_high_save = 0
    seen_hashes: set[str] = set()
    seen_pin_ids: set[str] = set()

    def _add(cand: dict | None, url: str, ctx_cat: str | None, reason_url: str) -> None:
        if cand is None:
            ok, reason = accept_link(url)
            if not ok and url:
                rejected.append({"url": url[:120], "reason": reason, "category": ctx_cat})
            return
        h = cand["product_url_hash"]
        if h in seen_hashes:
            return
        seen_hashes.add(h)
        accepted.append(cand)

    async with PinterestSession(delay=1.2) as session:
        for sp in source_pins:
            spid = sp.get("pin_id")
            # depth 0 — the source pin's own product outbound link
            sp_url = (sp.get("outbound_link") or "").strip()
            if sp_url:
                _add(_candidate(source_pin=sp, url=sp_url, title=sp.get("title"),
                                save_count=sp.get("save_count"), depth=0, related_pin_id=None),
                     sp_url, sp.get("category"), sp_url)
            # depth 1 — related pins
            if depth >= 1 and spid:
                try:
                    related = await session.fetch_related_pins(spid, max_pins=related_per_pin)
                except Exception as exc:
                    rejected.append({"url": f"related:{spid}", "reason": f"fetch_error:{exc}", "category": sp.get("category")})
                    related = []
                for r in related:
                    related_discovered += 1
                    rpid = str(r.get("id") or r.get("pin_id") or "")
                    if rpid and rpid in seen_pin_ids:
                        continue
                    if rpid:
                        seen_pin_ids.add(rpid)
                    related_inspected += 1
                    rsave = extract_save_count(r)
                    if rsave >= HIGH_SAVE_RELATED:
                        related_high_save += 1
                    rurl = (extract_outbound_link(r) or "").strip()
                    if not rurl:
                        continue
                    title = r.get("title") or r.get("grid_title") or r.get("closeup_description")
                    _add(_candidate(source_pin=sp, url=rurl, title=title, save_count=rsave,
                                    depth=1, related_pin_id=rpid),
                         rurl, sp.get("category"), rurl)

    # Dedup vs existing pin_products (by normalized URL) → projected inserts vs updates
    select_many = _db_select()
    existing_hashes: set[str] = set()
    hashes = [c["product_url_hash"] for c in accepted]
    for i in range(0, len(hashes), 100):
        chunk = hashes[i:i+100]
        rows = select_many("pin_products", filters={"product_url_hash": "in.(" + ",".join(chunk) + ")"}, limit=5000) or []
        for r in rows:
            if r.get("product_url_hash"):
                existing_hashes.add(r["product_url_hash"])
    inserts = [c for c in accepted if c["product_url_hash"] not in existing_hashes]
    updates = [c for c in accepted if c["product_url_hash"] in existing_hashes]

    report = {
        "mode": "apply" if apply else "dry-run",
        "scope": {"sinceHours": since_hours, "source": source, "categories": cats,
                  "seedPinLimit": seed_pin_limit, "relatedPerPin": related_per_pin, "depth": depth},
        "sourcePinsScanned": len(source_pins),
        "relatedPinsDiscovered": related_discovered,
        "relatedPinsInspected": related_inspected,
        "relatedPinsHighSave": related_high_save,
        "productCandidatesFound": len(accepted) + len(rejected),
        "acceptedProductLinks": len(accepted),
        "linksRejected": len(rejected),
        "rejectReasonDistribution": dict(Counter(r["reason"].split(":")[0] for r in rejected)),
        "duplicatesSkipped": (len(accepted) + len(rejected)) - len(set(seen_hashes)) if accepted else 0,
        "projectedInserts": len(inserts),
        "projectedUpdates": len(updates),
        "productsByCategory": dict(Counter(c.get("category_hint") for c in inserts)),
        "productsByDepth": dict(Counter(c["discovery_depth"] for c in inserts)),
        "productsByPlatform": dict(Counter(c.get("source_platform") for c in inserts)),
        "productTypeEstimate": dict(Counter(c.get("type_bucket") for c in inserts)),
        "legacyPinsTouched": 0,   # selection is bootstrap-source-scoped
        "provenanceValues": sorted({c["discovery_method"] for c in accepted}),
        "sampleAccepted": [
            {"category": c.get("category_hint"), "depth": c["discovery_depth"],
             "platform": c.get("source_platform"), "type": c.get("type_bucket"),
             "title": (c.get("product_name") or "")[:46], "path": c["discovery_path"][:80],
             "url": (c.get("source_url") or "")[:60]}
            for c in inserts[:30]
        ],
        "sampleRejected": rejected[:30],
    }
    if apply:
        report["applied"] = _apply_rows(inserts + updates)
    return report


def _apply_rows(rows: list[dict]) -> dict[str, Any]:
    """Write to pin_products. REQUIRES migrate_v28 (granular discovery_method values +
    discovery_depth / discovery_path columns). Strips reporting-only keys before write."""
    from db import upsert  # type: ignore
    if not rows:
        return {"written": 0}
    payload = []
    for c in rows:
        row = {k: v for k, v in c.items() if k not in ("type_bucket", "category_hint")}
        payload.append(row)
    written = upsert("pin_products", payload, "parent_pin_id,source_url")
    return {"written": len(written) if written else len(payload)}
