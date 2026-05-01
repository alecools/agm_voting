import asyncio
import logging
import traceback
import uuid as _uuid_module
from contextlib import asynccontextmanager
from contextvars import ContextVar

import structlog
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.sessions import SessionMiddleware

from app.config import settings
from app.logging_config import configure_logging, get_logger
from app.routers.admin import router as admin_router, debug_unauthed_router as admin_debug_unauthed_router

configure_logging()

logger = logging.getLogger(__name__)
_structlog_logger = get_logger(__name__)

# RR3-38: Per-request ID stored in a context variable so all log lines within
# a request include the same request_id for distributed trace correlation.
_request_id_var: ContextVar[str] = ContextVar("request_id", default="")


_SECURITY_HEADERS = {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "X-XSS-Protection": "1; mode=block",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://vercel.live https://*.vercel.live; "  # unsafe-inline required for Vite module preload polyfill; vercel.live required for Vercel preview feedback widget
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data: https:; "
        "connect-src 'self' https://vercel.live wss://vercel.live https://*.vercel.live wss://*.vercel.live; "  # vercel.live WSS and wildcard subdomains required for Vercel preview feedback widget
        "frame-src https://vercel.live https://*.vercel.live; "  # allows Vercel preview toolbar to load iframes
        "frame-ancestors 'none'"
    ),
}


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # RR4-16: Block all requests when a migration head mismatch was detected
        # at startup, ensuring the Lambda does not serve stale/incompatible data.
        # Health probes (/api/health/live) are exempted so load balancers can
        # detect the degraded state and route traffic elsewhere.
        if _migration_head_mismatch and request.url.path != "/api/health/live":
            mismatch_response = JSONResponse(
                status_code=503,
                content={"detail": "Service unavailable: database migration mismatch"},
            )
            for header, value in _SECURITY_HEADERS.items():
                mismatch_response.headers[header] = value
            return mismatch_response
        try:
            response = await call_next(request)
        except Exception as exc:
            # Catch unhandled exceptions that propagate through call_next (RR3-11).
            # BaseHTTPMiddleware re-raises route exceptions via call_next, bypassing
            # FastAPI's app.exception_handler(Exception) registration.  We catch them
            # here to: (a) log the full traceback server-side, and (b) return a safe
            # generic 500 response so internal details never reach the client.
            logger.error("Unhandled exception: %s\n%s", exc, traceback.format_exc())
            error_response = JSONResponse(
                status_code=500,
                content={"detail": "An internal error occurred"},
            )
            for header, value in _SECURITY_HEADERS.items():
                error_response.headers[header] = value
            return error_response
        for header, value in _SECURITY_HEADERS.items():
            response.headers[header] = value
        return response


class CSRFMiddleware(BaseHTTPMiddleware):
    """US-IAS-05: Require X-Requested-With header on all state-changing requests.

    SameSite=Lax cookies are NOT automatically included in cross-origin subresource
    requests (XHR/fetch) but ARE included on top-level navigation POST from the same
    site.  By requiring the X-Requested-With header on POST/PATCH/PUT/DELETE we prevent
    cross-origin form-based CSRF attacks: a cross-origin attacker cannot set arbitrary
    request headers without first passing a CORS preflight, which our CORS policy blocks.

    Exceptions:
    - OPTIONS (preflight) — must not be blocked
    - GET/HEAD — safe/idempotent, no state change
    - /api/auth/sign-in/email — Better Auth sign-in endpoint; the SDK does not send
      X-Requested-With and the endpoint is rate-limited by AdminLoginRateLimitMiddleware.
    - /api/auth/sign-out — Better Auth sign-out endpoint.
    - testing_mode=True — CSRF check is skipped entirely so unit/integration tests that
      do not send X-Requested-With are not blocked.
    """

    # All /api/auth/* paths are exempt: the Better Auth SDK does not send
    # X-Requested-With.  These paths are either rate-limited by
    # AdminLoginRateLimitMiddleware (sign-in) or require a valid session
    # cookie (other authenticated endpoints), providing equivalent protection.
    _EXEMPT_PREFIX = "/api/auth/"
    _STATE_CHANGING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

    async def dispatch(self, request: Request, call_next):
        # Skip CSRF in testing mode so integration tests are not required to send the header.
        if settings.testing_mode:
            return await call_next(request)
        if (
            request.method in self._STATE_CHANGING_METHODS
            and not request.url.path.startswith(self._EXEMPT_PREFIX)
            and "X-Requested-With" not in request.headers
        ):
            return JSONResponse(
                status_code=403,
                content={"detail": "CSRF check failed: X-Requested-With header missing"},
            )
        return await call_next(request)


