"""
upsert_pin_samples.py — 将爬虫 all_pins.jsonl 写入 pin_samples + pin_style_analysis。

用法：
    py db/upsert_pin_samples.py
    py db/upsert_pin_samples.py --input vibe_library/output/all_pins.jsonl
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from db import upsert, select_one  # noqa: E402

DEFAULT_INPUT = Path(__file__).parent.parent / "vibe_library" / "output" / "all_pins.jsonl"

_KW_CACHE: dict[str, str | None] = {}


def _get_keyword_id(keyword: str) -> str | None:
    if not keyword:
        return None
    if keyword not in _KW_CACHE:
        row = select_one("trend_keywords", {"keyword": keyword})
        _KW_CACHE[keyword] = str(row["id"]) if row else None
    return _KW_CACHE[keyword]


def _parse_dt(val) -> str | None:
    if not val:
        return None
    try:
        dt = datetime.fromisoformat(str(val))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat()
    except Exception:
        return None


def _to_int(val, default: int = 0) -> int:
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


def load_records(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".json":
        data = json.loads(text)
        return data if isinstance(data, list) else []
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--input", default=str(DEFAULT_INPUT))
    args = p.parse_args()

    path = Path(args.input)
    if not path.exists():
        print(f"❌ 文件不存在: {path}")
        sys.exit(1)

    records = load_records(path)
    print(f"▶  读取 {len(records)} 条，准备写入 …")

    now_iso = datetime.now(tz=timezone.utc).isoformat()
    sample_rows = []
    for raw in records:
        if not raw.get("pin_id"):
            continue
        kw_id = _get_keyword_id(raw.get("source_keyword", ""))
        sample_rows.append({
            "pin_id":            raw["pin_id"],
            "trend_keyword_id":  kw_id,
            "source_keyword":    raw.get("source_keyword"),
            "category":          "home",
            "title":             (raw.get("title") or "")[:500] or None,
            "source_url":        raw.get("source_url"),
            "image_url":         raw.get("image_url"),
            "local_image_path":  raw.get("local_image_path"),
            "outbound_link":     raw.get("outbound_link"),
            "is_ecommerce":      bool(raw.get("is_ecommerce")),
            "save_count":        _to_int(raw.get("save_count")),
            "reaction_count":    _to_int(raw.get("reaction_count")),
            "comment_count":     _to_int(raw.get("comment_count")),
            "created_at_source": _parse_dt(raw.get("created_at")),
            "scraped_at":        _parse_dt(raw.get("scraped_at")) or now_iso,
        })

    # Upsert pin_samples（分批，每批 200 条）
    inserted = []
    batch = 200
    for i in range(0, len(sample_rows), batch):
        chunk = sample_rows[i: i + batch]
        inserted.extend(upsert("pin_samples", chunk, on_conflict="pin_id"))
        print(f"  pin_samples: {min(i + batch, len(sample_rows))}/{len(sample_rows)}")

    print(f"✅ pin_samples upserted: {len(inserted)} 条")

    # 建 pin_id → db_id 映射
    pin_id_to_db = {str(r["pin_id"]): str(r["id"]) for r in inserted if r.get("id")}

    # 构建 style_analysis 行
    analysis_rows = []
    for raw in records:
        pid = raw.get("pin_id")
        db_id = pin_id_to_db.get(str(pid)) if pid else None
        if not db_id:
            continue
        ci = raw.get("commercial_intent_score")
        ms = raw.get("make_similar_score")
        pt = raw.get("pin_type")
        if not any([pt, ci, ms]):
            continue
        analysis_rows.append({
            "pin_sample_id":           db_id,
            "pin_type":                pt,
            "commercial_intent_score": float(ci) if ci is not None else None,
            "make_similar_score":      float(ms) if ms is not None else None,
            "model_name":              "scraper_heuristic",
        })

    if analysis_rows:
        for i in range(0, len(analysis_rows), batch):
            upsert("pin_style_analysis", analysis_rows[i: i + batch],
                   on_conflict="pin_sample_id,model_name")
        print(f"✅ pin_style_analysis upserted: {len(analysis_rows)} 条")


if __name__ == "__main__":
    main()
