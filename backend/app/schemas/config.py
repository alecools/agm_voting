"""
Pydantic schemas for tenant configuration and SMTP settings.
"""
from __future__ import annotations

import re
from typing import Optional

from pydantic import BaseModel, ConfigDict, field_validator

_HEX_COLOUR_RE = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


class LogoUploadOut(BaseModel):
    url: str


class FaviconUploadOut(BaseModel):
    url: str


class TenantConfigOut(BaseModel):
    app_name: str
    logo_url: str
    favicon_url: Optional[str]
    primary_colour: str
    support_email: str

    model_config = ConfigDict(from_attributes=True)


class TenantConfigUpdate(BaseModel):
    app_name: str
    logo_url: str = ""
    favicon_url: Optional[str] = None
    primary_colour: str
    support_email: str = ""

    @field_validator("app_name")
    @classmethod
    def app_name_non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("app_name must not be empty")
        return v.strip()

    @field_validator("primary_colour")
    @classmethod
    def primary_colour_valid_hex(cls, v: str) -> str:
        if not _HEX_COLOUR_RE.match(v):
            raise ValueError(
                "primary_colour must be a valid CSS hex colour (e.g. #1a73e8 or #fff)"
            )
        return v

    @field_validator("logo_url", "support_email")
    @classmethod
    def strip_optional(cls, v: str) -> str:
        return v.strip()

    @field_validator("favicon_url")
    @classmethod
    def strip_favicon_url(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        stripped = v.strip()
        return stripped if stripped else None


# ---------------------------------------------------------------------------
# SMTP configuration schemas
# ---------------------------------------------------------------------------


class SmtpConfigOut(BaseModel):
    """SMTP configuration returned to clients — password is never included."""

    smtp_host: str
    smtp_port: int
    smtp_username: str
    smtp_from_email: str
    password_is_set: bool

    model_config = ConfigDict(from_attributes=True)


class SmtpConfigUpdate(BaseModel):
    """Input for updating SMTP configuration.

    smtp_password is optional — omitting it (or passing None / empty string)
    leaves the existing stored password unchanged.
    """

    smtp_host: str
    smtp_port: int = 587
    smtp_username: str
    smtp_from_email: str
    smtp_password: Optional[str] = None

    @field_validator("smtp_host")
    @classmethod
    def smtp_host_non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("smtp_host must not be empty")
        return v.strip()

    @field_validator("smtp_port")
    @classmethod
    def smtp_port_in_range(cls, v: int) -> int:
        if not 1 <= v <= 65535:
            raise ValueError("smtp_port must be between 1 and 65535")
        return v

    @field_validator("smtp_username")
    @classmethod
    def smtp_username_non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("smtp_username must not be empty")
        return v.strip()

    @field_validator("smtp_from_email")
    @classmethod
    def smtp_from_email_valid(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("smtp_from_email must not be empty")
        v = v.strip()
        if "@" not in v:
            raise ValueError("smtp_from_email must be a valid email address")
        return v


class SmtpStatusOut(BaseModel):
    """SMTP configuration status — used by the admin layout banner."""

    configured: bool
