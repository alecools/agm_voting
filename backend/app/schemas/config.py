"""
Pydantic schemas for tenant configuration.
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
