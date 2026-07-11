"""
product_link_dryrun.py — DRY-RUN preview of linking unlinked products to keywords.

Read-only. Writes NOTHING to keyword_product_map. Conservative matching only.

A product is "unlinked" if its id is absent from keyword_product_map. For each,
we infer its category (parent_pin -> pin_samples.category, else token overlap),
then within that category find the best keyword by content-token overlap.

Conservative gates:
  • candidate keyword must be in the product's inferred category
  • >= 2 shared content tokens (title + seed_keyword vs keyword)
  • confidence = 0.70 + 0.05 * min(shared, 5)   (cap 0.95)
  • only confidence >= 0.70 reported as a candidate link

Usage:
  python product_link_dryrun.py
  python product_link_dryrun.py --json
  python product_link_dryrun.py --examples 10
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict

from report_utils import fetch_all, normalize_keyword, norm_category

CONF_MIN = 0.70
DIGITAL_FORMATS = {"printable", "template", "canva", "svg", "notion", "ebook", "pdf"}
_STOP = {
    "free", "printable", "template", "download", "downloadable", "digital",
    "the", "and", "for", "with", "etsy", "canva", "pdf", "set", "ideas",
    "best", "diy", "new",
}


def _tokens(text: str | None) -> set[str]:
    if not text:
        return set()
    return {t for t in normalize_keyword(text).split() if len(t) > 2 and t not in _STOP}


def build_report(n_examples: int = 8) -> dict:
    keywords = fetch_all("trend_keywords", columns="id,keyword,category,status,is_seed")
    active_kw = [k for k in keywords if k.get("status") == "active" and not k.get("is_seed")]

    # per-category keyword index + global category token freq
    kw_by_cat: dict[str, list[dict]] = defaultdict(list)
    cat_tokens: dict[str, Counter] = defaultdict(Counter)
    for k in active_kw:
        cat = norm_category(k.get("category"))
        toks = _tokens(k.get("keyword"))
        kw_by_cat[cat].append({"id": k["id"], "keyword": k["keyword"], "tokens": toks})
        if cat != "unknown":
            for t in toks:
                cat_tokens[cat][t] += 1

    pins = fetch_all("pin_samples", columns="pin_id,category")
    pin_cat = {str(p["pin_id"]): norm_category(p.get("category")) for p in pins if p.get("pin_id")}

    kpm = fetch_all("keyword_product_map", columns="product_id")
    linked_ids = {r["product_id"] for r in kpm if r.get("product_id")}

    products = fetch_all(
        "pin_products",
        columns="id,seed_keyword,parent_pin_id,product_name,digital_format,product_type,is_seed",
    )
    products = [p for p in products if not p.get("is_seed")]
    unlinked = [p for p in products if p["id"] not in linked_ids]

    def infer_category(p: dict) -> str:
        parent = str(p.get("parent_pin_id") or "")
        if parent in pin_cat and pin_cat[parent] != "unknown":
            return pin_cat[parent]
        toks = _tokens(p.get("seed_keyword")) | _tokens(p.get("product_name"))
        best, best_score = "unknown", 0
        for cat, freq in cat_tokens.items():
            score = sum(freq.get(t, 0) for t in toks)
            if score > best_score:
                best, best_score = cat, score
        if best != "unknown" and best_score >= 3:
            return best
        if (p.get("digital_format") or "").lower() in DIGITAL_FORMATS or p.get("product_type") == "digital":
            return "digital-products"
        return "unknown"

    candidates = 0
    by_cat: Counter = Counter()
    by_bucket: Counter = Counter()
    examples: list[dict] = []
    risky: list[dict] = []
    no_match = 0

    for p in unlinked:
        cat = infer_category(p)
        if cat == "unknown" or cat not in kw_by_cat:
            no_match += 1
            continue
        prod_toks = _tokens(p.get("product_name")) | _tokens(p.get("seed_keyword"))
        if not prod_toks:
            no_match += 1
            continue
        best_kw, best_shared = None, 0
        for kw in kw_by_cat[cat]:
            shared = len(prod_toks & kw["tokens"])
            if shared > best_shared:
                best_kw, best_shared = kw, shared
        if not best_kw or best_shared < 2:
            no_match += 1
            continue
        conf = round(min(0.95, CONF_MIN + 0.05 * min(best_shared, 5)), 2)
        candidates += 1
        by_cat[cat] += 1
        bucket = "0.90+" if conf >= 0.90 else "0.80-0.89" if conf >= 0.80 else "0.70-0.79"
        by_bucket[bucket] += 1
        rec = {
            "product": (p.get("product_name") or "")[:42],
            "inferred_category": cat,
            "matched_keyword": best_kw["keyword"],
            "shared_tokens": best_shared,
            "confidence": conf,
        }
        if conf >= 0.80 and len(examples) < n_examples:
            examples.append(rec)
        elif conf < 0.80 and len(risky) < n_examples:
            risky.append(rec)

    return {
        "total_products": len(products),
        "already_linked": len(products) - len(unlinked),
        "unlinked": len(unlinked),
        "candidate_links": candidates,
        "unlinked_no_confident_match": no_match,
        "candidates_by_category": dict(by_cat.most_common()),
        "candidates_by_confidence_bucket": dict(by_bucket.most_common()),
        "examples_correct": examples,
        "examples_risky": risky,
        "note": "DRY RUN — no keyword_product_map rows written. Review before writing.",
    }


def print_report(r: dict) -> None:
    line = "─" * 66
    print(f"\n{line}\n  PRODUCT -> OPPORTUNITY LINKING — DRY RUN (no writes)\n{line}")
    print(f"  Total products              : {r['total_products']}")
    print(f"  Already linked              : {r['already_linked']}")
    print(f"  Unlinked                    : {r['unlinked']}")
    print(f"  Candidate links found       : {r['candidate_links']}")
    print(f"  Unlinked, no confident match: {r['unlinked_no_confident_match']}")
    print(f"\n  Candidates by category:")
    for k, v in r["candidates_by_category"].items():
        print(f"    {k:<20} {v}")
    print(f"\n  Candidates by confidence bucket:")
    for k, v in r["candidates_by_confidence_bucket"].items():
        print(f"    {k:<12} {v}")
    print(f"\n  Example correct matches:")
    for e in r["examples_correct"]:
        print(f"    [{e['confidence']:.2f} x{e['shared_tokens']}] {e['inferred_category']:<16} "
              f"{e['matched_keyword']!r} <- {e['product']!r}")
    print(f"\n  Example risky matches (0.70-0.79):")
    for e in r["examples_risky"]:
        print(f"    [{e['confidence']:.2f} x{e['shared_tokens']}] {e['inferred_category']:<16} "
              f"{e['matched_keyword']!r} <- {e['product']!r}")
    print(f"\n  {r['note']}")
    print(line)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Product -> opportunity linking DRY RUN")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--examples", type=int, default=8)
    args = ap.parse_args()
    rep = build_report(n_examples=args.examples)
    if args.json:
        print(json.dumps(rep, indent=2, ensure_ascii=False))
    else:
        print_report(rep)
