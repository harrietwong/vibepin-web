"""
OAuth flows for Pinterest + Instagram.
Pinterest: Standard OAuth 2.0 (PKCE recommended in prod)
Instagram: Meta OAuth 2.0 → exchange for long-lived token (60 days)
"""
import hashlib, secrets
import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from app.core.config import get_settings
from app.core.database import get_supabase

router = APIRouter(prefix="/api/auth", tags=["auth"])

# ── Pinterest ─────────────────────────────────────────────────────────────────

PINTEREST_AUTH_URL = "https://www.pinterest.com/oauth/"
PINTEREST_TOKEN_URL = "https://api.pinterest.com/v5/oauth/token"
PINTEREST_SCOPES = "boards:read,pins:read,pins:write"


@router.get("/pinterest")
async def pinterest_auth(request: Request):
    settings = get_settings()
    state = secrets.token_urlsafe(16)
    # In production: store state in session/redis for CSRF verification
    url = (
        f"{PINTEREST_AUTH_URL}?client_id={settings.pinterest_app_id}"
        f"&redirect_uri={settings.pinterest_redirect_uri}"
        f"&response_type=code&scope={PINTEREST_SCOPES}&state={state}"
    )
    return RedirectResponse(url)


@router.get("/pinterest/callback")
async def pinterest_callback(code: str, state: str):
    settings = get_settings()
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            PINTEREST_TOKEN_URL,
            auth=(settings.pinterest_app_id, settings.pinterest_app_secret),
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": settings.pinterest_redirect_uri,
            },
        )
        if resp.status_code != 200:
            raise HTTPException(400, f"Pinterest token exchange failed: {resp.text}")
        token_data = resp.json()

        # Fetch user info
        me = await client.get(
            "https://api.pinterest.com/v5/user_account",
            headers={"Authorization": f"Bearer {token_data['access_token']}"},
        )
        user_info = me.json()

        # Fetch boards
        boards = await client.get(
            "https://api.pinterest.com/v5/boards",
            headers={"Authorization": f"Bearer {token_data['access_token']}"},
        )
        boards_data = boards.json().get("items", [])

    # TODO: store encrypted token per authenticated user
    db = get_supabase()
    db.table("user_settings").upsert({
        "pinterest_connected": True,
        "pinterest_username": user_info.get("username"),
        "pinterest_access_token": token_data["access_token"],
        "pinterest_refresh_token": token_data.get("refresh_token"),
        "pinterest_boards": boards_data,
    }).execute()

    return RedirectResponse(f"{settings.frontend_url}/settings?pinterest=connected")


# ── Instagram / Meta ──────────────────────────────────────────────────────────

META_AUTH_URL = "https://www.facebook.com/v22.0/dialog/oauth"
META_TOKEN_URL = "https://graph.facebook.com/v22.0/oauth/access_token"
META_SCOPES = "instagram_basic,instagram_content_publish,pages_show_list"


@router.get("/instagram")
async def instagram_auth():
    settings = get_settings()
    state = secrets.token_urlsafe(16)
    url = (
        f"{META_AUTH_URL}?client_id={settings.meta_app_id}"
        f"&redirect_uri={settings.meta_redirect_uri}"
        f"&scope={META_SCOPES}&response_type=code&state={state}"
    )
    return RedirectResponse(url)


@router.get("/instagram/callback")
async def instagram_callback(code: str, state: str):
    settings = get_settings()
    async with httpx.AsyncClient() as client:
        # Exchange code for short-lived token
        resp = await client.get(
            META_TOKEN_URL,
            params={
                "client_id": settings.meta_app_id,
                "client_secret": settings.meta_app_secret,
                "redirect_uri": settings.meta_redirect_uri,
                "code": code,
            },
        )
        if resp.status_code != 200:
            raise HTTPException(400, f"Meta token exchange failed: {resp.text}")
        short_token = resp.json()["access_token"]

        # Exchange for long-lived token (60 days)
        ll_resp = await client.get(
            "https://graph.facebook.com/v22.0/oauth/access_token",
            params={
                "grant_type": "fb_exchange_token",
                "client_id": settings.meta_app_id,
                "client_secret": settings.meta_app_secret,
                "fb_exchange_token": short_token,
            },
        )
        long_token = ll_resp.json()["access_token"]

        # Get connected IG account
        pages_resp = await client.get(
            "https://graph.facebook.com/v22.0/me/accounts",
            params={"access_token": long_token},
        )
        pages = pages_resp.json().get("data", [])
        ig_user_id = None
        if pages:
            page_token = pages[0]["access_token"]
            ig_resp = await client.get(
                f"https://graph.facebook.com/v22.0/{pages[0]['id']}",
                params={"fields": "instagram_business_account", "access_token": page_token},
            )
            ig_user_id = ig_resp.json().get("instagram_business_account", {}).get("id")

    db = get_supabase()
    db.table("user_settings").upsert({
        "instagram_connected": True,
        "instagram_access_token": long_token,
        "instagram_ig_user_id": ig_user_id,
    }).execute()

    return RedirectResponse(f"{settings.frontend_url}/settings?instagram=connected")


@router.get("/status")
async def auth_status():
    """Return connection status for both platforms."""
    db = get_supabase()
    result = db.table("user_settings").select(
        "pinterest_connected,pinterest_username,instagram_connected,instagram_ig_user_id"
    ).limit(1).execute()
    return result.data[0] if result.data else {
        "pinterest_connected": False,
        "instagram_connected": False,
    }
