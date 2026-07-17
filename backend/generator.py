#!/usr/bin/env python3
"""
backend/generator.py — Keyword-to-image batch generator CLI

Two entry points:
  1. --from-stdin  (used by Next.js /api/generate):
       Reads a JSON payload from stdin:
       {keyword, style, count, prompt, style_ref, product_images[]}
       Passes image inputs (reference + products) to the model.

  2. Legacy CLI (direct dev use):
       python generator.py --keyword "boho living room" --style lifestyle --count 4

Outputs a single JSON line to stdout:
  {"ok": true, "keyword": "...", "urls": ["https://..."], "errors": null}

Requires:
  LINAPI_KEY, LINAPI_BASE_URL, LINAPI_IMAGE_MODEL
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
"""

import argparse
import asyncio
import base64
import io
import json
import os
import re
import shutil
import sys
import tempfile
import time
import uuid
from pathlib import Path

# Force UTF-8 on Windows where the default console encoding is cp936/GBK.
# NOTE: this rebinds sys.stdin/stdout/stderr, so it MUST NOT run at import time —
# doing so corrupts pytest's output capture and breaks any process that imports
# generator as a library (e.g. the WP3 generation worker). It is invoked only from
# the CLI/stdin entry point (main()), preserving the original --from-stdin behavior.
def _force_utf8_streams() -> None:
    if sys.platform == "win32":
        sys.stdin  = io.TextIOWrapper(sys.stdin.buffer,  encoding="utf-8", errors="replace")
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

import httpx

try:
    import prompt_enhancer as _enhancer
    _ENHANCER_AVAILABLE = True
except ImportError:
    _ENHANCER_AVAILABLE = False

LINAPI_KEY       = os.environ.get("LINAPI_KEY", "")
LINAPI_BASE_URL  = os.environ.get("LINAPI_BASE_URL", "https://api.linapi.net/v1").rstrip("/")
IMAGE_MODEL      = os.environ.get("LINAPI_IMAGE_MODEL", "gemini-3.1-flash-image-preview")

# Provider model IDs are env-driven so we can swap LinAPI models without code changes.
GPT_IMAGE_MODEL    = os.environ.get("LINAPI_GPT_IMAGE_MODEL", "gpt-image-2").strip()
# Gemini image model is REQUIRED for the gemini_image path. Fall back to the legacy
# LINAPI_IMAGE_MODEL only when it is itself a Gemini image model; otherwise empty so
# the caller surfaces a clear "not configured" error instead of a silent wrong model.
_GEMINI_ENV = os.environ.get("LINAPI_GEMINI_IMAGE_MODEL", "").strip()
if not _GEMINI_ENV and "gemini" in IMAGE_MODEL.lower() and "image" in IMAGE_MODEL.lower():
    _GEMINI_ENV = IMAGE_MODEL
GEMINI_IMAGE_MODEL = _GEMINI_ENV

# Model key → LinAPI model ID. Empty string means "not configured" (validated by caller).
_MODEL_KEY_TO_MODEL_ID: dict[str, str] = {
    "gpt_image":    GPT_IMAGE_MODEL or "gpt-image-2",
    "gemini_image": GEMINI_IMAGE_MODEL,
    "nano_banana":  GEMINI_IMAGE_MODEL or "gemini-2.5-flash-image",  # legacy alias
}

def _resolve_model_id(model_key: str) -> str:
    """Return the LinAPI model ID for a frontend model key.

    Returns "" for gemini_image when no Gemini image model is configured — the
    caller MUST treat an empty id as a configuration error (no silent fallback).
    """
    key = (model_key or "").strip()
    if key in _MODEL_KEY_TO_MODEL_ID:
        return _MODEL_KEY_TO_MODEL_ID[key]
    return GPT_IMAGE_MODEL or "gpt-image-2"


def _model_supports_image_input(model_id: str) -> bool:
    """Whether a resolved model can receive product/reference image inputs."""
    ml = (model_id or "").lower()
    return ("gemini" in ml) or ("gpt-image" in ml)


def _input_ordering(product_count: int, has_ref: bool) -> list[dict]:
    """Image input ordering actually sent to the model: products first, reference last."""
    ordering = [{"position": i + 1, "role": "product"} for i in range(product_count)]
    if has_ref:
        ordering.append({"position": product_count + 1, "role": "reference"})
    return ordering


def _normalize_image_inputs(data: dict, product_images: list[str], style_ref: str | None) -> list[dict]:
    """Build provider image input manifest: products first, references last."""
    raw_inputs = data.get("image_inputs")
    if isinstance(raw_inputs, list) and raw_inputs:
        normalized: list[dict] = []
        for item in raw_inputs:
            if not isinstance(item, dict):
                continue
            role = str(item.get("role") or "").strip()
            source_url = str(item.get("sourceUrl") or item.get("source_url") or "").strip()
            if role not in ("product", "reference") or not source_url:
                continue
            normalized.append({
                "role": role,
                "order": int(item.get("order") or len(normalized) + 1),
                "sourceUrl": source_url,
                "label": str(item.get("label") or "").strip() or None,
                "productId": item.get("productId"),
                "referenceId": item.get("referenceId"),
            })
        products = [i for i in normalized if i["role"] == "product"]
        refs = [i for i in normalized if i["role"] == "reference"]
        return [
            *[{**i, "order": idx + 1} for idx, i in enumerate(products)],
            *[{**i, "order": len(products) + idx + 1} for idx, i in enumerate(refs)],
        ]

    return [
        *[
            {"role": "product", "order": idx + 1, "sourceUrl": url, "label": f"Product image {idx + 1}"}
            for idx, url in enumerate(product_images)
        ],
        *(
            [{"role": "reference", "order": len(product_images) + 1, "sourceUrl": style_ref, "label": "Reference image 1"}]
            if style_ref else []
        ),
    ]


def _build_image_manifest(image_inputs: list[dict]) -> str:
    product_orders = [int(i["order"]) for i in image_inputs if i.get("role") == "product"]
    reference_orders = [int(i["order"]) for i in image_inputs if i.get("role") == "reference"]
    if not product_orders and not reference_orders:
        return ""

    def _range_label(values: list[int]) -> str:
        if not values:
            return "none"
        if len(values) == 1:
            return f"Image {values[0]}"
        return f"Images {values[0]}-{values[-1]}"

    total = len(image_inputs)
    lines = [
        f"IMAGE INPUT MANIFEST: You are receiving {total} input image{'s' if total != 1 else ''}.",
    ]
    if product_orders:
        lines.append(
            f"{_range_label(product_orders)} are PRODUCT images. Use them to determine exactly WHAT appears: "
            "product identity, clothing/items, colors, shapes, materials, silhouettes, and key product details."
        )
    if reference_orders:
        lines.append(
            f"{_range_label(reference_orders)} {'are' if len(reference_orders) > 1 else 'is'} REFERENCE image"
            f"{'s' if len(reference_orders) > 1 else ''}. Use {'them' if len(reference_orders) > 1 else 'it'} to determine HOW the products are photographed: "
            "scene, composition, framing, pose, camera angle, lighting, mood, layout, and Pinterest-native atmosphere."
        )
    lines.extend([
        "Products define WHAT appears.",
        "References define HOW the products are photographed.",
        "Do not copy any reference person's identity, face, likeness, or distinctive personal features.",
        "Create an original Pinterest-native Pin using the selected products in a scene inspired by the reference.",
    ])
    return "\n".join(lines)


def _safe_variant_text(value: object) -> str:
    return str(value or "").strip().replace("\n", " ")[:240]


def _long_variant_text(value: object, limit: int = 700) -> str:
    """Like _safe_variant_text but keeps the full per-output directive (not 240-clamped)."""
    return str(value or "").strip().replace("\n", " ")[:limit]


def _variant_prompt_suffix(index: int, count: int, variation_mode: str, output_variants: list[dict]) -> str:
    if count <= 1:
        return ""
    variant = next((v for v in output_variants if int(v.get("index") or 0) == index + 1), None)
    role = _safe_variant_text((variant or {}).get("role")) or (
        "anchor" if index == 0 else ("consistent_variant" if variation_mode == "similar" else "distinct_variant")
    )
    role_label = role.replace("_", " ").upper()
    instructions = (variant or {}).get("variationInstructions")
    instructions = instructions if isinstance(instructions, dict) else {}
    # Full-sentence, output-specific directive compiled by the frontend — lead with it.
    variant_instruction = _long_variant_text((variant or {}).get("variantInstruction"))

    lines = [
        f"PAIRED VARIATION ROLE: Output {index + 1} of {count} is the {role_label} image.",
    ]
    if variant_instruction:
        lines.append(f"OUTPUT {index + 1} DIRECTIVE (HIGHEST PRIORITY FOR THIS OUTPUT): {variant_instruction}")
    lines.append(
        "Shared anchor: keep the same selected products, same reference image, same selected tags, same opportunity, "
        "same category, same format, and same direction brief."
    )
    if variation_mode == "similar":
        lines.append(
            "Variation mode is CONSISTENT: stay close to Output 1, but still avoid an exact duplicate through a small "
            "pose, crop, or camera-angle change."
        )
    elif index == 0:
        lines.append(
            "This anchor output should be closest to the selected direction, strongest in reference alignment, and stable/high-confidence."
        )
    else:
        lines.append(
            "Variation mode is DISTINCT: this output MUST be visibly different from Output 1 in at least 2-3 of "
            "{pose, framing, camera angle, micro-location/scene} while preserving the same products, category, "
            "reference influence, and format. Do NOT reproduce Output 1's pose, framing, and scene together."
        )

    for key in ("framing", "pose", "scene", "emphasis"):
        val = _safe_variant_text(instructions.get(key))
        if val:
            lines.append(f"- {key}: {val}")
    lines.append(
        "Do not generate a near-duplicate. Do not drift to another category, format, product set, or unrelated scene. "
        "Do not turn the image into a studio, catalog, or ecommerce product shot when a lifestyle/street-style reference was provided."
    )
    return "\n".join(lines)
SUPABASE_URL     = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SVC_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
STORAGE_BUCKET   = "generated"

STYLE_PROMPTS: dict[str, str] = {
    "editorial":          "Minimalist editorial flat-lay, pure white background, hero product shot, Pinterest-worthy, 35mm f/2.8, no text",
    "lifestyle":          "Warm lifestyle interior scene, golden-hour natural window light, lived-in cozy atmosphere, aspirational, photorealistic",
    "moody":              "Moody dark aesthetic interior, dramatic side lighting, deep shadows, high-contrast editorial, rich textures",
    "flat-lay":           "Overhead flat-lay composition, clean marble/linen surface, intentional prop styling, cohesive color story",
    "boho":               "Boho natural interior, earthy terracotta tones, woven rattan, macramé, trailing plants, warm golden light",
    "luxury":             "Quiet luxury aesthetic interior, muted greige palette, premium linen, organic shapes, understated elegance",
    "Soft Geometry":      "Minimalist Soft Geometry interior, curvaceous boucle furniture, limewash sage walls, arched windows, morning light, serene",
    "Scandinavian Loft":  "Scandinavian loft interior, light oak floors, crisp white linen, abundant Nordic sunlight, airy minimalist, rattan accents",
    "Biophilic Design":   "Biophilic indoor jungle interior, abundant tropical greenery, stone walls, reclaimed wood, dappled golden canopy light",
    "Mid-Century Modern": "Mid-Century Modern retro interior, rich walnut furniture, mustard yellow accents, sunburst clock, warm sunset film grain",
    "Moody Color Drenching": "Moody color-drenched interior, tone-on-tone saturated immersion, dramatic single window light, architectural shadow",
    "Heritage":           "Heritage classic interior, polished mahogany, oil painting frames, Persian rugs, antique brass, warm library light",
}


