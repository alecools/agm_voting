import uuid
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator


class SessionRestoreRequest(BaseModel):
    general_meeting_id: uuid.UUID
    session_token: Optional[str] = None

    @field_validator("session_token")
    @classmethod
    def token_not_empty(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not v.strip():
            raise ValueError("session_token must not be empty")
        return v


class OtpRequestBody(BaseModel):
    email: str = Field(..., max_length=254)
    general_meeting_id: uuid.UUID
    # channel is optional: when None, backend auto-selects enabled_channels[0].
    # When supplied, backend enforces that it is in enabled_channels.
    channel: Optional[Literal["email", "sms"]] = None

    @field_validator("email")
    @classmethod
    def email_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("email must not be empty")
        return v


class OtpRequestResponse(BaseModel):
    sent: bool
    has_phone: bool = False
    phone_hint: str | None = None
    enabled_channels: list[str] = ["email"]


class AuthVerifyRequest(BaseModel):
    email: str = Field(..., max_length=254)
    general_meeting_id: uuid.UUID
    code: str = Field(..., max_length=20)

    @field_validator("email")
    @classmethod
    def email_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("email must not be empty")
        return v

    @field_validator("code")
    @classmethod
    def code_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("code must not be empty")
        return v.strip()


class LotInfo(BaseModel):
    lot_owner_id: uuid.UUID
    lot_number: str
    financial_position: str
    already_submitted: bool
    is_proxy: bool = False
    voted_motion_ids: list[uuid.UUID] = []  # motion IDs with submitted votes for this lot


class AuthVerifyResponse(BaseModel):
    lots: list[LotInfo]
    voter_email: str
    agm_status: str
    building_name: str
    meeting_title: str
    unvoted_visible_count: int = 0
    session_token: str = ""  # nosemgrep: no-hardcoded-secrets -- Pydantic response model field; empty string is a safe default for optional token field, not a credential
