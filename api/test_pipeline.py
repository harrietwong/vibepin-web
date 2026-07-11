"""
Full VibePin pipeline test — product images fixed to:

    <repo>/图片/1.jpg … <repo>/图片/4.jpg

Run from repo root:
  py api/test_pipeline.py
Or:
  cd api && py test_pipeline.py

Writes to <repo>/图片/:
  - analysis_latest.json
  - scene_01_…_pin_2x3.png / scene_01_…_ig_1x1.png (and 02–04)
"""
import asyncio
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app.services.analyzer import analyze_product_aesthetics
from app.services.image_gen import STYLE_NAMES, STYLE_PRESETS, _generate_one
import random


API_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = API_DIR.parent
IMG_DIR = PROJECT_ROOT / "图片"


def _safe_stem(style_name: str) -> str:
    s = style_name.replace(" ", "")
    return re.sub(r"[^A-Za-z0-9_-]+", "", s) or "Style"


async def main():
    print(f"Repo root       : {PROJECT_ROOT}")
    print(f"Product images  : {IMG_DIR}")
    print(f"Output folder   : {IMG_DIR}")

    product_images: list[bytes] = []
    for i in range(1, 5):
        path = IMG_DIR / f"{i}.jpg"
        if path.is_file():
            product_images.append(path.read_bytes())
            print(f"  loaded: {path.name} ({path.stat().st_size // 1024} KB)")
        else:
            print(f"  missing (skip): {path.name}")

    product_title = "Home decor assortment (pinned product set)"

    # ── Step 1: Analyze ────────────────────────────────────────
    print("\n[Step 1] Analyzing product aesthetics...")
    analysis = await analyze_product_aesthetics(product_images, product_title)
    print(f"  materials : {analysis.get('materials')}")
    print(f"  colors    : {analysis.get('colors')}")
    print(f"  vibe      : {analysis.get('vibe')}")
    print(f"  best_style: {analysis.get('best_style')} — {analysis.get('style_reasoning')}")
    (IMG_DIR / "analysis_latest.json").write_text(
        json.dumps(analysis, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # ── Step 2: Generate 4 images (parallel, tolerate failures) ─
    print("\n[Step 2] Generating 4 style variants (concurrent)...")
    best_style = analysis.get("best_style", "Scandinavian Loft")
    if best_style not in STYLE_PRESETS:
        best_style = "Scandinavian Loft"
    remaining = [s for s in STYLE_NAMES if s != best_style]
    random_styles = random.sample(remaining, min(3, len(remaining)))
    styles_planned = [(best_style, True)] + [(s, False) for s in random_styles]

    semaphore = asyncio.Semaphore(2)

    async def run_one(style_name: str, is_best: bool, index: int):
        try:
            result = await _generate_one(
                style_name,
                analysis,
                product_title,
                semaphore,
                reference_images=(product_images or None),
            )
            result.is_best_match = is_best
            tag = "BEST" if is_best else "rand"
            stem = _safe_stem(style_name)
            suffix = f"{index:02d}_{tag}_{stem}"
            p_pin = IMG_DIR / f"scene_{suffix}_pin_2x3.png"
            p_ig = IMG_DIR / f"scene_{suffix}_ig_1x1.png"
            p_pin.write_bytes(result.img_2x3_bytes)
            p_ig.write_bytes(result.img_1x1_bytes)
            print(
                f"  OK {suffix}: 2x3={len(result.img_2x3_bytes) // 1024} KB, "
                f"1x1={len(result.img_1x1_bytes) // 1024} KB"
            )
            return True
        except Exception as e:  # noqa: BLE001 — test harness
            print(f"  FAIL [{index:02d}] {style_name}: {e}")
            return False

    tasks = [
        run_one(sn, bf, i + 1) for i, (sn, bf) in enumerate(styles_planned)
    ]
    outcomes = await asyncio.gather(*tasks)
    ok = sum(1 for x in outcomes if x)
    print(f"\nDone. {ok}/4 variants saved under: {IMG_DIR}")

    subprocess.Popen(["explorer", str(IMG_DIR.resolve())])


if __name__ == "__main__":
    asyncio.run(main())
