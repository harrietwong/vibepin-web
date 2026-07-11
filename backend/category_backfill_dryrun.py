"""
category_backfill_dryrun.py — DRY-RUN preview of product category normalization.

Read-only. Writes NOTHING. pin_products has no normalized_category column, so per
the MVP plan we only PREVIEW the inferred mapping and projected unknown-rate
reduction. No schema migration.

Signal cascade (highest confidence first):
  1. parent_pin_id -> pin_samples.category           confidence 0.95  (deterministic join)
  2. seed_keyword token overlap -> trend_keywords cat confidence 0.80
  3. digital_format set (printable/template/...)      confidence 0.70  -> digital-products
  4. unresolved

Confidence >= 0.80 is considered "qualified" for product supply; lower-confidence
inferences are reported but NOT counted as qualified supply.

Usage:
  python category_backfill_dryrun.py
  python category_backfill_dryrun.py --json
  python category_backfill_dryrun.py --examples 8
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict

from report_utils import fetch_all, normalize_keyword, norm_category

DIGITAL_FORMATS = {"printable", "template", "canva", "svg", "notion", "ebook", "pdf"}
QUALIFIED_CONFIDENCE = 0.80

# tokens too generic to anchor a category via token-overlap
_STOP = {
    "free", "printable", "template", "download", "downloadable", "digital",
    "the", "and", "for", "with", "etsy", "canva", "pdf", "set", "ideas",
    "best", "diy", "new", "art", "print",
}


def _tokens(text: str | None) -> set[str]:
    if not text:
        return set()
    raw = normalize_keyword(text).split()
    return {t for t in raw if len(t) > 2 and t not in _STOP}


def build_report(n_examples: int = 6) -> dict:
    keywords = fetch_all("trend_keywords", columns="keyword,category")
    kw_cat = {normalize_keyword(k.get("keyword")): norm_category(k.get("category")) for k in keywords}

    # category -> token frequency (for token-overlap inference)
    cat_tokens: dict[str, Counter] = defaultdict(Counter)
    for k in keywords:
        cat = norm_category(k.get("category"))
        if cat == "unknown":
            continue
        for tok in _tokens(k.get("keyword")):
            cat_tokens[cat][tok] += 1

    pins = fetch_all("pin_samples", columns="pin_id,category")
    pin_cat = {str(p["pin_id"]): norm_category(p.get("category")) for p in pins if p.get("pin_id")}

    products = fetch_all(
        "pin_products",
        columns="id,seed_keyword,parent_pin_id,product_name,digital_format,product_type,is_seed",
    )
    products = [p for p in products if not p.get("is_seed")]
    total = len(products)

    unknown = [p for p in products if kw_cat.get(normalize_keyword(p.get("seed_keyword")), "unknown") == "unknown"]
    n_unknown = len(unknown)

    by_signal: Counter = Counter()
    by_conf: Counter = Counter()
    inferred_by_cat: Counter = Counter()
    resolved = 0
    qualified = 0
    examples: list[dict] = []
    risky: list[dict] = []

    def infer(p: dict) -> tuple[str | None, float, str]:
        # 1. parent pin join
        parent = str(p.get("parent_pin_id") or "")
        if parent in pin_cat and pin_cat[parent] != "unknown":
            return pin_cat[parent], 0.95, "parent_pin"
        # 2. seed_keyword / title token overlap
        toks = _tokens(p.get("seed_keyword")) | _tokens(p.get("product_name"))
        if toks:
            best_cat, best_score = None, 0
            for cat, freq in cat_tokens.items():
                score = sum(freq.get(t, 0) for t in toks)
                if score > best_score:
                    best_cat, best_score = cat, score
            if best_cat and best_score >= 3:
                return best_cat, 0.80, "token_overlap"
        # 3. digital_format fallback
        if (p.get("digital_format") or "").lower() in DIGITAL_FORMATS or p.get("product_type") == "digital":
            return "digital-products", 0.70, "digital_format"
        return None, 0.0, "unresolved"

    for p in unknown:
        cat, conf, signal = infer(p)
        by_signal[signal] += 1
        if cat:
            resolved += 1
            by_conf[f"{conf:.2f}"] += 1
            inferred_by_cat[cat] += 1
            if conf >= QUALIFIED_CONFIDENCE:
                qualified += 1
            if len(examples) < n_examples and conf >= 0.80:
                examples.append({
                    "product": (p.get("product_name") or "")[:45],
                    "seed_keyword": p.get("seed_keyword"),
                    "inferred_category": cat,
                    "confidence": conf,
                    "signal": signal,
                })
            if len(risky) < n_examples and conf < 0.80:
                risky.append({
                    "product": (p.get("product_name") or "")[:45],
                    "seed_keyword": p.get("seed_keyword"),
                    "inferred_category": cat,
                    "confidence": conf,
                    "signal": signal,
                })

    still_unknown = n_unknown - resolved
    # projected unknown rate counts only QUALIFIED resolutions as truly mapped
    projected_unknown_qualified = n_unknown - qualified
    new_rate_all = round((total - n_unknown + resolved) and (still_unknown) / total, 4) if total else 0.0
    new_rate_qualified = round(projected_unknown_qualified / total, 4) if total else 0.0

    return {
        "total_products": total,
        "current_unknown": n_unknown,
        "current_unknown_rate": round(n_unknown / total, 4) if total else 0.0,
        "resolved_any_confidence": resolved,
        "resolved_qualified_080plus": qualified,
        "still_unresolved": still_unknown,
        "projected_unknown_rate_all": new_rate_all,
        "projected_unknown_rate_qualified_only": new_rate_qualified,
        "by_signal": dict(by_signal.most_common()),
        "by_confidence": dict(by_conf.most_common()),
        "inferred_by_category": dict(inferred_by_cat.most_common()),
        "examples_correct": examples,
        "examples_risky": risky,
    }


def print_report(r: dict) -> None:
    line = "─" * 66
    print(f"\n{line}\n  PRODUCT CATEGORY BACKFILL — DRY RUN (no writes)\n{line}")
    print(f"  Total products                  : {r['total_products']}")
    print(f"  Current unknown                 : {r['current_unknown']}  ({r['current_unknown_rate']*100:.1f}%)")
    print(f"  Resolved (any confidence)       : {r['resolved_any_confidence']}")
    print(f"  Resolved qualified (>=0.80)     : {r['resolved_qualified_080plus']}")
    print(f"  Still unresolved                : {r['still_unresolved']}")
    print(f"  Projected unknown rate (all)        : {r['projected_unknown_rate_all']*100:.1f}%")
    print(f"  Projected unknown rate (qualified)  : {r['projected_unknown_rate_qualified_only']*100:.1f}%   (target < 25%)")
    print(f"\n  By signal:")
    for k, v in r["by_signal"].items():
        print(f"    {k:<16} {v}")
    print(f"\n  By confidence:")
    for k, v in r["by_confidence"].items():
        print(f"    {k:<16} {v}")
    print(f"\n  Inferred by category:")
    for k, v in r["inferred_by_category"].items():
        print(f"    {k:<20} {v}")
    print(f"\n  Example correct matches (conf>=0.80):")
    for e in r["examples_correct"]:
        print(f"    [{e['confidence']:.2f} {e['signal']}] {e['inferred_category']:<16} <- {e['product']!r}")
    print(f"\n  Example risky matches (conf<0.80, NOT counted as qualified):")
    for e in r["examples_risky"]:
        print(f"    [{e['confidence']:.2f} {e['signal']}] {e['inferred_category']:<16} <- {e['product']!r}")
    print(line)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Product category backfill DRY RUN")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--examples", type=int, default=6)
    args = ap.parse_args()
    rep = build_report(n_examples=args.examples)
    if args.json:
        print(json.dumps(rep, indent=2, ensure_ascii=False))
    else:
        print_report(rep)