def _scrub(obj: object) -> object:
    """Recursively replace lone surrogates so json.dumps never raises UnicodeEncodeError."""
    if isinstance(obj, str):
        return obj.encode("utf-8", errors="replace").decode("utf-8")
    if isinstance(obj, dict):
        return {k: _scrub(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_scrub(v) for v in obj]
    return obj


def _emit(data: dict) -> None:
    try:
        line = json.dumps(data, ensure_ascii=False)
    except (UnicodeEncodeError, ValueError):
        line = json.dumps(_scrub(data), ensure_ascii=False)
    print(line)
    sys.stdout.flush()


# ── Image input helpers ────────────────────────────────────────────────────────

_SUPPORTED_IMAGE_MIME = {"image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/heic", "image/heif"}


def _sniff_image_mime(raw: bytes) -> str | None:
    """Detect image MIME from magic bytes; used when the source MIME is missing/wrong."""
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if raw[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return None


def _b64_to_bytes_strict(s: str) -> bytes:
    """
    Decode an arbitrary client-supplied base64 string to raw bytes, defensively:
      - strip any leading data-URL prefix (data:image/...;base64,)
      - strip ALL whitespace/newlines
      - normalize URL-safe base64 (-, _) → standard (+, /)
      - re-pad to a multiple of 4
      - decode with validation
    Raises ValueError on empty/invalid input. The caller re-encodes from the returned
    bytes so the value sent to the provider is always canonical standard base64.
    """
    if not s:
        raise ValueError("empty base64 input")
    # Strip a data-URL prefix if the raw string still carries one.
    s = re.sub(r"^data:[^;,]*(?:;[^,]*)*,", "", s, flags=re.I)
    s = re.sub(r"\s+", "", s)
    if not s:
        raise ValueError("base64 empty after stripping prefix/whitespace")
    s = s.replace("-", "+").replace("_", "/")
    pad = (-len(s)) % 4
    s += "=" * pad
    decoded = base64.b64decode(s, validate=True)  # raises binascii.Error on bad chars
    if not decoded:
        raise ValueError("base64 decoded to zero bytes")
    return decoded


def _bytes_to_inline_part(raw: bytes, mime: str) -> dict | None:
    """Build a Gemini inlineData part with canonical standard base64 re-encoded from bytes."""
    if not raw:
        return None
    mime = (mime or "").split(";")[0].strip().lower() or "image/jpeg"
    if mime not in _SUPPORTED_IMAGE_MIME:
        sniffed = _sniff_image_mime(raw)
        if not sniffed:
            return None
        mime = sniffed
    return {"inlineData": {"mimeType": mime, "data": base64.b64encode(raw).decode("ascii")}}


def _data_url_to_part(data_url: str) -> dict | None:
    """Convert a browser data URL (data:image/jpeg;base64,...) to a Gemini inlineData part.

    The base64 is always REGENERATED from decoded bytes — never the raw client string —
    so a truncated, whitespace-laden, URL-safe, or double-prefixed string can never reach
    the provider's inline_data.data field.
    """
    m = re.match(r"data:([^;,]+)(?:;[^,]*)*,(.+)", data_url, re.S)
    if not m:
        return None
    mime = m.group(1).strip().lower()
    try:
        raw = _b64_to_bytes_strict(m.group(2))
    except Exception as e:
        print(f"[generator] ✗ data-url base64 invalid: {e}", file=sys.stderr)
        return None
    return _bytes_to_inline_part(raw, mime)


async def _url_to_part(url: str) -> dict | None:
    """Download a remote image URL and return a Gemini inlineData part (canonical base64)."""
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Referer":         "https://www.pinterest.com/",
        "Accept":          "image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            r = await client.get(url, headers=headers)
            r.raise_for_status()
            if not r.content:
                print(f"[generator] ✗ ref image empty body: {url[:70]}", file=sys.stderr)
                return None
            mime = r.headers.get("content-type", "").split(";")[0].strip().lower()
            part = _bytes_to_inline_part(r.content, mime)  # re-encodes from raw bytes
            if not part:
                print(f"[generator] ✗ ref image not a supported image (mime={mime!r}): {url[:70]}", file=sys.stderr)
                return None
            kb = len(r.content) // 1024
            print(f"[generator] ✓ ref image loaded from URL: {url[:70]} ({kb}KB)", file=sys.stderr)
            return part
    except Exception as e:
        print(f"[generator] ✗ FAILED to load ref image from URL: {url[:70]}\n  reason: {e}", file=sys.stderr)
        return None


async def _image_input_to_part(inp: str) -> dict | None:
    """Dispatch: data URL → parse locally, http URL → download. Rejects blob:/file:/other."""
    if inp.startswith("data:"):
        return _data_url_to_part(inp)
    if inp.startswith("http://") or inp.startswith("https://"):
        return await _url_to_part(inp)
    # blob: URLs, filesystem paths, and bare strings can never be serialized — drop loudly.
    print(f"[generator] ✗ unsupported image input scheme (not data:/http): {inp[:48]!r}", file=sys.stderr)
    return None


def _safe_part_manifest(part: dict, *, output_index: int, part_index: int, role: str, source_id: str) -> dict:
    """Build a SAFE log manifest for one inline image part — never logs the base64 value."""
    inline = part.get("inlineData") if isinstance(part, dict) else None
    data = str((inline or {}).get("data") or "")
    mime = str((inline or {}).get("mimeType") or "")
    raw_len = -1
    sha = ""
    decode_ok = False
    try:
        decoded = base64.b64decode(data, validate=True) if data else b""
        raw_len = len(decoded)
        sha = __import__("hashlib").sha256(decoded).hexdigest()[:16]
        decode_ok = raw_len > 0
    except Exception:
        decode_ok = False
    return {
        "outputIndex":       output_index,
        "partIndex":         part_index,
        "role":              role,
        "sourceImageId":     (source_id[:80] + "…") if len(source_id) > 80 else source_id,
        "mimeType":          mime,
        "rawByteLength":     raw_len,
        "base64Length":      len(data),
        "base64Mod4":        len(data) % 4,
        "sha256_16":         sha,
        "hadDataUrlPrefix":  data.startswith("data:"),
        "localDecodeOk":     decode_ok,
    }


# ── Prompt builders ────────────────────────────────────────────────────────────

def _build_prompt(keyword: str, style: str, pin_format: str = "2:3") -> str:
    """Legacy text-only prompt (no image inputs)."""
    style_desc = STYLE_PROMPTS.get(style, f"{style} aesthetic, photorealistic")
    return (
        f"Create a Pinterest-worthy lifestyle photograph for the trending aesthetic: '{keyword}'. "
        f"Visual style direction: {style_desc}. "
        f"Aspect ratio: {pin_format}. Photorealistic, ultra-detailed, aspirational. "
        "High Pinterest save-rate aesthetic. No people's faces. "
        + _NO_TEXT
    )


_NO_TEXT = (
    "CRITICAL — ZERO TEXT RULE: "
    "There must be absolutely NO text, words, letters, numbers, labels, captions, "
    "watermarks, logos, typography, or any English characters visible anywhere in the image. "
    "No title overlays, no product names, no brand marks, no graphic design elements. "
    "Pure photographic image only."
)

# ── Category-aware prompt modules ─────────────────────────────────────────────
# Each entry defines: composition types, product integration rule, allowed props,
# what to avoid, and how the reference image should be interpreted.

_CATEGORY_MODULES: dict[str, dict[str, str]] = {
    "home-decor": {
        "composition":   "styled interior scenes, room vignettes, shelf styling, decor moodboards, or lifestyle room compositions",
        "product_rule":  "Naturally integrate most uploaded products into the room or styling setup. Uploaded products are the primary creative subjects — they must remain clearly recognizable and feel naturally placed.",
        "props":         "Additional furniture, plants, books, textiles, trays, wall art, lighting, and decor props are allowed and encouraged.",
        "avoid":         "Avoid plain isolated product shots on empty backgrounds. Do NOT force products into a setting where they look awkward or out of place.",
        "ref_use":       "Draw aesthetic inspiration from the reference's color palette, decor density, lighting quality, styling mood, and Pinterest visual language. The scene composition is flexible — adapt the layout freely to best showcase the uploaded products. If the products do not naturally fit the reference's exact setting, recompose the scene into any fitting setup (corner vignette, shelf composition, reading nook, styled surface, room moodboard, etc.) that preserves the same overall aesthetic DNA.",
    },
    "fashion": {
        "composition":   "outfit compositions, wardrobe styling boards, flat lays, seasonal looks, or lifestyle fashion moodboards",
        "product_rule":  "Use most uploaded apparel and accessory products when composition allows. Each item must be clearly visible.",
        "props":         "Additional complementary styling items, shoes, bags, and accessories are allowed.",
        "avoid":         "Avoid plain catalog-only product shots. Do not force items together if it makes the outfit unrealistic.",
        "ref_use":       "Match the reference's outfit layout, color palette, occasion vibe, and flat lay or lifestyle structure.",
    },
    "beauty": {
        "composition":   "beauty routine compositions, skincare shelfies, vanity flat lays, product ritual scenes, or texture moodboards",
        "product_rule":  "Feature most uploaded beauty products as recognizable items in the scene.",
        "props":         "Additional textures, swatches, trays, towels, mirrors, flowers, water droplets, and vanity props are allowed.",
        "avoid":         "Avoid sterile white-background catalog-only product shots.",
        "ref_use":       "Match the reference's product arrangement, texture detail, lighting style, and vanity or shelfie aesthetic.",
    },
    "food-and-drink": {
        "composition":   "recipe visuals, ingredient layouts, serving scenes, table settings, drink styling, or food moodboards",
        "product_rule":  "Use uploaded food, product, or packaging images as ingredients, packaging, or serving elements where applicable.",
        "props":         "Additional plates, utensils, linens, fresh ingredients, garnishes, herbs, and table props are allowed.",
        "avoid":         "Avoid isolated packaging-only shots unless the composition specifically calls for a product hero.",
        "ref_use":       "Match the reference's serving composition, ingredient arrangement, table styling, color palette, and appetite appeal.",
    },
    "digital-products": {
        "composition":   "digital product mockups, printable previews, laptop or tablet scenes, desk setups, template previews, or before/after style visuals",
        "product_rule":  "Represent uploaded digital assets as screens, pages, cards, mockups, or printable previews shown in realistic context.",
        "props":         "Additional desk props, devices, stationery, coffee cups, notebooks, and lifestyle context are allowed.",
        "avoid":         "Do not treat digital products as physical decor objects unless the composition concept specifically calls for it.",
        "ref_use":       "Match the reference's mockup composition, device or desk layout, and preview hierarchy.",
    },
    "diy-crafts": {
        "composition":   "finished handmade project hero shots, materials and supplies flat lays, step-by-step tutorial layouts, or cozy crafting scenes",
        "product_rule":  "Feature the uploaded craft items, supplies, or finished project as the clearly recognizable subjects. Keep handmade detail and texture visible.",
        "props":         "Additional crafting tools, yarn, fabric, scissors, work surfaces, and in-progress materials are allowed and encouraged.",
        "avoid":         "Avoid sterile catalog shots and avoid converting the scene into home-decor room styling unless the project is itself decor.",
        "ref_use":       "Match the reference's crafting layout, instructional clarity, color palette, and handmade Pinterest aesthetic.",
    },
    "travel": {
        "composition":   "aspirational destination scenes, evocative travel detail moments, scenic landscapes, or save-worthy travel guide compositions",
        "product_rule":  "When products or travel items are uploaded, place them naturally within the travel scene; otherwise lead with the destination as the hero subject.",
        "props":         "Additional scenic context, architecture, local detail, maps, and travel accessories are allowed.",
        "avoid":         "Avoid generic stock-photo blandness and avoid indoor room-decor staging unless the scene is a styled travel interior.",
        "ref_use":       "Match the reference's destination mood, lighting, scenic framing, and wanderlust Pinterest aesthetic.",
    },
    # Generic neutral fallback — product-primary, no interior/room bias.
    # Used when category is empty or unrecognized to avoid the wrong aesthetic default.
    "generic": {
        "composition":   "aspirational lifestyle compositions, styled product scenes, editorial flat lays, or creative product showcases",
        "product_rule":  "The uploaded product images are the primary subjects — design the entire scene to feature and showcase these items clearly and recognizably. Do NOT place products into a home interior or room decor scene unless they are home decor items.",
        "props":         "Complementary props that naturally match the product's aesthetic, intended use, and visual context.",
        "avoid":         "Do not default to bedroom, living room, or kitchen scenes for products that are not home decor. Avoid interior room styling unless the product belongs there.",
        "ref_use":       "Match the reference's color palette, mood, lighting quality, and aesthetic energy. Adapt composition freely to best showcase the products in a scene that fits their actual product type.",
    },
}

_FASHION_IDS = {"fashion", "womens-fashion", "mens-fashion", "kids-fashion"}
_HOME_DECOR_TERMS = [
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
_FASHION_HINTS = {
    "fashion", "outfit", "jeans", "denim", "handbag", "bag", "purse", "dress",
    "skirt", "shirt", "blouse", "jacket", "shoes", "boots", "sneakers",
    "wardrobe", "lookbook", "editorial fashion", "flat lay", "mirror outfit",
    "summer outfit", "boho outfit", "apparel", "accessory", "accessories",
}
_HOME_HINTS = {
    "home decor", "room decor", "living room", "bedroom", "interior", "sofa",
    "chair", "throw blanket", "blanket", "vase", "lamp", "wall art", "shelf",
    "rug", "coffee table",
}
_BEAUTY_HINTS = {
    "beauty", "skincare", "skin care", "makeup", "cosmetic", "cosmetics",
    "serum", "moisturizer", "lipstick", "mascara", "foundation", "cleanser",
    "sunscreen", "vanity", "shelfie",
}
_FOOD_HINTS = {
    "food", "drink", "recipe", "ingredient", "ingredients", "coffee", "tea",
    "cocktail", "mocktail", "meal", "dessert", "bakery", "snack", "beverage",
}
_DIGITAL_HINTS = {
    "digital", "template", "printable", "planner", "notion", "ebook", "e-book",
    "mockup", "laptop", "tablet", "screen", "download", "worksheet",
}


def _get_category_module(category: str) -> dict[str, str]:
    cat = (category or "").lower().strip()
    if cat == "home-decor":         return _CATEGORY_MODULES["home-decor"]
    if cat in _FASHION_IDS:         return _CATEGORY_MODULES["fashion"]
    if cat == "beauty":             return _CATEGORY_MODULES["beauty"]
    if cat == "food-and-drink":     return _CATEGORY_MODULES["food-and-drink"]
    if cat == "diy-crafts":         return _CATEGORY_MODULES["diy-crafts"]
    if cat == "travel":             return _CATEGORY_MODULES["travel"]
    if cat == "digital-products":   return _CATEGORY_MODULES["digital-products"]
    # Generic neutral fallback — does NOT default to home-decor for non-home products.
    return _CATEGORY_MODULES["generic"]


def _infer_category(category: str, output_type: str, custom_prompt: str | None, product_metadata: object) -> str:
    explicit = (category or "").lower().strip()
    if explicit:
        return explicit
    chunks: list[str] = [output_type or "", custom_prompt or ""]
    if isinstance(product_metadata, list):
        for item in product_metadata:
            if isinstance(item, dict):
                chunks.extend(str(item.get(k) or "") for k in ("id", "source", "category", "title", "name", "productUrl"))
    text = " ".join(chunks).lower()
    if any(h in text for h in _FASHION_HINTS):
        return "fashion"
    if any(h in text for h in _BEAUTY_HINTS):
        return "beauty"
    if any(h in text for h in _FOOD_HINTS):
        return "food-and-drink"
    if any(h in text for h in _DIGITAL_HINTS):
        return "digital-products"
    if any(h in text for h in _HOME_HINTS):
        return "home-decor"
    return "generic"


def _infer_output_type(output_type: str, effective_category: str) -> str:
    raw = (output_type or "").strip()
    cat = (effective_category or "").lower().strip()
    if cat in _FASHION_IDS and raw in ("", "lifestyle"):
        return "editorial"
    if cat == "digital-products" and raw in ("", "lifestyle"):
        return "digital-mockup"
    if cat == "diy-crafts" and raw in ("", "lifestyle"):
        return "tutorial"
    if cat == "travel" and raw in ("", "lifestyle"):
        return "lifestyle"
    return raw or "editorial"


def _home_decor_term_hits(text: str) -> dict[str, bool]:
    low = text.lower()
    return {term: term in low for term in _HOME_DECOR_TERMS}


def _build_prompt_with_images(
    keyword: str,
    style: str,
    product_count: int,
    has_ref: bool,
    custom_prompt: str | None = None,
    category: str = "",
    ref_at_end: bool = False,
    pin_format: str = "2:3",
) -> str:
    """
    Build the final generation prompt when image inputs are present.

    Modular architecture:
      1. Image-role declaration  — tells the model what each image IS
      2. Category creative module — composition type, product rules, props, reference use
      3. Custom prompt layer      — creative direction from the frontend (if provided)
      4. Output constraints       — format, NO TEXT (always appended)

    Image order sent to the model:
      [0]   Reference image (if any) — style/composition direction only
      [1…N] Product images           — must appear visibly in the output
    """
    cat        = (category or "").lower().strip()
    is_fashion = cat in _FASHION_IDS
    cat_mod    = _get_category_module(category)
    style_desc = STYLE_PROMPTS.get(style, f"{style} aesthetic, photorealistic")
    parts: list[str] = []

    # ── 1. Image-role declaration ─────────────────────────────────────────────
    if has_ref and product_count > 0:
        if ref_at_end:
            # Products are images 1‥N, reference is the LAST image.
            # This ordering anchors the model's generation to the products.
            ref_img_num = product_count + 1
            parts.append(
                f"TASK: Create an original, aspirational Pinterest image built around the provided products. "
                f"You are given {product_count + 1} images. "
                f"Images 1 through {product_count} are your PRODUCT SUBJECTS — "
                f"design the entire scene to feature and showcase these items. "
                f"{cat_mod['product_rule']} "
                f"Image {ref_img_num} is your STYLE MOOD BOARD — extract ONLY: "
                f"(a) dominant color palette, "
                f"(b) lighting quality and mood, "
                f"(c) decor density and styling approach, "
                f"(d) Pinterest-native aesthetic level. "
                f"ABSOLUTE RULE — DO NOT COPY Image {ref_img_num}: "
                f"Do NOT reproduce its room, furniture layout, camera angle, or scene composition. "
                f"The mood board is a color and vibe reference, not a scene template. "
                f"SCENE DESIGN: Build whatever composition (shelf vignette, corner scene, "
                f"styled surface, reading nook, room moodboard) best showcases the products naturally. "
                f"{cat_mod['ref_use']} "
                f"STYLE TRANSFER: The output should share the same color story, lighting mood, "
                f"and aesthetic energy as Image {ref_img_num}, but be an entirely original composition. "
                f"The products must look like they belong in that aesthetic world — not pasted in."
            )
        else:
            # Legacy order: reference is image 1, products are 2‥N.
            parts.append(
                f"You are given {1 + product_count} images. "
                f"Image 1 is the AESTHETIC DIRECTION REFERENCE — study its color palette, "
                f"decor density, lighting quality, styling mood, and Pinterest visual language. "
                f"Use this image as creative inspiration for style direction ONLY. "
                f"STRICT ANTI-COPY RULE: Do NOT reproduce the reference's exact scene, camera angle, "
                f"room layout, or object placement. Create an entirely original composition. "
                f"PRODUCT-FIRST RULE: Images 2 through {1 + product_count} are the main creative subjects. "
                f"{cat_mod['product_rule']} "
                f"SCENE ADAPTATION RULE: {cat_mod['ref_use']} "
            )
    elif has_ref:
        parts.append(
            f"The provided image is the AESTHETIC DIRECTION REFERENCE — study its color palette, "
            f"lighting quality, styling mood, composition style, and Pinterest visual language. "
            f"Use this as creative inspiration for aesthetic direction. "
            f"{cat_mod['ref_use']} "
            f"STRICT ANTI-COPY: Do NOT reproduce the exact scene, camera angle, or object placement. "
            f"Create an entirely original composition inspired by the same aesthetic direction."
        )
    elif product_count > 0:
        parts.append(
            f"You are given {product_count} PRODUCT IMAGE{'S' if product_count > 1 else ''}. "
            f"{cat_mod['product_rule']}"
        )

    # ── 1b. Fashion safety — explicit override to prevent home-decor scene bleed ──
    if (category or "").lower().strip() in _FASHION_IDS:
        parts.append(
            "FASHION CATEGORY RULE: These are fashion/apparel products. "
            "The composition MUST be fashion-appropriate: outfit flat lay, wardrobe styling board, "
            "fashion editorial, styled look, lookbook image, or apparel/accessory layout. "
            "Use only fashion styling context and avoid non-fashion environments."
        )

    # ── 2. Creative direction — custom prompt from frontend takes priority ─────
    if custom_prompt and len(custom_prompt.strip()) > 5:
        parts.append(custom_prompt.strip())
    else:
        # Category-native fallback
        if product_count > 1:
            parts.append(
                f"Create Pinterest-native {cat_mod['composition']} "
                f"for the keyword '{keyword}'. Visual style: {style_desc}. "
                f"Feature most or all of the {product_count} provided products together in one cohesive scene. "
                f"{cat_mod['props']} {cat_mod['avoid']}"
            )
        elif product_count == 1:
            parts.append(
                f"Create a Pinterest-worthy {cat_mod['composition']} "
                f"for '{keyword}' with the provided product as the hero item. "
                f"Visual style: {style_desc}. "
                "Feature it prominently — it must be clearly recognizable. "
                f"{cat_mod['props']}"
            )
        else:
            parts.append(
                f"Create Pinterest-native {cat_mod['composition']} "
                f"for '{keyword}'. Visual style: {style_desc}."
            )

    # ── 3. Output constraints (always) ────────────────────────────────────────
    parts.append(
        f"Aspect ratio: {pin_format}. Photorealistic, ultra-detailed, aspirational. "
        "High Pinterest save-rate aesthetic. No people's faces."
    )
    parts.append(_NO_TEXT)

    final = " ".join(parts)
    if cat != "home-decor":
        non_home_replacements = {
            "decor density": "styling density",
            "room, furniture layout, camera angle, or scene composition": "exact layout, camera angle, or scene composition",
            "room layout": "layout",
            "room moodboard": "product moodboard",
            "shelf vignette, corner scene, styled surface, reading nook, ": "",
            "home interior": "unrelated setting",
            "room decor": "unrelated styling",
            "bedroom": "generic setting",
            "living room": "generic setting",
            "kitchen": "generic setting",
            "interior room styling": "unrelated styling",
            "interior": "setting",
        }
        for old, new in non_home_replacements.items():
            final = final.replace(old, new).replace(old.title(), new)
    if is_fashion:
        replacements = {
            "decor density": "styling density",
            "room, furniture layout, camera angle, or scene composition": "pose, crop, camera angle, or item placement",
            "room layout": "layout",
            "room moodboard": "fashion moodboard",
            "shelf vignette, corner scene, styled surface, reading nook, ": "",
            "bedroom": "non-fashion setting",
            "living room": "non-fashion setting",
            "interior": "non-fashion setting",
            "room decor": "non-fashion styling",
            "cozy home": "warm editorial",
            "sofa": "styling prop",
            "wall art": "graphic accessory",
        }
        for old, new in replacements.items():
            final = final.replace(old, new).replace(old.title(), new)
        final = re.sub(r"\bbed\b", "accessory", final, flags=re.I)
        final = re.sub(r"\bvase\b", "accessory prop", final, flags=re.I)
    return final


def _v2_image_role_preamble(product_count: int, has_ref: bool) -> str:
    """
    Minimal, safe image-role declaration prepended to a frontend-compiled hidden
    prompt. This is platform scaffolding (which image is product vs reference) — it
    does NOT change the creative direction, so it satisfies the "safe minimal
    formatting only" rule for creative_direction_v2.
    """
    if has_ref and product_count > 0:
        last = product_count + 1
        return (
            f"You are given {last} images. Images 1 through {product_count} are the PRODUCT SUBJECTS "
            f"and must appear clearly. Image {last} is the VISUAL REFERENCE. The final input image is "
            f"the visual reference: use it for scene, framing, composition, camera distance, lighting, "
            f"styling, and pose energy according to the REFERENCE REQUIREMENTS section. Do NOT copy "
            f"any person's identity, face, likeness, or distinctive personal features."
        )
    if product_count > 0:
        return (
            f"You are given {product_count} PRODUCT IMAGE{'S' if product_count > 1 else ''} — "
            f"feature them clearly as the main subjects."
        )
    if has_ref:
        return (
            "The provided image is the VISUAL REFERENCE. Use it for scene, framing, composition, "
            "camera distance, lighting, styling, and pose energy according to the REFERENCE REQUIREMENTS "
            "section. Do NOT copy any person's identity, face, likeness, or distinctive personal features."
        )
    return ""


def _build_creative_direction_v2_prompt(
    keyword: str,
    product_count: int,
    has_ref: bool,
    user_brief: str | None,
    category: str,
    pin_format: str,
    creative_meta: dict | None,
) -> str:
    """Compile Creative Direction V2 into the final provider prompt exactly once.

    Fallback compiler used only when the frontend did NOT send a compiled hidden
    prompt (e.g. remix of an older v2 record that stored meta but no hidden prompt).
    """
    meta = creative_meta if isinstance(creative_meta, dict) else {}
    controls = meta.get("guidedControls") if isinstance(meta.get("guidedControls"), dict) else {}
    opportunity = meta.get("opportunityContext") if isinstance(meta.get("opportunityContext"), dict) else {}
    selected_assets = meta.get("selectedAssets") if isinstance(meta.get("selectedAssets"), list) else []
    selected_title = str(meta.get("selectedDirectionTitle") or "").strip()
    selected_summary = str(meta.get("selectedDirectionSummary") or "").strip()
    custom_instructions = str(meta.get("customInstructions") or "").strip()
    manual_brief = str(meta.get("manualBrief") or user_brief or "").strip()
    cat = (category or meta.get("categoryPlaybookId") or "generic").lower().strip() or "generic"
    cat_mod = _get_category_module(cat)
    is_fashion = cat in _FASHION_IDS

    product_titles: list[str] = []
    reference_notes: list[str] = []
    for asset in selected_assets:
        if not isinstance(asset, dict):
            continue
        role = str(asset.get("role") or "")
        title = str(asset.get("title") or asset.get("keyword") or asset.get("category") or "").strip()
        visual = str(asset.get("visualFormat") or "").strip()
        if role == "product" and title:
            product_titles.append(title)
        if role == "reference":
            note = title or visual
            if note:
                reference_notes.append(note)

    parts: list[str] = [
        "SAFETY AND TECHNICAL CONSTRAINTS: Create an original Pinterest-native image. "
        "No watermark, no UI, no illegible typography unless text overlay is explicitly requested. "
        f"Output format: Pinterest {pin_format}.",
    ]

    if product_count > 0:
        label = ", ".join(product_titles[:4]) if product_titles else f"{product_count} selected product image(s)"
        parts.append(
            "PRODUCT FIDELITY: The selected product image(s) are the main subject. "
            f"Feature {label}. Preserve color, shape, material, silhouette, finish, logos when visible, "
            "and other recognizable product details. Do not replace the product with a different item."
        )

    creative = manual_brief or custom_instructions
    if creative:
        parts.append(f"EXPLICIT USER CREATIVE INSTRUCTIONS: {creative}")

    if selected_title or selected_summary:
        parts.append(f"SELECTED DIRECTION: {selected_title}. {selected_summary}".strip())

    control_bits: list[str] = []
    for key in ("composition", "lighting", "mood", "productTreatment", "textTreatment", "referenceStrength"):
        value = str(controls.get(key) or "").strip()
        if value:
            control_bits.append(f"{key}: {value}")
    if control_bits:
        parts.append("GUIDED CONTROLS: " + "; ".join(control_bits) + ".")

    if has_ref:
        ref_label = ", ".join(reference_notes[:3]) if reference_notes else "the selected reference image(s)"
        parts.append(
            "REFERENCE REQUIREMENTS:\n"
            f"- Use {ref_label} as the visual reference.\n"
            "- Use the final input image as the main guide for scene, framing, composition, camera distance, lighting, styling, and pose energy.\n"
            "- Do not recreate the exact scene one-to-one.\n"
            "- If a reference includes a person, do not reproduce that person's identity, face, likeness, or distinctive personal features."
        )
        if is_fashion:
            parts.append(
                "FASHION REFERENCE CONSTRAINT:\n"
                "- The reference image is a strong structural visual director, not weak inspiration.\n"
                "- Create an urban outdoor street-style outfit photograph with Pinterest street-style composition.\n"
                "- Use candid editorial fashion photography, natural pose and movement, city/sidewalk/street context, and natural daylight.\n"
                "- Avoid plain studio backdrops, seamless paper, ecommerce catalog framing, mannequin-only presentation, isolated product shots, or sterile white-background product photography.\n"
                "- Preserve the selected products while placing them into the reference's street-style photographic world."
            )

    if bool(opportunity.get("enabled")):
        angle = str(opportunity.get("keyword") or opportunity.get("title") or "").strip()
        evidence = str(opportunity.get("evidenceSentence") or "").strip()
        if angle or evidence:
            parts.append(f"OPPORTUNITY CONTEXT: Market angle: {angle}. {evidence}".strip())

    parts.append(
        f"CATEGORY PLAYBOOK: Use a {cat_mod['composition']} approach. "
        f"{cat_mod['props']} {cat_mod['avoid']}"
    )

    if cat == "generic":
        parts.append(
            "GENERIC FALLBACK: Keep the scene category-neutral. Do not default to bedroom, living room, "
            "interior, room decor, cozy home, sofa, bed, vase, or wall art unless the user explicitly asked for home decor."
        )

    if is_fashion:
        parts.append(
            "FASHION SAFETY: This is a fashion/editorial direction. Use outfit styling, wardrobe flat lay, "
            "lookbook, mirror outfit framing, apparel/accessory layout, or fashion creator aesthetic. "
            "Do not turn this into a bedroom, living room, interior, room decor, sofa, bed, vase, or wall art scene."
        )

    return "\n\n".join(p for p in parts if p.strip())


# ── Supabase upload ────────────────────────────────────────────────────────────

def _upload_to_supabase(img_bytes: bytes, filename: str) -> str:
    if not SUPABASE_URL or not SUPABASE_SVC_KEY:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set")
    upload_url = f"{SUPABASE_URL}/storage/v1/object/{STORAGE_BUCKET}/{filename}"
    with httpx.Client(timeout=60.0) as client:
        r = client.post(
            upload_url,
            content=img_bytes,
            headers={
                "Authorization": f"Bearer {SUPABASE_SVC_KEY}",
                "apikey": SUPABASE_SVC_KEY,
                "Content-Type": "image/png",
                "x-upsert": "true",
            },
        )
        r.raise_for_status()
    return f"{SUPABASE_URL}/storage/v1/object/public/{STORAGE_BUCKET}/{filename}"


# ── Error type constants (embedded in exception messages as "type::detail") ──────
# These prefixes allow the caller to classify exceptions without pattern matching.
ERR_RATE_LIMITED    = "rate_limited"
ERR_SAFETY_BLOCKED  = "safety_blocked"
ERR_AUTH            = "api_auth_error"
ERR_PAYLOAD         = "api_payload_error"
ERR_SERVER          = "api_server_error"
ERR_MODEL_TEXT      = "model_returned_text"
ERR_IMAGE_LOAD      = "image_load_failed"
ERR_PROVIDER_BUSY   = "provider_busy"
ERR_UNKNOWN         = "unknown_error"

# Retry-After backoff for 429 responses (seconds per attempt 0, 1, 2).
# The spec asks for 30 / 60 / 120 s; after all retries the group is marked rate_limited.
BACKOFF_SCHEDULE_S = [30, 60, 120]

# Error types that must NOT fall through to the chat fallback path.
NO_FALLBACK_ERRORS = {ERR_RATE_LIMITED, ERR_AUTH, ERR_SAFETY_BLOCKED, ERR_PAYLOAD, ERR_PROVIDER_BUSY}

PROVIDER_CONCURRENCY_LIMIT = max(1, int(os.environ.get("GLOBAL_LINAPI_CONCURRENCY", "3") or "3"))
PROVIDER_PERMIT_TTL_SECONDS = max(30, int(os.environ.get("LINAPI_PERMIT_TTL_SECONDS", "600") or "600"))
PROVIDER_PERMIT_WAIT_TIMEOUT_SECONDS = max(0, int(os.environ.get("LINAPI_PERMIT_WAIT_TIMEOUT_SECONDS", "30") or "30"))
GENERATION_LOCK_ROOT = Path(os.environ.get("VIBEPIN_GENERATION_LOCK_DIR") or Path(tempfile.gettempdir()) / "vibepin-generation-locks")


def _lock_remove(path: Path) -> None:
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        return
    except Exception as exc:
        print(json.dumps({
            "event": "provider_limiter_cleanup_failed",
            "path": str(path),
            "error": str(exc)[:200],
        }), file=sys.stderr)


def _try_acquire_provider_permit_sync(owner: dict) -> Path | None:
    now = time.time()
    root = GENERATION_LOCK_ROOT / "provider-linapi"
    root.mkdir(parents=True, exist_ok=True)
    for idx in range(PROVIDER_CONCURRENCY_LIMIT):
        permit_dir = root / f"permit-{idx}"
        try:
            permit_dir.mkdir()
            (permit_dir / "owner.json").write_text(json.dumps({
                **owner,
                "permitId": idx,
                "acquiredAt": now,
                "expiresAt": now + PROVIDER_PERMIT_TTL_SECONDS,
            }, ensure_ascii=False, indent=2), encoding="utf-8")
            return permit_dir
        except FileExistsError:
            expired = False
            try:
                meta = json.loads((permit_dir / "owner.json").read_text(encoding="utf-8"))
                expired = float(meta.get("expiresAt") or 0) < now
            except Exception:
                try:
                    expired = now - permit_dir.stat().st_mtime > PROVIDER_PERMIT_TTL_SECONDS
                except FileNotFoundError:
                    expired = True
            if expired:
                _lock_remove(permit_dir)
                try:
                    permit_dir.mkdir()
                    (permit_dir / "owner.json").write_text(json.dumps({
                        **owner,
                        "permitId": idx,
                        "acquiredAt": now,
                        "expiresAt": now + PROVIDER_PERMIT_TTL_SECONDS,
                    }, ensure_ascii=False, indent=2), encoding="utf-8")
                    return permit_dir
                except FileExistsError:
                    continue
    return None


class ProviderPermit:
    def __init__(self, *, generation_request_id: str, output_index: int | None, variant_role: str | None, provider_model: str):
        self.generation_request_id = generation_request_id
        self.output_index = output_index
        self.variant_role = variant_role
        self.provider_model = provider_model
        self.permit_dir: Path | None = None
        self.started_at = time.time()

    async def __aenter__(self) -> "ProviderPermit":
        owner = {
            "generationRequestId": self.generation_request_id,
            "outputIndex": self.output_index,
            "variantRole": self.variant_role,
            "providerModel": self.provider_model,
            "pid": os.getpid(),
        }
        deadline = self.started_at + PROVIDER_PERMIT_WAIT_TIMEOUT_SECONDS
        printed_wait = False
        while True:
            permit = await asyncio.to_thread(_try_acquire_provider_permit_sync, owner)
            if permit:
                self.permit_dir = permit
                wait_ms = round((time.time() - self.started_at) * 1000)
                print(json.dumps({
                    "event": "provider_limiter_acquired",
                    "limit": PROVIDER_CONCURRENCY_LIMIT,
                    "waitMs": wait_ms,
                    "permit": permit.name,
                    **owner,
                }), file=sys.stderr)
                return self
            if time.time() >= deadline:
                wait_ms = round((time.time() - self.started_at) * 1000)
                print(json.dumps({
                    "event": "provider_limiter_timeout",
                    "limit": PROVIDER_CONCURRENCY_LIMIT,
                    "waitMs": wait_ms,
                    **owner,
                }), file=sys.stderr)
                raise ValueError(f"{ERR_PROVIDER_BUSY}::Provider is busy. Please retry shortly.")
            if not printed_wait:
                printed_wait = True
                print(json.dumps({
                    "event": "provider_limiter_wait",
                    "limit": PROVIDER_CONCURRENCY_LIMIT,
                    **owner,
                }), file=sys.stderr)
            await asyncio.sleep(0.35)

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self.permit_dir:
            await asyncio.to_thread(_lock_remove, self.permit_dir)
            print(json.dumps({
                "event": "provider_limiter_released",
                "permit": self.permit_dir.name,
                "generationRequestId": self.generation_request_id,
                "outputIndex": self.output_index,
                "variantRole": self.variant_role,
            }), file=sys.stderr)


# ── Aspect ratio mapping (user chip → Gemini imageConfig.aspectRatio) ──────────

_ASPECT_RATIO_MAP: dict[str, str] = {
    "1:1":  "1:1",
    "4:3":  "4:3",
    "3:4":  "3:4",
    "16:9": "16:9",
    "9:16": "9:16",
    # Pinterest-native portrait formats → nearest Gemini value
    "2:3":  "3:4",
    "4:5":  "3:4",
}

def _gemini_aspect_ratio(pin_format: str) -> str:
    """Map user-facing format string to Gemini imageConfig.aspectRatio."""
    return _ASPECT_RATIO_MAP.get(pin_format.strip(), "3:4")


# ── Core generation ────────────────────────────────────────────────────────────

def _image_part_to_file_tuple(part: dict, idx: int) -> tuple[str, tuple[str, bytes, str]] | None:
    inline = part.get("inlineData") if isinstance(part, dict) else None
    if not isinstance(inline, dict):
        return None
    mime = str(inline.get("mimeType") or "image/png")
    b64 = str(inline.get("data") or "")
    if not b64:
        return None
    ext = "png"
    if "jpeg" in mime or "jpg" in mime:
        ext = "jpg"
    elif "webp" in mime:
        ext = "webp"
    try:
        raw = base64.b64decode(re.sub(r"\s+", "", b64), validate=True)
    except Exception:
        return None
    return ("image", (f"input_{idx}.{ext}", raw, mime))


async def _generate_via_images_edit_api(
    prompt: str,
    image_parts: list[dict],
    pin_format: str = "2:3",
    model_id: str = "gpt-image-2",
    image_input_order: list[dict] | None = None,
    image_manifest: str | None = None,
) -> bytes:
    """OpenAI-compatible /images/edits endpoint for GPT image models with image inputs."""
    _SIZE_MAP = {
        "1:1":  "1024x1024",
        "16:9": "1536x1024",
        "4:3":  "1536x1024",
        "9:16": "1024x1536",
        "2:3":  "1024x1536",
        "3:4":  "1024x1536",
        "4:5":  "1024x1536",
    }
    size = _SIZE_MAP.get(pin_format.strip(), "1024x1536")
    url = f"{LINAPI_BASE_URL}/images/edits"
    files = [item for item in (_image_part_to_file_tuple(p, i) for i, p in enumerate(image_parts)) if item]
    if not files:
        raise ValueError(f"{ERR_IMAGE_LOAD}::No valid image files available for GPT image edit request")
    data = {
        "model": model_id,
        "prompt": prompt,
        "n": "1",
        "size": size,
        "response_format": "b64_json",
    }
    print(json.dumps({
        "event": "debug_final_request_payload",
        "endpoint": "/images/edits",
        "model": model_id,
        "size": size,
        "input_image_count": len(files),
        "input_order": image_input_order or "products first, references last",
        "imageManifest": image_manifest,
        "prompt_first_1000": prompt[:1000],
    }), file=sys.stderr)
    max_attempts = len(BACKOFF_SCHEDULE_S) + 1
    async with httpx.AsyncClient(timeout=300.0) as client:
        for attempt in range(max_attempts):
            r = await client.post(
                url,
                headers={"Authorization": f"Bearer {LINAPI_KEY}"},
                data=data,
                files=files,
            )
            print(f"[generator] images_edit attempt {attempt+1}/{max_attempts}: HTTP {r.status_code}", file=sys.stderr)
            if r.status_code == 429:
                if attempt >= len(BACKOFF_SCHEDULE_S):
                    raise ValueError(f"{ERR_RATE_LIMITED}::Rate limited after {max_attempts} attempts")
                wait = BACKOFF_SCHEDULE_S[attempt]
                print(f"[generator] rate limited. retryAfter={wait}s", file=sys.stderr)
                await asyncio.sleep(wait)
                continue
            if r.status_code in (401, 403):
                raise ValueError(f"{ERR_AUTH}::HTTP {r.status_code} — check LINAPI_KEY: {r.text[:200]}")
            if r.status_code == 400:
                raise ValueError(f"{ERR_PAYLOAD}::HTTP 400 from /images/edits — {r.text[:350]}")
            if r.status_code in (404, 405):
                raise ValueError(f"{ERR_PAYLOAD}::/images/edits unsupported for {model_id}; refusing text-only fallback because reference images would be dropped")
            if r.status_code >= 500:
                if attempt < len(BACKOFF_SCHEDULE_S):
                    await asyncio.sleep(BACKOFF_SCHEDULE_S[attempt])
                    continue
                raise ValueError(f"{ERR_SERVER}::HTTP {r.status_code} — {r.text[:200]}")
            if r.status_code != 200:
                raise ValueError(f"{ERR_UNKNOWN}::HTTP {r.status_code} — {r.text[:200]}")
            payload = r.json()
            items = payload.get("data") or []
            if not items:
                raise ValueError(f"{ERR_UNKNOWN}::No image data in edits response")
            b64 = items[0].get("b64_json") or ""
            if b64:
                return base64.b64decode(b64)
            url_val = items[0].get("url") or ""
            if url_val:
                async with httpx.AsyncClient(timeout=60.0) as http:
                    img_r = await http.get(url_val)
                    img_r.raise_for_status()
                    return img_r.content
            raise ValueError(f"{ERR_UNKNOWN}::No b64_json or url in edits response")
    raise ValueError(f"{ERR_UNKNOWN}::No image data after {max_attempts} attempts")


async def _generate_via_images_api(
    prompt: str,
    pin_format: str = "2:3",
    model_id: str = "gpt-image-2",
) -> bytes:
    """OpenAI /images/generations endpoint — used for GPT Image models (text-prompt only)."""
    _SIZE_MAP = {
        "1:1":  "1024x1024",
        "16:9": "1536x1024",
        "4:3":  "1536x1024",
        "9:16": "1024x1536",
        "2:3":  "1024x1536",
        "3:4":  "1024x1536",
        "4:5":  "1024x1536",
    }
    size = _SIZE_MAP.get(pin_format.strip(), "1024x1536")
    url = f"{LINAPI_BASE_URL}/images/generations"
    body = {
        "model": model_id,
        "prompt": prompt,
        "n": 1,
        "size": size,
        "response_format": "b64_json",
    }
    print(json.dumps({
        "event": "debug_final_request_payload",
        "endpoint": "/images/generations",
        "model": model_id,
        "size": size,
        "input_image_count": 0,
        "warning": "text-only endpoint",
        "prompt_first_1000": prompt[:1000],
    }), file=sys.stderr)
    max_attempts = len(BACKOFF_SCHEDULE_S) + 1
    async with httpx.AsyncClient(timeout=300.0) as client:
        for attempt in range(max_attempts):
            r = await client.post(
                url,
                headers={"Authorization": f"Bearer {LINAPI_KEY}", "Content-Type": "application/json"},
                json=body,
            )
            print(f"[generator] images_api attempt {attempt+1}/{max_attempts}: HTTP {r.status_code}", file=sys.stderr)
            if r.status_code == 429:
                if attempt >= len(BACKOFF_SCHEDULE_S):
                    raise ValueError(f"{ERR_RATE_LIMITED}::Rate limited after {max_attempts} attempts")
                wait = BACKOFF_SCHEDULE_S[attempt]
                print(f"[generator] rate limited. retryAfter={wait}s", file=sys.stderr)
                await asyncio.sleep(wait)
                continue
            if r.status_code in (401, 403):
                raise ValueError(f"{ERR_AUTH}::HTTP {r.status_code} — check LINAPI_KEY: {r.text[:200]}")
            if r.status_code == 400:
                raise ValueError(f"{ERR_PAYLOAD}::HTTP 400 — {r.text[:250]}")
            if r.status_code >= 500:
                if attempt < len(BACKOFF_SCHEDULE_S):
                    await asyncio.sleep(BACKOFF_SCHEDULE_S[attempt])
                    continue
                raise ValueError(f"{ERR_SERVER}::HTTP {r.status_code} — {r.text[:200]}")
            if r.status_code != 200:
                raise ValueError(f"{ERR_UNKNOWN}::HTTP {r.status_code} — {r.text[:200]}")
            data = r.json()
            items = data.get("data") or []
            if not items:
                raise ValueError(f"{ERR_UNKNOWN}::No image data in response")
            b64 = items[0].get("b64_json") or ""
            if not b64:
                url_val = items[0].get("url") or ""
                if url_val:
                    async with httpx.AsyncClient(timeout=60.0) as http:
                        img_r = await http.get(url_val)
                        img_r.raise_for_status()
                        return img_r.content
                raise ValueError(f"{ERR_UNKNOWN}::No b64_json or url in images response")
            return base64.b64decode(b64)
    raise ValueError(f"{ERR_UNKNOWN}::No image data after {max_attempts} attempts")


async def _generate_via_native_generate_content(
    prompt: str,
    image_parts: list[dict] | None = None,
    pin_format: str = "2:3",
    model_id: str | None = None,
    image_input_order: list[dict] | None = None,
    image_manifest: str | None = None,
) -> bytes:
    """
    Call the Gemini :generateContent endpoint (native LinAPI path).

    Error classification (exception prefix::detail):
      rate_limited::    HTTP 429, all retries exhausted
      api_auth_error::  HTTP 401/403
      api_payload_error:: HTTP 400
      api_server_error:: HTTP 5xx
      safety_blocked::  No candidates + blockReason set
      model_returned_text:: Candidate returned text, not image
      unknown_error::   Anything else
    """
    model = model_id or IMAGE_MODEL
    if LINAPI_BASE_URL.endswith("/v1"):
        origin = LINAPI_BASE_URL[:-3]
    else:
        origin = LINAPI_BASE_URL
    url = f"{origin}/v1beta/models/{model}:generateContent"

    content_parts: list[dict] = []
    if image_parts and image_input_order and len(image_parts) == len(image_input_order):
        for meta, part in zip(image_input_order, image_parts):
            role = str(meta.get("role") or "input").upper()
            order = int(meta.get("order") or len(content_parts) + 1)
            content_parts.append({"text": f"Image {order} — {role}"})
            content_parts.append(part)
    else:
        content_parts = list(image_parts or [])
    content_parts.append({"text": prompt})

    body = {
        "contents": [{"parts": content_parts}],
        "generationConfig": {
            "imageConfig": {"aspectRatio": _gemini_aspect_ratio(pin_format), "imageSize": "1K"}
        },
    }

    print(json.dumps({
        "event": "debug_final_request_payload",
        "endpoint": "native:generateContent",
        "model": model,
        "aspectRatio": _gemini_aspect_ratio(pin_format),
        "input_image_count": len(image_parts or []),
        "input_order": image_input_order or [],
        "imageManifest": image_manifest,
        "prompt_first_1000": prompt[:1000],
    }), file=sys.stderr)

    max_attempts = len(BACKOFF_SCHEDULE_S) + 1  # 4 total
    async with httpx.AsyncClient(timeout=300.0, follow_redirects=True) as client:
        for attempt in range(max_attempts):
            r = await client.post(
                url,
                headers={
                    "Authorization": f"Bearer {LINAPI_KEY}",
                    "Content-Type": "application/json",
                },
                json=body,
            )
            print(f"[generator] API attempt {attempt+1}/{max_attempts}: HTTP {r.status_code}", file=sys.stderr)

            # ── 429 Rate limited ──────────────────────────────────────────────
            if r.status_code == 429:
                if attempt >= len(BACKOFF_SCHEDULE_S):
                    raise ValueError(
                        f"{ERR_RATE_LIMITED}::Rate limited after {max_attempts} attempts (all retries exhausted)"
                    )
                # Respect Retry-After header if present, else use backoff schedule
                retry_after = BACKOFF_SCHEDULE_S[attempt]
                ra_header = r.headers.get("Retry-After") or r.headers.get("retry-after")
                if ra_header:
                    try:
                        retry_after = max(int(ra_header), retry_after)
                    except ValueError:
                        pass
                print(f"[generator] rate limited. retryAfter={retry_after}s (attempt {attempt+1})", file=sys.stderr)
                await asyncio.sleep(retry_after)
                continue

            # ── Auth / key errors ─────────────────────────────────────────────
            if r.status_code in (401, 403):
                print(f"[generator] auth error: {r.text[:300]}", file=sys.stderr)
                raise ValueError(f"{ERR_AUTH}::HTTP {r.status_code} — check LINAPI_KEY: {r.text[:200]}")

            # ── Bad request (payload too large, model not found, etc.) ─────────
            if r.status_code == 400:
                print(f"[generator] bad request: {r.text[:400]}", file=sys.stderr)
                raise ValueError(f"{ERR_PAYLOAD}::HTTP 400 — {r.text[:250]}")

            # ── 5xx server errors — retry with backoff ────────────────────────
            if r.status_code >= 500:
                if attempt < len(BACKOFF_SCHEDULE_S):
                    wait = BACKOFF_SCHEDULE_S[attempt]
                    print(f"[generator] server error {r.status_code}, waiting {wait}s before retry", file=sys.stderr)
                    await asyncio.sleep(wait)
                    continue
                print(f"[generator] server error body: {r.text[:400]}", file=sys.stderr)
                raise ValueError(f"{ERR_SERVER}::HTTP {r.status_code} — {r.text[:200]}")

            # ── Other non-200 ─────────────────────────────────────────────────
            if r.status_code != 200:
                print(f"[generator] unexpected status {r.status_code}: {r.text[:400]}", file=sys.stderr)
                raise ValueError(f"{ERR_UNKNOWN}::HTTP {r.status_code} — {r.text[:200]}")

            # ── Parse successful response ─────────────────────────────────────
            data = r.json()
            candidates = data.get("candidates") or []

            if not candidates:
                feedback = data.get("promptFeedback") or {}
                block_reason = feedback.get("blockReason") or ""
                api_error    = data.get("error") or {}
                print(
                    f"[generator] No candidates. blockReason={block_reason!r} "
                    f"api_error={json.dumps(api_error)[:200]} keys={list(data.keys())}",
                    file=sys.stderr,
                )
                if block_reason:
                    raise ValueError(f"{ERR_SAFETY_BLOCKED}::Model blocked: blockReason={block_reason}")
                raise ValueError(f"{ERR_UNKNOWN}::No candidates in API response (no block reason found)")

            for cand in candidates:
                finish = cand.get("finishReason") or ""
                if finish not in ("", "STOP"):
                    print(f"[generator] finishReason={finish}", file=sys.stderr)

                for part in (cand.get("content") or {}).get("parts") or []:
                    b64 = (part.get("inlineData") or {}).get("data")
                    if b64:
                        return base64.b64decode(b64)
                    if "text" in part:
                        text_snippet = part["text"][:200]
                        print(f"[generator] Got text instead of image: {text_snippet}", file=sys.stderr)
                        raise ValueError(f"{ERR_MODEL_TEXT}::Model returned text instead of image: {text_snippet[:120]}")

    raise ValueError(f"{ERR_UNKNOWN}::No image data after {max_attempts} attempts")


async def _generate_via_chat(
    prompt: str,
    image_parts: list[dict] | None = None,
) -> bytes:
    """
    Fallback: OpenAI-compatible chat completions.
    Includes images as vision content when available.
    """
    try:
        from openai import AsyncOpenAI  # type: ignore
    except ImportError:
        raise RuntimeError("openai package not installed; run: pip install openai")

    client = AsyncOpenAI(api_key=LINAPI_KEY, base_url=LINAPI_BASE_URL)
    instructions = (
        "\n\nGenerate exactly ONE photorealistic Pinterest pin image. "
        "Output ONLY a single markdown image line: ![](<url>) or ![](data:image/png;base64,...). "
        "No explanatory text."
    )

    # Build content: image parts + text
    if image_parts:
        content: list[dict] | str = []
        for ip in image_parts:
            inline = ip.get("inlineData", {})
            mime   = inline.get("mimeType", "image/jpeg")
            data   = inline.get("data", "")
            content.append({  # type: ignore[attr-defined]
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{data}"},
            })
        content.append({"type": "text", "text": prompt + instructions})  # type: ignore[union-attr]
    else:
        content = prompt + instructions

    for attempt in range(3):
        try:
            resp = await client.chat.completions.create(
                model=IMAGE_MODEL,
                messages=[{"role": "user", "content": content}],  # type: ignore[arg-type]
                stream=False,
                temperature=0.4,
                max_tokens=8192,
            )
            text_out = resp.choices[0].message.content or ""
            m = re.search(r"data:image/[^;]+;base64,([A-Za-z0-9+/=\s\n]+)", text_out, re.I | re.S)
            if m:
                return base64.b64decode(re.sub(r"\s+", "", m.group(1)))
            m2 = re.search(r"!\[[^\]]*\]\((https?://[^)\s]+)\)", text_out)
            if m2:
                async with httpx.AsyncClient(timeout=60.0) as http:
                    img_r = await http.get(m2.group(1))
                    img_r.raise_for_status()
                    return img_r.content
            raise ValueError("No image in chat response")
        except Exception as e:
            if "429" in str(e) and attempt < 2:
                await asyncio.sleep(20 * (attempt + 1))
                continue
            raise


async def _call_api(
    prompt: str,
    image_parts: list[dict] | None = None,
    pin_format: str = "2:3",
    model_id: str | None = None,
    image_input_order: list[dict] | None = None,
    image_manifest: str | None = None,
    generation_request_id: str = "",
    output_index: int | None = None,
    variant_role: str | None = None,
    provider_mode: str = "real",
    mock_provider_behavior: str = "success",
    mock_provider_delay_ms: int = 1500,
) -> bytes:
    """Route to the correct LinAPI path based on the model ID.

    - gemini-*  → native :generateContent (multimodal, supports image_parts)
    - gpt-image-* with image_parts → /images/edits (multimodal image input)
    - gpt-image-* without image_parts → /images/generations (text prompt only)
    - anything else → chat completions fallback

    Fallback to chat completions is used ONLY for routing/format errors, not for:
      rate_limited, api_auth_error, safety_blocked, api_payload_error
    """
    effective_model = (model_id or IMAGE_MODEL).lower()
    print(f"[generator] _call_api: model={effective_model}", file=sys.stderr)
    async with ProviderPermit(
        generation_request_id=generation_request_id or "unknown",
        output_index=output_index,
        variant_role=variant_role,
        provider_model=effective_model,
    ):
        if provider_mode == "mock":
            print(json.dumps({
                "event": "mock_provider_call",
                "behavior": mock_provider_behavior,
                "delayMs": mock_provider_delay_ms,
                "generationRequestId": generation_request_id,
                "outputIndex": output_index,
                "variantRole": variant_role,
                "wouldCallLinapi": False,
            }), file=sys.stderr)
            await asyncio.sleep(max(0, mock_provider_delay_ms) / 1000)
            if mock_provider_behavior in ("fail_all", "provider_timeout"):
                raise ValueError(f"{ERR_SERVER}::Mock provider forced failure")
            if mock_provider_behavior in ("partial", "fail_output_2") and output_index == 1:
                raise ValueError(f"{ERR_SERVER}::Mock output {output_index} forced failure")
            return base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lkWz9wAAAABJRU5ErkJggg=="
            )

        if "gemini" in effective_model:
            try:
                return await _generate_via_native_generate_content(
                    prompt, image_parts, pin_format, model_id=effective_model,
                    image_input_order=image_input_order, image_manifest=image_manifest,
                )
            except Exception as e:
                e_str = str(e)
                etype = e_str.split("::", 1)[0] if "::" in e_str else ERR_UNKNOWN
                if etype in NO_FALLBACK_ERRORS:
                    print(f"[generator] ✗ {etype} — not falling through to chat path (won't help)", file=sys.stderr)
                    raise
                print(f"[generator] ✗ Native path failed ({etype}): {e_str[:200]} — trying chat fallback", file=sys.stderr)
                return await _generate_via_chat(prompt, image_parts)

        if "gpt-image" in effective_model and image_parts:
            return await _generate_via_images_edit_api(
                prompt, image_parts, pin_format, model_id=effective_model,
                image_input_order=image_input_order, image_manifest=image_manifest,
            )

        if "gpt-image" in effective_model:
            if image_input_order:
                raise ValueError(f"{ERR_PAYLOAD}::Image inputs were selected but GPT image path resolved to text-only generation")
            return await _generate_via_images_api(prompt, pin_format, model_id=effective_model)

        print(f"[generator] Using chat completions fallback for model={effective_model}", file=sys.stderr)
        return await _generate_via_chat(prompt, image_parts)


async def _generate_one(
    keyword: str,
    style: str,
    idx: int,
    prompt: str | None = None,
    image_parts: list[dict] | None = None,
    pin_format: str = "2:3",
    model_id: str | None = None,
    image_input_order: list[dict] | None = None,
    image_manifest: str | None = None,
    generation_request_id: str = "",
    variant_role: str | None = None,
    provider_mode: str = "real",
    mock_provider_behavior: str = "success",
    mock_provider_delay_ms: int = 1500,
) -> str:
    final_prompt = prompt or _build_prompt(keyword, style, pin_format)
    img_bytes = await _call_api(
        final_prompt, image_parts, pin_format, model_id=model_id,
        image_input_order=image_input_order, image_manifest=image_manifest,
        generation_request_id=generation_request_id,
        output_index=idx,
        variant_role=variant_role,
        provider_mode=provider_mode,
        mock_provider_behavior=mock_provider_behavior,
        mock_provider_delay_ms=mock_provider_delay_ms,
    )
    if provider_mode == "mock":
        return f"https://mock.vibepin.local/studio/{generation_request_id}/{idx}_{uuid.uuid4().hex[:8]}.png"
    filename = f"studio/{int(time.time())}_{idx}_{uuid.uuid4().hex[:8]}.png"
    return _upload_to_supabase(img_bytes, filename)


# ── Entry points ───────────────────────────────────────────────────────────────

async def run_from_stdin() -> None:
    """
    Main entry point used by Next.js /api/generate.
    Reads full JSON payload from stdin:
      {
        "keyword": str,
        "style": str,
        "count": int,
        "prompt": str,         # assembled by frontend
        "style_ref": str|null, # URL or data URL of reference pin
        "product_images": []   # list of data URLs from user uploads
      }
    """
    try:
        raw = sys.stdin.read()
        # Strip UTF-8 BOM (﻿) — can appear on Windows when the parent process
        # pipes through certain encodings (PowerShell, some Node.js builds).
        raw = raw.lstrip("﻿")
        # Scrub any surrogate replacement characters before JSON parsing.
        raw = raw.encode("utf-8", errors="replace").decode("utf-8")
        if not raw.strip():
            _emit({"ok": False, "error": "Empty stdin payload received", "urls": []})
            return
        data: dict = json.loads(raw)
    except Exception as e:
        _emit({"ok": False, "error": f"Failed to parse stdin payload: {e}", "urls": []})
        return

    result = await generate_from_payload(data)
    _emit(result)


async def prepare_generation(data: dict) -> dict:
    """
    Setup phase of a generation request: parse fields, validate inputs, load
    images, run the enhancer, and build the final prompt + per-slot variant
    prompts. Emits NOTHING — on a validation/early-exit error it returns
    ``{"ok": False, "phase": "prepare", "emit": {...}}`` carrying the exact dict
    that run_from_stdin's original body passed to ``_emit``. On success it returns
    ``{"ok": True, "plan": {...}}`` with every value the per-slot loop and the
    final emit need. All stderr ``print(...)`` calls are preserved verbatim.
    """
    t_total_start      = time.time()
    keyword            = str(data.get("keyword") or "").strip()
    style              = str(data.get("style") or "lifestyle")
    count              = max(1, min(8, int(data.get("count") or 4)))
    # Single-output retry ALWAYS generates exactly one image — never the batch count.
    retry_single_output = str(data.get("mode") or "") == "retry_single_output"
    if retry_single_output:
        count = 1
    custom_prompt      = str(data.get("prompt") or "").strip() or None
    style_ref          = str(data.get("style_ref") or "").strip() or None
    product_images     = [str(s) for s in (data.get("product_images") or []) if s]
    category           = str(data.get("category") or "").strip()
    # Prompt-enhancer inputs (optional — defaults used when not sent by frontend)
    text_overlay       = bool(data.get("text_overlay", False))
    reference_strength = str(data.get("reference_strength") or "moderate").strip()
    pin_format         = str(data.get("format") or "2:3").strip()
    output_type        = str(data.get("output_type") or "").strip()
    product_metadata   = data.get("product_metadata") or None  # list[dict] | None
    model_key          = str(data.get("model_key") or "gemini_image").strip()
    prompt_mode        = str(data.get("prompt_mode") or "legacy").strip()
    prompt_version     = str(data.get("prompt_version") or ("2" if prompt_mode == "creative_direction_v2" else "1")).strip()
    creative_direction_meta = data.get("creative_direction_meta") if isinstance(data.get("creative_direction_meta"), dict) else None
    product_count_requested = int(data.get("productImageCountRequested") or len(product_images))
    reference_count_requested = int(data.get("referenceImageCountRequested") or (1 if style_ref else 0))
    output_count       = int(data.get("outputCount") or count)
    requested_image_count = int(data.get("requestedImageCount") or count)
    actual_image_count = int(data.get("actualImageCount") or count)
    count_clamped     = bool(data.get("countClamped", actual_image_count != requested_image_count))
    generation_request_id = str(data.get("generationRequestId") or f"gen_{int(time.time())}_{uuid.uuid4().hex[:8]}")
    generation_owner_id = str(data.get("generationOwnerId") or "")
    provider_mode = str(data.get("providerMode") or "real").strip().lower()
    if provider_mode != "mock":
        provider_mode = "real"
    mock_provider_behavior = str(data.get("mockProviderBehavior") or "success").strip().lower()
    mock_provider_delay_ms = max(0, min(60_000, int(data.get("mockProviderDelayMs") or 1500)))
    variation_mode     = str(data.get("variationMode") or "distinct").strip().lower()
    if variation_mode not in ("distinct", "similar"):
        variation_mode = "distinct"
    output_variants    = data.get("outputVariants") if isinstance(data.get("outputVariants"), list) else []
    output_variants    = [v for v in output_variants if isinstance(v, dict)]
    # Creative-control fields — parsed for per-output logging / provenance only.
    selected_tags      = data.get("selectedTags") if isinstance(data.get("selectedTags"), list) else []
    primary_format_tag = str(data.get("primaryFormatTag") or "").strip()
    direction_brief    = str(data.get("directionBrief") or "").strip()
    image_inputs = _normalize_image_inputs(data, product_images, style_ref)
    image_manifest = _build_image_manifest(image_inputs)
    model_id           = _resolve_model_id(model_key)
    category_passed    = category
    inferred_category  = _infer_category(category, output_type, custom_prompt, product_metadata)
    category           = inferred_category
    output_type        = _infer_output_type(output_type, category)
    fashion_safety_applied = category in _FASHION_IDS

    if not keyword:
        return {"ok": False, "phase": "prepare", "emit": {"ok": False, "error": "keyword is required", "urls": []}}
    if not LINAPI_KEY and provider_mode != "mock":
        return {"ok": False, "phase": "prepare", "emit": {"ok": False, "error": "LINAPI_KEY not set in environment", "urls": [], "keyword": keyword}}

    # ── Provider / capability validation (never silently fall back to text-only) ──
    if model_key == "gemini_image" and not (model_id or "").strip():
        return {"ok": False, "phase": "prepare", "emit": {"ok": False, "error": "Gemini image model is not configured.",
               "error_type": "configuration_error", "urls": [], "keyword": keyword}}
    _has_image_inputs    = bool(product_images) or bool(style_ref)
    _supports_image_input = _model_supports_image_input(model_id)
    if _has_image_inputs and not _supports_image_input:
        return {"ok": False, "phase": "prepare", "emit": {"ok": False,
               "error": "The selected image model does not support product/reference image inputs through the current provider configuration.",
               "error_type": "api_payload_error", "urls": [], "keyword": keyword}}

    # ── Collect image parts: reference first, then products ────────────────────
    print(
        f"\n[generator] === New generation request ===\n"
        f"  keyword       : {keyword}\n"
        f"  category      : {category_passed}\n"
        f"  inferred_cat  : {inferred_category}\n"
        f"  count         : {count}\n"
        f"  style_ref     : {('data-url (' + str(len(style_ref)) + ' chars)') if style_ref and style_ref.startswith('data:') else style_ref or 'NONE'}\n"
        f"  product_images: {len(product_images)} images",
        file=sys.stderr
    )

    # ── Load product images + reference in PARALLEL ───────────────────────────
    # Previous approach was sequential (4 products = 4 serial downloads).
    # Now: fire all image fetches simultaneously, then sort results.
    t_img_start = time.time()

    load_targets: list[dict] = image_inputs

    if load_targets:
        raw_results = await asyncio.gather(
            *[_image_input_to_part(str(t["sourceUrl"])) for t in load_targets],
            return_exceptions=True,
        )
    else:
        raw_results = []

    loaded_inputs: list[dict] = []

    for target, result in zip(load_targets, raw_results):
        kind = str(target.get("role") or "input")
        src = str(target.get("sourceUrl") or "")
        if isinstance(result, Exception):
            print(f"[generator] ✗ {kind} image load EXCEPTION: {result}", file=sys.stderr)
            continue
        if result:
            loaded_inputs.append({**target, "part": result})
            print(f"[generator] ✓ {kind} image loaded order={target.get('order')} source={src[:70]}", file=sys.stderr)
        else:
            print(f"[generator] ✗ {kind} image FAILED to load order={target.get('order')} source={src[:70]}", file=sys.stderr)

    t_img_elapsed = time.time() - t_img_start
    product_parts: list[dict] = [i["part"] for i in loaded_inputs if i.get("role") == "product"]
    reference_parts: list[dict] = [i["part"] for i in loaded_inputs if i.get("role") == "reference"]
    loaded_products = len(product_parts)
    loaded_references = len(reference_parts)
    print(
        f"[generator] image loading done in {t_img_elapsed:.1f}s — "
        f"{loaded_products}/{product_count_requested} products, "
        f"{loaded_references}/{reference_count_requested} references",
        file=sys.stderr,
    )

    # Order: [product_1, product_2, ..., reference]
    image_parts: list[dict] = [i["part"] for i in loaded_inputs]
    image_input_order: list[dict] = [
        {
            "order": int(i.get("order") or idx + 1),
            "role": i.get("role"),
            "sourceUrl": str(i.get("sourceUrl") or ""),
            "label": i.get("label"),
        }
        for idx, i in enumerate(loaded_inputs)
    ]
    expected_input_count = product_count_requested + reference_count_requested
    if expected_input_count > 0 and len(image_parts) != expected_input_count:
        missing_msg = (
            "Reference images were selected but were not included in the provider image input payload."
            if reference_count_requested > 0 and loaded_references < reference_count_requested
            else "Selected images were not included in the provider image input payload."
        )
        print(json.dumps({
            "event": "image_input_validation_failed",
            "productImageCountRequested": product_count_requested,
            "referenceImageCountRequested": reference_count_requested,
            "totalInputImageCount": len(image_parts),
            "expectedInputImageCount": expected_input_count,
            "imageInputOrder": image_input_order,
            "imageManifest": image_manifest,
            "usedTextOnlyFallback": False,
        }), file=sys.stderr)
        return {"ok": False, "phase": "prepare", "emit": {
            "ok": False,
            "error": missing_msg,
            "error_type": ERR_IMAGE_LOAD,
            "urls": [],
            "keyword": keyword,
            "style": style,
        }}

    if expected_input_count == 0:
        print(f"[generator] image_inputs = NONE (text-only generation allowed)", file=sys.stderr)

    # ── Preflight: validate every inline image part and log a SAFE manifest ────────
    # This is what identifies which part (e.g. contents[0].parts[4]) is bad and why,
    # BEFORE the provider call — so a single broken input fails loudly here with an
    # actionable error_type instead of producing the opaque upstream
    # "Invalid value at contents[0].parts[N].inline_data.data / Base64 decoding failed".
    image_manifest_log: list[dict] = []
    bad_parts: list[dict] = []
    for pidx, (part, order_meta) in enumerate(zip(image_parts, image_input_order)):
        role = str(order_meta.get("role") or "input")
        src = str(order_meta.get("sourceUrl") or "")
        entry = _safe_part_manifest(part, output_index=-1, part_index=pidx, role=f"{role}_image", source_id=src)
        image_manifest_log.append(entry)
        if not entry["localDecodeOk"] or entry["base64Mod4"] != 0 or entry["hadDataUrlPrefix"]:
            bad_parts.append(entry)
    print(json.dumps({
        "event": "image_input_manifest",
        "generationRequestId": generation_request_id,
        "totalInputImageCount": len(image_parts),
        "allImagePartsValid": len(bad_parts) == 0,
        "parts": image_manifest_log,
    }), file=sys.stderr)
    if bad_parts:
        print(json.dumps({"event": "image_input_invalid_parts", "badParts": bad_parts}), file=sys.stderr)
        return {"ok": False, "phase": "prepare", "emit": {
            "ok": False,
            "error": "One of the input images could not be processed.",
            "error_type": ERR_IMAGE_LOAD,
            "urls": [],
            "keyword": keyword,
            "style": style,
        }}

    provider_endpoint = (
        "/images/edits" if image_parts and "gpt-image" in model_id.lower()
        else "/images/generations" if "gpt-image" in model_id.lower()
        else "native:generateContent" if "gemini" in model_id.lower()
        else "chat.completions"
    )

    print(
        f"[generator] image_parts order: [{len(product_parts)} products] + "
        f"[{loaded_references} references] = {len(image_parts)} total",
        file=sys.stderr
    )
    print(json.dumps({
        "event": "debug_image_input_assembly",
        "productImageCountRequested": product_count_requested,
        "referenceImageCountRequested": reference_count_requested,
        "productImageCountLoaded": len(product_parts),
        "referenceImageCountLoaded": loaded_references,
        "totalInputImageCount": len(image_parts),
        "expectedInputImageCount": expected_input_count,
        "imageInputOrder": [
            {**i, "sourceUrl": (i["sourceUrl"][:120] + "…") if len(i["sourceUrl"]) > 120 else i["sourceUrl"]}
            for i in image_input_order
        ],
        "imageManifest": image_manifest,
        "productUrls": product_images,
        "referenceUrls": [i["sourceUrl"] for i in image_inputs if i.get("role") == "reference"],
        "gptReceivesImages": bool(image_parts) and "gpt-image" in model_id.lower(),
        "providerEndpoint": provider_endpoint,
        "usedTextOnlyFallback": False if image_parts else provider_endpoint == "/images/generations",
    }), file=sys.stderr)

    # ── DEBUG: Log all generation inputs before enhancement ──────────────────
    print(json.dumps({
        "event":                  "debug_generation_inputs",
        "selectedProductImages":  [u[:80] + "…" if len(u) > 80 else u for u in product_images],
        "selectedProductCount":   len(product_images),
        "selectedPinReferences":  [style_ref[:80] + "…" if style_ref and len(style_ref) > 80 else style_ref] if style_ref else [],
        "userIntentText":         custom_prompt,
        "categoryPassedFromFrontend": category_passed,
        "inferredCategory":       inferred_category,
        "outputType":             output_type,
        "aspectRatio":            pin_format,
        "modelKey":               model_key,
        "modelId":                model_id,
        "promptMode":             prompt_mode,
        "promptVersion":          prompt_version,
        "generationRequestId":    generation_request_id,
        "generationOwnerId":      generation_owner_id,
        "providerMode":           provider_mode,
        "mockProviderBehavior":    mock_provider_behavior if provider_mode == "mock" else None,
        "mockProviderDelayMs":     mock_provider_delay_ms if provider_mode == "mock" else None,
        "requestedImageCount":    requested_image_count,
        "actualImageCount":       actual_image_count,
        "countClamped":           count_clamped,
        "outputCount":            output_count,
        "variationMode":          variation_mode,
        "outputVariants":         output_variants,
        "creativeDirectionMeta":   creative_direction_meta,
        "category":               category,
        "style":                  style,
        "productMetadata":        product_metadata,
    }), file=sys.stderr)

    # ── Prompt enhancement (Vision-to-Prompt) ─────────────────────────────────
    # Analyzes product + reference images with a VLM to produce a structured
    # prompt plan. Falls back to custom_prompt if enhancer is unconfigured or fails.
    enhancer_result: dict = {}
    enhanced_custom_prompt = custom_prompt
    if _ENHANCER_AVAILABLE:
        ref_urls_for_enhancer: list[str] = [style_ref] if style_ref else []
        enhancer_result = await _enhancer.enhance(
            product_image_urls=product_images,
            reference_image_urls=ref_urls_for_enhancer,
            user_raw_text=custom_prompt,
            output_type=output_type,
            reference_strength=reference_strength,
            text_overlay=text_overlay,
            fmt=pin_format,
            product_metadata=product_metadata,
            category=category,
        )
        if not enhancer_result.get("enhancer_failed") and prompt_mode != "creative_direction_v2":
            enhanced_custom_prompt = enhancer_result["final_prompt"]
            cache_tag = "cache" if enhancer_result.get("cache_hit") else "fresh"
            print(f"[generator] prompt enhancer applied ({cache_tag})", file=sys.stderr)
        elif not enhancer_result.get("enhancer_failed"):
            cache_tag = "cache" if enhancer_result.get("cache_hit") else "fresh"
            print(f"[generator] prompt enhancer analysis applied for creative_direction_v2 ({cache_tag})", file=sys.stderr)
        else:
            reason = enhancer_result.get("fallback_reason", "unknown")
            print(f"[generator] ⚠ prompt enhancer fallback — {reason}", file=sys.stderr)
    else:
        print("[generator] prompt_enhancer module not available — skipping", file=sys.stderr)

    # ── Category feedback loop ────────────────────────────────────────────────
    # The enhancer analyzed the actual product images and may have detected a more
    # specific category than the frontend sent (e.g. fashion when the Remix path lost
    # the category and inference only saw a neutral prompt → "generic"). Adopt it so
    # the generator-level fashion safety + home-decor stripping also apply.
    detected_category = str(enhancer_result.get("detected_category") or "").strip()
    if detected_category and detected_category in _CATEGORY_MODULES and category in ("", "generic"):
        print(
            f"[generator] category upgraded by VLM analysis: {category!r} → {detected_category!r}",
            file=sys.stderr,
        )
        category    = detected_category
        output_type = _infer_output_type(output_type, category)
        fashion_safety_applied = category in _FASHION_IDS

    # ── Build final prompt ─────────────────────────────────────────────────────
    if prompt_mode == "creative_direction_v2":
        # The frontend compiles the authoritative hidden prompt (hiddenPromptBuilder).
        # Pass it through verbatim with only a safe image-role preamble — never
        # re-enhance or re-wrap it (no double enhancement). Fall back to the meta
        # compiler only when no frontend hidden prompt was sent (old v2 records).
        fe_hidden = (custom_prompt or "").strip()
        if len(fe_hidden) > 40:
            preamble = image_manifest or _v2_image_role_preamble(len(product_parts), loaded_references > 0)
            final_prompt = (preamble + "\n\n" + fe_hidden) if preamble else fe_hidden
            print("[generator] creative_direction_v2: frontend hidden prompt (pass-through, no re-enhance)", file=sys.stderr)
        else:
            final_prompt = _build_creative_direction_v2_prompt(
                keyword=keyword,
                product_count=len(product_parts),
                has_ref=loaded_references > 0,
                user_brief=custom_prompt,
                category=category,
                pin_format=pin_format,
                creative_meta=creative_direction_meta,
            )
            print("[generator] creative_direction_v2: compiled from meta (no frontend hidden prompt)", file=sys.stderr)
    else:
        final_prompt = _build_prompt_with_images(
            keyword=keyword,
            style=style,
            product_count=len(product_parts),
            has_ref=loaded_references > 0,
            custom_prompt=enhanced_custom_prompt,
            category=category,
            ref_at_end=True,
            pin_format=pin_format,
        )

    # ── DEBUG: Log enhancer output and final prompt ───────────────────────────
    print(json.dumps({
        "event":                 "debug_prompt_chain",
        "enhancer_available":    _ENHANCER_AVAILABLE,
        "enhancer_failed":       enhancer_result.get("enhancer_failed", not bool(enhancer_result)),
        "cache_hit":             enhancer_result.get("cache_hit", False),
        "enhancer_cache_key":    enhancer_result.get("cache_key"),
        "enhancer_model":        enhancer_result.get("enhancer_model"),
        "enhanced_custom_prompt": (enhanced_custom_prompt or "")[:1000],
        "final_prompt":          final_prompt[:1000],
        "final_prompt_length":   len(final_prompt),
        "image_parts_count":     len(image_parts),
        "product_parts_count":   len(product_parts),
        "has_ref":               loaded_references > 0,
        "imageManifest":         image_manifest,
        "providerEndpoint":      provider_endpoint,
        "model_id":              model_id,
        "modelKey":              model_key,
        "promptMode":            prompt_mode,
        "promptVersion":         prompt_version,
        "outputCount":           output_count,
        "variationMode":         variation_mode,
        "outputVariants":        output_variants,
        "creativeDirectionMeta":  creative_direction_meta,
        "pin_format":            pin_format,
        "output_type":           output_type,
        "categoryPassedFromFrontend": category_passed,
        "inferredCategory":      inferred_category,
        "detectedCategory":      enhancer_result.get("detected_category"),
        "effectiveCategory":     category,
        "home_decor_check":      _home_decor_term_hits(final_prompt),
        "fashion_safety_applied": fashion_safety_applied,
    }), file=sys.stderr)

    # ── Provider payload proof — confirms product + reference images reach the
    #    selected model, with the prompt hierarchy intact (both GPT and Gemini). ──
    _ref_mode_match = re.search(r"referenceInfluenceMode:\s*([a-z_]+)", final_prompt)
    print(json.dumps({
        "event":                       "image_generation_provider_payload",
        "selectedModel":               model_key,
        "providerModel":               model_id,
        "providerEndpoint":            provider_endpoint,
        "promptMode":                  prompt_mode,
        "productImageCountRequested":  product_count_requested,
        "referenceImageCountRequested": reference_count_requested,
        "totalInputImageCount":        len(image_parts),
        "imageInputOrder":             image_input_order,
        "imageManifest":               image_manifest,
        "usedTextOnlyFallback":         False if image_parts else provider_endpoint == "/images/generations",
        "referenceInfluenceMode":      _ref_mode_match.group(1) if _ref_mode_match else "n/a",
        "promptContainsReferenceRequirements": "REFERENCE REQUIREMENTS" in final_prompt,
        "promptContainsProductRequirements":   "PRODUCT REQUIREMENTS" in final_prompt,
        "promptContainsAvoidStudio":   "studio" in final_prompt.lower(),
    }), file=sys.stderr)

    # ── Generate count variations in parallel ──────────────────────────────────
    style_pool = [style] + [s for s in STYLE_PROMPTS if s != style]
    styles     = [style_pool[i % len(style_pool)] for i in range(count)]

    # ── Structured log: all fields requested by the spec ──────────────────────
    print(json.dumps({
        "event":              "generation_start",
        "keyword":            keyword,
        "count":              count,
        "generationRequestId": generation_request_id,
        "requestedImageCount": requested_image_count,
        "actualImageCount":    actual_image_count,
        "countClamped":        count_clamped,
        "outputCount":         output_count,
        "variationMode":       variation_mode,
        "outputVariants":      output_variants,
        "productsRequested":  product_count_requested,
        "productsLoaded":     loaded_products,
        "referencesLoaded":   loaded_references,
        "model":              model_id,
        "model_key":          model_key,
    }), file=sys.stderr)

    print(f"[generator] starting {count} image generation(s) in parallel via {model_id} (key={model_key})", file=sys.stderr)
    variant_prompts = [
        f"{final_prompt}\n\n{_variant_prompt_suffix(i, count, variation_mode, output_variants)}".strip()
        for i in range(count)
    ]
    variant_roles = [
        str(output_variants[i].get("role") or ("anchor" if i == 0 else "variant"))
        if i < len(output_variants) and isinstance(output_variants[i], dict)
        else ("anchor" if i == 0 else "variant")
        for i in range(count)
    ]

    # ── Per-output provenance log: proves each output got a distinct, output-specific
    #    prompt (different hash) with the same products/reference manifest. ──────────
    import hashlib as _hashlib
    for i in range(count):
        _vp = variant_prompts[i]
        print(json.dumps({
            "event":                       "per_output_generation_plan",
            "generationRequestId":         generation_request_id,
            "outputIndex":                 i,
            "variantRole":                 variant_roles[i],
            "variationMode":               variation_mode,
            "model":                       model_id,
            "modelKey":                    model_key,
            "selectedTags":                selected_tags,
            "primaryFormatTag":            primary_format_tag,
            "directionBrief":              direction_brief[:200],
            "productImageCountRequested":  product_count_requested,
            "referenceImageCountRequested": reference_count_requested,
            "totalInputImageCount":        len(image_parts),
            "usedTextOnlyFallback":        False if image_parts else provider_endpoint == "/images/generations",
            # Identical across every output — proves outputs 0/1 share the same image
            # bytes and that DISTINCT mode varies only the text prompt, not serialization.
            "imagePartShaList":            [e["sha256_16"] for e in image_manifest_log],
            "perOutputPromptHash":         _hashlib.sha256(_vp.encode("utf-8", "replace")).hexdigest()[:16],
            "perOutputPromptPreview":      _vp[-500:],
        }), file=sys.stderr)

    # Everything needed by the per-slot loop and the final emit is captured here.
    plan = {
        "keyword": keyword,
        "style": style,
        "count": count,
        "styles": styles,
        "pin_format": pin_format,
        "model_id": model_id,
        "model_key": model_key,
        "image_parts": image_parts,
        "image_input_order": image_input_order,
        "image_manifest": image_manifest,
        "generation_request_id": generation_request_id,
        "variation_mode": variation_mode,
        "output_variants": output_variants,
        "provider_mode": provider_mode,
        "mock_provider_behavior": mock_provider_behavior,
        "mock_provider_delay_ms": mock_provider_delay_ms,
        "variant_prompts": variant_prompts,
        "variant_roles": variant_roles,
        "t_total_start": t_total_start,
        "t_img_elapsed": t_img_elapsed,
        # Fields the final _emit prompt_snapshot needs.
        "custom_prompt": custom_prompt,
        "output_type": output_type,
        "reference_strength": reference_strength,
        "product_count_requested": product_count_requested,
        "reference_count_requested": reference_count_requested,
        "provider_endpoint": provider_endpoint,
        "product_parts": product_parts,
        "loaded_products": loaded_products,
        "loaded_references": loaded_references,
        "enhancer_result": enhancer_result,
        "enhanced_custom_prompt": enhanced_custom_prompt,
        "final_prompt": final_prompt,
        "category_passed": category_passed,
        "inferred_category": inferred_category,
        "category": category,
        "prompt_mode": prompt_mode,
        "prompt_version": prompt_version,
        "creative_direction_meta": creative_direction_meta,
        "requested_image_count": requested_image_count,
        "actual_image_count": actual_image_count,
        "count_clamped": count_clamped,
        "output_count": output_count,
        "selected_tags": selected_tags,
        "primary_format_tag": primary_format_tag,
        "direction_brief": direction_brief,
        "image_manifest_log": image_manifest_log,
        "fashion_safety_applied": fashion_safety_applied,
    }
    return {"ok": True, "plan": plan}


async def generate_slot(plan: dict, slot_index: int) -> str:
    """
    Run ONE generation slot. This is the idempotent, per-slot unit a worker can
    retry independently. Returns the image URL string, or lets the
    ``ValueError("type::detail")`` raised by ``_generate_one`` propagate (never
    caught here) so the caller can classify it.
    """
    return await _generate_one(
        plan["keyword"], plan["styles"][slot_index], slot_index,
        plan["variant_prompts"][slot_index], plan["image_parts"] or None, plan["pin_format"],
        model_id=plan["model_id"],
        image_input_order=plan["image_input_order"],
        image_manifest=plan["image_manifest"],
        generation_request_id=plan["generation_request_id"],
        variant_role=plan["variant_roles"][slot_index],
        provider_mode=plan["provider_mode"],
        mock_provider_behavior=plan["mock_provider_behavior"],
        mock_provider_delay_ms=plan["mock_provider_delay_ms"],
    )


async def generate_from_payload(data: dict) -> dict:
    """
    End-to-end generation for one request. Reproduces the ORIGINAL
    run_from_stdin body's behavior byte-for-byte (same stderr logs, same final
    result dict) but RETURNS the final dict instead of calling ``_emit``.
    """
    prep = await prepare_generation(data)
    if not prep["ok"]:
        return prep["emit"]
    plan = prep["plan"]

    keyword                   = plan["keyword"]
    style                     = plan["style"]
    count                     = plan["count"]
    image_parts               = plan["image_parts"]
    variant_roles             = plan["variant_roles"]
    t_total_start             = plan["t_total_start"]
    t_img_elapsed             = plan["t_img_elapsed"]
    custom_prompt             = plan["custom_prompt"]
    output_type               = plan["output_type"]
    reference_strength        = plan["reference_strength"]
    product_count_requested   = plan["product_count_requested"]
    reference_count_requested = plan["reference_count_requested"]
    provider_endpoint         = plan["provider_endpoint"]
    product_parts             = plan["product_parts"]
    loaded_references         = plan["loaded_references"]
    enhancer_result           = plan["enhancer_result"]
    enhanced_custom_prompt    = plan["enhanced_custom_prompt"]
    final_prompt              = plan["final_prompt"]
    category_passed           = plan["category_passed"]
    inferred_category         = plan["inferred_category"]
    category                  = plan["category"]
    prompt_mode               = plan["prompt_mode"]
    prompt_version            = plan["prompt_version"]
    creative_direction_meta   = plan["creative_direction_meta"]
    requested_image_count     = plan["requested_image_count"]
    actual_image_count        = plan["actual_image_count"]
    count_clamped             = plan["count_clamped"]
    output_count              = plan["output_count"]
    variation_mode            = plan["variation_mode"]
    output_variants           = plan["output_variants"]
    generation_request_id     = plan["generation_request_id"]
    image_input_order         = plan["image_input_order"]
    image_manifest            = plan["image_manifest"]
    fashion_safety_applied    = plan["fashion_safety_applied"]

    t_gen_start = time.time()
    results = await asyncio.gather(
        *[generate_slot(plan, i) for i in range(count)],
        return_exceptions=True,
    )

    t_gen_elapsed = time.time() - t_gen_start

    urls: list[str] = [r for r in results if isinstance(r, str)]

    # Classify errors
    error_types_seen: list[str] = []
    error_messages:   list[str] = []
    error_details:    list[dict] = []
    for output_index, r in enumerate(results):
        if isinstance(r, Exception):
            e_str = str(r)
            if "::" in e_str:
                etype, emsg = e_str.split("::", 1)
            else:
                etype, emsg = ERR_UNKNOWN, e_str
            error_types_seen.append(etype)
            error_messages.append(emsg)
            error_details.append({
                "outputIndex": output_index,
                "error_type": etype,
                "message": emsg,
                "variantRole": variant_roles[output_index] if output_index < len(variant_roles) else None,
            })
            print(f"[generator] error [{etype}]: {emsg[:200]}", file=sys.stderr)

    # Primary error type = most severe (prefer auth > rate_limit > safety > others)
    severity_order = [ERR_AUTH, ERR_PAYLOAD, ERR_PROVIDER_BUSY, ERR_RATE_LIMITED, ERR_SAFETY_BLOCKED, ERR_SERVER,
                      ERR_MODEL_TEXT, ERR_IMAGE_LOAD, ERR_UNKNOWN]
    primary_error_type: str | None = None
    for etype in severity_order:
        if etype in error_types_seen:
            primary_error_type = etype
            break

    print(json.dumps({
        "event":        "generation_done",
        "elapsedSec":   round(t_gen_elapsed, 1),
        "succeeded":    len(urls),
        "failed":       len(error_types_seen),
        "count":        count,
        "generationRequestId": generation_request_id,
        "primaryErrorType": primary_error_type,
        "errorDetails": error_details,
    }), file=sys.stderr)

    t_total_elapsed = time.time() - t_total_start
    print(
        f"[generator] === TOTAL {t_total_elapsed:.1f}s | "
        f"img_load={t_img_elapsed:.1f}s | gen={t_gen_elapsed:.1f}s | "
        f"{len(urls)}/{count} urls | errorType={primary_error_type} ===",
        file=sys.stderr,
    )

    return {
        "ok":         len(urls) > 0,
        "keyword":    keyword,
        "style":      style,
        "count":      count,
        "urls":       urls,
        "errors":     error_messages if error_messages else None,
        "error_details": error_details if error_details else None,
        "error_type": primary_error_type,
        "requested_image_count": requested_image_count,
        "actual_image_count": actual_image_count,
        "count_clamped": count_clamped,
        "generation_request_id": generation_request_id,
        "prompt_snapshot": {
            "user_raw_text":          custom_prompt,
            "output_type":            output_type,
            "reference_strength":     reference_strength,
            "product_image_count":    product_count_requested,
            "reference_image_count":  reference_count_requested,
            "provider_endpoint":      provider_endpoint,
            "image_ordering":         image_input_order,
            "image_manifest":         image_manifest,
            "used_text_only_fallback": False if image_parts else provider_endpoint == "/images/generations",
            "products_loaded":        len(product_parts),
            "references_loaded":      loaded_references,
            "enhanced_prompt_plan":   enhancer_result.get("plan"),
            "enhanced_custom_prompt": enhanced_custom_prompt,
            "final_prompt":           final_prompt,
            "category_passed":        category_passed,
            "inferred_category":      inferred_category,
            "detected_category":      enhancer_result.get("detected_category"),
            "effective_category":     category,
            "enhancer_cache_key":     enhancer_result.get("cache_key"),
            "home_decor_check":       _home_decor_term_hits(final_prompt),
            "fashion_safety_applied": fashion_safety_applied,
            "enhancer_model":         enhancer_result.get("enhancer_model"),
            "enhancer_failed":        enhancer_result.get("enhancer_failed", not bool(enhancer_result)),
            "prompt_mode":            prompt_mode,
            "prompt_version":         prompt_version,
            "creative_direction_meta": creative_direction_meta,
            "generation_request_id":  generation_request_id,
            "requested_image_count":  requested_image_count,
            "actual_image_count":     actual_image_count,
            "count_clamped":          count_clamped,
            "output_count":           output_count,
            "variation_mode":         variation_mode,
            "output_variants":        output_variants,
            "created_at":             int(time.time()),
        },
    }


async def run(keyword: str, style: str, count: int) -> None:
    """Legacy CLI entry point (no image inputs)."""
    if not LINAPI_KEY:
        _emit({"ok": False, "error": "LINAPI_KEY not set in environment", "urls": [], "keyword": keyword})
        return

    style_pool = [style] + [s for s in STYLE_PROMPTS if s != style]
    styles     = [style_pool[i % len(style_pool)] for i in range(count)]

    tasks   = [_generate_one(keyword, s, i) for i, s in enumerate(styles)]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    urls   = [r for r in results if isinstance(r, str)]
    errors = [str(r) for r in results if isinstance(r, Exception)]

    _emit({
        "ok":     len(urls) > 0,
        "keyword": keyword,
        "style":   style,
        "count":   count,
        "urls":    urls,
        "errors":  errors if errors else None,
    })


def main() -> None:
    _force_utf8_streams()
    ap = argparse.ArgumentParser(description="VibePin keyword-to-image batch generator")
    ap.add_argument("--keyword",    default="",          help="Trend keyword (legacy CLI mode)")
    ap.add_argument("--style",      default="lifestyle",  help="Visual style preset")
    ap.add_argument("--count",      type=int, default=4,  help="Number of images to generate")
    ap.add_argument("--from-stdin", action="store_true",  help="Read full JSON payload from stdin (used by Next.js)")
    args = ap.parse_args()

    if args.from_stdin:
        asyncio.run(run_from_stdin())
    else:
        if not args.keyword:
            _emit({"ok": False, "error": "keyword is required (pass --keyword or use --from-stdin)", "urls": []})
            sys.exit(1)
        asyncio.run(run(args.keyword, args.style, args.count))


if __name__ == "__main__":
    main()
