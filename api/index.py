"""
Vercel serverless entry point for the FastAPI backend.

Makes the backend package importable from the project root, then exports
the FastAPI `app` instance for Vercel's Python runtime (ASGI).

Environment variables expected (set in Vercel project settings):
  DATABASE_URL      postgresql+asyncpg://... (cloud Postgres)
  SESSION_SECRET    random secret for session cookies
  SMTP_HOST         SMTP server hostname (e.g. mail-au.smtp2go.com)
  SMTP_PORT         SMTP server port (e.g. 2525 for STARTTLS)
  SMTP_USERNAME     SMTP authentication username
  SMTP_PASSWORD     SMTP authentication password
  SMTP_FROM_EMAIL   sender address for result emails
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

_db_url = os.environ.get("DATABASE_URL", "")

from app.main import app  # noqa: E402 — must come after sys.path manipulation

# ---------------------------------------------------------------------------
# Auto-open + auto-close on Lambda cold start (US-PS02, US-CD01).
# Runs once per cold start, after migrations.
# Auto-open runs BEFORE auto-close so a meeting whose both timestamps have
# passed transitions pending → open → closed in the same cold start.
# Failures are logged as warnings but do NOT prevent the app from starting.
# ---------------------------------------------------------------------------
if _db_url:  # pragma: no cover — requires a live DB; exercised by integration tests
    try:  # pragma: no cover
        import asyncio as _asyncio  # pragma: no cover
        import logging as _logging  # pragma: no cover
        from datetime import UTC as _UTC, datetime as _datetime  # pragma: no cover

        async def _auto_open_and_close_meetings() -> None:  # pragma: no cover
            """Open pending meetings whose meeting_at has passed, then close expired open meetings."""
            from sqlalchemy import select as _select  # pragma: no cover
            from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession  # pragma: no cover
            from sqlalchemy.orm import sessionmaker  # pragma: no cover
            from app.models.general_meeting import GeneralMeeting as _GeneralMeeting, GeneralMeetingStatus as _GeneralMeetingStatus  # pragma: no cover
            from app.services.admin_service import close_general_meeting as _close_general_meeting  # pragma: no cover

            _engine = create_async_engine(_db_url, echo=False)  # pragma: no cover
            _session_factory = sessionmaker(_engine, class_=AsyncSession, expire_on_commit=False)  # pragma: no cover

            # --- Auto-open: transition pending meetings whose meeting_at has passed ---
            opened_count = 0  # pragma: no cover
            async with _session_factory() as _db:  # pragma: no cover
                _pending_res = await _db.execute(  # pragma: no cover
                    _select(_GeneralMeeting).where(  # pragma: no cover
                        _GeneralMeeting.status == _GeneralMeetingStatus.pending,  # pragma: no cover
                        _GeneralMeeting.meeting_at <= _datetime.now(_UTC),  # pragma: no cover
                    )  # pragma: no cover
                )  # pragma: no cover
                for _meeting in _pending_res.scalars().all():  # pragma: no cover
                    _meeting.status = _GeneralMeetingStatus.open  # pragma: no cover
                    opened_count += 1  # pragma: no cover
                await _db.commit()  # pragma: no cover
            _logging.info("[startup] Auto-opened %d pending meeting(s)", opened_count)  # pragma: no cover

            # --- Auto-close: close open meetings whose voting_closes_at has passed ---
            closed_count = 0  # pragma: no cover
            async with _session_factory() as _db:  # pragma: no cover
                _res = await _db.execute(  # pragma: no cover
                    _select(_GeneralMeeting).where(  # pragma: no cover
                        _GeneralMeeting.status == _GeneralMeetingStatus.open,  # pragma: no cover
                        _GeneralMeeting.voting_closes_at < _datetime.now(_UTC),  # pragma: no cover
                    )  # pragma: no cover
                )  # pragma: no cover
                expired = list(_res.scalars().all())  # pragma: no cover
                for _meeting in expired:  # pragma: no cover
                    try:  # pragma: no cover
                        await _close_general_meeting(_meeting.id, _db)  # pragma: no cover
                        closed_count += 1  # pragma: no cover
                    except Exception as _exc:  # pragma: no cover
                        _logging.warning("[startup] Could not auto-close meeting %s: %s", _meeting.id, _exc)  # pragma: no cover
            await _engine.dispose()  # pragma: no cover
            _logging.info("[startup] Auto-closed %d expired meeting(s)", closed_count)  # pragma: no cover

        _asyncio.run(_auto_open_and_close_meetings())  # pragma: no cover
    except Exception as _autoclose_exc:  # pragma: no cover
        import logging as _logging  # pragma: no cover
        _logging.warning("[startup] Auto-open/close error (non-fatal): %s", _autoclose_exc)  # pragma: no cover

# Serve the React SPA from the bundled frontend/dist directory.
# frontend/dist is included in the Lambda via vercel.json includeFiles.
_dist_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(_dist_dir):
    from fastapi.staticfiles import StaticFiles  # noqa: E402
    from fastapi.responses import FileResponse  # noqa: E402
    from starlette.types import Scope  # noqa: E402

    class _ImmutableStaticFiles(StaticFiles):  # pragma: no cover
        """StaticFiles subclass that adds immutable cache headers to all responses.

        Hashed asset filenames (e.g. main.abc123.js) are safe to cache forever
        because their URLs change whenever the content changes.
        """

        async def get_response(self, path: str, scope: Scope):  # type: ignore[override]  # pragma: no cover
            response = await super().get_response(path, scope)  # pragma: no cover
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"  # pragma: no cover
            return response  # pragma: no cover

    _assets_dir = os.path.join(_dist_dir, "assets")
    if os.path.isdir(_assets_dir):
        app.mount("/assets", _ImmutableStaticFiles(directory=_assets_dir), name="static_assets")

    _NO_CACHE = {"Cache-Control": "no-cache, no-store, must-revalidate"}

    @app.get("/{full_path:path}", include_in_schema=False)  # pragma: no cover
    async def _serve_spa(full_path: str) -> FileResponse:  # pragma: no cover
        # Serve static files that exist in the dist root (e.g. logo.png, favicon)
        # before falling back to the SPA shell.
        candidate = os.path.join(_dist_dir, full_path)  # pragma: no cover
        if os.path.isfile(candidate):  # pragma: no cover
            return FileResponse(candidate)  # pragma: no cover
        return FileResponse(  # pragma: no cover
            os.path.join(_dist_dir, "index.html"),  # pragma: no cover
            headers=_NO_CACHE,  # pragma: no cover
        )  # pragma: no cover

__all__ = ["app"]
