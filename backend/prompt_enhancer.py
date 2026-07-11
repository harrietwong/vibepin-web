"""
backend/prompt_enhancer.py — Vision-to-Prompt enhancer for VibePin

Analyzes product + reference images using a vision-capable LLM to produce a
structured prompt plan before image generation.

Entry point:
    result = await enhance(
        product_image_urls=["data:image/jpeg;base64,...", ...],
        reference_image_urls=["https://..."],
        user_raw_text="cozy neutral tones",
        output_type="lifestyle",
        reference_strength="moderate",
        text_overlay=False,
        fmt="2:3",
        product_metadata=[{"title": "Ceramic Vase"}],
    )
    # result["final_prompt"] → ready-to-use generation prompt
    # result["enhancer_failed"] → True if VLM was skipped / timed out

Always returns; never raises. Falls back gracefully to the base prompt if the
VLM call fails, times out, or is not configured.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Optional

import httpx

# ── Config ────────────────────────────────────────────────────────────────────
ENHANCER_MODEL  = os.environ.get("OPENAI_PROMPT_ENHANCER_MODEL", "")
LINAPI_KEY      = os.environ.get("LINAPI_KEY", "")
LINAPI_BASE_URL = os.environ.get("LINAPI_BASE_URL", "https://api.openai.com/v1").rstrip("/")

CACHE_DIR  = Path(tempfile.gettempdir()) / "vibe_prompt_cache"
CACHE_TTL  = 6 * 3600   # 6 hours
MAX_PRODUCTS    = 4
MAX_REFERENCES  = 3
VLM_TIMEOUT_S   = 25.0  # tight — fail fast and fall back

# ── Analysis system prompt ────────────────────────────────────────────────────
_ANALYSIS_SYSTEM = """\
You are a Pinterest creative director. Analyze the provided product and reference \
images to plan a cohesive, aspirational Pinterest Pin. Return ONLY valid JSON with \
no markdown fencing, no preamble.

You will receive:
- Product images: the specific items that MUST appear prominently in the Pin
- Reference images: Pinterest Pins to borrow mood, lighting, and composition from \
  — do NOT recreate their exact scenes

