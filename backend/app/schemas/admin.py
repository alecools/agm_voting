"""
Pydantic schemas for the admin portal API.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, field_validator, model_validator

from app.models.motion import MotionType


# ---------------------------------------------------------------------------
# Building schemas
# ---------------------------------------------------------------------------


class BuildingOut(BaseModel):
    id: uuid.UUID
    name: str
    manager_email: str
    is_archived: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class BuildingCreate(BaseModel):
    name: str
    manager_email: str

    @field_validator("name")
    @classmethod
    def name_non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("name must not be empty")
        return v

    @field_validator("manager_email")
    @classmethod
    def email_non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("manager_email must not be empty")
        return v


class BuildingImportResult(BaseModel):
    created: int
    updated: int


# ---------------------------------------------------------------------------
# Lot owner schemas
# ---------------------------------------------------------------------------


class LotOwnerOut(BaseModel):
    id: uuid.UUID
    lot_number: str
    emails: list[str]
    unit_entitlement: int
    financial_position: str
    proxy_email: str | None = None

    model_config = {"from_attributes": True}


class LotOwnerCreate(BaseModel):
    lot_number: str
    unit_entitlement: int
    financial_position: str = "normal"
    emails: list[str] = []

    @field_validator("unit_entitlement")
    @classmethod
    def entitlement_non_negative(cls, v: int) -> int:
        if v < 0:
            raise ValueError("unit_entitlement must be >= 0")
        return v

    @field_validator("lot_number")
    @classmethod
    def lot_number_non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("lot_number must not be empty")
        return v

    @field_validator("financial_position")
    @classmethod
    def financial_position_valid(cls, v: str) -> str:
        if v not in ("normal", "in_arrear"):
            raise ValueError("financial_position must be 'normal' or 'in_arrear'")
        return v


class LotOwnerUpdate(BaseModel):
    unit_entitlement: int | None = None
    financial_position: str | None = None

    @field_validator("unit_entitlement")
    @classmethod
    def entitlement_non_negative(cls, v: int | None) -> int | None:
        if v is not None and v < 0:
            raise ValueError("unit_entitlement must be >= 0")
        return v

    @field_validator("financial_position")
    @classmethod
    def financial_position_valid(cls, v: str | None) -> str | None:
        if v is not None and v not in ("normal", "in_arrear"):
            raise ValueError("financial_position must be 'normal' or 'in_arrear'")
        return v

    @model_validator(mode="after")
    def at_least_one_field(self) -> "LotOwnerUpdate":
        if self.unit_entitlement is None and self.financial_position is None:
            raise ValueError("At least one of unit_entitlement or financial_position must be provided")
        return self


class AddEmailRequest(BaseModel):
    email: str

    @field_validator("email")
    @classmethod
    def email_non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("email must not be empty")
        return v


class LotOwnerImportResult(BaseModel):
    imported: int
    emails: int


# ---------------------------------------------------------------------------
# Motion schemas
# ---------------------------------------------------------------------------


class MotionCreate(BaseModel):
    title: str
    description: str | None = None
    order_index: int
    motion_type: MotionType = MotionType.general


class MotionOut(BaseModel):
    id: uuid.UUID
    title: str
    description: str | None
    order_index: int
    motion_type: MotionType

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# General Meeting schemas
# ---------------------------------------------------------------------------


class GeneralMeetingCreate(BaseModel):
    building_id: uuid.UUID
    title: str
    meeting_at: datetime
    voting_closes_at: datetime
    motions: list[MotionCreate]

    @field_validator("motions")
    @classmethod
    def at_least_one_motion(cls, v: list[MotionCreate]) -> list[MotionCreate]:
        if not v:
            raise ValueError("At least one motion is required")
        return v

    @model_validator(mode="after")
    def voting_closes_after_meeting(self) -> "GeneralMeetingCreate":
        if self.voting_closes_at <= self.meeting_at:
            raise ValueError("voting_closes_at must be after meeting_at")
        return self


class GeneralMeetingOut(BaseModel):
    id: uuid.UUID
    building_id: uuid.UUID
    title: str
    status: str
    meeting_at: datetime
    voting_closes_at: datetime
    motions: list[MotionOut]

    model_config = {"from_attributes": True}


class GeneralMeetingListItem(BaseModel):
    id: uuid.UUID
    building_id: uuid.UUID
    building_name: str
    title: str
    status: str
    meeting_at: datetime
    voting_closes_at: datetime
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# AGM detail / results schemas
# ---------------------------------------------------------------------------


class VoterEntry(BaseModel):
    voter_email: str
    lot_number: str
    entitlement: int


class TallyCategory(BaseModel):
    voter_count: int
    entitlement_sum: int


class MotionTally(BaseModel):
    yes: TallyCategory
    no: TallyCategory
    abstained: TallyCategory
    absent: TallyCategory
    not_eligible: TallyCategory


class MotionVoterLists(BaseModel):
    yes: list[VoterEntry]
    no: list[VoterEntry]
    abstained: list[VoterEntry]
    absent: list[VoterEntry]
    not_eligible: list[VoterEntry]


class MotionDetail(BaseModel):
    id: uuid.UUID
    title: str
    description: str | None
    order_index: int
    motion_type: MotionType
    tally: MotionTally
    voter_lists: MotionVoterLists


class GeneralMeetingDetail(BaseModel):
    id: uuid.UUID
    building_name: str
    title: str
    status: str
    meeting_at: datetime
    voting_closes_at: datetime
    closed_at: datetime | None
    total_eligible_voters: int
    total_submitted: int
    total_entitlement: int
    motions: list[MotionDetail]


# ---------------------------------------------------------------------------
# General Meeting close / resend schemas
# ---------------------------------------------------------------------------


class GeneralMeetingStartOut(BaseModel):
    id: uuid.UUID
    status: str
    meeting_at: datetime


class GeneralMeetingCloseOut(BaseModel):
    id: uuid.UUID
    status: str
    closed_at: datetime
    voting_closes_at: datetime


class ResendReportOut(BaseModel):
    queued: bool


class GeneralMeetingBallotResetOut(BaseModel):
    deleted: int


# ---------------------------------------------------------------------------
# Archive schemas
# ---------------------------------------------------------------------------


class BuildingArchiveOut(BaseModel):
    id: uuid.UUID
    name: str
    is_archived: bool

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Proxy nomination import schemas
# ---------------------------------------------------------------------------


class ProxyImportResult(BaseModel):
    upserted: int
    removed: int
    skipped: int


# ---------------------------------------------------------------------------
# Financial position import schemas
# ---------------------------------------------------------------------------


class FinancialPositionImportResult(BaseModel):
    updated: int
    skipped: int


# ---------------------------------------------------------------------------
# Admin auth schemas
# ---------------------------------------------------------------------------


class AdminLoginRequest(BaseModel):
    username: str
    password: str
