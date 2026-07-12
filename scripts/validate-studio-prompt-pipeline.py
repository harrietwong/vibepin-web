from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import time
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

try:
    from PIL import Image, ImageDraw, ImageFont
except Exception as exc:  # pragma: no cover
    raise SystemExit(f"Pillow is required for validation fixtures: {exc}")


ROOT = Path.cwd()
if ROOT.name == "web":
    ROOT = ROOT.parent

OUT_DIR = ROOT / "web" / "test-results" / "studio-validation"
OUT_DIR.mkdir(parents=True, exist_ok=True)

HOME_TERMS = [
    "bedroom",
    "living room",
    "interior",
    "room decor",
    "cozy home",
    "sofa",
    "bed",
    "vase",
    "wall art",
]


def load_env() -> dict[str, str]:
    env = os.environ.copy()
    env_file = ROOT / "web" / ".env.local"
    if env_file.exists():
        for raw in env_file.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            env.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return env


def fixture_image(label: str, bg: tuple[int, int, int], fg: tuple[int, int, int]) -> str:
    img = Image.new("RGB", (768, 1152), bg)
    draw = ImageDraw.Draw(img)
    font = ImageFont.load_default()
    y = 90
    for line in label.split("\n"):
        draw.text((72, y), line, fill=fg, font=font)
        y += 52
    for i in range(6):
        draw.rounded_rectangle(
            (80 + i * 62, 500 + i * 34, 520 + i * 26, 760 + i * 22),
            radius=30,
            outline=fg,
            width=5,
        )
    buf = BytesIO()
    img.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


FASHION_PRODUCT = fixture_image(
    "FASHION PRODUCT\njeans handbag outfit apparel\nboho wardrobe item",
    (246, 222, 232),
    (46, 36, 72),
)
FASHION_REF = fixture_image(
    "FASHION EDITORIAL REFERENCE\noutfit flat lay mirror outfit\nlookbook composition",
    (229, 214, 246),
    (52, 38, 96),
)
HOME_PRODUCT = fixture_image(
    "HOME DECOR PRODUCT\nvase throw blanket chair\nwarm neutral styling",
    (226, 216, 202),
    (64, 43, 30),
)
HOME_REF = fixture_image(
    "HOME DECOR REFERENCE\nliving room interior styling\nwarm neutral composition",
    (221, 211, 193),
    (70, 44, 32),
)
BEAUTY_PRODUCT = fixture_image(
    "BEAUTY PRODUCT\nserum moisturizer skincare\nclean vanity product",
    (238, 224, 232),
    (90, 48, 76),
)
BEAUTY_REF = fixture_image(
    "BEAUTY REFERENCE\nskincare shelfie vanity flat lay\nsoft glossy lighting",
    (246, 232, 238),
    (94, 50, 78),
)
FOOD_PRODUCT = fixture_image(
    "FOOD PRODUCT\ncoffee tea pastry ingredients\nwarm cafe styling",
    (235, 218, 196),
    (88, 54, 28),
)
FOOD_REF = fixture_image(
    "FOOD REFERENCE\nrecipe ingredient layout\ntabletop appetite appeal",
    (243, 226, 202),
    (84, 54, 28),
)
DIGITAL_PRODUCT = fixture_image(
    "DIGITAL PRODUCT\ntemplate printable planner\nscreen mockup preview",
    (222, 234, 248),
    (35, 66, 104),
)
DIGITAL_REF = fixture_image(
    "DIGITAL REFERENCE\nlaptop tablet mockup\nclean preview hierarchy",
    (232, 240, 250),
    (37, 70, 112),
)
GENERIC_PRODUCT = fixture_image(
    "GENERIC PRODUCT\nminimal lifestyle object\neditorial product showcase",
    (230, 229, 224),
    (50, 54, 62),
)
GENERIC_REF = fixture_image(
    "GENERIC REFERENCE\nminimal product showcase\nsoft editorial lighting",
    (238, 237, 232),
    (50, 54, 62),
)


