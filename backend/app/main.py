from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.sessions import SessionMiddleware
from starlette.requests import Request

from app.config import settings
from app.logging_config import configure_logging
from app.routers.admin import router as admin_router
from app.routers.admin_auth import router as admin_auth_router

configure_logging()


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com; "
            "img-src 'self' data: https:; "
            "script-src 'self'; "
            "frame-ancestors 'none'"
        )
        return response


@asynccontextmanager
async def lifespan(app: FastAPI):  # pragma: no cover
    # Startup: requeue any pending email deliveries that survived a restart
    from app.database import AsyncSessionLocal
    from app.services.email_service import EmailService
    async with AsyncSessionLocal() as db:
        await EmailService().requeue_pending_on_startup(db)
    yield
    # Shutdown: cleanup


def create_app() -> FastAPI:
    app = FastAPI(
        title="General Meeting Voting App",
        version="0.1.0",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.allowed_origin],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization", "Accept", "X-Requested-With"],
    )
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.session_secret,
        https_only=settings.environment == "production",
        same_site="lax",
    )
    # SecurityHeadersMiddleware runs after CORS (Starlette runs middleware in
    # reverse registration order, so registering it last means it executes first
    # on the way in / last on the way out — ensuring headers are set on every
    # response including CORS preflight responses).
    app.add_middleware(SecurityHeadersMiddleware)

    from app.routers.public import router as public_router
    from app.routers.auth import router as auth_router
    from app.routers.voting import router as voting_router

    app.include_router(public_router, prefix="/api")
    app.include_router(auth_router, prefix="/api")
    app.include_router(voting_router, prefix="/api")
    app.include_router(admin_auth_router, prefix="/api/admin")
    app.include_router(admin_router, prefix="/api/admin")

    @app.get("/api/health")
    async def health() -> dict:
        return {"status": "ok"}

    return app


app = create_app()
