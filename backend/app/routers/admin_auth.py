"""
Admin authentication endpoints and require_admin dependency.
  POST /api/admin/auth/login
  POST /api/admin/auth/logout
  GET  /api/admin/auth/me
  POST /api/admin/auth/hash-password  (dev-only helper)
"""
import hmac
from datetime import UTC, datetime, timedelta

import bcrypt as _bcrypt_lib
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import delete as sql_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.admin_login_attempt import AdminLoginAttempt
from app.schemas.admin import AdminLoginRequest

router = APIRouter(tags=["admin-auth"])

# ---------------------------------------------------------------------------
# Rate-limit constants — 5 failures within 15 minutes → 429
# ---------------------------------------------------------------------------
_LOGIN_MAX_FAILURES = 5
_LOGIN_WINDOW_SECONDS = 900  # 15 minutes


def get_client_ip(request: Request) -> str:
    """Return the real client IP address, honouring X-Forwarded-For from Vercel proxy.

    Vercel sets X-Forwarded-For to the originating client IP before forwarding the
    request to the Lambda.  Reading request.client.host would return the Vercel proxy
    IP instead of the real client, causing all rate-limit records to share a single
    IP and making rate-limiting ineffective (RR3-15).

    Falls back to request.client.host when X-Forwarded-For is absent (e.g. local dev).
    """
    forwarded_for = request.headers.get("X-Forwarded-For")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _verify_admin_password(plain: str, stored: str) -> bool:
    """Verify a plaintext password against a bcrypt-hashed stored value.

    Uses the bcrypt library directly (not passlib) for compatibility with
    bcrypt >= 5.0 which removed the __about__ module that passlib 1.7.x
    relied on.

    Raises ValueError if `stored` is not a bcrypt hash (i.e. does not start
    with $2b$ or $2a$). Plaintext env-var passwords are no longer supported —
    run /api/admin/auth/hash-password to generate a hash first.
    """
    if stored.startswith("$2b$") or stored.startswith("$2a$"):
        return _bcrypt_lib.checkpw(plain.encode(), stored.encode())
    raise ValueError(
        "ADMIN_PASSWORD must be a bcrypt hash. "
        "Run /api/admin/auth/hash-password to generate one."
    )


def require_admin(request: Request) -> None:
    """Dependency: raises 401 if the admin session cookie is not present."""
    if not request.session.get("admin"):
        raise HTTPException(status_code=401, detail="Authentication required")


@router.post("/auth/login")
async def admin_login(
    data: AdminLoginRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> dict:
    ip = get_client_ip(request)

    # --- Rate-limit check (atomic: SELECT FOR UPDATE + write in same transaction) ---
    # SELECT FOR UPDATE locks the row so concurrent login requests for the same IP
    # cannot both pass the rate-limit check before either records a failure (RR3-13).
    now = datetime.now(UTC)
    window_start = now - timedelta(seconds=_LOGIN_WINDOW_SECONDS)

    attempt_result = await db.execute(
        select(AdminLoginAttempt)
        .where(AdminLoginAttempt.ip_address == ip)
        .with_for_update()
    )
    attempt_record = attempt_result.scalar_one_or_none()

    if attempt_record is not None:
        # Expire the record if the window has passed
        if attempt_record.first_attempt_at.replace(tzinfo=UTC) < window_start:
            await db.execute(sql_delete(AdminLoginAttempt).where(AdminLoginAttempt.id == attempt_record.id))
            await db.flush()
            attempt_record = None

    if (
        attempt_record is not None
        and attempt_record.failed_count >= _LOGIN_MAX_FAILURES
    ):
        raise HTTPException(
            status_code=429,
            detail="Too many failed login attempts. Try again in 15 minutes.",
        )

    # --- Credential verification ---
    # Use timing-safe comparison for both username and password so that a wrong
    # username does not short-circuit before bcrypt runs — preventing a timing
    # oracle that could enumerate valid usernames.
    try:
        valid_username = hmac.compare_digest(data.username, settings.admin_username)
        valid_password = _verify_admin_password(data.password, settings.admin_password)
    except ValueError:
        # ADMIN_PASSWORD is not a bcrypt hash — raised by _verify_admin_password.
        # Return a generic 500 so the raw error message is never sent to the client
        # (LOW-7). The startup validator in config.py catches this in non-development
        # environments; this handler is the last-resort safety net for dev deployments.
        raise HTTPException(status_code=500, detail="Server configuration error")
    valid = valid_username and valid_password

    if not valid:
        # Record the failed attempt — in the same transaction as the SELECT FOR UPDATE
        # above, so the check and the record creation are atomic (RR3-13).
        if attempt_record is None:
            db.add(
                AdminLoginAttempt(
                    ip_address=ip,
                    failed_count=1,
                    first_attempt_at=now,
                    last_attempt_at=now,
                )
            )
        else:
            attempt_record.failed_count += 1
            attempt_record.last_attempt_at = now
        await db.flush()
        await db.commit()
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # --- Successful login: reset failure counter ---
    if attempt_record is not None:
        await db.execute(sql_delete(AdminLoginAttempt).where(AdminLoginAttempt.id == attempt_record.id))
        await db.flush()
    await db.commit()

    request.session["admin"] = True
    request.session["admin_username"] = data.username
    return {"ok": True}


@router.post("/auth/logout")
async def admin_logout(request: Request) -> dict:
    request.session.clear()
    return {"ok": True}


@router.get("/auth/me")
async def admin_me(request: Request) -> dict:
    if not request.session.get("admin"):
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {"authenticated": True}


class HashPasswordRequest(BaseModel):
    password: str


@router.post("/auth/hash-password")
async def hash_password(
    data: HashPasswordRequest,
    _admin: None = Depends(require_admin),
) -> dict:
    """Dev helper: returns the bcrypt hash for a given plaintext password.

    Only available in the development environment (MED-6). On demo, preview,
    and production deployments the endpoint returns 404 so it cannot be used
    even by an authenticated admin — preventing accidental exposure of the
    hashing utility on shared environments.

    On local development the require_admin dependency is still enforced
    (admin session cookie required).
    """
    if settings.environment != "development":
        raise HTTPException(status_code=404, detail="Not found")
    hashed = _bcrypt_lib.hashpw(data.password.encode(), _bcrypt_lib.gensalt()).decode()
    return {"hash": hashed}
