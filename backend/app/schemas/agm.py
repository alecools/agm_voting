import uuid
from datetime import datetime

from pydantic import BaseModel

from app.models.general_meeting import GeneralMeetingStatus
from app.models.motion import MotionType


class GeneralMeetingOut(BaseModel):
    id: uuid.UUID
    title: str
    status: GeneralMeetingStatus
    meeting_at: datetime
    voting_closes_at: datetime

    model_config = {"from_attributes": True}


class MotionSummaryOut(BaseModel):
    display_order: int
    motion_number: str | None
    title: str
    description: str | None
    motion_type: MotionType

    model_config = {"from_attributes": True}


class GeneralMeetingWithBuildingOut(BaseModel):
    id: uuid.UUID
    title: str
    status: GeneralMeetingStatus
    meeting_at: datetime
    voting_closes_at: datetime
    building_name: str

    model_config = {"from_attributes": True}


class GeneralMeetingSummaryOut(BaseModel):
    general_meeting_id: uuid.UUID
    building_id: uuid.UUID
    title: str
    status: str
    meeting_at: datetime
    voting_closes_at: datetime
    building_name: str
    motions: list[MotionSummaryOut]
