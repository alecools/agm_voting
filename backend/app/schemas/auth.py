import uuid

from pydantic import BaseModel, field_validator


class AuthVerifyRequest(BaseModel):
    lot_number: str
    email: str
    building_id: uuid.UUID
    agm_id: uuid.UUID

    @field_validator("lot_number")
    @classmethod
    def lot_number_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("lot_number must not be empty")
        return v

    @field_validator("email")
    @classmethod
    def email_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("email must not be empty")
        return v


class AuthVerifyResponse(BaseModel):
    already_submitted: bool
    voter_email: str
    agm_status: str
