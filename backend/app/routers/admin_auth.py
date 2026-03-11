"""
Admin authentication endpoints and require_admin dependency.
  POST /api/admin/auth/login
  POST /api/admin/auth/logout
  GET  /api/admin/auth/me
"""
from fastapi import APIRouter, HTTPException, Request

from app.config import settings
from app.schemas.admin import AdminLoginRequest

router = APIRouter(tags=["admin-auth"])


def require_admin(request: Request) -> None:
    """Dependency: raises 401 if the admin session cookie is not present."""
    if not request.session.get("admin"):
        raise HTTPException(status_code=401, detail="Authentication required")


@router.post("/auth/login")
async def admin_login(data: AdminLoginRequest, request: Request) -> dict:
    if data.username != settings.admin_username or data.password != settings.admin_password:
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
