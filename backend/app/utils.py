"""Shared utility functions used across multiple routers."""
from __future__ import annotations

from fastapi import Request

from app.config import settings


def derive_origin(request: Request) -> str:
    """Return the browser-facing origin of the incoming request.

    On Vercel, x-forwarded-proto and x-forwarded-host carry the browser-facing
    scheme and hostname.  Falls back to settings.allowed_origin for local dev
    where those headers are absent.

    This function is the single canonical implementation — auth_proxy.py and
    admin.py both import from here to avoid a circular import.
    """
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
    host = request.headers.get("x-forwarded-host", "").split(",")[0].strip()
    if proto and host:
        return f"{proto}://{host}"
    return settings.allowed_origin.strip()
