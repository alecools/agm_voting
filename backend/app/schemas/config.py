"""
Pydantic schemas for tenant configuration.
"""
from __future__ import annotations

import re

from pydantic import BaseModel, ConfigDict, field_validator

_HEX_COLOUR_RE = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


class TenantConfigOut(BaseModel):
    app_name: str
    logo_url: str
    primary_colour: str
    support_email: str

    model_config = ConfigDict(from_attributes=True)


class TenantConfigUpdate(BaseModel):
    app_name: str
    logo_url: str = ""
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
