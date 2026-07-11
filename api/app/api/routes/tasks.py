"""
Task CRUD + SSE status stream.
POST /api/tasks         — create task, enqueue worker
GET  /api/tasks         — list user's tasks
GET  /api/tasks/{id}    — get single task
GET  /api/tasks/{id}/stream — SSE real-time status
POST /api/tasks/{id}/publish — trigger publish step
PATCH /api/tasks/{id}   — update assets/copy (user edits)
"""
import asyncio
import json
from uuid import UUID
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from arq import create_pool
from arq.connections import RedisSettings

from app.core.config import get_settings
from app.core.database import get_supabase
from app.models.task import TaskCreate, TaskPublish
from app.services.publisher import publish_all

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


def _get_user_id(request) -> str:
    """Extract user_id from Supabase JWT. Simplified for now."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    # In production: verify JWT with Supabase
    return auth.split(" ")[1][:36]  # Use token prefix as user_id for dev


@router.post("")
async def create_task(body: TaskCreate, request=None):
    settings = get_settings()
    db = get_supabase()

    # Insert task
    result = db.table("tasks").insert({
        "product_url": str(body.product_url),
        "style_preset": body.style_preset,
        "platforms": body.platforms,
        "status": "pending",
        "retry_count": 0,
    }).execute()
    task = result.data[0]
    task_id = task["id"]

    # Enqueue worker
    pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
    await pool.enqueue_job("process_task", task_id)
    await pool.aclose()

    return task


@router.get("")
async def list_tasks():
    db = get_supabase()
    result = db.table("tasks").select("*").order("created_at", desc=True).limit(50).execute()
    return result.data


@router.get("/{task_id}")
async def get_task(task_id: UUID):
    db = get_supabase()
    result = db.table("tasks").select("*").eq("id", str(task_id)).single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Task not found")
    return result.data


@router.get("/{task_id}/stream")
async def stream_task_status(task_id: UUID):
    """Server-Sent Events — poll DB every 2s and push status changes."""
    db = get_supabase()

    async def event_generator():
        last_status = None
        for _ in range(150):  # 5 min max stream (150 × 2s)
            result = db.table("tasks").select("status, assets, error_message").eq(
                "id", str(task_id)
            ).single().execute()
            data = result.data or {}
            status = data.get("status")

            if status != last_status:
                last_status = status
                yield f"data: {json.dumps(data)}\n\n"

            if status in ("awaiting_review", "done", "failed"):
                break

            await asyncio.sleep(2)

        yield "data: {\"status\": \"stream_end\"}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.patch("/{task_id}")
async def update_task_assets(task_id: UUID, body: dict):
    """User edits copy or swaps image before publishing."""
    db = get_supabase()
    allowed_fields = {
        "assets", "copy_pinterest_title", "copy_pinterest_description", "copy_instagram_caption"
    }
    update_data = {k: v for k, v in body.items() if k in allowed_fields}
    if not update_data:
        raise HTTPException(status_code=400, detail="No valid fields to update")
    db.table("tasks").update(update_data).eq("id", str(task_id)).execute()
    return {"ok": True}


@router.post("/{task_id}/publish")
async def publish_task(task_id: UUID, body: TaskPublish):
    db = get_supabase()

    # Fetch task + assets
    result = db.table("tasks").select("*").eq("id", str(task_id)).single().execute()
    task = result.data
    if not task:
        raise HTTPException(404, "Task not found")
    if task["status"] != "awaiting_review":
        raise HTTPException(400, f"Task is in status '{task['status']}', not awaiting_review")

    # Fetch user platform tokens (from user_settings table)
    # TODO: replace with actual user auth
    settings_result = db.table("user_settings").select("*").limit(1).execute()
    user_settings = settings_result.data[0] if settings_result.data else {}

    db.table("tasks").update({"status": "publishing"}).eq("id", str(task_id)).execute()

    from app.models.task import GeneratedAssets, ProductMetadata
    assets = GeneratedAssets(**task.get("assets", {}))
    metadata = ProductMetadata(**task.get("metadata", {})) if task.get("metadata") else None

    publish_result = await publish_all(
        assets=assets,
        metadata=metadata,
        pinterest_token=user_settings.get("pinterest_access_token"),
        pinterest_board_id=body.board_id or user_settings.get("pinterest_default_board_id"),
        ig_token=user_settings.get("instagram_access_token"),
        ig_user_id=body.ig_user_id or user_settings.get("instagram_ig_user_id"),
        platforms=body.platforms,
    )

    update_data: dict = {"status": "done"}
    if publish_result.get("pinterest"):
        update_data["pin_id"] = publish_result["pinterest"]["pin_id"]
        update_data["pin_url"] = publish_result["pinterest"]["pin_url"]
    if publish_result.get("instagram"):
        update_data["ig_media_id"] = publish_result["instagram"]["ig_media_id"]
        update_data["ig_permalink"] = publish_result["instagram"]["ig_permalink"]
    if publish_result.get("errors"):
        update_data["error_message"] = json.dumps(publish_result["errors"])
        # Partial success: at least one platform worked → still mark done
        if not publish_result.get("pinterest") and not publish_result.get("instagram"):
            update_data["status"] = "failed"

    db.table("tasks").update(update_data).eq("id", str(task_id)).execute()
    return {**update_data, "publish_details": publish_result}
