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

# ---------------------------------------------------------------------------
# Run Alembic migrations at Lambda startup (once per cold start).
# Uses the existing async env.py — no psycopg2 required.
# Failures are logged as warnings but do NOT prevent the app from starting,
# so a bad migration doesn't take down the entire deployment.
# ---------------------------------------------------------------------------
_db_url = os.environ.get("DATABASE_URL", "")
if _db_url:  # pragma: no cover — runs at Lambda cold-start; cannot unit-test without a live DB
    try:  # pragma: no cover
        from alembic.config import Config as _AlembicConfig  # pragma: no cover
        from alembic import command as _alembic_command  # pragma: no cover

        _backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend"))  # pragma: no cover
        _alembic_ini = os.path.join(_backend_dir, "alembic.ini")  # pragma: no cover
        _alembic_cfg = _AlembicConfig(_alembic_ini)  # pragma: no cover
        _alembic_cfg.set_main_option("sqlalchemy.url", _db_url)  # pragma: no cover
        # script_location in alembic.ini is relative — resolve to absolute path so it
        # works regardless of the Lambda's current working directory.
        _alembic_cfg.set_main_option("script_location", os.path.join(_backend_dir, "alembic"))  # pragma: no cover
        _alembic_command.upgrade(_alembic_cfg, "head")  # pragma: no cover
    except Exception as _migration_exc:  # pragma: no cover
        import logging as _logging  # pragma: no cover
        _logging.warning("[startup] Alembic migration error (non-fatal): %s", _migration_exc)  # pragma: no cover

from app.main import app  # noqa: E402 — must come after sys.path manipulation

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
