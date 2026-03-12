"""
Public endpoints (no auth required):
  GET /api/server-time
  GET /api/buildings
  GET /api/buildings/{building_id}/agms
  GET /api/agm/{agm_id}/summary
"""
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.agm import AGM, get_effective_status
from app.models.building import Building
from app.models.motion import Motion
from app.schemas.agm import AGMOut, AGMSummaryOut, MotionSummaryOut
from app.schemas.building import BuildingOut

router = APIRouter()


@router.get("/server-time")
async def server_time() -> dict:
    """Return current UTC time for client countdown timer anchoring."""
    now = datetime.now(UTC)
    return {"utc": now.strftime("%Y-%m-%dT%H:%M:%SZ")}


@router.get("/buildings", response_model=list[BuildingOut])
async def list_buildings(db: AsyncSession = Depends(get_db)) -> list[BuildingOut]:
    """List all active (non-archived) buildings."""
    result = await db.execute(
        select(Building)
        .where(Building.is_archived == False)  # noqa: E712
        .order_by(Building.name)
    )
    buildings = result.scalars().all()
    return [BuildingOut(id=b.id, name=b.name) for b in buildings]


@router.get("/buildings/{building_id}/agms", response_model=list[AGMOut])
async def list_agms(
    building_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> list[AGMOut]:
    """List all AGMs for a building, ordered by meeting_at descending."""
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
        select(AGM)
        .where(AGM.building_id == building_id)
        .order_by(AGM.meeting_at.desc())
    )
    agms = result.scalars().all()
    return [
        AGMOut(
            id=a.id,
            title=a.title,
            # Use effective status so past-voting_closes_at AGMs appear as closed
            # before the auto-close background job has run.
            status=get_effective_status(a),
            meeting_at=a.meeting_at,
            voting_closes_at=a.voting_closes_at,
        )
        for a in agms
    ]


@router.get("/agm/{agm_id}/summary", response_model=AGMSummaryOut)
async def get_agm_summary(
    agm_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> AGMSummaryOut:
    """Return public summary of an AGM including building name and motions."""
    agm_result = await db.execute(
        select(AGM).where(AGM.id == agm_id)
    )
    agm = agm_result.scalar_one_or_none()
    if agm is None:
        raise HTTPException(status_code=404, detail="AGM not found")

    building_result = await db.execute(
        select(Building).where(Building.id == agm.building_id)
    )
    building = building_result.scalar_one()

    motions_result = await db.execute(
        select(Motion)
        .where(Motion.agm_id == agm_id)
        .order_by(Motion.order_index)
    )
    motions = motions_result.scalars().all()

    return AGMSummaryOut(
        agm_id=agm.id,
        title=agm.title,
        status=get_effective_status(agm).value,
        meeting_at=agm.meeting_at,
        voting_closes_at=agm.voting_closes_at,
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
