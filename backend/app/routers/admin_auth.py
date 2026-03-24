"""
Admin authentication endpoints and require_admin dependency.
  POST /api/admin/auth/login
  POST /api/admin/auth/logout
  GET  /api/admin/auth/me
  POST /api/admin/auth/hash-password  (dev-only helper)
"""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.config import settings
from app.schemas.admin import AdminLoginRequest

router = APIRouter(tags=["admin-auth"])

from passlib.context import CryptContext

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def _verify_admin_password(plain: str, stored: str) -> bool:
    """Verify a plaintext password against a stored value.

    If the stored value looks like a bcrypt hash, use bcrypt comparison.
    Otherwise fall back to a plaintext equality check so existing deployments
    that have a plaintext ADMIN_PASSWORD env var continue to work without
    requiring an immediate re-configuration step.
    """
    if stored.startswith("$2b$") or stored.startswith("$2a$"):
        return _pwd_context.verify(plain, stored)
    return plain == stored  # fallback for plaintext env vars


def require_admin(request: Request) -> None:
    """Dependency: raises 401 if the admin session cookie is not present."""
    if not request.session.get("admin"):
        raise HTTPException(status_code=401, detail="Authentication required")


@router.post("/auth/login")
async def admin_login(data: AdminLoginRequest, request: Request) -> dict:
    if data.username != settings.admin_username or not _verify_admin_password(
        data.password, settings.admin_password
    ):
        raise HTTPException(status_code=401, detail="Invalid credentials")
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
    hashed = _pwd_context.hash(data.password)
    return {"hash": hashed}
