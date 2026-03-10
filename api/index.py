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
    os.environ["DATABASE_URL"] = asyncpg_url

from app.main import app  # noqa: E402 — must come after sys.path manipulation

__all__ = ["app"]
