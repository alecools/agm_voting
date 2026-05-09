"""
Pydantic schemas for tenant configuration, SMTP settings, and SMS settings.
"""
from __future__ import annotations

import re
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, field_validator, model_validator

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
    otp_email_enabled: bool = True
    otp_sms_enabled: bool = False

    model_config = ConfigDict(from_attributes=True)


class TenantConfigUpdate(BaseModel):
    app_name: str
    logo_url: str = ""
    favicon_url: Optional[str] = None
    primary_colour: str
    support_email: str = ""
    otp_email_enabled: bool = True
    otp_sms_enabled: bool = False

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

    @model_validator(mode="after")
    def at_least_one_channel(self) -> "TenantConfigUpdate":
        if not self.otp_email_enabled and not self.otp_sms_enabled:
            raise ValueError("At least one verification method must be enabled")
        return self


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


# ---------------------------------------------------------------------------
# SMS configuration schemas
# ---------------------------------------------------------------------------

_SMS_PROVIDERS = {"smtp2go", "twilio", "clicksend", "webhook"}


class SmsConfigOut(BaseModel):
    """SMS configuration returned to clients — secrets are never included."""

    sms_enabled: bool
    sms_provider: Optional[str]
    sms_from_number: Optional[str]
    sms_webhook_url: Optional[str]
    # Presence flags instead of raw secrets
    sms_webhook_secret_is_set: bool
    sms_smtp2go_api_key_is_set: bool
    sms_twilio_account_sid: Optional[str]
    sms_twilio_auth_token_is_set: bool
    sms_twilio_from_number: Optional[str]
    sms_clicksend_username: Optional[str]
    sms_clicksend_api_key_is_set: bool
    sms_clicksend_from_number: Optional[str]


class SmsConfigUpdate(BaseModel):
    """Input for updating SMS configuration.

    Encrypted secret fields are optional — omitting / passing None leaves
    the existing stored value unchanged (same pattern as smtp_password).
    """

    sms_enabled: bool = False
    sms_provider: Optional[Literal["smtp2go", "twilio", "clicksend", "webhook"]] = None
    sms_from_number: Optional[str] = None
    sms_webhook_url: Optional[str] = None
    sms_webhook_secret: Optional[str] = None
    sms_smtp2go_api_key: Optional[str] = None
    sms_twilio_account_sid: Optional[str] = None
    sms_twilio_auth_token: Optional[str] = None
    sms_twilio_from_number: Optional[str] = None
    sms_clicksend_username: Optional[str] = None
    sms_clicksend_api_key: Optional[str] = None
    sms_clicksend_from_number: Optional[str] = None


class SmsTestRequest(BaseModel):
    to: str

    @field_validator("to")
    @classmethod
    def to_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("to must not be empty")
        return v.strip()
