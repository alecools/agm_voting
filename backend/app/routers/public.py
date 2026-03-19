"""
Public endpoints (no auth required):
  GET /api/server-time
  GET /api/buildings
  GET /api/buildings/{building_id}/general-meetings
  GET /api/general-meeting/{general_meeting_id}/summary
"""
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.general_meeting import GeneralMeeting, GeneralMeetingStatus, get_effective_status
from app.models.building import Building
from app.models.motion import Motion
from app.schemas.agm import GeneralMeetingOut, GeneralMeetingSummaryOut, MotionSummaryOut
from app.schemas.building import BuildingOut

router = APIRouter()


@router.get("/server-time")
async def server_time() -> dict:
    """Return current UTC time for client countdown timer anchoring."""
    now = datetime.now(UTC)
    return {"utc": now.strftime("%Y-%m-%dT%H:%M:%SZ")}


@router.get("/buildings", response_model=list[BuildingOut])
async def list_buildings(db: AsyncSession = Depends(get_db)) -> list[BuildingOut]:
    """List active (non-archived) buildings that have at least one open meeting."""
    result = await db.execute(
        select(Building)
        .where(Building.is_archived == False)  # noqa: E712
        .where(
            exists(
                select(GeneralMeeting.id)
                .where(GeneralMeeting.building_id == Building.id)
                .where(GeneralMeeting.status != GeneralMeetingStatus.closed)
                .where(GeneralMeeting.voting_closes_at > func.now())
                .where(GeneralMeeting.meeting_at <= func.now())
            )
        )
        .order_by(Building.name)
    )
    buildings = result.scalars().all()
    return [BuildingOut(id=b.id, name=b.name) for b in buildings]


@router.get("/buildings/{building_id}/general-meetings", response_model=list[GeneralMeetingOut])
async def list_general_meetings(
    building_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> list[GeneralMeetingOut]:
    """List all General Meetings for a building, ordered by meeting_at descending."""
    # Verify building exists and is not archived
    building_result = await db.execute(
        select(Building).where(
            Building.id == building_id,
            Building.is_archived == False,  # noqa: E712
        )
    )
    building = building_result.scalar_one_or_none()
    if building is None:
        raise HTTPException(status_code=404, detail="Building not found")

    result = await db.execute(
        select(GeneralMeeting)
        .where(GeneralMeeting.building_id == building_id)
        .order_by(GeneralMeeting.meeting_at.desc())
    )
    meetings = result.scalars().all()
    return [
        GeneralMeetingOut(
            id=m.id,
            title=m.title,
            # Use effective status so past-voting_closes_at meetings appear as closed
            # before the auto-close background job has run.
            status=get_effective_status(m),
            meeting_at=m.meeting_at,
            voting_closes_at=m.voting_closes_at,
        )
        for m in meetings
    ]


@router.get("/general-meeting/{general_meeting_id}/summary", response_model=GeneralMeetingSummaryOut)
async def get_general_meeting_summary(
    general_meeting_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> GeneralMeetingSummaryOut:
    """Return public summary of a General Meeting including building name and motions."""
    meeting_result = await db.execute(
        select(GeneralMeeting).where(GeneralMeeting.id == general_meeting_id)
    )
    meeting = meeting_result.scalar_one_or_none()
    if meeting is None:
        raise HTTPException(status_code=404, detail="General Meeting not found")

    building_result = await db.execute(
        select(Building).where(Building.id == meeting.building_id)
    )
    building = building_result.scalar_one()

    motions_result = await db.execute(
        select(Motion)
        .where(Motion.general_meeting_id == general_meeting_id)
        .order_by(Motion.order_index)
    )
    motions = motions_result.scalars().all()

    return GeneralMeetingSummaryOut(
        general_meeting_id=meeting.id,
        building_id=meeting.building_id,
        title=meeting.title,
        status=get_effective_status(meeting).value,
        meeting_at=meeting.meeting_at,
        voting_closes_at=meeting.voting_closes_at,
        building_name=building.name,
        motions=[
            MotionSummaryOut(
                order_index=m.order_index,
                title=m.title,
                description=m.description,
                motion_type=m.motion_type,
            )
            for m in motions
        ],
    )
