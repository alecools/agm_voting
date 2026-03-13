import uuid
from typing import Optional

from pydantic import BaseModel, field_validator


class AuthVerifyRequest(BaseModel):
    email: str
    general_meeting_id: uuid.UUID

    @field_validator("email")
    @classmethod
    def email_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("email must not be empty")
        return v


class LotInfo(BaseModel):
    lot_owner_id: uuid.UUID
    lot_number: str
    financial_position: str
    already_submitted: bool
    is_proxy: bool = False


class AuthVerifyResponse(BaseModel):
    lots: list[LotInfo]
    voter_email: str
    agm_status: str
    building_name: str
    meeting_title: str
