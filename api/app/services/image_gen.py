"""
Step 2 — VibePin Batch Image Generator.

LinAPI Gemini Image Preview (official):
  POST https://api.* /v1beta/models/{model}:generateContent
See LinAPI doc: contents[].parts (text + optional inlineData), generationConfig.imageConfig
(aspectRatio, imageSize), response candidates[].content.parts[].inlineData.

Fallback: OpenAI-compatible chat completions (markdown image) or /v1/images/generations.
"""
import asyncio
import base64
import io
import random
import re
from dataclasses import dataclass

import httpx
from openai import APIStatusError, AsyncOpenAI
from PIL import Image
from app.core.config import get_settings

# ─── 12 Style Preset Library ──────────────────────────────────────────────────
# All prompts include "实拍感" parameters as required.
# Placeholders {materials}, {colors}, {vibe} are filled in at runtime from analysis.

STYLE_PRESETS: dict[str, str] = {
    "Afrohemian": (
        "Afrohemian interior style. Richly dyed kente and mud-cloth textiles draped over "
        "carved organic wood furniture. Handwoven baskets, terracotta pottery. "
        "Earthy neutrals — ochre, sienna, clay — with deep emerald accents. "
        "The {product_desc} sits naturally within the scene. "
        "Warm, soulful natural window light from the side. "
        "35mm lens, f/2.8, architectural photography, natural light, photorealistic."
    ),
    "Neo Deco": (
        "Sleek Neo Deco interior. Polished brass fixtures, marble surfaces, "
        "deep-tufted velvet upholstery. Moody palette of deep burgundy, chocolate brown, and gold. "
        "Arched geometry and Gatsby-meets-space-age forms. "
        "The {product_desc} is placed as the focal statement piece. "
        "Dramatic low-key ambient lighting. "
        "35mm lens, f/2.8, architectural photography, natural light, photorealistic."
    ),
    "Dopamine Decor": (
        "Vibrant maximalist dopamine decor interior. Saturated citrus yellow, coral pink, "
        "and electric blue tones. Playful pattern mixing — bold stripes meet oversized florals. "
        "The {product_desc} pops with energy in the joyful, high-energy scene. "
        "Crisp, bright studio-style lighting. "
        "35mm lens, f/2.8, architectural photography, natural light, photorealistic."
    ),
    "Opera Aesthetic": (
        "Theatrical Opera Aesthetic interior. Heavy jewel-toned velvet drapery in plum and ruby. "
        "Dim candle-like amber lighting, dramatic deep shadows. Moody, romantic, luxurious. "
        "Gilded picture frames and brass accents throughout. "
        "The {product_desc} glows in the candlelight as the room's dramatic centerpiece. "
        "35mm lens, f/2.8, architectural photography, natural light, photorealistic."
    ),
    "Soft Geometry": (
        "Minimalist Soft Geometry interior. Curvaceous boucle furniture with scalloped edges "
        "and circular motifs. Limewash walls in the softest sage and ivory. "
        "Morning light streaming through arched windows. Serene, tactile, sculptural. "
        "The {product_desc} sits in perfect harmony with the gentle organic forms. "
        "35mm lens, f/2.8, architectural photography, natural light, photorealistic."
    ),
    "Biophilic Design": (
        "Biophilic indoor jungle interior. Abundant lush tropical greenery — monstera, palms, "
        "trailing pothos vines. Unfinished stone walls, reclaimed wood shelving. "
        "Dappled golden sunlight filtering through the canopy of leaves. "
        "The {product_desc} nestles naturally among the organic materials. "
        "Fresh, breathing, airy atmosphere. "
        "35mm lens, f/2.8, architectural photography, natural light, photorealistic."
    ),
    "Extra Celestial": (
        "Futuristic Extra Celestial interior. High-shine chrome and metallic surfaces, "
        "iridescent holographic accents, subtle neon-glow edge lighting in soft violet and cyan. "
        "Space-age pod furniture with cool alabaster tones. "
        "The {product_desc} reflects the cosmic, otherworldly environment. "
        "Cool-toned cinematic lighting, long shadows. "
        "35mm lens, f/2.8, architectural photography, natural light, photorealistic."
    ),
    "Cabbagecore": (
        "Whimsical Cabbagecore cottage interior. Soft sage and celery greens everywhere — "
        "ruffled linen cushions, quirky ceramic vegetable figurines, pressed botanical prints. "
        "English cottage garden charm with a playful, storybook quality. "
        "The {product_desc} fits perfectly in this charming, cozy nook. "
        "Soft diffused morning sunlight. "
        "35mm lens, f/2.8, architectural photography, natural light, photorealistic."
    ),
    "Heritage": (
        "Heritage classic interior. Dark polished walnut and mahogany furniture, "
        "oil paintings in ornate frames, leather-bound books on shelves. "
        "Persian rugs, antique brass hardware, aged patina everywhere. "
        "The {product_desc} is presented as a timeless heirloom piece. "
        "Soft, warm library-style lighting from a reading lamp. "
        "35mm lens, f/2.8, architectural photography, natural light, photorealistic."
    ),
    "Moody Color Drenching": (
        "Moody Color Drenching interior — tone-on-tone saturated immersion. "
        "Walls, ceiling, furniture, and trim all in one deep {dominant_color} shade. "
        "High contrast between light and shadow creates architectural drama. "
        "The {product_desc} commands attention against the saturated monochrome backdrop. "
        "Single dramatic window light source. "
        "35mm lens, f/2.8, architectural photography, natural light, photorealistic."
    ),
    "Scandinavian Loft": (
        "Scandinavian Loft interior. Minimalist light oak wood floors, crisp white linen, "
        "warm abundant natural sunlight. Clean functional forms, no clutter. "
        "Subtle organic textures — wool, rattan, ceramic. "
        "The {product_desc} is styled with effortless simplicity. "
        "Airy, professional, IKEA-high-end aesthetic. "
        "35mm lens, f/2.8, architectural photography, natural light, photorealistic."
    ),
    "Mid-Century Modern": (
        "Mid-Century Modern retro interior. Rich walnut furniture with tapered hairpin legs, "
        "mustard yellow and burnt orange accent cushions, avocado green side tables. "
        "Geometric patterned rug, sunburst wall clock. "
        "The {product_desc} anchors the warm, retro-70s composition. "
        "Warm sunset light, subtle film grain. "
        "35mm lens, f/2.8, architectural photography, natural light, photorealistic."
    ),
}