class RequestIDMiddleware(BaseHTTPMiddleware):
    """RR3-38: Attach a UUID request ID to every request.

    Generates a new UUID per request, stores it in the _request_id_var context
    variable, and binds it into structlog's context so every log line emitted
    within the request includes ``request_id``.  Also sets the X-Request-ID
    response header for client-side correlation.
    """

    async def dispatch(self, request: Request, call_next):
        request_id = str(_uuid_module.uuid4())
        _request_id_var.set(request_id)
        structlog.contextvars.bind_contextvars(request_id=request_id)
        try:
            response = await call_next(request)
        finally:
            structlog.contextvars.unbind_contextvars("request_id")
        response.headers["X-Request-ID"] = request_id
        return response


class AdminLoginRateLimitMiddleware(BaseHTTPMiddleware):
    """Rate-limit POST /api/auth/sign-in/email using the AdminLoginAttempt table.

    Wraps the Better Auth sign-in endpoint transparently:
    - Pre-request: if the IP has >= 5 failures within the 15-minute window → 429
    - Post-response: if Better Auth returns non-2xx, record a failure; if 2xx, clear failures

    Two separate DB sessions are used — one before call_next (check + possible early return)
    and one after (record outcome).  A single open transaction across call_next is not
    possible because Starlette BaseHTTPMiddleware streams the response body lazily.

    Path: POST /api/auth/sign-in/email only. All other requests pass through unchanged.
    """

    _TARGET_PATH = "/api/auth/sign-in/email"
    _MAX_FAILURES = 5
    _WINDOW_SECONDS = 900  # 15 minutes

    async def dispatch(self, request: Request, call_next):
        if request.method != "POST" or request.url.path != self._TARGET_PATH:
            return await call_next(request)

        from datetime import UTC, datetime, timedelta
        from sqlalchemy import delete as sql_delete, select
        from app.database import AsyncSessionLocal
        from app.models.admin_login_attempt import AdminLoginAttempt
        from app.dependencies import get_client_ip

        ip = get_client_ip(request)
        now = datetime.now(UTC)
        window_start = now - timedelta(seconds=self._WINDOW_SECONDS)

        # --- Pre-request check: is this IP rate-limited? ---
        async with AsyncSessionLocal() as db:
            attempt_result = await db.execute(
                select(AdminLoginAttempt)
                .where(AdminLoginAttempt.ip_address == ip)
                .with_for_update()
            )
            attempt_record = attempt_result.scalar_one_or_none()

            # Expire stale window
            if attempt_record is not None:
                if attempt_record.first_attempt_at.replace(tzinfo=UTC) < window_start:
                    await db.execute(
                        sql_delete(AdminLoginAttempt)
                        .where(AdminLoginAttempt.id == attempt_record.id)
                    )
                    await db.flush()
                    attempt_record = None

            if (
                attempt_record is not None
                and attempt_record.failed_count >= self._MAX_FAILURES
            ):
                await db.commit()
                return JSONResponse(
                    status_code=429,
                    content={"detail": "Too many failed login attempts. Try again in 15 minutes."},
                )

            await db.commit()  # release FOR UPDATE lock before calling next handler

        # --- Call the Better Auth handler ---
        response = await call_next(request)

        # --- Post-response: record success or failure ---
        async with AsyncSessionLocal() as db:
            attempt_result = await db.execute(
                select(AdminLoginAttempt)
                .where(AdminLoginAttempt.ip_address == ip)
                .with_for_update()
            )
            attempt_record = attempt_result.scalar_one_or_none()

            if response.status_code >= 400:
                # Record failure
                if attempt_record is None:
                    db.add(AdminLoginAttempt(
                        ip_address=ip,
                        failed_count=1,
                        first_attempt_at=now,
                        last_attempt_at=now,
                    ))
                else:
                    attempt_record.failed_count += 1
                    attempt_record.last_attempt_at = now
            else:
                # Successful login — clear failure record
                if attempt_record is not None:
                    await db.execute(
                        sql_delete(AdminLoginAttempt)
                        .where(AdminLoginAttempt.id == attempt_record.id)
                    )

            await db.commit()

        return response


