"""
import_products.py -- JSONL -> Supabase pin_products

Usage:
  cd backend
  py db/import_products.py
"""
import json, sys
from pathlib import Path

# Force UTF-8 stdout so emoji/Chinese chars don't crash on GBK consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT      = Path(__file__).parent.parent          # backend/
JSONL     = ROOT / "shop_the_look_products.jsonl"
BATCH     = 50                                     # rows per upsert call

sys.path.insert(0, str(Path(__file__).parent))
from db import upsert


def _parse_price(raw) -> float | None:
    if not raw:
        return None
    s = str(raw).strip().lstrip("$£€¥₩").replace(",", "").split()[0]
    try:
        v = float(s)
        return round(v, 2) if v > 0 else None
    except (ValueError, TypeError):
        return None


def _parse_currency(raw) -> str:
    if not raw:
        return "USD"
    s = str(raw).strip()
    if s.startswith("£"): return "GBP"
    if s.startswith("€"): return "EUR"
    if s.startswith("¥"): return "JPY"
    return "USD"


def build_row(p: dict) -> dict | None:
    title = (p.get("title") or "").strip()
    if not title:
        return None
    return {
        "product_pin_id":        p.get("product_pin_id") or None,
        "parent_pin_id":         str(p.get("parent_pin_id") or ""),
        "product_name":          title[:500],
        "price":                 _parse_price(p.get("price")),
        "currency":              _parse_currency(p.get("price")),
        "source_url":            p.get("link") or None,
        "domain":                p.get("domain") or None,
        "merchant":              p.get("merchant") or None,
        "image_url":             p.get("image_url") or None,
        "save_count":            int(p.get("save_count") or 0),
        "reaction_count":        int(p.get("reaction_count") or 0),
        "source_pin_save_count": int(p.get("source_pin_save_count") or 0),
        "seed_keyword":          p.get("seed_keyword") or None,
    }


def main():
    if not JSONL.exists():
        print(f"[import] 找不到 {JSONL}")
        sys.exit(1)

    raw = [json.loads(l) for l in JSONL.read_text(encoding="utf-8").splitlines() if l.strip()]
    rows = [r for p in raw if (r := build_row(p)) is not None]
    print(f"[import] 共 {len(raw)} 条原始数据，{len(rows)} 条有效")

    # Deduplicate within each conflict group before batching
    keyed_map:   dict[str, dict] = {}
    unkeyed_map: dict[tuple, dict] = {}
    for r in rows:
        if r.get("product_pin_id"):
            keyed_map[r["product_pin_id"]] = r
        elif r.get("parent_pin_id") and r.get("source_url"):
            unkeyed_map[(r["parent_pin_id"], r["source_url"])] = r

    keyed   = list(keyed_map.values())
    unkeyed = list(unkeyed_map.values())
    print(f"[import] keyed={len(keyed)}  unkeyed={len(unkeyed)}  (after dedup)")

    total = 0
    for group, conflict in [(keyed, "product_pin_id"), (unkeyed, "parent_pin_id,source_url")]:
        for i in range(0, len(group), BATCH):
            batch = group[i:i + BATCH]
            try:
                result = upsert("pin_products", batch, on_conflict=conflict)
                total += len(result)
                print(f"  OK upserted {len(result)} rows  (conflict={conflict})")
            except Exception as e:
                print(f"  FAIL batch failed: {e}")

    print(f"\n[import] 完成，写入 {total} 行到 pin_products")


if __name__ == "__main__":
    main()
