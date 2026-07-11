"""
ARQ async worker — VibePin two-step pipeline.

State machine:
  pending → scraping → analyzing → generating → copywriting → awaiting_review → done/failed

Generating phase streams 4 variant images one-by-one into the task's assets JSONB column.
The SSE endpoint in tasks.py picks up each update so the frontend renders images as they arrive.
"""
import asyncio
import json
from arq import create_pool
from arq.connections import RedisSettings

from app.core.config import get_settings
from app.core.database import get_supabase
from app.services.scraper import scrape_product
from app.services.analyzer import analyze_product_aesthetics
from app.services.image_gen import generate_images_batch
from app.services.copywriter import generate_copy


# ─── DB helpers ───────────────────────────────────────────────────────────────

def _db():
    return get_supabase()


async def _set_status(task_id: str, status: str, **extra):
    _db().table("tasks").update({"status": status, **extra}).eq("id", task_id).execute()


async def _patch_assets(task_id: str, assets: dict):
    _db().table("tasks").update({"assets": assets}).eq("id", task_id).execute()


async def _upload(image_bytes: bytes, task_id: str, suffix: str) -> str:
    """Upload PNG bytes to Supabase Storage, return CDN URL."""
    from app.services.publisher import _upload_to_supabase
    filename = f"{task_id}_{suffix}.png"
    return await _upload_to_supabase(image_bytes, filename)


# ─── Main worker ──────────────────────────────────────────────────────────────

async def process_task(ctx, task_id: str):
    """Full pipeline for one task. Called by ARQ queue."""
    settings = get_settings()
    db = _db()
    assets: dict = {"analysis": None, "variants": [], "selected_variant": 0}

    try:
        # Fetch task row
        row = db.table("tasks").select("*").eq("id", task_id).single().execute().data
        product_url = row["product_url"]

        # ── Step 1: Scrape product ────────────────────────────
        await _set_status(task_id, "scraping")
        metadata = await scrape_product(product_url)
        if not metadata:
            await _set_status(task_id, "failed",
                error_message="Could not extract product info. Please fill in manually.")
            return
        await _set_status(task_id, "analyzing", metadata=metadata.model_dump())

        # ── Step 2: Download product images for analysis ──────
        import httpx
        product_image_bytes: list[bytes] = []
        if metadata.image_url:
            try:
                async with httpx.AsyncClient(timeout=15.0) as client:
                    r = await client.get(metadata.image_url)
                    r.raise_for_status()
                    product_image_bytes.append(r.content)
            except Exception:
                pass  # analysis without image — falls back gracefully

        # ── Step 3: Aesthetic analysis ────────────────────────
        analysis = await analyze_product_aesthetics(
            product_images=product_image_bytes,
            product_title=metadata.title,
        )
        assets["analysis"] = analysis

        # Initialise 4 variant slots as "pending"
        best_style = analysis.get("best_style", "Scandinavian Loft")
        from app.services.image_gen import STYLE_NAMES
        import random
        remaining = [s for s in STYLE_NAMES if s != best_style]
        random_styles = random.sample(remaining, 3)
        planned_styles = [best_style] + random_styles

        assets["variants"] = [
            {"style_name": s, "img_2x3_url": None, "img_1x1_url": None,
             "is_best_match": i == 0, "status": "pending", "error": None}
            for i, s in enumerate(planned_styles)
        ]
        await _patch_assets(task_id, assets)
        await _set_status(task_id, "generating")

        # ── Step 4: Generate 4 images concurrently ────────────
        # Mark all as "generating"
        for v in assets["variants"]:
            v["status"] = "generating"
        await _patch_assets(task_id, assets)

        async def _run_and_upload(style: str, idx: int):
            """Generate one variant and upload; updates assets in place."""
            from app.services.image_gen import _generate_one
            sem = asyncio.Semaphore(4)
            try:
                result = await _generate_one(
                    style,
                    analysis,
                    metadata.title,
                    sem,
                    reference_images=(product_image_bytes or None),
                )
                img_2x3_url = await _upload(result.img_2x3_bytes, task_id, f"v{idx}_2x3")
                img_1x1_url = await _upload(result.img_1x1_bytes, task_id, f"v{idx}_1x1")
                assets["variants"][idx].update({
                    "img_2x3_url": img_2x3_url,
                    "img_1x1_url": img_1x1_url,
                    "status": "done",
                })
            except Exception as e:
                assets["variants"][idx].update({"status": "failed", "error": str(e)[:120]})

            # Push partial update immediately so SSE can stream it
            await _patch_assets(task_id, assets)

        await asyncio.gather(*[
            _run_and_upload(style, i)
            for i, style in enumerate(planned_styles)
        ])

        # ── Step 5: Generate copy ─────────────────────────────
        await _set_status(task_id, "copywriting")
        try:
            pin_title, pin_desc, ig_caption = await generate_copy(metadata)
            assets["copy_pinterest_title"] = pin_title
            assets["copy_pinterest_description"] = pin_desc
            assets["copy_instagram_caption"] = ig_caption
        except Exception as e:
            # Copy failure is non-fatal — use minimal fallback
            assets["copy_pinterest_title"] = metadata.title
            assets["copy_pinterest_description"] = ""
            assets["copy_instagram_caption"] = f"Shop this look via the link in bio."

        await _patch_assets(task_id, assets)
        await _set_status(task_id, "awaiting_review")

    except Exception as e:
        row = db.table("tasks").select("retry_count").eq("id", task_id).single().execute()
        retry_count = (row.data or {}).get("retry_count", 0)
        if retry_count < 2:
            db.table("tasks").update({"retry_count": retry_count + 1}).eq("id", task_id).execute()
            pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
            await pool.enqueue_job("process_task", task_id,
                _defer_by=60 * (2 ** retry_count))
            await pool.aclose()
        else:
            await _set_status(task_id, "failed",
                error_message=f"Pipeline failed: {str(e)[:200]}")


class WorkerSettings:
    functions = [process_task]
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
    max_jobs = 5
    job_timeout = 300
