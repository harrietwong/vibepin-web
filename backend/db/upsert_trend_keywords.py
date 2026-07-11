"""
upsert_trend_keywords.py — 将趋势关键词写入 trend_keywords 表。

用法：
    py db/upsert_trend_keywords.py
    py db/upsert_trend_keywords.py --file my_keywords.txt --category home
    py db/upsert_trend_keywords.py --region US --season summer_2026
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from db import upsert  # noqa: E402

DEFAULT_KEYWORDS = [
    ("living room decor ideas",   "home", "living_room"),
    ("cozy bedroom decor",        "home", "bedroom"),
    ("vintage home decor",        "home", "vintage"),
    ("boho living room ideas",    "home", "living_room"),
    ("neutral living room decor", "home", "living_room"),
    ("modern farmhouse decor",    "home", "farmhouse"),
    ("small apartment decor",     "home", "apartment"),
    ("wall art decor ideas",      "home", "wall_art"),
    ("coffee table styling",      "home", "living_room"),
    ("home decor collage",        "home", "collage"),
]


def load_from_file(path: str, category: str, subcategory: str | None) -> list[tuple]:
    rows = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        kw = line.strip()
        if kw and not kw.startswith("#"):
            rows.append((kw, category, subcategory))
    return rows


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--file",         help="关键词文件（每行一个）")
    p.add_argument("--category",     default="home")
    p.add_argument("--subcategory",  default=None)
    p.add_argument("--region",       default="US")
    p.add_argument("--source",       default="pinterest_search")
    p.add_argument("--trend-intent", default=None)
    p.add_argument("--season",       default=None)
    args = p.parse_args()

    pairs = (
        load_from_file(args.file, args.category, args.subcategory)
        if args.file else DEFAULT_KEYWORDS
    )

    rows = [
        {
            "keyword":        kw,
            "category":       cat,
            "subcategory":    sub,
            "region":         args.region,
            "source":         args.source,
            "trend_intent":   args.trend_intent,
            "season":         args.season,
            "priority_score": 0,
        }
        for kw, cat, sub in pairs
    ]

    result = upsert("trend_keywords", rows, on_conflict="keyword,category")
    print(f"✅ trend_keywords upserted: {len(result)} 条")


if __name__ == "__main__":
    main()
