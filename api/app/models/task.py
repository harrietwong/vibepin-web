from pydantic import BaseModel
from typing import Optional, Literal
from datetime import datetime
from uuid import UUID


TaskStatus = Literal[
    "pending", "scraping", "analyzing", "generating",
    "copywriting", "awaiting_review", "publishing", "done", "failed"
]

Platform = Literal["pinterest", "instagram", "both"]

# Kept for legacy compat; image_gen now uses free-form style names from STYLE_PRESETS
StylePreset = Literal["scandinavian", "boho_vintage", "contemporary_minimal"]


class ProductMetadata(BaseModel):
    product_id: str
    title: str
    price: Optional[float] = None
    currency: str = "USD"
    image_url: str
    product_url: str
    category_tags: list[str] = []
    platform_source: Literal["shopify", "etsy", "generic"] = "generic"


class AestheticAnalysis(BaseModel):
    """Result from Step 1 — Gemini product analyzer."""
    materials: list[str] = []
    colors: list[str] = []
    vibe: list[str] = []
    best_style: str = "Scandinavian Loft"
    style_reasoning: str = ""


class GeneratedVariant(BaseModel):
    """One generated image variant (one style)."""
    style_name: str
    img_2x3_url: Optional[str] = None   # Pinterest 2:3
    img_1x1_url: Optional[str] = None   # Instagram 1:1
    is_best_match: bool = False
    status: Literal["pending", "generating", "done", "failed"] = "pending"
    error: Optional[str] = None


class GeneratedAssets(BaseModel):
    """All generated assets for a task — 4 style variants + copy."""
    analysis: Optional[AestheticAnalysis] = None
    variants: list[GeneratedVariant] = []          # up to 4 variants
    # Copy — same for all variants
    copy_pinterest_title: Optional[str] = None
    copy_pinterest_description: Optional[str] = None
    copy_instagram_caption: Optional[str] = None
    # Selected variant index for publishing
    selected_variant: int = 0


class TaskCreate(BaseModel):
    product_url: str
    platforms: Platform = "both"


class TaskPublish(BaseModel):
    task_id: UUID
    platforms: Platform = "both"
    selected_variant: int = 0            # which of the 4 variants to publish
    board_id: Optional[str] = None
    ig_user_id: Optional[str] = None


class Task(BaseModel):
    id: UUID
    user_id: str
    product_url: str
    platforms: Platform
    status: TaskStatus
    metadata: Optional[ProductMetadata] = None
    assets: Optional[GeneratedAssets] = None
    error_message: Optional[str] = None
    retry_count: int = 0
    created_at: datetime
    updated_at: datetime
    published_at: Optional[datetime] = None
    pin_id: Optional[str] = None
    pin_url: Optional[str] = None
    ig_media_id: Optional[str] = None
    ig_permalink: Optional[str] = None
