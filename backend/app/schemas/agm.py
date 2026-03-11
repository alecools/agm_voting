import uuid
from datetime import datetime

from pydantic import BaseModel

from app.models.agm import AGMStatus
from app.models.motion import MotionType


class AGMOut(BaseModel):
    id: uuid.UUID
    title: str
    status: AGMStatus
    meeting_at: datetime
    voting_closes_at: datetime

    model_config = {"from_attributes": True}


class MotionSummaryOut(BaseModel):
    order_index: int
    title: str
    description: str | None
    motion_type: MotionType

    model_config = {"from_attributes": True}


class AGMSummaryOut(BaseModel):
    agm_id: uuid.UUID
    title: str
    status: str
    meeting_at: datetime
    voting_closes_at: datetime
    building_name: str
    motions: list[MotionSummaryOut]
