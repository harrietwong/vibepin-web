from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class PlatformConnection(BaseModel):
    connected: bool = False
    username: Optional[str] = None
    access_token: Optional[str] = None  # encrypted at rest
    refresh_token: Optional[str] = None
    expires_at: Optional[datetime] = None
    default_board_id: Optional[str] = None  # Pinterest
    ig_user_id: Optional[str] = None  # Instagram


class UserSettings(BaseModel):
    user_id: str
    auto_publish: bool = False
    review_image: bool = True
    review_copy: bool = True
    default_platforms: str = "both"
    daily_limit: int = 10
    default_style: str = "scandinavian"
    pinterest: PlatformConnection = PlatformConnection()
    instagram: PlatformConnection = PlatformConnection()
