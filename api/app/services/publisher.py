"""
Dual-platform publisher.
Pinterest: v5 API — POST /v5/media → POST /v5/pins
Instagram: Graph API v22 — POST media container → POST media_publish
Both run concurrently via asyncio.gather; independent failure does not block the other.
"""
import asyncio
import httpx
from typing import Optional
from app.models.task import GeneratedAssets, ProductMetadata


async def _upload_to_supabase(image_bytes: bytes, filename: str, bucket: str = "generated") -> str:
    """Upload image to Supabase Storage, return public CDN URL."""
    from app.core.database import get_supabase
    db = get_supabase()
    path = f"images/{filename}"
    db.storage.from_(bucket).upload(
        path, image_bytes, {"content-type": "image/png", "upsert": "true"}
    )
    return db.storage.from_(bucket).get_public_url(path)


async def _publish_pinterest(
    img_2x3_url: str,
    title: str,
    description: str,
    product_url: str,
    board_id: str,
    access_token: str,
    client: httpx.AsyncClient,
) -> dict:
    """Upload media then create Pin."""
    # Step 1: register media
    media_resp = await client.post(
        "https://api.pinterest.com/v5/media",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"media_type": "image"},
    )
    media_resp.raise_for_status()
    upload_info = media_resp.json()

    # Step 2: upload to Pinterest's upload URL
    img_resp = await client.get(img_2x3_url)
    await client.post(
        upload_info["upload_url"],
        content=img_resp.content,
        headers={"Content-Type": "image/png"},
    )

    # Step 3: create Pin
    pin_resp = await client.post(
        "https://api.pinterest.com/v5/pins",
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        json={
            "board_id": board_id,
            "title": title,
            "description": description,
            "link": product_url,
            "media_source": {
                "source_type": "image_base64",
                "media_id": upload_info["media_id"],
            },
            "alt_text": title,
        },
    )
    pin_resp.raise_for_status()
    data = pin_resp.json()
    return {"pin_id": data["id"], "pin_url": f"https://www.pinterest.com/pin/{data['id']}/"}


async def _publish_instagram(
    img_1x1_url: str,
    caption: str,
    ig_user_id: str,
    access_token: str,
    client: httpx.AsyncClient,
) -> dict:
    """Create media container then publish."""
    # Step 1: create container
    container_resp = await client.post(
        f"https://graph.instagram.com/v22.0/{ig_user_id}/media",
        params={
            "image_url": img_1x1_url,
            "caption": caption,
            "access_token": access_token,
        },
    )
    container_resp.raise_for_status()
    creation_id = container_resp.json()["id"]

    # Step 2: publish
    publish_resp = await client.post(
        f"https://graph.instagram.com/v22.0/{ig_user_id}/media_publish",
        params={"creation_id": creation_id, "access_token": access_token},
    )
    publish_resp.raise_for_status()
    data = publish_resp.json()
    ig_media_id = data["id"]
    return {
        "ig_media_id": ig_media_id,
        "ig_permalink": f"https://www.instagram.com/p/{ig_media_id}/",
    }


async def publish_all(
    assets: GeneratedAssets,
    metadata: ProductMetadata,
    pinterest_token: Optional[str],
    pinterest_board_id: Optional[str],
    ig_token: Optional[str],
    ig_user_id: Optional[str],
    platforms: str = "both",
) -> dict:
    """
    Run Pinterest + Instagram publish concurrently.
    Returns dict with results and any per-platform errors.
    """
    results = {"pinterest": None, "instagram": None, "errors": {}}

    async with httpx.AsyncClient(timeout=30.0) as client:
        tasks = []

        if platforms in ("both", "pinterest") and pinterest_token and pinterest_board_id:
            tasks.append(
                _publish_pinterest(
                    assets.img_2x3_url,
                    assets.copy_pinterest_title,
                    assets.copy_pinterest_description,
                    metadata.product_url,
                    pinterest_board_id,
                    pinterest_token,
                    client,
                )
            )
        else:
            tasks.append(asyncio.coroutine(lambda: None)())

        if platforms in ("both", "instagram") and ig_token and ig_user_id:
            tasks.append(
                _publish_instagram(
                    assets.img_1x1_url,
                    assets.copy_instagram_caption,
                    ig_user_id,
                    ig_token,
                    client,
                )
            )
        else:
            tasks.append(asyncio.coroutine(lambda: None)())

        p_result, ig_result = await asyncio.gather(*tasks, return_exceptions=True)

        if isinstance(p_result, Exception):
            results["errors"]["pinterest"] = str(p_result)
        else:
            results["pinterest"] = p_result

        if isinstance(ig_result, Exception):
            results["errors"]["instagram"] = str(ig_result)
        else:
            results["instagram"] = ig_result

    return results
