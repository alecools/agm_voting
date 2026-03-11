import uuid
from typing import Optional

from pydantic import BaseModel

from app.models.motion import MotionType
from app.models.vote import VoteChoice


class MotionOut(BaseModel):
    id: uuid.UUID
    title: str
    description: Optional[str]
    order_index: int
    motion_type: MotionType

    model_config = {"from_attributes": True}


class DraftSaveRequest(BaseModel):
    motion_id: uuid.UUID
    choice: Optional[VoteChoice] = None


class DraftSaveResponse(BaseModel):
    saved: bool


class DraftItem(BaseModel):
    motion_id: uuid.UUID
    choice: VoteChoice

    model_config = {"from_attributes": True}


class DraftsResponse(BaseModel):
    drafts: list[DraftItem]


class VoteSummaryItem(BaseModel):
    motion_id: uuid.UUID
    motion_title: str
    choice: VoteChoice


class SubmitResponse(BaseModel):
    submitted: bool
    votes: list[VoteSummaryItem]


class BallotVoteItem(BaseModel):
    motion_id: uuid.UUID
    motion_title: str
    order_index: int
    choice: VoteChoice


class MyBallotResponse(BaseModel):
    voter_email: str
    agm_title: str
    building_name: str
    votes: list[BallotVoteItem]
