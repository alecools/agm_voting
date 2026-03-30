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


class BuildingUpdate(BaseModel):
    name: str | None = None
    manager_email: str | None = None

    @field_validator("name")
    @classmethod
    def name_non_empty(cls, v: str | None) -> str | None:
        if v is not None and not v.strip():
            raise ValueError("name must not be empty")
        return v

    @field_validator("manager_email")
    @classmethod
    def email_non_empty(cls, v: str | None) -> str | None:
        if v is not None and not v.strip():
            raise ValueError("manager_email must not be empty")
        return v

    @model_validator(mode="after")
    def at_least_one_field(self) -> "BuildingUpdate":
        if self.name is None and self.manager_email is None:
            raise ValueError("At least one of name or manager_email must be provided")
        return self


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


class SetProxyRequest(BaseModel):
    proxy_email: str

    @field_validator("proxy_email")
    @classmethod
    def proxy_email_non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("proxy_email must not be empty")
        return v


class LotOwnerImportResult(BaseModel):
    imported: int
    emails: int


# ---------------------------------------------------------------------------
# Motion option schemas
# ---------------------------------------------------------------------------


class MotionOptionCreate(BaseModel):
    text: str
    display_order: int = 1

    @field_validator("text")
    @classmethod
    def text_non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("option text must not be empty")
        if len(v) > 200:
            raise ValueError("option text must not exceed 200 characters")
        return v


class MotionOptionOut(BaseModel):
    id: uuid.UUID
    text: str
    display_order: int

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Motion schemas
# ---------------------------------------------------------------------------


class MotionCreate(BaseModel):
    title: str
    description: str | None = None
    display_order: int
    motion_type: MotionType = MotionType.general
    is_multi_choice: bool = False
    motion_number: str | None = None
    option_limit: int | None = None
    options: list[MotionOptionCreate] = []

    @field_validator("title")
    @classmethod
    def title_max_length(cls, v: str) -> str:
        if len(v) > 500:
            raise ValueError("title must not exceed 500 characters")
        return v

    @field_validator("description")
    @classmethod
    def description_max_length(cls, v: str | None) -> str | None:
        if v is not None and len(v) > 2000:
            raise ValueError("description must not exceed 2000 characters")
        return v

    @field_validator("motion_number")
    @classmethod
    def motion_number_max_length(cls, v: str | None) -> str | None:
        if v is not None and len(v) > 50:
            raise ValueError("motion_number must not exceed 50 characters")
        return v

    @model_validator(mode="after")
    def validate_multi_choice_fields(self) -> "MotionCreate":
        if self.is_multi_choice:
            if self.option_limit is None or self.option_limit < 1:
                raise ValueError("option_limit must be >= 1 for multi_choice motions")
            if len(self.options) < 2:
                raise ValueError("multi_choice motions require at least 2 options")
            if self.option_limit > len(self.options):
                raise ValueError("option_limit cannot exceed the number of options")
        else:
            if self.option_limit is not None:
                raise ValueError("option_limit must be null for non-multi_choice motions")
            if self.options:
                raise ValueError("options must be empty for non-multi_choice motions")
        return self


class MotionOut(BaseModel):
    id: uuid.UUID
    title: str
    description: str | None
    display_order: int
    motion_number: str | None
    motion_type: MotionType
    is_multi_choice: bool = False
    is_visible: bool = True
    option_limit: int | None = None
    options: list[MotionOptionOut] = []

    model_config = {"from_attributes": True}


class MotionVisibilityRequest(BaseModel):
    is_visible: bool


class MotionVisibilityOut(BaseModel):
    id: uuid.UUID
    title: str
    description: str | None
    display_order: int
    motion_number: str | None
    motion_type: MotionType
    is_multi_choice: bool = False
    is_visible: bool
    option_limit: int | None = None
    options: list[MotionOptionOut] = []

    model_config = {"from_attributes": True}


