"""
Admin authentication endpoints and require_admin dependency.
  POST /api/admin/auth/login
  POST /api/admin/auth/logout
  GET  /api/admin/auth/me
  POST /api/admin/auth/hash-password  (dev-only helper)
"""
from datetime import UTC, datetime, timedelta

import bcrypt as _bcrypt_lib
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
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
    ip = request.client.host if request.client else "unknown"  # pragma: no cover — client is always set in tests and production

    # --- Rate-limit check ---
    now = datetime.now(UTC)
    window_start = now - timedelta(seconds=_LOGIN_WINDOW_SECONDS)

    attempt_result = await db.execute(
        select(AdminLoginAttempt).where(AdminLoginAttempt.ip_address == ip)
    )
    attempt_record = attempt_result.scalar_one_or_none()

    if attempt_record is not None:
        # Expire the record if the window has passed
        if attempt_record.first_attempt_at.replace(tzinfo=UTC) < window_start:
            await db.delete(attempt_record)
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
    try:
        valid = (
            data.username == settings.admin_username
            and _verify_admin_password(data.password, settings.admin_password)
        )
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    if not valid:
        # Record the failed attempt
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
        await db.delete(attempt_record)
        await db.flush()
    await db.commit()

    request.session["admin"] = True
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
async def hash_password(data: HashPasswordRequest) -> dict:
    """Dev-only helper: returns the bcrypt hash for a given plaintext password.

    Only available when ENVIRONMENT != "production" so this endpoint is never
    reachable in a live deployment.
    """
    if settings.environment == "production":
        raise HTTPException(status_code=404, detail="Not found")
    hashed = _bcrypt_lib.hashpw(data.password.encode(), _bcrypt_lib.gensalt()).decode()
    return {"hash": hashed}
