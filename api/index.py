"""
Vercel serverless entry point for the FastAPI backend.

Makes the backend package importable from the project root, then exports
the FastAPI `app` instance for Vercel's Python runtime (ASGI).

Environment variables expected (set in Vercel project settings):
  DATABASE_URL      postgresql+asyncpg://... (cloud Postgres)
  SESSION_SECRET    random secret for session cookies
  RESEND_API_KEY    Resend API key for email delivery
  RESEND_FROM_EMAIL sender address for result emails
  ALLOWED_ORIGIN    frontend URL (e.g. https://your-project.vercel.app)
"""
import os
import sys

# Make the backend package importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

# If Vercel Postgres injects POSTGRES_URL, convert it to the asyncpg scheme
# expected by SQLAlchemy (postgresql+asyncpg://...)
postgres_url = os.environ.get("POSTGRES_URL")
if postgres_url and "DATABASE_URL" not in os.environ:
    # Vercel Postgres uses postgres:// or postgresql://; swap for asyncpg driver
    asyncpg_url = postgres_url.replace("postgres://", "postgresql+asyncpg://", 1).replace(
        "postgresql://", "postgresql+asyncpg://", 1
    )
    # asyncpg uses ssl=require, not sslmode=require (psycopg2 syntax)
    asyncpg_url = asyncpg_url.replace("sslmode=require", "ssl=require")
    asyncpg_url = asyncpg_url.replace("&channel_binding=require", "").replace("channel_binding=require&", "").replace("channel_binding=require", "")
    os.environ["DATABASE_URL"] = asyncpg_url

# Sanitize DATABASE_URL regardless of how it was set: asyncpg rejects sslmode=require
# and does not understand channel_binding (a libpq-only parameter).
if "DATABASE_URL" in os.environ:
    os.environ["DATABASE_URL"] = (
        os.environ["DATABASE_URL"]
        .replace("postgres://", "postgresql+asyncpg://", 1)
        .replace("postgresql://", "postgresql+asyncpg://", 1)
        .replace("sslmode=require", "ssl=require")
        .replace("&channel_binding=require", "")
        .replace("channel_binding=require&", "")
        .replace("channel_binding=require", "")
    )

from app.main import app  # noqa: E402 — must come after sys.path manipulation

# TEMP: debug endpoint — retrieve unpooled DB URL for manual migration
@app.get("/api/debug/db-url", include_in_schema=False)  # pragma: no cover
async def _debug_db_url():  # pragma: no cover
    return {
        "DATABASE_URL": os.environ.get("DATABASE_URL"),
        "DATABASE_URL_UNPOOLED": os.environ.get("DATABASE_URL_UNPOOLED"),
        "POSTGRES_URL": os.environ.get("POSTGRES_URL"),
        "POSTGRES_URL_NON_POOLING": os.environ.get("POSTGRES_URL_NON_POOLING"),
    }

# Serve the React SPA from the bundled frontend/dist directory.
# frontend/dist is included in the Lambda via vercel.json includeFiles.
_dist_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(_dist_dir):
    from fastapi.staticfiles import StaticFiles  # noqa: E402
    from fastapi.responses import FileResponse  # noqa: E402

    _assets_dir = os.path.join(_dist_dir, "assets")
    if os.path.isdir(_assets_dir):
        app.mount("/assets", StaticFiles(directory=_assets_dir), name="static_assets")

    @app.get("/{full_path:path}", include_in_schema=False)  # pragma: no cover
    async def _serve_spa(full_path: str) -> FileResponse:  # pragma: no cover
        # Serve static files that exist in the dist root (e.g. logo.png, favicon)
        # before falling back to the SPA shell.
        candidate = os.path.join(_dist_dir, full_path)  # pragma: no cover
        if os.path.isfile(candidate):  # pragma: no cover
            return FileResponse(candidate)  # pragma: no cover
        return FileResponse(os.path.join(_dist_dir, "index.html"))  # pragma: no cover

__all__ = ["app"]
