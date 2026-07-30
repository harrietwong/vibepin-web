"""
t2_supply_recount.py — READ-ONLY supply recount against the CURRENT PDP gate.

WRITES NOTHING. Runs no crawler, no scoring, no scheduler. Touches no schema.
Its only DB access is SELECT via PostgREST.

WHY: the "277 rows" figure was computed under the OLD accept_link(), before the PDP
gate was backfilled (and before three false negatives in that gate were fixed). That
number is therefore stale in BOTH directions. This recount re-derives the real
candidate set with the gate as it stands today.

Two rates are reported separately and never merged (per the corrected positioning):
  Discovery  = did we find a real external product URL + verified Pinterest evidence?
  Enrichment = could we ALSO read product details off the merchant page? (optional)

Enrichment for the FULL candidate set is not measured by fetching every URL — that
would be a crawl. Instead we ESTIMATE it by DOMAIN-FAMILY STRATIFICATION using the
19 rows already written (the only rows whose detail fetch actually happened), and we
label the estimate as an estimate, with its sample size, everywhere it appears.

  py t2_supply_recount.py            # report to stdout + JSON evidence
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from dotenv import dotenv_values

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND.parent
for p in (str(BACKEND), str(BACKEND / "db")):
    if p not in sys.path:
        sys.path.insert(0, p)

from product_lifecycle import NOT_RETIRED_OR_EXPR, is_retired          # noqa: E402
from product_harvest import accept_link, get_domain                     # noqa: E402

ENV = dotenv_values(ROOT / "web" / ".env.local")
SUPABASE_URL = ENV.get("NEXT_PUBLIC_SUPABASE_URL", "")
SERVICE_KEY = ENV.get("SUPABASE_SERVICE_ROLE_KEY", "")

OUT = Path(__file__).resolve().parent / "t2_supply_recount.json"
CARDS = Path(__file__).resolve().parent / "t2_preview_cards.json"


def _headers(extra: dict | None = None) -> dict:
    h = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}
    if extra:
        h.update(extra)
    return h


def page_all(c: httpx.Client, table: str, select: str, filt: str, order: str) -> list[dict]:
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


# ── Rejection taxonomy the decision-maker asked for ─────────────────────────
# accept_link() returns fine-grained internal reasons; these are the buckets the
# report must speak in. Mapping is explicit so the numbers can be audited.
def reason_bucket(reason: str, url: str) -> str:
    path = (urlsplit(url).path or "").rstrip("/")
    if reason == "social_media":
        return "social"
    if reason == "pinterest_internal":
        return "pinterest-internal"
    if reason in ("empty_or_relative", "no_domain"):
        return "other"
    if reason.startswith("not_product_detail_page:"):
        sub = reason.split(":", 1)[1]
        if sub == "search_query_string":
            return "search"
        if sub == "listing_or_browse_path":
            return "browse"
        if sub in ("not_a_pdp_path", "no_recognizable_pdp_path"):
            # Distinguish the shapes the decision-maker enumerated.
            if path in ("", "/"):
                return "homepage"
            if re.search(r"/(?:collections?|category|categories|c)(?:/|$)", path, re.I):
                return "category-collection"
            if _is_shortlink(url):
                return "shortlink-unresolvable"
            return "not-PDP"
        return "not-PDP"
    if reason in ("non_product_path", "shopify_non_product_path", "retailer_non_product_path"):
        if path in ("", "/"):
            return "homepage"
        if re.search(r"/(?:collections?|category|categories)(?:/|$)", path, re.I):
            return "category-collection"
        if re.search(r"/(?:search)(?:/|$)", path, re.I):
            return "search"
        if re.search(r"/(?:blog|blogs|post|posts|article)(?:/|$)", path, re.I):
            return "blog-tutorial"
        return "not-PDP"
    if reason == "marketplace_profile":
        return "not-PDP"
    if reason == "non_commerce_domain":
        if _is_shortlink(url):
            return "shortlink-unresolvable"
        if path in ("", "/"):
            return "homepage"
        if re.search(r"/(?:blog|blogs|post|posts|article|ideas|tips|how-to|tutorial|\d{4}/\d{2})(?:/|$)",
                     path, re.I):
            return "blog-tutorial"
        return "blog-tutorial"   # non-commerce content domains are overwhelmingly editorial
    return "other"


_SHORTLINK_HOSTS = ("bit.ly", "shorturl", "onelink.", "s.click.", "amzn.to", "rstyle.me",
                    "shopstyle", "liketk.it", "ltk.app", "go.magik.ly", "shrsl.com",
                    "tidd.ly", "beacons.ai", "linktr.ee", "shop.app", "t.co")


def _is_shortlink(url: str) -> bool:
    d = get_domain(url)
    return any(h in d for h in _SHORTLINK_HOSTS)


DOMAIN_FAMILIES = (
    ("Etsy",                 lambda d: "etsy.com" in d),
    ("Amazon",               lambda d: "amazon." in d or "amzn." in d),
    ("Digital marketplaces", lambda d: any(x in d for x in (
        "payhip", "gumroad", "teacherspayteachers", "canva.com", "teepublic",
        "ko-fi", "creativemarket", "creativefabrica"))),
    ("Shopify / merchant",   lambda d: True),   # catch-all for accepted PDP merchants
)


def family_of(domain: str) -> str:
    for name, fn in DOMAIN_FAMILIES:
        if fn(domain):
            return name
    return "Other"


def main() -> int:
    with httpx.Client(timeout=90) as c:
        # ── Corpus: every crawled pin carrying an outbound link ──────────────
        pins = page_all(c, "pin_samples",
                        "pin_id,title,outbound_link,image_url,save_count,category,"
                        "seed_keyword,source_keyword,pinterest_url",
                        "outbound_link=not.is.null", "save_count.desc,pin_id.asc")
        total_pins = page_all(c, "pin_samples", "pin_id", "pin_id=not.is.null", "pin_id.asc")

        # ── Existing supply, lifecycle-aware (retired rows do NOT block) ─────
        existing = page_all(c, "pin_products",
                            "source_url,canonical_product_url,lifecycle_status,"
                            "detail_fetch_status,discovery_method,domain,product_name,"
                            "image_url,price,merchant",
                            f"or=({NOT_RETIRED_OR_EXPR})", "id.asc")
        for e in existing:
            if is_retired(e):
                raise RuntimeError("lifecycle filter leaked a retired row — aborting")
        active_norms = set()
        for e in existing:
            u = (e.get("source_url") or e.get("canonical_product_url") or "").strip()
            if not u:
                continue
            s = urlsplit(u)
            host = (s.netloc or "").lower()
            host = host[4:] if host.startswith("www.") else host
            active_norms.add(f"{host}{s.path.rstrip('/')}")

        def norm(u: str) -> str:
            s = urlsplit(u.strip())
            host = (s.netloc or "").lower()
            host = host[4:] if host.startswith("www.") else host
            return f"{host}{s.path.rstrip('/')}"

        # ── Gate every outbound link with the CURRENT accept_link (PDP inside) ──
        accepted: list[dict] = []
        rejected_buckets: Counter = Counter()
        rejected_raw: Counter = Counter()
        seen_norm: set[str] = set()
        dup_against_active = 0
        dup_within_batch = 0

        for p in pins:
            u = (p.get("outbound_link") or "").strip()
            ok, reason = accept_link(u)
            if not ok:
                rejected_buckets[reason_bucket(reason, u)] += 1
                rejected_raw[reason] += 1
                continue
            n = norm(u)
            if n in active_norms:
                dup_against_active += 1
                continue
            if n in seen_norm:
                dup_within_batch += 1
                continue
            seen_norm.add(n)
            # Evidence completeness (A-fields) — the DB CHECK will reject these anyway.
            has_evidence = bool(
                p.get("pin_id") and p.get("save_count") is not None
                and p.get("category") and (p.get("seed_keyword") or p.get("source_keyword")))
            accepted.append({**p, "_url": u, "_domain": get_domain(u),
                             "_family": family_of(get_domain(u)),
                             "_hasEvidence": has_evidence})

        evidence_ok = [a for a in accepted if a["_hasEvidence"]]
        evidence_missing = len(accepted) - len(evidence_ok)

        # ── Enrichment estimate: stratified by domain family, using ONLY the rows
        #    whose detail fetch actually ran (the 19 written + any prior outbound_link).
        measured = [e for e in existing
                    if e.get("discovery_method") == "outbound_link"
                    and e.get("detail_fetch_status")]
        strat: dict[str, dict] = defaultdict(lambda: {"n": 0, "available": 0})
        for m in measured:
            f = family_of(m.get("domain") or "")
            strat[f]["n"] += 1
            if m.get("detail_fetch_status") == "available":
                strat[f]["available"] += 1

        # Field-level availability, measured on the same fetched sample.
        field_sample = [m for m in measured]
        field_rates = {}
        for fld, key in (("product_name", "product_name"), ("product_image_url", "image_url"),
                         ("price", "price"), ("merchant", "merchant")):
            got = sum(1 for m in field_sample if m.get(key) not in (None, ""))
            field_rates[fld] = {
                "measuredOn": len(field_sample),
                "got": got,
                "rate": (f"{100.0*got/len(field_sample):.0f}%" if field_sample else "n/a"),
                "basis": "MEASURED on fetched rows (detail enrichment — requires a real fetch)",
            }
        # Evidence fields: exact, straight from the candidate set. No estimation.
        field_rates["source_pin_url"] = {
            "measuredOn": len(evidence_ok), "got": len(evidence_ok), "rate": "100%",
            "basis": "EXACT (Evidence field — derived from pin_id, always present by construction)"}
        n_saves = sum(1 for a in evidence_ok if a.get("save_count") is not None)
        field_rates["source_pin_save_count"] = {
            "measuredOn": len(evidence_ok), "got": n_saves,
            "rate": (f"{100.0*n_saves/len(evidence_ok):.0f}%" if evidence_ok else "n/a"),
            "basis": "EXACT (Evidence field — read directly from pin_samples, no fetch needed)"}

        # Project enrichment onto the candidate set, per family.
        by_family: dict[str, dict] = defaultdict(lambda: {"accepted": 0})
        for a in evidence_ok:
            by_family[a["_family"]]["accepted"] += 1
        projection = {}
        est_enriched = 0.0
        for fam, d in by_family.items():
            s = strat.get(fam, {"n": 0, "available": 0})
            rate = (s["available"] / s["n"]) if s["n"] else None
            proj = (d["accepted"] * rate) if rate is not None else None
            if proj is not None:
                est_enriched += proj
            projection[fam] = {
                "candidates": d["accepted"],
                "sampleN": s["n"],
                "sampleAvailable": s["available"],
                "sampledEnrichmentRate": (f"{100.0*rate:.0f}%" if rate is not None else "NO SAMPLE"),
                "projectedEnriched": (round(proj) if proj is not None else None),
                "caveat": ("extrapolated from a sample of %d fetched rows" % s["n"]) if s["n"]
                          else "no fetched sample for this family — enrichment UNKNOWN",
            }

        cat_counts = Counter((a.get("category") or "(none)") for a in evidence_ok)
        dom_counts = Counter(a["_domain"] for a in evidence_ok)

        report = {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "mode": "READ-ONLY recount. No writes. No crawler. No scoring. No scheduler. No schema change.",
            "gate": "current accept_link() with the PDP gate backfilled (incl. the 3 false-negative fixes)",
            "corpus": {
                "totalPinsScanned": len(total_pins),
                "pinsWithOutboundLink": len(pins),
            },
            "discovery": {
                "acceptedProductUrls": len(accepted),
                "rejectedUrls": sum(rejected_buckets.values()),
                "acceptRate": f"{100.0*len(accepted)/max(1,len(pins)):.1f}%",
                "rejectionReasons": dict(rejected_buckets.most_common()),
                "rejectionReasonsRaw_internal": dict(rejected_raw.most_common()),
            },
            "netNew": {
                "acceptedBeforeDedup": len(accepted) + dup_against_active + dup_within_batch,
                "duplicateOfExistingActiveRow": dup_against_active,
                "duplicateWithinCandidateBatch": dup_within_batch,
                "netNewAfterLifecycleAwareDedup": len(accepted),
                "ofWhichEvidenceComplete_WRITABLE": len(evidence_ok),
                "ofWhichEvidenceIncomplete_BLOCKED_by_v47_CHECK": evidence_missing,
                "note": ("Dedup is lifecycle-aware: RETIRED rows do NOT reserve their URL, so a "
                         "retired T10 URL is re-collectable. Only NON-retired rows block."),
            },
            "domainBreakdown_byFamily": {
                f: {"accepted": d["accepted"]} for f, d in sorted(
                    by_family.items(), key=lambda kv: -kv[1]["accepted"])},
            "domainBreakdown_topDomains": dict(dom_counts.most_common(20)),
            "categoryBreakdown": dict(cat_counts.most_common(25)),
            "fieldAvailability": field_rates,
            "enrichmentProjection": {
                "method": ("STRATIFIED ESTIMATE, not a full measurement. Detail enrichment can only "
                           "be known by actually fetching each merchant page, which would be a crawl "
                           "(explicitly forbidden this round). We therefore take the ONLY rows whose "
                           "detail fetch really ran (the outbound_link rows already in the DB), compute "
                           "the enrichment rate PER DOMAIN FAMILY, and project it onto the candidate "
                           "set of the same family."),
                "sampleTotal": len(measured),
                "byFamily": projection,
                "projectedEnrichedOfWritable": round(est_enriched),
                "projectedNullDetailOfWritable": len(evidence_ok) - round(est_enriched),
                "projectedEnrichmentRate":
                    (f"{100.0*est_enriched/len(evidence_ok):.0f}%" if evidence_ok else "n/a"),
            },
        }

        OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

        # Card preview payload for (B) — top 100 by save_count. NO WRITES.
        est_rate_by_fam = {f: (strat[f]["available"] / strat[f]["n"]) if strat.get(f, {}).get("n")
                           else None for f in by_family}
        cards = []
        for a in sorted(evidence_ok, key=lambda x: -(x.get("save_count") or 0))[:100]:
            cards.append({
                "pinId": a["pin_id"],
                "sourcePinImage": a.get("image_url"),
                "sourcePinUrl": a.get("pinterest_url") or f"https://www.pinterest.com/pin/{a['pin_id']}/",
                "externalProductUrl": a["_url"],
                "domain": a["_domain"],
                "family": a["_family"],
                "saves": a.get("save_count"),
                "category": a.get("category"),
                "keyword": a.get("seed_keyword") or a.get("source_keyword"),
                "pinTitle": a.get("title"),
                "familyEnrichmentRate": est_rate_by_fam.get(a["_family"]),
            })
        CARDS.write_text(json.dumps(cards, ensure_ascii=False, indent=2), encoding="utf-8")

        # ── stdout ──
        r = report
        print("=" * 78)
        print("(A) SUPPLY RECOUNT — READ-ONLY. Nothing written, no crawl, no scoring.")
        print("=" * 78)
        print(f"total pins scanned          : {r['corpus']['totalPinsScanned']}")
        print(f"  ...with an outbound link  : {r['corpus']['pinsWithOutboundLink']}")
        print(f"accepted product URLs       : {r['discovery']['acceptedProductUrls']}")
        print(f"rejected URLs               : {r['discovery']['rejectedUrls']}")
        print("\nREJECTION REASONS")
        for k, v in r["discovery"]["rejectionReasons"].items():
            print(f"  {k:26} {v:5}")
        print("\nNET NEW (lifecycle-aware dedup — retired rows do NOT block)")
        for k in ("acceptedBeforeDedup", "duplicateOfExistingActiveRow",
                  "duplicateWithinCandidateBatch", "netNewAfterLifecycleAwareDedup",
                  "ofWhichEvidenceComplete_WRITABLE", "ofWhichEvidenceIncomplete_BLOCKED_by_v47_CHECK"):
            print(f"  {k:46} {r['netNew'][k]:5}")
        print("\nDOMAIN BREAKDOWN (accepted, evidence-complete)")
        for f, d in r["domainBreakdown_byFamily"].items():
            print(f"  {f:24} {d['accepted']:5}")
        print("\nCATEGORY BREAKDOWN (top 12)")
        for k, v in list(r["categoryBreakdown"].items())[:12]:
            print(f"  {k:30} {v:5}")
        print("\nFIELD AVAILABILITY (6 fields — note the basis column)")
        for k, v in r["fieldAvailability"].items():
            print(f"  {k:22} {v['rate']:>5}  ({v['got']}/{v['measuredOn']})  {v['basis'][:52]}")
        print("\nENRICHMENT PROJECTION (STRATIFIED ESTIMATE — not a measurement)")
        ep = r["enrichmentProjection"]
        print(f"  sample = {ep['sampleTotal']} rows whose detail fetch actually ran")
        for f, d in ep["byFamily"].items():
            print(f"  {f:24} cand={d['candidates']:4}  sample={d['sampleN']:2} "
                  f"rate={d['sampledEnrichmentRate']:>8}  proj_enriched={d['projectedEnriched']}")
        print(f"  → projected enriched  : {ep['projectedEnrichedOfWritable']} "
              f"({ep['projectedEnrichmentRate']})")
        print(f"  → projected NULL detail: {ep['projectedNullDetailOfWritable']}")
        print(f"\nevidence → {OUT.name}, {CARDS.name}")
        return 0


if __name__ == "__main__":
    sys.exit(main())