class MotionAddRequest(BaseModel):
    title: str
    description: str | None = None
    motion_type: MotionType = MotionType.general
    is_multi_choice: bool = False
    motion_number: str | None = None
    option_limit: int | None = None
    options: list[MotionOptionCreate] = []

    @field_validator("title")
    @classmethod
    def title_non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("title must not be empty")
        if len(v) > 500:
            raise ValueError("title must not exceed 500 characters")
        return v

    @field_validator("description")
    @classmethod
    def description_max_length(cls, v: str | None) -> str | None:
        if v is not None and len(v) > 2000:
            raise ValueError("description must not exceed 2000 characters")
        return v

    @field_validator("motion_number")
    @classmethod
    def motion_number_max_length(cls, v: str | None) -> str | None:
        if v is not None and len(v) > 50:
            raise ValueError("motion_number must not exceed 50 characters")
        return v

    @model_validator(mode="after")
    def validate_multi_choice_fields(self) -> "MotionAddRequest":
        if self.is_multi_choice:
            if self.option_limit is None or self.option_limit < 1:
                raise ValueError("option_limit must be >= 1 for multi_choice motions")
            if len(self.options) < 2:
                raise ValueError("multi_choice motions require at least 2 options")
            if self.option_limit > len(self.options):
                raise ValueError("option_limit cannot exceed the number of options")
        else:
            if self.option_limit is not None:
                raise ValueError("option_limit must be null for non-multi_choice motions")
            if self.options:
                raise ValueError("options must be empty for non-multi_choice motions")
        return self


class MotionUpdateRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    motion_type: MotionType | None = None
    is_multi_choice: bool | None = None
    motion_number: str | None = None
    option_limit: int | None = None
    options: list[MotionOptionCreate] | None = None

    @model_validator(mode="after")
    def at_least_one_field(self) -> "MotionUpdateRequest":
        if (
            self.title is None
            and self.description is None
            and self.motion_type is None
            and self.is_multi_choice is None
            and self.motion_number is None
            and self.option_limit is None
            and self.options is None
        ):
            raise ValueError("At least one field must be provided")
        return self

    @field_validator("title")
    @classmethod
    def title_non_empty(cls, v: str | None) -> str | None:
        if v is not None and not v.strip():
            raise ValueError("title must not be empty")
        if v is not None and len(v) > 500:
            raise ValueError("title must not exceed 500 characters")
        return v

    @field_validator("description")
    @classmethod
    def description_max_length(cls, v: str | None) -> str | None:
        if v is not None and len(v) > 2000:
            raise ValueError("description must not exceed 2000 characters")
        return v

    @field_validator("motion_number")
    @classmethod
    def motion_number_max_length(cls, v: str | None) -> str | None:
        if v is not None and len(v) > 50:
            raise ValueError("motion_number must not exceed 50 characters")
        return v


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
    proxy_email: str | None = None


class TallyCategory(BaseModel):
    voter_count: int
    entitlement_sum: int


class OptionTallyEntry(BaseModel):
    option_id: uuid.UUID
    option_text: str
    display_order: int
    voter_count: int
    entitlement_sum: int


class MotionTally(BaseModel):
    yes: TallyCategory
    no: TallyCategory
    abstained: TallyCategory
    absent: TallyCategory
    not_eligible: TallyCategory
    options: list[OptionTallyEntry] = []


class MotionVoterLists(BaseModel):
    yes: list[VoterEntry]
    no: list[VoterEntry]
    abstained: list[VoterEntry]
    absent: list[VoterEntry]
    not_eligible: list[VoterEntry]
    options: dict[str, list[VoterEntry]] = {}  # key: option_id str


class MotionDetail(BaseModel):
    id: uuid.UUID
    title: str
    description: str | None
    display_order: int
    motion_number: str | None
    motion_type: MotionType
    is_multi_choice: bool = False
    is_visible: bool = True
    option_limit: int | None = None
    options: list[MotionOptionOut] = []
    tally: MotionTally
    voter_lists: MotionVoterLists


class EmailDeliveryInfo(BaseModel):
    status: str
    last_error: str | None = None


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
    email_delivery: EmailDeliveryInfo | None = None


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
# Motion reorder schemas
# ---------------------------------------------------------------------------


class MotionReorderItem(BaseModel):
    motion_id: uuid.UUID
    display_order: int


class MotionReorderRequest(BaseModel):
    motions: list[MotionReorderItem]


class MotionReorderOut(BaseModel):
    motions: list[MotionOut]


# ---------------------------------------------------------------------------
# Admin auth schemas
# ---------------------------------------------------------------------------


class AdminLoginRequest(BaseModel):
    username: str
    password: str
