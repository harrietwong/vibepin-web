from fastapi import HTTPException, Request

from .database import get_supabase


def require_authenticated_user_id(request: Request) -> str:
    """Verify a Supabase bearer token and return its immutable user id."""
    authorization = request.headers.get("Authorization", "")
    scheme, separator, token = authorization.partition(" ")
    if separator != " " or scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        response = get_supabase().auth.get_user(token.strip())
        user = response.user
        user_id = str(user.id).strip() if user and user.id else ""
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Not authenticated") from exc

    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user_id
