"""
Pydantic schemas for the admin portal API.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, EmailStr, Field, computed_field, field_validator, model_validator

from app.models.motion import MotionType
from app.schemas.shared import MotionOptionOut

# Re-export so existing callers that import MotionOptionOut from admin keep working.
__all__ = ["MotionOptionOut"]


# ---------------------------------------------------------------------------
# Admin user management schemas
# ---------------------------------------------------------------------------


class AdminUserOut(BaseModel):
    id: str
    email: str
    created_at: datetime


class AdminUserListOut(BaseModel):
    users: list[AdminUserOut]


class AdminUserInviteRequest(BaseModel):
    email: EmailStr


# ---------------------------------------------------------------------------
# Building schemas
# ---------------------------------------------------------------------------


class BuildingOut(BaseModel):
    id: uuid.UUID
    name: str
    manager_email: str
    is_archived: bool
    unarchive_count: int
    created_at: datetime

    model_config = {"from_attributes": True}


class BuildingCreate(BaseModel):
    name: str = Field(..., max_length=255)
    manager_email: str = Field(..., max_length=254)

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
    name: str | None = Field(default=None, max_length=255)
    manager_email: str | None = Field(default=None, max_length=254)

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


class LotOwnerEmailOut(BaseModel):
    id: uuid.UUID
    email: str | None
    given_name: str | None = None
    surname: str | None = None
    phone_number: str | None = None

    model_config = {"from_attributes": True}


class LotOwnerOut(BaseModel):
    id: uuid.UUID
    lot_number: str
    given_name: str | None = None
    surname: str | None = None
    owner_emails: list[LotOwnerEmailOut] = []
    unit_entitlement: int
    financial_position: str
    proxy_email: str | None = None
    proxy_given_name: str | None = None
    proxy_surname: str | None = None

    model_config = {"from_attributes": True}

    @computed_field  # type: ignore[prop-decorator]
    @property
    def emails(self) -> list[str]:
        """Backward-compatible alias: flat list of email strings."""
        return [e.email for e in self.owner_emails if e.email]


class LotOwnerCreate(BaseModel):
    lot_number: str = Field(..., max_length=255)
    given_name: str | None = Field(default=None, max_length=255)
    surname: str | None = Field(default=None, max_length=255)
    unit_entitlement: int
    financial_position: str = "normal"
    emails: list[str] = []

    @field_validator("unit_entitlement")
    @classmethod
    def entitlement_positive(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("unit_entitlement must be > 0")
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
    given_name: str | None = Field(default=None, max_length=255)
    surname: str | None = Field(default=None, max_length=255)
    unit_entitlement: int | None = None
    financial_position: str | None = None

    @field_validator("unit_entitlement")
    @classmethod
    def entitlement_positive(cls, v: int | None) -> int | None:
        if v is not None and v <= 0:
            raise ValueError("unit_entitlement must be > 0")
        return v

    @field_validator("financial_position")
    @classmethod
    def financial_position_valid(cls, v: str | None) -> str | None:
        if v is not None and v not in ("normal", "in_arrear"):
            raise ValueError("financial_position must be 'normal' or 'in_arrear'")
        return v

    @model_validator(mode="after")
    def at_least_one_field(self) -> "LotOwnerUpdate":
        if (
            self.given_name is None
            and self.surname is None
            and self.unit_entitlement is None
            and self.financial_position is None
        ):
            raise ValueError("At least one field must be provided")
        return self


class AddEmailRequest(BaseModel):
    email: str = Field(..., max_length=254)

    @field_validator("email")
    @classmethod
    def email_non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("email must not be empty")
        return v


class AddOwnerEmailRequest(BaseModel):
    email: str = Field(..., max_length=254)
    given_name: str | None = Field(default=None, max_length=255)
    surname: str | None = Field(default=None, max_length=255)
    phone_number: str | None = Field(default=None, max_length=20)

    @field_validator("email")
    @classmethod
    def email_non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("email must not be empty")
        return v


class UpdateOwnerEmailRequest(BaseModel):
    email: str | None = Field(default=None, max_length=254)
    given_name: str | None = Field(default=None, max_length=255)
    surname: str | None = Field(default=None, max_length=255)
    phone_number: str | None = Field(default=None, max_length=20)

    @model_validator(mode="after")
    def at_least_one_field(self) -> "UpdateOwnerEmailRequest":
        # A field is "provided" if it appears in the request payload, even if its
        # value is None (explicit null is a valid way to clear phone_number).
        if not self.model_fields_set:
            raise ValueError("At least one field must be provided")
        return self


class SetProxyRequest(BaseModel):
    proxy_email: str = Field(..., max_length=254)
    given_name: str | None = Field(default=None, max_length=255)
    surname: str | None = Field(default=None, max_length=255)

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


# ---------------------------------------------------------------------------
# Motion schemas
# ---------------------------------------------------------------------------


class MotionCreate(BaseModel):
    title: str = Field(..., max_length=500)
    description: str | None = Field(default=None, max_length=5000)
    display_order: int
    motion_type: MotionType = MotionType.general
    is_multi_choice: bool = False
    motion_number: str | None = Field(default=None, max_length=50)
    option_limit: int | None = None
    options: list[MotionOptionCreate] = []

    # Note: max_length limits are enforced by Field() above.
    # No separate length validators needed — Field(max_length=...) runs first.

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
    title: str = Field(..., max_length=500)
    description: str | None = Field(default=None, max_length=5000)
    motion_type: MotionType = MotionType.general
    is_multi_choice: bool = False
    motion_number: str | None = Field(default=None, max_length=50)
    option_limit: int | None = None
    options: list[MotionOptionCreate] = []

    @field_validator("title")
    @classmethod
    def title_non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("title must not be empty")
        return v

    # Note: description, motion_number max_length enforced by Field() above.

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
    title: str | None = Field(default=None, max_length=500)
    description: str | None = Field(default=None, max_length=5000)
    motion_type: MotionType | None = None
    is_multi_choice: bool | None = None
    motion_number: str | None = Field(default=None, max_length=50)
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
        return v

    # Note: description, motion_number max_length enforced by Field() above.


# ---------------------------------------------------------------------------
# General Meeting schemas
# ---------------------------------------------------------------------------


class GeneralMeetingCreate(BaseModel):
    building_id: uuid.UUID
    title: str = Field(..., max_length=500)
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
    voter_name: str | None = None
    lot_number: str
    entitlement: int
    proxy_email: str | None = None
    ballot_hash: str | None = None  # US-VIL-03: SHA-256 audit hash of submitted ballot
    submitted_by_admin: bool = False
    submitted_by_admin_username: str | None = None
    submitted_at: datetime | None = None


class TallyCategory(BaseModel):
    voter_count: int
    entitlement_sum: int


class OptionTallyEntry(BaseModel):
    option_id: uuid.UUID
    option_text: str
    display_order: int
    # Primary tally fields (For/Against/Abstained)
    for_voter_count: int = 0
    for_entitlement_sum: int = 0
    against_voter_count: int = 0
    against_entitlement_sum: int = 0
    abstained_voter_count: int = 0
    abstained_entitlement_sum: int = 0
    outcome: str | None = None
    # Backward-compatible alias fields (serialized in JSON response)
    voter_count: int = 0
    entitlement_sum: int = 0

    @model_validator(mode="after")
    def populate_backward_compat_aliases(self) -> "OptionTallyEntry":
        """Ensure voter_count/entitlement_sum always mirror for_voter_count/for_entitlement_sum."""
        # If old fields were provided but new ones weren't, propagate old → new
        if self.voter_count and not self.for_voter_count:
            self.for_voter_count = self.voter_count
        if self.entitlement_sum and not self.for_entitlement_sum:
            self.for_entitlement_sum = self.entitlement_sum
        # Always keep aliases in sync with primary fields
        self.voter_count = self.for_voter_count
        self.entitlement_sum = self.for_entitlement_sum
        return self


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
    # Per-option voter lists split by For/Against/Abstained category
    options_for: dict[str, list[VoterEntry]] = {}      # key: option_id str
    options_against: dict[str, list[VoterEntry]] = {}   # key: option_id str
    options_abstained: dict[str, list[VoterEntry]] = {} # key: option_id str
    # Backward-compatible alias: options == options_for
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
    voting_closed_at: datetime | None = None
    tally: MotionTally
    voter_lists: MotionVoterLists


class EmailDeliveryInfo(BaseModel):
    status: str
    last_error: str | None = None


class GeneralMeetingDetail(BaseModel):
    id: uuid.UUID
    building_id: uuid.UUID | None = None
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
# Subscription schemas
# ---------------------------------------------------------------------------


class SubscriptionResponse(BaseModel):
    tier_name: str | None
    building_limit: int | None
    active_building_count: int


class SubscriptionUpdate(BaseModel):
    tier_name: str | None = Field(default=None, max_length=255)
    building_limit: int | None = None

    @field_validator("building_limit")
    @classmethod
    def building_limit_positive(cls, v: int | None) -> int | None:
        if v is not None and v < 1:
            raise ValueError("building_limit must be >= 1")
        return v


class SubscriptionChangeRequest(BaseModel):
    requested_tier: str = Field(..., max_length=255)


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


# ---------------------------------------------------------------------------
# Admin vote entry schemas
# ---------------------------------------------------------------------------


class AdminMultiChoiceOptionChoice(BaseModel):
    """Per-option For/Against/Abstain choice for admin vote entry (US-AVE2-01)."""

    option_id: uuid.UUID
    choice: str  # "for" | "against" | "abstained"

    @field_validator("choice")
    @classmethod
    def choice_valid(cls, v: str) -> str:
        if v not in ("for", "against", "abstained"):
            raise ValueError("choice must be 'for', 'against', or 'abstained'")
        return v


class AdminVoteEntry(BaseModel):
    lot_owner_id: uuid.UUID
    votes: list[dict] = []  # [{motion_id: str, choice: str}]
    # New shape (US-AVE2-01): per-option For/Against/Abstain
    option_choices: list[AdminMultiChoiceOptionChoice] | None = None
    # Legacy field: motion_id -> [option_ids] treated as all "for"
    multi_choice_votes: list[dict] = []  # [{motion_id: str, option_ids?: [str], option_choices?: [...]}]


class AdminVoteEntryRequest(BaseModel):
    entries: list[AdminVoteEntry]


class AdminVoteEntryResult(BaseModel):
    submitted_count: int
    skipped_count: int
