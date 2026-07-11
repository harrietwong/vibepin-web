"""
import_style_library.py — 导入 Vision LLM 风格分析结果到数据库。

输入文件每行一条 JSON，字段见 README。

用法：
    py db/import_style_library.py
    py db/import_style_library.py --input vibe_library/output/style_library.jsonl
    py db/import_style_library.py --model gemini-2.5-flash
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from db import upsert, select_one  # noqa: E402

DEFAULT_INPUT = Path(__file__).parent.parent / "vibe_library" / "output" / "style_library.jsonl"

_KW_CACHE: dict[str, str | None] = {}
BATCH = 100


def _get_or_create_keyword_id(keyword: str, category: str = "home") -> str | None:
    if not keyword:
        return None
    key = f"{keyword}::{category}"
    if key not in _KW_CACHE:
        row = select_one("trend_keywords", {"keyword": keyword})
        if row:
            _KW_CACHE[key] = str(row["id"])
        else:
            result = upsert(
                "trend_keywords",
                [{"keyword": keyword, "category": category, "source": "auto_import"}],
                on_conflict="keyword,category",
            )
            _KW_CACHE[key] = str(result[0]["id"]) if result else None
    return _KW_CACHE[key]


def _to_float(val) -> float | None:
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _to_int(val, default: int = 0) -> int:
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


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


def _list(val) -> list:
    if isinstance(val, list):
        return val
    if isinstance(val, str):
        return [val]
    return []


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
    p.add_argument("--input",    default=str(DEFAULT_INPUT))
    p.add_argument("--model",    default=None, help="覆盖 model_name 字段")
    p.add_argument("--category", default="home")
    args = p.parse_args()

    path = Path(args.input)
    if not path.exists():
        print(f"❌ 文件不存在: {path}")
        print("   请先运行 Vision LLM 分析脚本生成 style_library.jsonl")
        sys.exit(1)

    records = load_records(path)
    print(f"▶  读取 {len(records)} 条 …")

    now_iso = datetime.now(tz=timezone.utc).isoformat()
    sample_rows, analysis_map = [], {}

    for raw in records:
        pin_id = raw.get("pin_id")
        if not pin_id:
            continue
        kw_id = _get_or_create_keyword_id(raw.get("source_keyword", ""), args.category)
        sample_rows.append({
            "pin_id":              pin_id,
            "trend_keyword_id":    kw_id,
            "source_keyword":      raw.get("source_keyword"),
            "seed_keyword":        raw.get("seed_keyword"),
            "category":            args.category,
            "title":               (raw.get("title") or "")[:500] or None,
            "description":         (raw.get("description") or "")[:2000] or None,
            "image_url":           raw.get("image_url"),
            "local_image_path":    raw.get("local_image_path"),
            "outbound_link":       raw.get("outbound_link"),
            "is_ecommerce":        bool(raw.get("is_ecommerce")),
            "save_count":          _to_int(raw.get("save_count")),
            "reaction_count":      _to_int(raw.get("reaction_count")),
            "comment_count":       _to_int(raw.get("comment_count")),
            "image_ratio":         _to_float(raw.get("image_ratio")),
            "created_at_source":   _parse_dt(raw.get("created_at")),
            "scraped_at":          _parse_dt(raw.get("scraped_at")) or now_iso,
            "source_type":         raw.get("source_type", "search_result_v2"),
            # viral intelligence fields (migrate_v4.sql required)
            "days_since_creation": _to_int(raw.get("days_since_creation")) or None,
            "save_velocity":       _to_float(raw.get("save_velocity")),
            "intent_ratio":        _to_float(raw.get("intent_ratio")),
            "is_high_growth":      bool(raw.get("is_high_growth")),
            "reject_reason":       raw.get("reject_reason"),
        })
        analysis_map[pin_id] = raw  # hold for after we get db IDs

    # Upsert pin_samples
    inserted = []
    for i in range(0, len(sample_rows), BATCH):
        inserted.extend(upsert("pin_samples", sample_rows[i: i + BATCH], on_conflict="pin_id"))
        print(f"  pin_samples: {min(i + BATCH, len(sample_rows))}/{len(sample_rows)}")

    print(f"✅ pin_samples: {len(inserted)} 条")

    pin_id_to_db = {str(r["pin_id"]): str(r["id"]) for r in inserted if r.get("id")}

    # Upsert style analysis
    style_rows = []
    for pin_id, raw in analysis_map.items():
        db_id = pin_id_to_db.get(str(pin_id))
        if not db_id:
            continue
        style_fields = ["pin_type", "style_tags", "layout_type", "composition",
                        "dominant_colors", "has_text_overlay", "visual_hook",
                        "best_for_products", "commercial_intent_score",
                        "make_similar_score", "prompt_template", "negative_prompt",
                        "analysis_reason", "prompt_seed"]
        if not any(raw.get(f) is not None for f in style_fields):
            continue
        style_rows.append({
            "pin_sample_id":           db_id,
            "pin_type":                raw.get("pin_type"),
            "style_tags":              _list(raw.get("style_tags")),
            "layout_type":             raw.get("layout_type"),
            "composition":             raw.get("composition"),
            "dominant_colors":         _list(raw.get("dominant_colors")),
            "has_text_overlay":        raw.get("has_text_overlay"),
            "visual_hook":             raw.get("visual_hook"),
            "best_for_products":       _list(raw.get("best_for_products")),
            "commercial_intent_score": _to_float(raw.get("commercial_intent_score")),
            "make_similar_score":      _to_float(raw.get("make_similar_score")),
            "prompt_template":         raw.get("prompt_template"),
            "prompt_seed":             raw.get("prompt_seed"),
            "negative_prompt":         raw.get("negative_prompt"),
            "analysis_reason":         raw.get("analysis_reason"),
            "model_name":              args.model or raw.get("model_name") or "unknown",
        })

    if style_rows:
        for i in range(0, len(style_rows), BATCH):
            upsert("pin_style_analysis", style_rows[i: i + BATCH],
                   on_conflict="pin_sample_id,model_name")
        print(f"✅ pin_style_analysis: {len(style_rows)} 条")
    else:
        print("ℹ️  没有风格分析字段，跳过 pin_style_analysis")


if __name__ == "__main__":
    main()