CASES: dict[str, dict[str, Any]] = {
    "A": {
        "keyword": "boho outfit styling",
        "prompt": "boho outfit styling",
        "category": "fashion",
        "output_type": "editorial",
        "format": "2:3",
        "model_key": "gpt_image",
        "product_images": [FASHION_PRODUCT],
        "style_ref": FASHION_REF,
        "product_metadata": [
            {
                "id": "fashion-product-jeans-handbag",
                "source": "validation_fixture",
                "category": "fashion",
                "title": "Jeans handbag outfit-related product image",
            }
        ],
        "reference_metadata": [
            {
                "id": "fashion-reference-flatlay",
                "source": "validation_fixture",
                "category": "fashion",
                "title": "Fashion editorial outfit flat lay mirror outfit reference",
            }
        ],
    },
    "B": {
        "keyword": "summer outfit board",
        "prompt": "summer outfit board",
        "category": "",
        "output_type": "",
        "format": "2:3",
        "model_key": "gpt_image",
        "product_images": [FASHION_PRODUCT],
        "style_ref": FASHION_REF,
        "product_metadata": [
            {
                "id": "fashion-product-summer-board",
                "source": "validation_fixture",
                "category": "fashion",
                "title": "Summer outfit board with denim and handbag",
            }
        ],
        "reference_metadata": [
            {
                "id": "fashion-reference-mirror-outfit",
                "source": "validation_fixture",
                "category": "fashion",
                "title": "Mirror outfit and fashion editorial reference",
            }
        ],
    },
    "C": {
        "keyword": "warm neutral living room styling",
        "prompt": "warm neutral living room styling",
        "category": "home-decor",
        "output_type": "lifestyle",
        "format": "2:3",
        "model_key": "gpt_image",
        "product_images": [HOME_PRODUCT],
        "style_ref": HOME_REF,
        "product_metadata": [
            {
                "id": "home-product-vase-blanket-chair",
                "source": "validation_fixture",
                "category": "home-decor",
                "title": "Vase throw blanket chair home decor product image",
            }
        ],
        "reference_metadata": [
            {
                "id": "home-reference-living-room",
                "source": "validation_fixture",
                "category": "home-decor",
                "title": "Warm neutral living room interior reference",
            }
        ],
    },
    "D": {
        "keyword": "boho vibes",
        "prompt": "boho vibes",
        "category": "fashion",
        "output_type": "editorial",
        "format": "2:3",
        "model_key": "gpt_image",
        "product_images": [FASHION_PRODUCT],
        "style_ref": FASHION_REF,
        "product_metadata": [
            {
                "id": "fashion-product-short-boho",
                "source": "validation_fixture",
                "category": "fashion",
                "title": "Boho fashion apparel accessory product image",
            }
        ],
        "reference_metadata": [
            {
                "id": "fashion-reference-short-boho",
                "source": "validation_fixture",
                "category": "fashion",
                "title": "Boho fashion editorial flat lay reference",
            }
        ],
    },
    "E": {
        "keyword": "glowy skincare routine",
        "prompt": "glowy skincare routine",
        "category": "beauty",
        "output_type": "beauty-lifestyle",
        "format": "2:3",
        "model_key": "gpt_image",
        "product_images": [BEAUTY_PRODUCT],
        "style_ref": BEAUTY_REF,
        "product_metadata": [
            {
                "id": "beauty-product-serum-moisturizer",
                "source": "validation_fixture",
                "category": "beauty",
                "title": "Serum moisturizer skincare beauty product image",
            }
        ],
        "reference_metadata": [
            {
                "id": "beauty-reference-shelfie",
                "source": "validation_fixture",
                "category": "beauty",
                "title": "Skincare shelfie vanity flat lay reference",
            }
        ],
    },
    "F": {
        "keyword": "iced coffee pastry pairing",
        "prompt": "iced coffee pastry pairing",
        "category": "food-and-drink",
        "output_type": "food-lifestyle",
        "format": "2:3",
        "model_key": "gpt_image",
        "product_images": [FOOD_PRODUCT],
        "style_ref": FOOD_REF,
        "product_metadata": [
            {
                "id": "food-product-coffee-pastry",
                "source": "validation_fixture",
                "category": "food-and-drink",
                "title": "Coffee tea pastry ingredient food product image",
            }
        ],
        "reference_metadata": [
            {
                "id": "food-reference-recipe-layout",
                "source": "validation_fixture",
                "category": "food-and-drink",
                "title": "Recipe ingredient layout food reference",
            }
        ],
    },
    "G": {
        "keyword": "printable planner mockup",
        "prompt": "printable planner mockup",
        "category": "digital-products",
        "output_type": "digital-mockup",
        "format": "2:3",
        "model_key": "gpt_image",
        "product_images": [DIGITAL_PRODUCT],
        "style_ref": DIGITAL_REF,
        "product_metadata": [
            {
                "id": "digital-product-planner-template",
                "source": "validation_fixture",
                "category": "digital-products",
                "title": "Printable planner template digital product image",
            }
        ],
        "reference_metadata": [
            {
                "id": "digital-reference-laptop-mockup",
                "source": "validation_fixture",
                "category": "digital-products",
                "title": "Laptop tablet mockup digital reference",
            }
        ],
    },
    "H": {
        "keyword": "minimal product showcase",
        "prompt": "minimal product showcase",
        "category": "",
        "output_type": "",
        "format": "2:3",
        "model_key": "gpt_image",
        "product_images": [GENERIC_PRODUCT],
        "style_ref": GENERIC_REF,
        "product_metadata": [
            {
                "id": "generic-product-minimal-object",
                "source": "validation_fixture",
                "category": "",
                "title": "Minimal lifestyle object editorial product showcase",
            }
        ],
        "reference_metadata": [
            {
                "id": "generic-reference-product-showcase",
                "source": "validation_fixture",
                "category": "",
                "title": "Minimal product showcase soft editorial reference",
            }
        ],
    },
}