# RR4-34: Cache the migration head check result after the first cold-start
# invocation so subsequent warm Lambda invocations skip the DB query entirely.
_migration_head_checked: bool = False
# RR4-16: When a mismatch is detected, set this flag so all routes return 503.
_migration_head_mismatch: bool = False


async def _check_migration_head() -> None:
    """Verify the DB schema is at the expected Alembic head revision (RR3-20).

    Performs a direct SELECT on alembic_version rather than running
    `alembic current` (which spawns a subprocess) so the check completes
    in < 100 ms.

    RR4-16: Raises RuntimeError on mismatch so the Lambda fails fast.
    RR4-34: Caches the result in a module-level flag so warm invocations
    skip the DB query entirely.
    """
    global _migration_head_checked, _migration_head_mismatch  # noqa: PLW0603

    # RR4-34: Skip the DB query on warm invocations.
    if _migration_head_checked:
        return

    try:
        from alembic.config import Config as AlembicConfig
        from alembic.script import ScriptDirectory
        from sqlalchemy import text as _text
        from app.database import AsyncSessionLocal

        # Resolve the Alembic head revision from the migration scripts.
        # script_location is relative to the backend directory.
        import os
        _backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        alembic_cfg = AlembicConfig(os.path.join(_backend_dir, "alembic.ini"))
        script = ScriptDirectory.from_config(alembic_cfg)
        head_rev = script.get_current_head()
        _structlog_logger.info("migration_head_resolved", head_rev=head_rev, backend_dir=_backend_dir)

        if head_rev is None:
            _structlog_logger.warning(
                "migration_head_resolution_failed",
                backend_dir=_backend_dir,
                reason="get_current_head() returned None — skipping mismatch check",
            )
            return  # Do not set _migration_head_mismatch — benefit of doubt

        async with AsyncSessionLocal() as db:
            result = await db.execute(_text("SELECT version_num FROM alembic_version LIMIT 1"))
            row = result.first()
            current_rev = row[0] if row else None

        if current_rev != head_rev:
            _migration_head_mismatch = True
            _structlog_logger.critical(
                "migration_head_mismatch",
                current_revision=current_rev,
                expected_head=head_rev,
            )
            # RR4-16: Raise so that requests are blocked until the Lambda is
            # redeployed with the correct migration applied.
            raise RuntimeError(
                f"Migration head mismatch: DB has {current_rev!r}, expected {head_rev!r}"
            )
        else:
            _structlog_logger.info(
                "migration_head_ok",
                revision=current_rev,
            )
    except RuntimeError:
        raise
    except Exception as exc:
        _structlog_logger.error("migration_head_check_failed", error=str(exc))
    finally:
        # Mark as checked regardless of outcome so warm invocations skip the DB query.
        _migration_head_checked = True


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: check migration head and requeue pending email deliveries.
    #
    # IMPORTANT — sequential execution is intentional and must not be changed
    # to asyncio.gather() or any concurrent form.
    #
    # Both _check_migration_head() and requeue_pending_on_startup() acquire a
    # DB connection from AsyncSessionLocal (QueuePool via PgBouncer — same
    # engine as request handlers).  Sequential awaits ensure the first operation
    # fully acquires, uses, and releases its connection before the second one
    # begins, keeping startup predictable.
    #
    # Retry startup DB tasks on transient connection errors.
    # Under concurrent Lambda cold-starts (e.g. 3 parallel E2E shards), asyncpg's
    # connect_timeout can fire when many instances race to connect simultaneously.
    # Retry with backoff (1s, 2s) staggers attempts and gives PgBouncer time to clear.
    # Uses the same exception types as get_db() in database.py.
    from app.database import AsyncSessionLocal, _DB_RETRY_ATTEMPTS, _DB_RETRY_BASE_WAIT
    from app.services.email_service import EmailService
    from sqlalchemy.exc import DBAPIError, OperationalError
    from sqlalchemy.exc import TimeoutError as SQLAlchemyTimeoutError

    for attempt in range(_DB_RETRY_ATTEMPTS):
        try:
            await _check_migration_head()
            async with AsyncSessionLocal() as db:
                await EmailService().requeue_pending_on_startup(db)
            break
        except (OperationalError, DBAPIError, SQLAlchemyTimeoutError, asyncio.TimeoutError):
            if attempt < _DB_RETRY_ATTEMPTS - 1:
                await asyncio.sleep(_DB_RETRY_BASE_WAIT * (2 ** attempt))
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
        # US-IAS-05: X-Requested-With is our CSRF double-submit header.
        # SameSite=Lax cookies are sent on top-level navigations from cross-origin
        # but NOT on cross-origin subresource requests (XHR/fetch).  However, to
        # defend against CSRF via cross-origin form posts that browsers still allow
        # on Lax, we also require X-Requested-With on every state-changing request
        # (enforced by CSRFMiddleware below).  A cross-origin attacker cannot set
        # arbitrary headers without passing the CORS preflight — providing strong CSRF
        # protection without needing a separate synchronizer token.
        allow_headers=["Content-Type", "Authorization", "Accept", "X-Requested-With"],
    )
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.session_secret,
        # https_only in all non-development environments (production + preview) — RR3-35
        https_only=settings.environment != "development",
        same_site="lax",
    )
    # SecurityHeadersMiddleware runs after CORS (Starlette runs middleware in
    # reverse registration order, so registering it last means it executes first
    # on the way in / last on the way out — ensuring headers are set on every
    # response including CORS preflight responses).
    app.add_middleware(SecurityHeadersMiddleware)
    # RR3-38: RequestIDMiddleware generates a UUID per request and binds it to
    # structlog context so all log lines include request_id.  Registered after
    # SecurityHeadersMiddleware so it executes before SecurityHeadersMiddleware
    # on the way in (Starlette reverse order).
    app.add_middleware(RequestIDMiddleware)
    # US-IAS-05: CSRFMiddleware enforces X-Requested-With on state-changing requests.
    app.add_middleware(CSRFMiddleware)
    # Rate-limit the Better Auth sign-in endpoint (POST /api/auth/sign-in/email).
    # Registered last so it is innermost — intercepts the request after CSRF passes.
    app.add_middleware(AdminLoginRateLimitMiddleware)

    @app.exception_handler(Exception)
    async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        """Catch-all handler that prevents raw exception messages reaching the client.

        Logs the full traceback server-side and returns a generic 500 response so
        that stack traces and internal error details are never exposed to callers
        (RR3-11).

        HTTPException is intentionally not caught here — FastAPI handles it
        before this handler runs, so it only fires for truly unhandled exceptions.
        """
        logger.error("Unhandled exception: %s\n%s", exc, traceback.format_exc())
        return JSONResponse(
            status_code=500,
            content={"detail": "An internal error occurred"},
        )

    from app.routers.public import router as public_router
    from app.routers.auth import router as auth_router
    from app.routers.voting import router as voting_router
    from app.routers.auth_proxy import router as auth_proxy_router

    app.include_router(public_router, prefix="/api")
    app.include_router(auth_router, prefix="/api")
    app.include_router(voting_router, prefix="/api")
    app.include_router(admin_router, prefix="/api/admin")
    app.include_router(admin_debug_unauthed_router, prefix="/api/admin")
    # auth_proxy_router is included last so it acts as a catch-all fallback for
    # any /api/auth/* path not handled by the routers above.
    app.include_router(auth_proxy_router)

    from app.database import get_db

    @app.get("/api/health")
    async def health(db: AsyncSession = Depends(get_db)) -> dict:
        """Health check that verifies live database connectivity.

        Executes SELECT 1 with a 2-second timeout.
        Returns 200 {"status": "ok", "db": "connected"} when the DB is reachable.
        Returns 503 {"status": "degraded", "db": "unreachable", "error": "..."} on
        any DB failure or timeout.
        """
        try:
            await asyncio.wait_for(db.execute(select(1)), timeout=2.0)
            return {"status": "ok", "db": "connected"}
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail={"status": "degraded", "db": "unreachable", "error": str(exc)},
            )

    @app.get("/api/health/live")
    async def health_live() -> dict:
        """Process liveness probe — always returns 200 without touching the DB.

        Use this endpoint for container/Lambda process-level liveness checks that
        must never fail due to transient DB issues.
        """
        return {"status": "ok"}

    return app


app = create_app()
