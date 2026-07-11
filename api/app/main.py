from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration

from app.core.config import get_settings
from app.api.routes import tasks, auth

settings = get_settings()

if not settings.is_development:
    sentry_sdk.init(
        dsn=getattr(settings, "sentry_dsn", ""),
        integrations=[FastApiIntegration()],
        traces_sample_rate=0.2,
    )

app = FastAPI(
    title="Social Flow API",
    version="1.0.0",
    docs_url="/docs" if settings.is_development else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tasks.router)
app.include_router(auth.router)


@app.get("/health")
async def health():
    return {"status": "ok", "environment": settings.environment}