def parse_events(stderr_text: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for raw in stderr_text.splitlines():
        line = raw.strip()
        if not line.startswith("{"):
            continue
        try:
            events.append(json.loads(line))
        except Exception:
            continue
    return events


def last_json(stdout_text: str) -> dict[str, Any] | None:
    for raw in reversed(stdout_text.splitlines()):
        line = raw.strip()
        if not line.startswith("{"):
            continue
        try:
            return json.loads(line)
        except Exception:
            continue
    return None


def term_hits(text: str) -> dict[str, bool]:
    low = text.lower()
    hits: dict[str, bool] = {}
    for term in HOME_TERMS:
        if term == "bed":
            hits[term] = bool(re.search(r"\bbed\b", low))
        else:
            hits[term] = term in low
    return hits


def download_output(case_id: str, urls: list[str]) -> list[str]:
    saved: list[str] = []
    for idx, url in enumerate(urls):
        if not url.startswith("http"):
            continue
        target = OUT_DIR / f"test_{case_id}_output_{idx}.png"
        req = Request(url, headers={"User-Agent": "VibePin validation"})
        with urlopen(req, timeout=90) as response:
            target.write_bytes(response.read())
        saved.append(str(target))
    return saved


def run_case(case_id: str, env: dict[str, str]) -> dict[str, Any]:
    payload = dict(CASES[case_id])
    payload.update(
        {
            "style": "editorial",
            "count": 1,
            "text_overlay": "none",
            "reference_strength": "moderate",
            "content_language": "en",
        }
    )

    started = time.time()
    proc = subprocess.run(
        ["py", str(ROOT / "backend" / "generator.py"), "--from-stdin"],
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(ROOT / "backend"),
        env=env,
        timeout=520,
    )

    stdout_path = OUT_DIR / f"test_{case_id}_stdout.log"
    stderr_path = OUT_DIR / f"test_{case_id}_stderr.log"
    stdout_path.write_text(proc.stdout, encoding="utf-8")
    stderr_path.write_text(proc.stderr, encoding="utf-8")

    events = parse_events(proc.stderr)
    prompt_event = next((e for e in events if e.get("event") == "debug_prompt_chain"), {})
    input_event = next((e for e in events if e.get("event") == "debug_generation_inputs"), {})
    result = last_json(proc.stdout) or {}
    snapshot = result.get("prompt_snapshot") or result.get("promptSnapshot") or {}
    final_prompt = snapshot.get("final_prompt") or prompt_event.get("final_prompt") or ""
    urls = result.get("urls") or []
    downloaded: list[str] = []
    try:
        downloaded = download_output(case_id, urls)
    except Exception as exc:
        downloaded = [f"download_failed: {exc}"]

    summary = {
        "case": case_id,
        "returncode": proc.returncode,
        "duration_seconds": round(time.time() - started, 2),
        "selectedProductImages": payload["product_metadata"],
        "selectedPinReferences": payload["reference_metadata"],
        "userIntentText": payload["prompt"],
        "category_passed_from_frontend": prompt_event.get("categoryPassedFromFrontend", payload["category"]),
        "inferred_category": prompt_event.get("inferredCategory") or snapshot.get("inferred_category"),
        "output_type": prompt_event.get("output_type"),
        "aspectRatio": payload["format"],
        "modelKey": prompt_event.get("modelKey", payload["model_key"]),
        "enhancer_cache_key": prompt_event.get("enhancer_cache_key") or snapshot.get("enhancer_cache_key"),
        "enhanced_custom_prompt": prompt_event.get("enhanced_custom_prompt"),
        "final_prompt_first_1000": final_prompt[:1000],
        "home_decor_check": prompt_event.get("home_decor_check") or term_hits(final_prompt),
        "fashion_safety_applied": prompt_event.get("fashion_safety_applied") or snapshot.get("fashion_safety_applied"),
        "term_hits": term_hits(final_prompt),
        "ok": result.get("ok"),
        "error": result.get("error"),
        "error_type": result.get("error_type") or result.get("errorType"),
        "urls": urls,
        "downloaded_outputs": downloaded,
        "stdout_log": str(stdout_path),
        "stderr_log": str(stderr_path),
        "debug_generation_inputs": input_event,
    }
    (OUT_DIR / f"test_{case_id}_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return summary


def main() -> None:
    env = load_env()
    selected = sys.argv[1:] or ["A", "B", "C", "D"]
    summaries = []
    for case_id in selected:
        print(f"running Test {case_id}...", flush=True)
        summaries.append(run_case(case_id, env))
        print(json.dumps(summaries[-1], ensure_ascii=False)[:2000], flush=True)
    (OUT_DIR / "summary.json").write_text(json.dumps(summaries, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