Return exactly this JSON schema (all keys required):
{
  "product_constraints": [
    {
      "product_index": 1,
      "description": "concise visual description",
      "must_preserve": ["key visual properties: shape, color, material, finish, etc."]
    }
  ],
  "reference_style": {
    "scene_type": "e.g. overhead flat lay, fashion editorial, outfit styling board, styled surface, product showcase, tabletop layout",
    "lighting": "e.g. soft diffused natural light from left window",
    "mood": "e.g. warm, cozy, aspirational, editorial",
    "palette": ["2-4 dominant colors or hex values"],
    "composition": "e.g. centered hero, rule-of-thirds, diagonal flow",
    "visual_density": "minimal | moderately styled | richly layered",
    "styling_cues": ["specific styling elements worth borrowing, max 4"]
  },
  "scene_plan": "1-2 sentences describing the overall scene concept",
  "visual_prompt": "One rich paragraph (80-140 words) of creative direction for the image generator. Describe the scene, product placement, props, lighting, and mood concretely. Write as a direct instruction. Do not reference 'image 1', 'the reference', or 'as shown'.",
  "negative_constraints": ["up to 5 specific things to avoid in the output"],
  "summary_for_ui": {
    "scene": "2-4 word scene label",
    "style": "2-4 word style label",
    "layout": "2-4 word layout label",
    "products": "brief phrase describing how products are featured"
  }
}"""


# ── Deterministic final-prompt renderer ───────────────────────────────────────
_FASHION_IDS_ENHANCER = {"fashion", "womens-fashion", "mens-fashion", "kids-fashion"}
_FASHION_FORBIDDEN_REPLACEMENTS = {
    "bedroom": "fashion styling set",
    "living room": "fashion styling set",
    "interior": "fashion set",
    "room decor": "fashion styling",
    "cozy home": "warm editorial",
    "sofa": "styling prop",
    "bed": "accessory",
    "vase": "accessory prop",
    "wall art": "graphic accessory",
}


def _sanitize_fashion_prompt(text: str) -> str:
    out = text
    for old, new in _FASHION_FORBIDDEN_REPLACEMENTS.items():
        out = out.replace(old, new).replace(old.title(), new)
    return out


# ── Category detection from the VLM plan (the missing feedback loop) ───────────
# When the frontend loses the product category (Remix on an older pin, empty
# product metadata), the VLM still SAW the products. We read its own analysis to
# recover the real category so fashion/beauty/etc. guardrails can still fire.
_KNOWN_SPECIFIC_CATEGORIES = {
    "home-decor", "fashion", "womens-fashion", "mens-fashion", "kids-fashion",
    "beauty", "food-and-drink", "diy-crafts", "travel", "digital-products",
}
_PLAN_FASHION_HINTS = {
    "fashion", "apparel", "outfit", "clothing", "clothes", "garment", "wardrobe",
    "lookbook", "camisole", "lace top", "lace", "blouse", "shirt", "tee", "t-shirt",
    "dress", "skirt", "jeans", "denim", "pants", "trousers", "shorts", "jacket",
    "coat", "blazer", "knit", "sweater", "cardigan", "lingerie", "activewear",
    "swimwear", "bikini", "heels", "boots", "sneakers", "loafers", "handbag",
    "purse", "tote", "clutch", "scarf", "beanie", "sunglasses", "jewelry",
    "earrings", "necklace", "bracelet", "streetwear", "editorial fashion",
    "model wearing", "styled outfit", "ootd", "flat lay outfit",
}
_PLAN_BEAUTY_HINTS = {
    "beauty", "skincare", "skin care", "cosmetic", "cosmetics", "makeup", "serum",
    "moisturizer", "moisturiser", "cleanser", "toner", "lipstick", "lip gloss",
    "mascara", "foundation", "concealer", "blush", "sunscreen", "spf", "fragrance",
    "perfume", "nail polish", "vanity", "shelfie",
}
_PLAN_FOOD_HINTS = {
    "food", "drink", "recipe", "ingredient", "ingredients", "beverage", "coffee",
    "tea", "cocktail", "mocktail", "smoothie", "dessert", "bakery", "pastry",
    "meal", "snack", "dish", "plated", "charcuterie", "cuisine",
}
_PLAN_HOME_HINTS = {
    "home decor", "room decor", "interior", "living room", "bedroom", "nursery",
    "sofa", "couch", "armchair", "furniture", "vase", "candle", "candles",
    "throw blanket", "throw pillow", "rug", "wall art", "shelf styling",
    "tabletop decor", "vignette", "nightstand", "headboard", "duvet",
}
_PLAN_DIGITAL_HINTS = {
    "digital", "template", "printable", "planner", "mockup", "laptop", "tablet",
    "screen", "ebook", "e-book", "worksheet", "notion",
}
_PLAN_CRAFT_HINTS = {
    "diy", "craft", "handmade", "crochet", "knit", "knitting", "embroidery",
    "macrame", "yarn", "clay", "polymer clay", "resin", "scrapbook", "sewing",
    "quilt", "candle making", "soap making", "step by step", "tutorial", "how to make",
    "supplies", "materials", "work in progress", "wip", "craft kit",
}
_PLAN_TRAVEL_HINTS = {
    "travel", "destination", "wanderlust", "itinerary", "vacation", "trip",
    "landscape", "skyline", "cityscape", "beach", "mountains", "landmark",
    "passport", "luggage", "suitcase", "packing", "getaway", "scenic", "tropical",
}


def _score_hints(text: str, hints: set[str]) -> int:
    return sum(1 for h in hints if h in text)


def _detect_category_from_plan(plan: dict) -> str:
    """
    Infer the product category from the VLM's own analysis.

    Product descriptions (`product_constraints`) are authoritative — they describe
    the actual uploaded items. We only fall back to the scene / styling context
    when the product analysis carries no category signal (e.g. products failed to
    load and only a reference was analyzed).

    Returns a category id ("fashion", "home-decor", …) or "" when undetectable.
    """
    if not isinstance(plan, dict):
        return ""

    cat_hints = {
        "fashion":          _PLAN_FASHION_HINTS,
        "beauty":           _PLAN_BEAUTY_HINTS,
        "food-and-drink":   _PLAN_FOOD_HINTS,
        "home-decor":       _PLAN_HOME_HINTS,
        "diy-crafts":       _PLAN_CRAFT_HINTS,
        "travel":           _PLAN_TRAVEL_HINTS,
        "digital-products": _PLAN_DIGITAL_HINTS,
    }

    # 1. Authoritative: what the products actually are.
    product_chunks: list[str] = []
    for pc in (plan.get("product_constraints") or []):
        if isinstance(pc, dict):
            product_chunks.append(str(pc.get("description") or ""))
            mp = pc.get("must_preserve") or []
            if isinstance(mp, list):
                product_chunks.extend(str(x) for x in mp)
    product_text = " ".join(product_chunks).lower()
    if product_text.strip():
        scores = {cat: _score_hints(product_text, hints) for cat, hints in cat_hints.items()}
        best = max(scores, key=scores.get)
        if scores[best] > 0:
            return best

    # 2. Fallback: scene / styling context (reference + overall plan).
    context_chunks: list[str] = []
    ref = plan.get("reference_style") or {}
    if isinstance(ref, dict):
        context_chunks.append(str(ref.get("scene_type") or ""))
        context_chunks.append(str(ref.get("mood") or ""))
        sc = ref.get("styling_cues") or []
        if isinstance(sc, list):
            context_chunks.extend(str(x) for x in sc)
    context_chunks.append(str(plan.get("scene_plan") or ""))
    context_chunks.append(str(plan.get("visual_prompt") or ""))
    sui = plan.get("summary_for_ui") or {}
    if isinstance(sui, dict):
        context_chunks.extend(str(v) for v in sui.values())
    context_text = " ".join(context_chunks).lower()
    if context_text.strip():
        scores = {cat: _score_hints(context_text, hints) for cat, hints in cat_hints.items()}
        best = max(scores, key=scores.get)
        if scores[best] > 0:
            return best

    return ""


def _resolve_effective_category(incoming_category: str, plan: dict | None) -> tuple[str, str]:
    """
    Decide the category used to render the final prompt.

    - A specific incoming category (from the frontend) is trusted as-is.
    - An empty / "generic" / unknown incoming category is upgraded using the VLM
      plan, so fashion/beauty guardrails fire even when the frontend lost it.

    Returns (effective_category, detected_category). detected_category is "" when
    no detection was attempted or nothing was found.
    """
    incoming = (incoming_category or "").lower().strip()
    if incoming in _KNOWN_SPECIFIC_CATEGORIES:
        return incoming, ""
    detected = _detect_category_from_plan(plan or {})
    return (detected or incoming), detected


def _render_final_prompt(
    plan: dict,
    output_type: str,
    user_raw_text: Optional[str],
    text_overlay: bool,
    fmt: str,
    reference_strength: str,
    category: str = "",
) -> str:
    """
    Combine plan fields into a single generation prompt string.
    Deterministic — same inputs always produce the same output.
    """
    parts: list[str] = []

    # 0. Fashion safety — must come first to override any interior-biased VLM output
    cat = (category or "").lower().strip()
    if cat in _FASHION_IDS_ENHANCER:
        parts.append(
            "FASHION CATEGORY: These are fashion/apparel products. "
            "The composition MUST be fashion-appropriate: outfit styling, wardrobe flat lay, "
            "fashion editorial, lookbook image, or fashion lifestyle scene. "
            "Use apparel/accessory styling context only; avoid non-fashion environments."
        )

    # 1. Core visual direction from VLM
    vp = (plan.get("visual_prompt") or "").strip()
    if vp:
        parts.append(vp)

    # 2. Product fidelity constraints
    constraints = plan.get("product_constraints") or []
    if constraints:
        frags: list[str] = []
        for pc in constraints:
            preserve = ", ".join(pc.get("must_preserve") or [])
            desc     = (pc.get("description") or "").strip()
            idx      = pc.get("product_index", "?")
            line     = f"Product {idx}: {desc}"
            if preserve:
                line += f" — preserve {preserve}"
            frags.append(line + ".")
        parts.append("PRODUCT FIDELITY — " + " ".join(frags))

    # 3. Reference style translation
    ref = plan.get("reference_style") or {}
    if ref:
        cues: list[str] = []
        if ref.get("lighting"):
            cues.append(f"lighting: {ref['lighting']}")
        if ref.get("mood"):
            cues.append(f"mood: {ref['mood']}")
        if ref.get("composition"):
            cues.append(f"composition: {ref['composition']}")
        sc = ref.get("styling_cues") or []
        if sc:
            cues.append(f"styling: {', '.join(sc[:3])}")
        if cues:
            verb = {
                "strong":   "Closely follow",
                "moderate": "Draw inspiration from",
                "light":    "Loosely inspired by",
            }.get(reference_strength, "Draw inspiration from")
            anti_copy = "Create an original image; do not duplicate the reference framing."
            if cat in _FASHION_IDS_ENHANCER:
                anti_copy = "Create an original fashion image; do not duplicate the reference framing."
            parts.append(f"{verb} the reference aesthetic — {'; '.join(cues)}. {anti_copy}")

    # 4. User's additional direction
    uraw = (user_raw_text or "").strip()
    if uraw:
        parts.append(f"Additional creative direction: {uraw}")

    # 5. Output type context
    if output_type:
        parts.append(f"Pin type: {output_type}.")

    # 6. Hard constraints (always appended)
    hard: list[str] = [
        "CRITICAL: Products are the primary subjects — they must be clearly recognizable.",
        "No watermarks.",
    ]
    if cat in _FASHION_IDS_ENHANCER:
        hard.append(
            "HARD CONSTRAINT: If the selected products are fashion/apparel, do NOT convert "
            "the scene into home decor, bedroom styling, candles, vases, bottles, furniture, "
            "or interior still life unless the user explicitly asked for that. The apparel/"
            "accessory items remain the hero subjects."
        )
    if text_overlay:
        hard.append(
            "TYPOGRAPHY: Add the exact text the user requested as a clean, "
            "readable Pinterest-native overlay. Keep typography minimal, "
            "well-composed, and legible. No watermarks."
        )
    else:
        hard.append(
            "ZERO TEXT RULE: absolutely no text, words, letters, numbers, labels, "
            "captions, watermarks, logos, or typography anywhere in the image."
        )
    hard.append(f"Aspect ratio: {fmt or '2:3'}. Photorealistic, ultra-detailed.")

    neg = plan.get("negative_constraints") or []
    for n in neg[:4]:
        n = (n or "").strip()
        if n and len(n) < 120:
            hard.append(f"Avoid: {n}.")

    # Sanitize ONLY the VLM-derived dynamic content (which can drift toward interior
    # language). The fixed hard-constraint block is authored to deliberately name
    # home-decor items in a negative instruction, so it must NOT be word-replaced.
    dynamic = "\n\n".join(p for p in parts if p)
    if cat in _FASHION_IDS_ENHANCER:
        dynamic = _sanitize_fashion_prompt(dynamic)

    final = dynamic + ("\n\n" if dynamic else "") + " ".join(hard)
    return final


# ── Cache ─────────────────────────────────────────────────────────────────────
def _cache_key(
    product_urls:     list[str],
    ref_urls:         list[str],
    product_metadata: Optional[list[dict]] = None,
    output_type:      str = "",
    category:         str = "",
) -> str:
    """
    Stable fingerprint based on image content + product titles + rendering context.
    output_type and category are included because they affect how the cached plan is
    rendered into the final prompt — a cached home-decor plan must NOT be reused for
    a fashion generation (different category → different final_prompt).
    """
    h = hashlib.sha256()
    for u in product_urls:
        sample = (u[:2000] + str(len(u))).encode("utf-8", errors="replace")
        h.update(sample)
    h.update(b"||refs||")
    for u in ref_urls:
        sample = (u[:2000] + str(len(u))).encode("utf-8", errors="replace")
        h.update(sample)
    if product_metadata:
        h.update(b"||meta||")
        for meta in product_metadata:
            title = (meta.get("title") or "").encode("utf-8", errors="replace")
            h.update(title)
    h.update(b"||otype||")
    h.update((output_type or "").encode("utf-8", errors="replace"))
    h.update(b"||cat||")
    h.update((category or "").encode("utf-8", errors="replace"))
    return h.hexdigest()[:20]


def _load_cache(key: str) -> Optional[dict]:
    p = CACHE_DIR / f"{key}.json"
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if time.time() - data.get("_ts", 0) > CACHE_TTL:
            p.unlink(missing_ok=True)
            return None
        return data["payload"]
    except Exception:
        return None


def _save_cache(key: str, payload: dict) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        (CACHE_DIR / f"{key}.json").write_text(
            json.dumps({"_ts": time.time(), "payload": payload}, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception:
        pass  # non-fatal


# ── VLM call ──────────────────────────────────────────────────────────────────
async def _call_vlm(
    product_images: list[str],
    reference_images: list[str],
    user_raw_text: Optional[str],
    product_metadata: Optional[list[dict]],
) -> dict:
    """
    Call vision-capable chat completions. Returns parsed plan dict.
    Raises on any failure — caller wraps in try/except.
    """
    content: list[dict] = []

    # Log image counts and types for debugging
    p_data = sum(1 for u in product_images  if u.startswith("data:"))
    p_http = sum(1 for u in product_images  if not u.startswith("data:"))
    r_data = sum(1 for u in reference_images if u.startswith("data:"))
    r_http = sum(1 for u in reference_images if not u.startswith("data:"))
    print(
        f"[enhancer._call_vlm] products={len(product_images)} "
        f"(data-url={p_data} https={p_http})  "
        f"refs={len(reference_images)} "
        f"(data-url={r_data} https={r_http})  "
        f"model={ENHANCER_MODEL}",
        file=sys.stderr,
    )

    # Announce and add product images
    if product_images:
        n = len(product_images)
        content.append({
            "type": "text",
            "text": (
                f"The following {n} image{'s' if n > 1 else ''} show the "
                f"product{'s' if n > 1 else ''} that MUST appear in the Pin:"
            ),
        })
        for i, img in enumerate(product_images):
            meta  = ((product_metadata or [])[i] if i < len(product_metadata or []) else None) or {}
            label = meta.get("title") or f"Product {i + 1}"
            content.append({"type": "text", "text": f"[{label}]"})
            content.append({"type": "image_url", "image_url": {"url": img, "detail": "low"}})

    # Announce and add reference images
    if reference_images:
        n = len(reference_images)
        content.append({
            "type": "text",
            "text": (
                f"The following {n} image{'s' if n > 1 else ''} are Pinterest Pin "
                f"references for style/mood/composition inspiration only. "
                "Do NOT recreate these exact scenes:"
            ),
        })
        for i, img in enumerate(reference_images):
            content.append({"type": "text", "text": f"[Reference {i + 1}]"})
            content.append({"type": "image_url", "image_url": {"url": img, "detail": "low"}})

    # Final instruction + optional user direction
    instr = "Analyze all images and return the JSON plan as specified in your system prompt."
    uraw  = (user_raw_text or "").strip()
    if uraw:
        instr += f' Incorporate this user creative direction: "{uraw}"'
    content.append({"type": "text", "text": instr})

    payload: dict = {
        "model":    ENHANCER_MODEL,
        "messages": [
            {"role": "system", "content": _ANALYSIS_SYSTEM},
            {"role": "user",   "content": content},
        ],
        "max_tokens":       1200,
        "temperature":      0.3,
        "response_format":  {"type": "json_object"},
    }

    async with httpx.AsyncClient(timeout=VLM_TIMEOUT_S) as client:
        r = await client.post(
            f"{LINAPI_BASE_URL}/chat/completions",
            json=payload,
            headers={
                "Authorization": f"Bearer {LINAPI_KEY}",
                "Content-Type":  "application/json",
            },
        )
        r.raise_for_status()

    data        = r.json()
    raw_content = data["choices"][0]["message"]["content"].strip()

    # Strip markdown fencing — some proxies add it despite response_format
    if raw_content.startswith("```"):
        lines = raw_content.split("\n")
        raw_content = "\n".join(lines[1:])
        if raw_content.endswith("```"):
            raw_content = raw_content[:-3].strip()

    return json.loads(raw_content)


# ── Fallback ──────────────────────────────────────────────────────────────────
# Category-aware base lines for the fallback path (VLM unavailable). Never reuse a
# single universal template — keep the scene anchored to the real product type.
_FALLBACK_CATEGORY_TEMPLATES = {
    "fashion": (
        "Create a Pinterest-native fashion product Pin featuring the selected apparel/"
        "accessory items as the hero subjects — styled as an outfit, flat lay, or fashion "
        "editorial. Do NOT turn the scene into home decor, candles, vases, or interior styling."
    ),
    "home-decor": (
        "Create a Pinterest-native home decor Pin featuring the selected decor products, "
        "naturally styled within a cohesive interior or shelf vignette."
    ),
    "beauty": (
        "Create a Pinterest-native beauty product Pin featuring the selected beauty/skincare "
        "items as the hero subjects in a clean vanity or shelfie composition."
    ),
    "food-and-drink": (
        "Create a Pinterest-native food & drink Pin featuring the selected items styled as an "
        "appetizing serving, recipe, or ingredient composition."
    ),
    "diy-crafts": (
        "Create a Pinterest-native DIY & crafts Pin featuring the selected handmade items "
        "or supplies as the hero subjects — styled as a finished project, materials flat lay, "
        "or step-by-step make. Keep handmade texture and instructional clarity."
    ),
    "travel": (
        "Create a Pinterest-native travel Pin leading with an aspirational destination scene "
        "or evocative travel detail; place any selected items naturally within the travel context."
    ),
    "digital-products": (
        "Create a Pinterest-native digital product Pin presenting the selected assets as "
        "screen/printable mockups in a realistic desk or device context."
    ),
}


def _fallback_result(
    user_raw_text: Optional[str],
    text_overlay:  bool,
    fmt:           str,
    reason:        str,
    category:      str = "",
) -> dict:
    """Minimal prompt from available context when VLM is unavailable.

    Category-aware: the base line is chosen by product category so a fashion batch
    never inherits a home-decor / generic scene template.
    """
    parts: list[str] = []
    cat = (category or "").lower().strip()
    if cat in _FASHION_IDS_ENHANCER:
        cat = "fashion"
    base = _FALLBACK_CATEGORY_TEMPLATES.get(cat)
    if base:
        parts.append(base)
    uraw = (user_raw_text or "").strip()
    if uraw:
        parts.append(uraw)
    hard = [
        "Products are the primary subjects — keep them clearly recognizable.",
        "No watermarks.",
    ]
    if text_overlay:
        hard.append(
            "TYPOGRAPHY: Add the exact text the user requested as a clean, "
            "readable Pinterest-native overlay. Keep typography minimal and legible."
        )
    else:
        hard.append("ZERO TEXT RULE: no text, words, letters, typography, or overlays of any kind.")
    hard.append(f"Aspect ratio: {fmt or '2:3'}.")
    parts.append(" ".join(hard))

    final_prompt = "\n\n".join(p for p in parts if p)
    if cat == "fashion":
        final_prompt = _sanitize_fashion_prompt(final_prompt)

    return {
        "plan":               None,
        "final_prompt":       final_prompt,
        "enhancer_failed":    True,
        "cache_hit":          False,
        "enhancer_model":     ENHANCER_MODEL or "none",
        "fallback_reason":    reason,
        "detected_category":  "",
        "effective_category": cat,
    }


# ── Main entry point ──────────────────────────────────────────────────────────
async def enhance(
    product_image_urls:  list[str],
    reference_image_urls: list[str],
    user_raw_text:        Optional[str]        = None,
    output_type:          str                  = "lifestyle",
    reference_strength:   str                  = "moderate",
    text_overlay:         bool                 = False,
    fmt:                  str                  = "2:3",
    product_metadata:     Optional[list[dict]] = None,
    category:             str                  = "",
) -> dict:
    """
    Analyze product + reference images and return an enhanced prompt plan.

    Returns a dict with keys:
      plan:             dict | None      — structured VLM analysis (None on fallback)
      final_prompt:     str              — ready-to-use generation prompt
      enhancer_failed:  bool             — True when VLM was skipped or failed
      cache_hit:        bool
      enhancer_model:   str
      fallback_reason:  str | absent     — only present on failure

    Never raises. Always returns a usable final_prompt.
    """
    if not ENHANCER_MODEL:
        print("[enhancer] OPENAI_PROMPT_ENHANCER_MODEL not set — skipping", file=sys.stderr)
        return _fallback_result(user_raw_text, text_overlay, fmt, "model_not_configured")

    if not LINAPI_KEY:
        print("[enhancer] LINAPI_KEY not set — skipping", file=sys.stderr)
        return _fallback_result(user_raw_text, text_overlay, fmt, "api_key_not_set")

    prod_limited = product_image_urls[:MAX_PRODUCTS]
    ref_limited  = reference_image_urls[:MAX_REFERENCES]

    if not prod_limited and not ref_limited:
        print("[enhancer] no images to analyze — skipping", file=sys.stderr)
        return _fallback_result(user_raw_text, text_overlay, fmt, "no_images")

    # ── Cache check ───────────────────────────────────────────────────────────
    ckey   = _cache_key(prod_limited, ref_limited, product_metadata, output_type, category)
    cached = _load_cache(ckey)
    if cached:
        # Re-detect category from the cached plan so the guardrail still applies even
        # when the frontend sent an empty/generic category for this cached analysis.
        effective_category, detected_category = _resolve_effective_category(category, cached)
        final_prompt = _render_final_prompt(
            cached, output_type, user_raw_text, text_overlay, fmt, reference_strength, effective_category
        )
        print(
            f"[enhancer] ✓ cache hit ({ckey[:8]}…) "
            f"category in={category!r} detected={detected_category!r} effective={effective_category!r}",
            file=sys.stderr,
        )
        return {
            "plan":               cached,
            "final_prompt":       final_prompt,
            "enhancer_failed":    False,
            "cache_hit":          True,
            "cache_key":          ckey,
            "enhancer_model":     ENHANCER_MODEL,
            "detected_category":  detected_category,
            "effective_category": effective_category,
        }

    # ── VLM call ──────────────────────────────────────────────────────────────
    t0 = time.time()
    try:
        plan    = await _call_vlm(prod_limited, ref_limited, user_raw_text, product_metadata)
        elapsed = round(time.time() - t0, 1)
        # Feedback loop: the VLM saw the products — recover the real category from its
        # analysis when the frontend didn't send a specific one.
        effective_category, detected_category = _resolve_effective_category(category, plan)
        print(
            f"[enhancer] ✓ analysis complete in {elapsed}s "
            f"— model={ENHANCER_MODEL} products={len(prod_limited)} refs={len(ref_limited)} "
            f"category in={category!r} detected={detected_category!r} effective={effective_category!r}",
            file=sys.stderr,
        )
        _save_cache(ckey, plan)
        final_prompt = _render_final_prompt(
            plan, output_type, user_raw_text, text_overlay, fmt, reference_strength, effective_category
        )
        return {
            "plan":               plan,
            "final_prompt":       final_prompt,
            "enhancer_failed":    False,
            "cache_hit":          False,
            "cache_key":          ckey,
            "enhancer_model":     ENHANCER_MODEL,
            "detected_category":  detected_category,
            "effective_category": effective_category,
        }
    except Exception as exc:
        elapsed = round(time.time() - t0, 1)
        reason  = f"{type(exc).__name__}: {str(exc)[:150]}"
        print(f"[enhancer] ✗ VLM call failed after {elapsed}s — {reason}", file=sys.stderr)
        return _fallback_result(user_raw_text, text_overlay, fmt, reason, category)
