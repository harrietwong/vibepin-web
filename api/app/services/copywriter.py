"""
Dual-platform copywriter via LinAPI (OpenAI-compatible chat).
Pinterest: SEO-dense, keyword-rich, no emoji.
Instagram: Emotional hook + scene narrative + link-in-bio CTA + hashtags.
"""
import random
from openai import AsyncOpenAI
from app.models.task import ProductMetadata, GeneratedAssets
from app.core.config import get_settings

PINTEREST_SYSTEM = """You are an expert Pinterest SEO copywriter for home decor and lifestyle products.
Rules:
- Title: max 100 chars, format: [Category] + [Style Adj] + [Use Case]. Natural, keyword-dense.
- Description: 3-5 sentences. First 2 must contain the 3 strongest search terms. End with: Shop this look at [STORE].
- NO emojis. NO hashtags. NO fabricated product attributes.
- Do NOT change the product's material, color, or dimensions.
Return JSON: {"title": "...", "description": "..."}"""

INSTAGRAM_SYSTEM = """You are an Instagram content writer for a warm, aspirational home decor brand.
Rules:
- Hook: 1 punchy line (creates desire or curiosity). Can use 1 emoji max.
- Body: 2-3 lines painting a lifestyle scene around the product. Warm, human, sensory.
- CTA_VARIANT: use exactly one of these two, chosen randomly by the caller:
  A: "Shop this look via the link in bio."
  B: "Tap the link in bio to bring this piece home."
- Blank line before hashtags.
- Hashtags: 20-25 tags. Mix: 3 large (1M+), 10 medium (100k-1M), 8 small (10k-100k). All home/decor relevant.
- Do NOT fabricate product specs.
Return JSON: {"caption": "full caption with CTA and hashtags"}"""

CTA_OPTIONS = [
    "Shop this look via the link in bio.",
    "Tap the link in bio to bring this piece home.",
]


async def generate_copy(metadata: ProductMetadata) -> tuple[str, str, str, str]:
    """
    Returns: (pinterest_title, pinterest_description, instagram_caption)
    """
    settings = get_settings()
    client = AsyncOpenAI(
        api_key=settings.linapi_key,
        base_url=settings.linapi_base_url,
    )
    copy_model = settings.linapi_copy_model
    cta = random.choice(CTA_OPTIONS)

    product_brief = (
        f"Product: {metadata.title}\n"
        f"Price: {metadata.price} {metadata.currency}\n"
        f"URL: {metadata.product_url}\n"
        f"Category tags: {', '.join(metadata.category_tags) or 'home decor'}"
    )

    pin_prompt = f"{product_brief}\n\nWrite Pinterest copy."
    ig_prompt = f"{product_brief}\n\nCTA to use: '{cta}'\n\nWrite Instagram caption."

    pin_resp, ig_resp = await asyncio.gather(
        client.chat.completions.create(
            model=copy_model,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": PINTEREST_SYSTEM},
                {"role": "user", "content": pin_prompt},
            ],
            temperature=0.7,
            max_tokens=300,
        ),
        client.chat.completions.create(
            model=copy_model,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": INSTAGRAM_SYSTEM},
                {"role": "user", "content": ig_prompt},
            ],
            temperature=0.8,
            max_tokens=500,
        ),
    )

    import json
    pin_data = json.loads(pin_resp.choices[0].message.content)
    ig_data = json.loads(ig_resp.choices[0].message.content)

    return (
        pin_data.get("title", metadata.title),
        pin_data.get("description", ""),
        ig_data.get("caption", ""),
    )


import asyncio  # noqa: E402 — imported after use in gather above
