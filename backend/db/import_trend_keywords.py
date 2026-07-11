"""
import_trend_keywords.py — Bootstrap/admin CSV import for trend_keywords.

NOT the daily production path. Automated seeds come from trend_fetcher.py +
trend_seed_pipeline.py via run_worker.py --job trends or run_crawl.py.

Rules:
- keyword + category 已存在 → 更新变化率、priority_score、status 等
- 不存在 → 插入

priority_score 计算：
  monthly_change × 3  +  weekly_change × 2  +  yearly_change × 1
  + 10 若 keyword 含 outfit / nails / decor / ideas / aesthetic / styling
  = -100 若 status = rejected（强制沉底）

用法：
    py db/import_trend_keywords.py
    py db/import_trend_keywords.py --file trend_keywords_seed.csv
    py db/import_trend_keywords.py --dry-run
"""

import argparse
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from db import upsert  # noqa: E402

DEFAULT_CSV = Path(__file__).parent.parent / "trend_keywords_seed.csv"

BONUS_KEYWORDS = ["outfit", "nails", "decor", "ideas", "aesthetic", "styling"]


def _safe_float(val, default: float = 0.0) -> float:
    try:
        return float(str(val).strip()) if str(val).strip() else default
    except (ValueError, TypeError):
        return default


def calculate_priority_score(row: dict) -> float:
    monthly = _safe_float(row.get("monthly_change"))
    weekly  = _safe_float(row.get("weekly_change"))
    yearly  = _safe_float(row.get("yearly_change"))

    score = monthly * 3.0 + weekly * 2.0 + yearly * 1.0

    kw = str(row.get("keyword", "")).lower()
    if any(b in kw for b in BONUS_KEYWORDS):
        score += 10

    if str(row.get("status", "")).lower() == "rejected":
        score = -100.0

    return round(score, 2)


def load_csv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def build_row(raw: dict) -> dict:
    return {
        "keyword":              raw.get("keyword", "").strip(),
        "category":             raw.get("category", "home").strip(),
        "subcategory":          raw.get("subcategory") or None,
        "region":               raw.get("region") or "US",
        "source":               raw.get("source") or "manual",
        "season":               raw.get("season") or None,
        "intent_type":          raw.get("intent_type") or None,
        "content_type":         raw.get("content_type") or None,
        "weekly_change":        _safe_float(raw.get("weekly_change")),
        "monthly_change":       _safe_float(raw.get("monthly_change")),
        "yearly_change":        _safe_float(raw.get("yearly_change")),
        "search_volume_level":  raw.get("search_volume_level") or None,
        "status":               raw.get("status") or "active",
        "notes":                raw.get("notes") or None,
        "priority_score":       calculate_priority_score(raw),
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--file",    default=str(DEFAULT_CSV), help="CSV 文件路径")
    p.add_argument("--dry-run", action="store_true",      help="只打印，不写入")
    args = p.parse_args()

    path = Path(args.file)
    if not path.exists():
        print(f"❌ 文件不存在: {path}")
        sys.exit(1)

    raw_rows = load_csv(path)
    rows = [build_row(r) for r in raw_rows if r.get("keyword", "").strip()]

    if not rows:
        print("⚠️  没有有效行")
        sys.exit(0)

    # Print preview
    print(f"{'keyword':<35} {'category':<10} {'score':>7}  {'status'}")
    print("-" * 65)
    for r in rows:
        print(f"{r['keyword']:<35} {r['category']:<10} {r['priority_score']:>7.1f}  {r['status']}")

    print(f"\n共 {len(rows)} 条")

    if args.dry_run:
        print("（dry-run 模式，未写入）")
        return

    result = upsert(
        "trend_keywords",
        rows,
        on_conflict="keyword,category",
    )
    print(f"\n✅ trend_keywords upserted: {len(result)} 条")


if __name__ == "__main__":
    main()
