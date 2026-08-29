"""
t2_harvest.py — the T2 Opportunity Discovery harvester.

Supersedes backend/tools/t2_pilot_harvest.py. That tool was built for the OLD product
positioning ("a row is only good if we scraped full product details"), and its central
rule — "no product_name → REJECT the row" — is now WRONG. It threw away real
opportunities (every Etsy listing behind a WAF) because it could not read a merchant
page it never needed to read.

════════════════════════════════════════════════════════════════════════════════
 VibePin is a Pinterest OPPORTUNITY DISCOVERY tool.
 It is NOT a product scraper, NOT a product database, NOT marketplace intelligence.
════════════════════════════════════════════════════════════════════════════════
The asset is the EVIDENCE:
    Pin → external product URL → verified Pinterest demand → Opportunity → user clicks
Product DETAILS are optional enrichment. Etsy at Discovery=100% / Detail=0% is a
COMPLETE SUCCESS, not a problem to solve.

── SHARED CORE (2026-07-19) ────────────────────────────────────────────────────
The discover / red-line / write / verify / rollback machinery is NOT defined here
any more — it lives in backend/supply_core.py, imported below and re-exported so
this tool's existing behaviour and tests are byte-for-byte unchanged. The SAME core
is imported by the automatic Shop-the-Look production path
(shop_the_look_expand.py), so the manual T2 tool and the automatic Product-Supply
job share one candidate-admissibility gate, one discover(), one check_red_lines(),
one PLAIN INSERT, one verify_written(), and one rollback. There is no second copy of
the red-line logic anywhere.

This file keeps ONLY:
  • build_candidates() — the T2-specific DB candidate query (retired-URL re-collection
    + net-new outbound pins), which produces the {pin, url} candidates the shared core
    consumes;
  • main() / the CLI — the operator entry point (--dry-run / --apply / --rollback-window).

── THE TWO-TIER FIELD MODEL (the whole design) ────────────────────────────────
A. REQUIRED — Opportunity Evidence. Missing any one → NOT an opportunity → no write.
     parent_pin_id, source_pin_url, source_url (the external product URL),
     source_pin_save_count, source_category, seed_keyword, discovery_method
   Enforced THREE times: assert_evidence() (core), the DB CHECK
   pin_products_outbound_evidence_check (v47), and the red-line gate.

B. OPTIONAL — Product Details. Un-fetchable → NULL. NEVER blocks the opportunity.
     product_name, image_url, price, currency, merchant, availability
   Outcome recorded honestly in detail_fetch_status:
     available | blocked | not_found | not_attempted        (v48 vocabulary)

── THE THREE RED LINES (hard-coded in supply_core; violation = no write / rollback) ──
  1. A Pin title NEVER becomes product_name.       Un-fetchable → NULL.
  2. A Pin image NEVER becomes image_url.          pinimg/pinterest host → REJECT → NULL.
  3. NEVER guess a field. Absent on the merchant page → NULL. No inference, no default.

FETCH ETIQUETTE: >= 0.55 s between outbound GETs (<= 2 req/s), real browser UA, 10 s
timeout, GET only, follow redirects, never log in, never render or execute JS. A WAF 403
is recorded honestly as detail_fetch_status='blocked' — we do NOT work around it.

USAGE
  py t2_harvest.py --dry-run                  # discover + enrich + validate; write nothing
  py t2_harvest.py --apply --confirm-write    # insert (<=20 rows), verify, auto-rollback on failure
  py t2_harvest.py --rollback-window LO HI    # delete a batch by its created_at window
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import httpx

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND.parent
for p in (str(BACKEND), str(BACKEND / "db")):
    if p not in sys.path:
        sys.path.insert(0, p)

# ── THE shared bounded core. Everything below this line that the tests and the CLI
#    reference (constants, discover, check_red_lines, verify_written, enc_ts, …) is
#    RE-EXPORTED from supply_core so t2_harvest stays a thin, T2-specific shell over
#    the single source of truth. ─────────────────────────────────────────────────
import supply_core as core  # noqa: E402
from supply_core import (  # noqa: E402,F401  (re-exported for the CLI and the test suite)
    SUPABASE_URL, SERVICE_KEY,
    DISCOVERY_METHOD, MAX_BATCH, MIN_INTERVAL,
    DETAIL_AVAILABLE, DETAIL_BLOCKED, DETAIL_NOT_FOUND, DETAIL_NOT_ATTEMPTED, DETAIL_STATES,
    BLOCKED_STATUSES, UA, BROWSER_HEADERS,
    ALLOWED_COLUMNS, REQUIRED_EVIDENCE, ENRICHMENT_FIELDS, PINTEREST_IMG_HOSTS,
    normalize_product_url, url_hash,
    extract_details,
    _headers, enc_ts, _require_list, _page_all, active_dedup_norms,
    DOMAIN_BUCKETS, bucket_of,
    polite_get, assert_evidence, discover,
    check_red_lines, build_metrics, verify_written,
)
from product_lifecycle import NOT_RETIRED_OR_EXPR, is_retired          # noqa: E402,F401
from product_harvest import accept_link, get_domain, is_product_detail_url  # noqa: E402,F401

OUT = Path(__file__).resolve().parent / "t2_harvest_evidence.json"


# ── Candidate selection — T2-specific DB query producing {pin, url} candidates ───

def build_candidates(c: httpx.Client, want: int) -> tuple[list[dict], dict]:
    """Two sources:
       (A) RETIRED-URL re-collection — the lifecycle-coexistence proof;
       (B) net-new outbound pins never present in pin_products.
    Bucket-balanced across shopify / digital / amazon / etsy. Etsy is INCLUDED: a WAF is
    an enrichment problem, never a discovery problem.

    Emits the shared {pin, url, origin, domain} candidate shape that supply_core.discover
    consumes. `pin` carries ONLY provenance evidence — never product-card details."""
    active = active_dedup_norms(c)

    retired = _page_all(c, "pin_products",
                        "parent_pin_id,source_url,domain,product_name,image_url,source_pin_save_count",
                        "lifecycle_status=eq.retired", "id.asc")
    # accept_link() now embeds the PDP gate, so this single call enforces both.
    reclaim = [r for r in retired
               if r.get("source_url")
               and normalize_product_url(r["source_url"]) not in active
               and accept_link(r["source_url"])[0]]

    pins_by_id: dict[str, dict] = {}
    ids = [r["parent_pin_id"] for r in reclaim if r.get("parent_pin_id")]
    for i in range(0, len(ids), 100):
        chunk = ids[i:i + 100]
        for p in _page_all(c, "pin_samples",
                           "pin_id,title,outbound_link,image_url,save_count,category,"
                           "seed_keyword,source_keyword,pinterest_url",
                           "pin_id=in.(" + ",".join(chunk) + ")", "pin_id.asc"):
            pins_by_id[p["pin_id"]] = p

    cands: list[dict] = []
    for r in reclaim:
        p = pins_by_id.get(r.get("parent_pin_id") or "")
        if not p:
            continue
        cands.append({"pin": p, "url": r["source_url"], "origin": "retired_reclaim",
                      "domain": get_domain(r["source_url"])})

    seen = {normalize_product_url(x["url"]) for x in cands}
    fresh = _page_all(c, "pin_samples",
                      "pin_id,title,outbound_link,image_url,save_count,category,"
                      "seed_keyword,source_keyword,pinterest_url",
                      "outbound_link=not.is.null", "save_count.desc,pin_id.asc")
    for p in fresh:
        u = (p.get("outbound_link") or "").strip()
        if not u or not accept_link(u)[0]:
            continue
        n = normalize_product_url(u)
        if n in active or n in seen:
            continue
        seen.add(n)
        cands.append({"pin": p, "url": u, "origin": "net_new", "domain": get_domain(u)})

    by_bucket: dict[str, list[dict]] = defaultdict(list)
    for x in cands:
        by_bucket[bucket_of(x["domain"])].append(x)

    rng = random.Random(20260714)

    def _spread(pool: list[dict]) -> list[dict]:
        """Round-robin across DISTINCT merchant domains so one hostile host cannot
        monopolise a bucket and make the whole bucket look incapable."""
        by_dom: dict[str, list[dict]] = defaultdict(list)
        for x in pool:
            by_dom[x["domain"]].append(x)
        for v in by_dom.values():
            rng.shuffle(v)
        doms = sorted(by_dom, key=lambda d: -len(by_dom[d]))
        rng.shuffle(doms)
        out: list[dict] = []
        while any(by_dom[d] for d in doms):
            for d in doms:
                if by_dom[d]:
                    out.append(by_dom[d].pop())
        return out

    picked: list[dict] = []
    reclaims = _spread([x for x in cands if x["origin"] == "retired_reclaim"])
    picked += reclaims[:max(6, want // 2)]
    for b in ("shopify", "digital", "amazon", "etsy"):
        pool = _spread([x for x in by_bucket.get(b, []) if x not in picked])
        picked += pool[:8]
    rng.shuffle(picked)

    stats = {
        "activeNormUrls": len(active),
        "retiredRows": len(retired),
        "retiredUrlsReCollectable": len(reclaim),
        "retiredWithSourcePin": sum(1 for x in cands if x["origin"] == "retired_reclaim"),
        "netNewCandidates": sum(1 for x in cands if x["origin"] == "net_new"),
    }
    return picked, stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--confirm-write", action="store_true")
    ap.add_argument("--limit", type=int, default=18)
    ap.add_argument("--rollback-window", nargs=2, metavar=("LO", "HI"))
    args = ap.parse_args()

    assert args.limit <= MAX_BATCH, f"limit {args.limit} > MAX_BATCH {MAX_BATCH}"

    with httpx.Client(timeout=60) as db:
        if args.rollback_window:
            lo, hi = args.rollback_window
            res = core.rollback_window(db, lo, hi)
            print(f"rollback → HTTP {res['status']}, removed {res['removed']} rows")
            return 0 if (res["status"] or 500) < 300 else 1

        cands, stats = build_candidates(db, args.limit)
        print(f"candidate pool: {json.dumps(stats)}")
        print("picked buckets: " + json.dumps(
            {b: sum(1 for x in cands if bucket_of(x["domain"]) == b)
             for b in ("shopify", "digital", "amazon", "etsy", "other")}))
        print("        origins: " + json.dumps(
            {o: sum(1 for x in cands if x["origin"] == o)
             for o in ("retired_reclaim", "net_new")}))

        with httpx.Client(timeout=15) as web:
            rows, failures = discover(web, cands, want=args.limit)

        assert len(rows) <= MAX_BATCH, f"batch {len(rows)} exceeds MAX_BATCH {MAX_BATCH}"

        metrics = build_metrics(rows, failures)
        ok, violations = check_red_lines(rows)

        print(f"\n── DISCOVERY: {len(rows)} opportunities, {len(failures)} rejected ──")
        print("OVERALL   ", json.dumps(metrics["overall"], ensure_ascii=False))
        print("\nBY DOMAIN — Discovery rate vs Detail enrichment rate (SEPARATE metrics):")
        print(f"  {'domain':<32} {'bkt':<8} {'disc':>10} {'detail':>10}  detail_fetch_status")
        for dom, m in metrics["byDomain"].items():
            print(f"  {dom:<32} {m['bucket']:<8} "
                  f"{m['discovered']}/{m['attempted']:<2} {m['discoverySuccessRate']:>5} "
                  f"{m['detailEnriched']}/{m['discovered']:<2} {m['detailEnrichmentRate']:>5}  "
                  f"{json.dumps(m['detailFetchStatus'])}")
        print(f"\nRED LINES (pre-write): {'PASS' if ok else 'FAIL'}")
        for x in violations:
            print("  VIOLATION:", x)

        evidence = {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "mode": "apply" if (args.apply and args.confirm_write) else "dry-run",
            "positioning": "Pinterest Opportunity Discovery — product details are OPTIONAL enrichment",
            "candidatePool": stats,
            "metrics": metrics,
            "redLinesPassPreWrite": ok,
            "violations": violations,
            "discovered": [i["rec"] for i in rows],
            "discoveryFailures": failures,
        }

        if not (args.apply and args.confirm_write) or not ok:
            evidence["written"] = 0
            OUT.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"\nDRY-RUN (or red-line FAIL): nothing written. evidence → {OUT.name}")
            return 0 if ok else 1

        # ── WRITE via the shared core: PLAIN INSERT + read-back verify + precise
        #    DB-derived rollback on any post-write failure. ─────────────────────
        result = core.apply_rows(db, rows)
        evidence.update({k: result[k] for k in
                         ("written", "insertedIds", "createdAtWindow", "rollback")
                         if k in result})
        if "insertError" in result:
            print(f"INSERT FAILED [{result.get('insertStatus')}]: {result['insertError']}")
            evidence["insertError"] = result["insertError"]
            OUT.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
            return 1

        print(f"\nINSERTED {result['written']} / {len(rows)} rows")
        print("ROLLBACK:\n ", result["rollback"])

        post = result["postWriteVerification"]
        evidence["postWriteVerification"] = post

        print("\n── POST-WRITE RED-LINE VERIFICATION (read back from the DB) ──")
        for k in ("redLine1_sourceAuthenticity", "redLine2_noFabrication",
                  "redLine3_provenanceSeparation", "redLine4_lifecycleCoexistence"):
            print(f"  {'PASS' if post[k]['pass'] else 'FAIL'}  {k}")
            for x in post[k].get("violations", []):
                print("        violation:", x)
        for c2 in post["redLine4_lifecycleCoexistence"]["pairs"]:
            print(f"        {'OK ' if c2['coexists'] else 'NO '} {c2['lifecycleStates']} "
                  f"rows={c2['rows']}  {c2['url'][:70]}")

        if result.get("rolledBack"):
            print("\n!! POST-WRITE RED LINE FAILED — ROLLED BACK")
            print(f"  rollback → HTTP {result.get('rollbackStatus')}, "
                  f"removed {result.get('rollbackRemoved')} rows")
            evidence["rolledBack"] = True
            OUT.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
            return 1

        OUT.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        print("\nALL FOUR RED LINES PASS POST-WRITE. evidence →", OUT.name)
        return 0


if __name__ == "__main__":
    sys.exit(main())
