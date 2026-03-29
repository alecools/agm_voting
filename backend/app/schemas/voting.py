import uuid
from typing import Optional

from pydantic import BaseModel

from app.models.motion import MotionType
from app.models.vote import VoteChoice
from app.schemas.admin import MotionOptionOut


class MotionOut(BaseModel):
    id: uuid.UUID
    title: str
    description: Optional[str]
    display_order: int
    motion_number: Optional[str]
    motion_type: MotionType
    is_multi_choice: bool = False
    is_visible: bool = True
    already_voted: bool = False
    submitted_choice: Optional[VoteChoice] = None
    submitted_option_ids: list[uuid.UUID] = []
    option_limit: Optional[int] = None
    options: list[MotionOptionOut] = []

    model_config = {"from_attributes": True}


class DraftSaveRequest(BaseModel):
    motion_id: uuid.UUID
    choice: Optional[VoteChoice] = None
    lot_owner_id: Optional[uuid.UUID] = None


class DraftSaveResponse(BaseModel):
    saved: bool


class DraftItem(BaseModel):
    motion_id: uuid.UUID
    choice: VoteChoice
    lot_owner_id: Optional[uuid.UUID] = None

    model_config = {"from_attributes": True}


class DraftsResponse(BaseModel):
    drafts: list[DraftItem]


class VoteSummaryItem(BaseModel):
    motion_id: uuid.UUID
    motion_title: str
    choice: VoteChoice


class LotBallotResult(BaseModel):
    lot_owner_id: uuid.UUID
    lot_number: str
    votes: list[VoteSummaryItem]


class SubmitResponse(BaseModel):
    submitted: bool
    lots: list[LotBallotResult]


class MultiChoiceVoteItem(BaseModel):
    motion_id: uuid.UUID
    option_ids: list[uuid.UUID] = []  # empty = abstain


class BallotVoteItem(BaseModel):
    motion_id: uuid.UUID
    motion_title: str
    display_order: int
    motion_number: Optional[str] = None
    choice: VoteChoice
    eligible: bool = True
    motion_type: MotionType = MotionType.general
    is_multi_choice: bool = False
    selected_options: list[MotionOptionOut] = []


class LotBallotSummary(BaseModel):
    lot_owner_id: uuid.UUID
    lot_number: str
    financial_position: str
    votes: list[BallotVoteItem]


class MyBallotResponse(BaseModel):
    voter_email: str
    meeting_title: str
    building_name: str
    submitted_lots: list[LotBallotSummary]
    remaining_lot_owner_ids: list[uuid.UUID]
