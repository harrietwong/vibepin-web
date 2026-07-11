"""
Step 1 — Product Aesthetic Analyzer.

Sends 1-4 product images to gemini-2.5-flash (cheapest multimodal, ¥0.0001/M tokens)
and returns structured JSON with materials, colors, vibe, and best-matching style.
"""
import base64
import json
import re
from openai import AsyncOpenAI
from app.core.config import get_settings


ANALYZER_SYSTEM = """You are an expert interior design aesthetic analyst.
Analyze the provided product image(s) and return ONLY a valid JSON object with these exact keys:

{
  "materials": ["list of materials, e.g. brass, walnut wood, velvet, ceramic"],
  "colors": ["main color tones, e.g. warm ivory, deep burgundy, matte black"],
  "vibe": ["mood descriptors, e.g. industrial, cozy, minimalist, luxurious, playful"],
  "best_style": "ONE style name from this exact list that best matches the product",
  "style_reasoning": "one sentence explaining why this style matches"
}

Available styles to choose from for best_style (use EXACT name):
Afrohemian, Neo Deco, Dopamine Decor, Opera Aesthetic, Soft Geometry,
Biophilic Design, Extra Celestial, Cabbagecore, Heritage,
Moody Color Drenching, Scandinavian Loft, Mid-Century Modern

Return ONLY the JSON object, no markdown, no extra text."""


async def analyze_product_aesthetics(
    product_images: list[bytes],
    product_title: str = "",
) -> dict:
    """
    Analyze product images and return aesthetic profile.

    Returns:
        {
            "materials": [...],
            "colors": [...],
            "vibe": [...],
            "best_style": "Neo Deco",
            "style_reasoning": "..."
        }
    Falls back to a generic neutral profile on any error.
    """
    settings = get_settings()
    client = AsyncOpenAI(
        api_key=settings.linapi_key,
        base_url=settings.linapi_base_url,
    )

    # Build message content — include all product images
    content: list[dict] = []
    for i, img_bytes in enumerate(product_images[:4]):
        b64 = base64.b64encode(img_bytes).decode()
        # Detect format
        mime = "image/png" if img_bytes[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg"
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:{mime};base64,{b64}"},
        })

    text_prompt = f"Analyze {'these product images' if len(product_images) > 1 else 'this product image'}."
    if product_title:
        text_prompt += f" Product name: {product_title}."
    content.append({"type": "text", "text": text_prompt})

    try:
        response = await client.chat.completions.create(
            model=settings.linapi_analysis_model,
            messages=[
                {"role": "system", "content": ANALYZER_SYSTEM},
                {"role": "user", "content": content},
            ],
            temperature=0.2,
            max_tokens=400,
        )
        raw = response.choices[0].message.content.strip()

        # Strip markdown code fences if present
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)

        return json.loads(raw)

    except Exception as e:
        # Graceful fallback — generic neutral profile
        return {
            "materials": ["mixed materials"],
            "colors": ["neutral tones"],
            "vibe": ["versatile", "contemporary"],
            "best_style": "Scandinavian Loft",
            "style_reasoning": f"Fallback due to analysis error: {str(e)[:80]}",
        }