STYLE_NAMES = list(STYLE_PRESETS.keys())


# ─── Result dataclass ─────────────────────────────────────────────────────────

@dataclass
class GeneratedImage:
    style_name: str
    img_2x3_bytes: bytes   # decoded source raster from API (any aspect ratio → stored as PNG)
    img_1x1_bytes: bytes   # 1080×1080 PNG (center-crop)
    is_best_match: bool    # True for the AI-selected best style


# ─── Prompt builder ───────────────────────────────────────────────────────────

def _build_prompt(style_name: str, analysis: dict, product_title: str) -> str:
    """Inject product aesthetic data into the style template."""
    materials = ", ".join(analysis.get("materials", ["mixed materials"]))
    colors = ", ".join(analysis.get("colors", ["neutral tones"]))
    vibe = ", ".join(analysis.get("vibe", ["contemporary"]))
    dominant_color = analysis.get("colors", ["deep teal"])[0]

    # Short product description for in-prompt reference
    product_desc = f"home decor item ({product_title})" if product_title else "home decor piece"
    if materials:
        product_desc += f" made of {materials}"

    template = STYLE_PRESETS[style_name]
    prompt = template.format(
        product_desc=product_desc,
        dominant_color=dominant_color,
    )

    # Append aesthetic fingerprint from analysis
    prompt += (
        f"\nProduct materials present in scene: {materials}. "
        f"Color palette: {colors}. "
        f"Overall mood: {vibe}. "
        "Ultra-detailed, high-resolution, photorealistic, no text, no watermarks."
    )
    return prompt


