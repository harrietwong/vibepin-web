import warnings
from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # App
    app_secret_key: str = "dev-secret-change-in-production"
    frontend_url: str = "http://localhost:3000"
    environment: str = "development"

    # Supabase
    supabase_url: str
    supabase_service_role_key: str
    supabase_anon_key: str

    # LinAPI — OpenAI-compatible proxy serving Gemini models
    # Get your key + base_url from: https://www.linapi.cc (or your LinAPI dashboard)
    linapi_key: str
    linapi_base_url: str = "https://api.linapi.cc/v1"

    # Model routing — priced per token / image at LinAPI
    # Analysis: multimodal gemini flash
    linapi_analysis_model: str = "gemini-2.5-flash"
    # Gemini Image Preview (LinAPI): POST .../v1beta/models/{model}:generateContent
    # Match model suffix (-2K/-4K) with LINAPI_IMAGE_SIZE when possible.
    linapi_image_model: str = "gemini-3.1-flash-image-preview"
    linapi_image_model_fallback: str = (
        "gemini-3.1-flash-image-preview-2K,"
        "gemini-3-pro-image-preview,"
        "gemini-3-pro-image-preview-2K"
    )
    # generationConfig.imageConfig (LinAPI doc): 1:1 16:9 9:16 3:4 4:3
    linapi_image_aspect_ratio: str = "3:4"
    # 1K / 2K / 4K — if model ends with -2K or -4K, code overrides to match
    linapi_image_size: str = "1K"
    linapi_copy_model: str = "gemini-2.5-flash"

    # Pinterest — required for OAuth; placeholder OK during local image-gen testing
    pinterest_app_id: str = "placeholder"
    pinterest_app_secret: str = "placeholder"
    pinterest_redirect_uri: str = "http://localhost:8000/api/auth/pinterest/callback"

    # Meta / Instagram
    meta_app_id: str = "placeholder"
    meta_app_secret: str = "placeholder"
    meta_redirect_uri: str = "http://localhost:8000/api/auth/instagram/callback"

    # Redis (Upstash)
    redis_url: str = "redis://localhost:6379"

    @property
    def is_development(self) -> bool:
        return self.environment == "development"

    @model_validator(mode="after")
    def warn_openai_when_using_linapi(self):
        """Process env often overrides `.env`; warn if gateway is clearly wrong."""
        url = self.linapi_base_url.lower().rstrip("/")
        if "api.openai.com" in url:
            warnings.warn(
                "LINAPI_BASE_URL points to api.openai.com — LinAPI keys will get 401. "
                "Set LINAPI_BASE_URL to your LinAPI dashboard URL "
                "(e.g. https://api.linapi.net/v1) and unset any conflicting machine env.",
                UserWarning,
                stacklevel=1,
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