def _mime_for_bytes(img_bytes: bytes) -> str:
    if img_bytes[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if img_bytes[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if len(img_bytes) >= 12 and img_bytes[:4] == b"RIFF" and img_bytes[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"


def _api_origin_from_linapi_base() -> str:
    """LINAPI_BASE_URL often ends with /v1; :generateContent lives under /v1beta on same host."""
    base = get_settings().linapi_base_url.rstrip("/")
    if base.endswith("/v1"):
        return base[:-3]
    return base


def _effective_linapi_image_size(model: str, configured: str) -> str:
    """Doc: model suffix -2K/-4K should align with imageSize."""
    ml = model.lower()
    if ml.endswith("-4k"):
        return "4K"
    if ml.endswith("-2k"):
        return "2K"
    cfg = (configured or "1K").strip().upper()
    if cfg in ("1K", "2K", "4K"):
        return cfg
    return "1K"


def _linapi_uses_native_generate_content(model: str) -> bool:
    """LinAPI PDF: gemini-3.* … image … preview → :generateContent."""
    m = model.lower()
    if "dall-e" in m or "gpt-image" in m:
        return False
    return "gemini-3" in m and "image" in m and "preview" in m


def _linapi_generate_content_url(model: str) -> str:
    origin = _api_origin_from_linapi_base()
    return f"{origin}/v1beta/models/{model}:generateContent"


def _build_linapi_generate_content_body(
    prompt: str,
    reference_images: list[bytes] | None,
    aspect_ratio: str,
    image_size: str,
) -> dict:
    parts: list[dict] = [{"text": prompt}]
    for img in (reference_images or [])[:14]:
        parts.append(
            {
                "inlineData": {
                    "mimeType": _mime_for_bytes(img),
                    "data": base64.b64encode(img).decode("utf-8"),
                },
            }
        )
    return {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "imageConfig": {
                "aspectRatio": aspect_ratio,
                "imageSize": image_size,
            },
        },
    }


def _bytes_from_linapi_generate_content_json(data: dict) -> bytes | None:
    for cand in data.get("candidates") or []:
        content = cand.get("content") or {}
        for part in content.get("parts") or []:
            inline = part.get("inlineData")
            if isinstance(inline, dict):
                b64 = inline.get("data")
                if b64:
                    return base64.b64decode(b64)
    return None


async def _linapi_generate_content_image(
    model: str,
    prompt: str,
    reference_images: list[bytes] | None,
) -> bytes:
    settings = get_settings()
    url = _linapi_generate_content_url(model)
    image_size = _effective_linapi_image_size(model, settings.linapi_image_size)
    body = _build_linapi_generate_content_body(
        prompt,
        reference_images,
        settings.linapi_image_aspect_ratio,
        image_size,
    )
    headers = {
        "Authorization": f"Bearer {settings.linapi_key}",
        "Content-Type": "application/json",
    }
    for attempt in range(4):
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(300.0),
            follow_redirects=True,
        ) as client:
            r = await client.post(url, headers=headers, json=body)
            if r.status_code == 429 and attempt < 3:
                await asyncio.sleep(18.0 * (attempt + 1))
                continue
            r.raise_for_status()
            payload = r.json()
        out = _bytes_from_linapi_generate_content_json(payload)
        if out:
            return out
        raise ValueError("LinAPI generateContent returned no inlineData in candidates")
    raise RuntimeError("LinAPI generateContent failed after retries")  # pragma: no cover


def _model_prefers_chat_completions(model: str) -> bool:
    """Gemini image models on LinAPI-style proxies map to chat, not images.generate."""
    m = model.lower()
    if "dall-e" in m or "gpt-image" in m:
        return False
    return any(
        needle in m
        for needle in (
            "image-preview",
            "flash-image",
            "flash-preview-image",
            "pro-image",
            "image-generation",
            "image_generation",
        )
    )


def _assistant_text(message) -> str:
    """Normalize assistant message.content to plain text."""
    c = message.content
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        chunks: list[str] = []
        for p in c:
            if isinstance(p, dict) and p.get("type") == "text":
                chunks.append(str(p.get("text") or ""))
        return "\n".join(chunks)
    return str(c or "")


async def _download_or_decode_image_ref(url: str) -> bytes:
    url = url.strip()
    if url.startswith("data:"):
        i = url.find("base64,")
        if i < 0:
            raise ValueError("data URI missing base64 payload")
        b64 = re.sub(r"\s+", "", url[i + 7 :])
        return base64.b64decode(b64)
    async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as http:
        r = await http.get(url)
        r.raise_for_status()
        return r.content


async def _image_bytes_from_assistant_message(message) -> bytes:
    """Extract first image returned by Gemini-style chat responses."""
    c = message.content
    if isinstance(c, list):
        for p in c:
            if not isinstance(p, dict):
                continue
            if p.get("type") == "image_url":
                nested = p.get("image_url") or {}
                u = nested.get("url") if isinstance(nested, dict) else None
                if u:
                    return await _download_or_decode_image_ref(u)

    text = _assistant_text(message)
    if not text.strip():
        raise ValueError("empty assistant content")

    m = re.search(r"data:image/[^;]+;base64,([A-Za-z0-9+/=\s\n]+)", text, re.I | re.S)
    if m:
        raw = re.sub(r"\s+", "", m.group(1))
        return base64.b64decode(raw)

    for pattern in (
        r"!\[[^\]]*\]\((https?://[^)\s]+)\)",
        r"!\[[^\]]*\]\((data:image/[^\)]+\))",
        r"(https?://[^\s\)]+\.(?:png|jpg|jpeg|webp)(?:\?[^)\s]*)?)",
    ):
        um = re.search(pattern, text, re.I)
        if um:
            return await _download_or_decode_image_ref(um.group(1))

    raise ValueError("no image URL or base64 payload found in chat response")


def _chat_user_message_content(prompt: str, reference_images: list[bytes] | None) -> list[dict]:
    """Multimodal user message (LinAPI Gemini Image Preview „Chat格式“)."""
    instructions = (
        "\n\n— Image task — Generate exactly ONE photorealistic interior lifestyle photograph "
        "matching the brief above. The product references (if attached) depict the merchandise; "
        "integrate faithfully. "
        "Output a single markdown image line: ![](<url>) or ![](data:image/...;base64,...); "
        "no other explanatory text."
    )
    parts: list[dict] = [{"type": "text", "text": prompt + instructions}]
    for img in (reference_images or [])[:4]:
        b64 = base64.b64encode(img).decode()
        mime = _mime_for_bytes(img)
        parts.append(
            {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
        )
    return parts


async def _chat_image_with_retries(
    client: AsyncOpenAI,
    model: str,
    prompt: str,
    reference_images: list[bytes] | None,
) -> bytes:
    messages = [
        {"role": "user", "content": _chat_user_message_content(prompt, reference_images)},
    ]
    for attempt in range(4):
        try:
            resp = await client.chat.completions.create(
                model=model,
                messages=messages,
                stream=False,
                temperature=0.35,
                max_tokens=8192,
            )
            msg = resp.choices[0].message
            return await _image_bytes_from_assistant_message(msg)
        except APIStatusError as e:
            if e.status_code == 429 and attempt < 3:
                await asyncio.sleep(18.0 * (attempt + 1))
                continue
            raise


def _image_model_candidates() -> list[str]:
    s = get_settings()
    chunks: list[str] = []
    chunks.append(s.linapi_image_model)
    chunks.extend(part.strip() for part in s.linapi_image_model_fallback.split(",") if part.strip())
    seen: set[str] = set()
    out: list[str] = []
    for m in chunks:
        if m not in seen:
            seen.add(m)
            out.append(m)
    return out


async def _images_generate_with_retries(
    client: AsyncOpenAI,
    model: str,
    prompt: str,
) -> object:
    """POST /images/generations; retry a few times on LinAPI rate limits (429)."""
    for attempt in range(4):
        try:
            return await client.images.generate(
                model=model,
                prompt=prompt,
                size="1024x1536",
                n=1,
            )
        except APIStatusError as e:
            if e.status_code == 429 and attempt < 3:
                await asyncio.sleep(18.0 * (attempt + 1))
                continue
            raise


# ─── Single image call ────────────────────────────────────────────────────────

async def _generate_one(
    style_name: str,
    analysis: dict,
    product_title: str,
    semaphore: asyncio.Semaphore,
    reference_images: list[bytes] | None = None,
) -> GeneratedImage:
    """
    One style variant. LinAPI Gemini 3 Image Preview: native :generateContent; then chat/images fallback.
    """
    settings = get_settings()
    client = AsyncOpenAI(
        api_key=settings.linapi_key,
        base_url=settings.linapi_base_url,
    )
    prompt = _build_prompt(style_name, analysis, product_title)

    models = _image_model_candidates()
    async with semaphore:
        img_bytes: bytes | None = None
        last_err: BaseException | None = None
        for model in models:
            img_bytes = None
            try:
                if _linapi_uses_native_generate_content(model):
                    try:
                        img_bytes = await _linapi_generate_content_image(
                            model, prompt, reference_images
                        )
                    except ValueError as ve:
                        last_err = ve
                        continue
                elif _model_prefers_chat_completions(model):
                    try:
                        img_bytes = await _chat_image_with_retries(
                            client, model, prompt, reference_images
                        )
                    except ValueError as ve:
                        last_err = ve
                        continue
                else:
                    response = await _images_generate_with_retries(client, model, prompt)
                    data = response.data[0]
                    if data.b64_json:
                        img_bytes = base64.b64decode(data.b64_json)
                    else:
                        async with httpx.AsyncClient(timeout=120.0) as http:
                            r = await http.get(data.url)
                            r.raise_for_status()
                            img_bytes = r.content
                break
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 429:
                    raise
                last_err = e
                continue
            except APIStatusError as e:
                if e.status_code == 429:
                    raise
                txt = getattr(e.response, "text", "") or str(e.body) or ""
                if e.status_code in (400, 500, 503) and (
                    "not supported model" in txt
                    or "convert_request_failed" in txt
                    or "model_not_found" in txt
                ):
                    last_err = e
                    continue
                raise
            except Exception as e:  # noqa: BLE001
                es = str(e).lower()
                if (
                    "not supported model" in es
                    or "convert_request_failed" in es
                    or "model_not_found" in es
                ):
                    last_err = e
                    continue
                raise

        if img_bytes is None:
            if last_err is None:
                raise RuntimeError("image generation failed with no captured error")  # pragma: no cover
            raise last_err

    # Derive 1:1 via center square crop (chat API may return arbitrary aspect ratio)
    portrait = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    w, h = portrait.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    square = portrait.crop((left, top, left + side, top + side)).resize(
        (1080, 1080), Image.LANCZOS
    )
    buf = io.BytesIO()
    square.save(buf, format="PNG", optimize=True)

    return GeneratedImage(
        style_name=style_name,
        img_2x3_bytes=img_bytes,
        img_1x1_bytes=buf.getvalue(),
        is_best_match=False,  # set by caller
    )


# ─── Public batch API ─────────────────────────────────────────────────────────

async def generate_images_batch(
    analysis: dict,
    product_title: str = "",
    n_total: int = 4,
    reference_images: list[bytes] | None = None,
):
    """
    Async generator — yields GeneratedImage objects as each completes.

    Strategy:
      - 1 image: best_style from analysis (AI-selected)
      - 3 images: random from remaining 11 styles
      - All 4 run concurrently (semaphore=4 to respect API rate limits)

    Usage:
        async for result in generate_images_batch(analysis, product_title):
            # result.style_name, result.img_2x3_bytes, result.img_1x1_bytes
    """
    best_style = analysis.get("best_style", "Scandinavian Loft")
    if best_style not in STYLE_PRESETS:
        best_style = "Scandinavian Loft"

    remaining = [s for s in STYLE_NAMES if s != best_style]
    random_styles = random.sample(remaining, min(n_total - 1, len(remaining)))
    styles_to_gen = [best_style] + random_styles

    semaphore = asyncio.Semaphore(2)  # reduce parallel image calls (LinAPI 429)

    async def _run(style: str, is_best: bool):
        result = await _generate_one(
            style, analysis, product_title, semaphore, reference_images=reference_images
        )
        result.is_best_match = is_best
        return result

    tasks = [
        asyncio.create_task(_run(style, i == 0))
        for i, style in enumerate(styles_to_gen)
    ]

    # Yield as each completes
    for coro in asyncio.as_completed(tasks):
        yield await coro


# ─── Legacy single-image compat shim ─────────────────────────────────────────
# Keeps task_worker.py working until it's updated to use generate_images_batch.

async def generate_images(
    product_image_url: str = "",
    product_images: list[bytes] = [],
    style: str = "Scandinavian Loft",
    platform_style: str = "pinterest",
) -> tuple[bytes, bytes]:
    """Legacy: generate one image. Use generate_images_batch for full pipeline."""
    fallback_analysis = {
        "materials": ["mixed materials"],
        "colors": ["neutral tones"],
        "vibe": ["contemporary"],
        "best_style": style if style in STYLE_PRESETS else "Scandinavian Loft",
    }
    semaphore = asyncio.Semaphore(1)
    result = await _generate_one(
        style if style in STYLE_PRESETS else "Scandinavian Loft",
        fallback_analysis,
        "",
        semaphore,
        reference_images=(product_images[:4] if product_images else None),
    )
    return result.img_2x3_bytes, result.img_1x1_bytes
