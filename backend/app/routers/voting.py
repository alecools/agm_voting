"""
Voting endpoints (all require valid session):
  GET  /api/agm/{agm_id}/motions
  PUT  /api/agm/{agm_id}/draft
  GET  /api/agm/{agm_id}/drafts
  POST /api/agm/{agm_id}/submit
  GET  /api/agm/{agm_id}/my-ballot
"""
import uuid
from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.agm import AGM
from app.models.motion import Motion
from app.models.session_record import SessionRecord
from app.schemas.voting import (
    DraftSaveRequest,
    DraftSaveResponse,
    DraftsResponse,
    MotionOut,
    MyBallotResponse,
    SubmitResponse,
)
from app.services.auth_service import get_session
from app.services.voting_service import (
    get_drafts,
    get_my_ballot,
    save_draft,
    submit_ballot,
)

router = APIRouter()


@router.get("/agm/{agm_id}/motions", response_model=list[MotionOut])
async def list_motions(
    agm_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    agm_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> list[MotionOut]:
    """List motions for an AGM. Requires valid session."""
    await get_session(agm_id=agm_id, db=db, agm_session=agm_session, authorization=authorization)

    # Verify AGM exists
    agm_result = await db.execute(select(AGM).where(AGM.id == agm_id))
    agm = agm_result.scalar_one_or_none()
    if agm is None:  # pragma: no cover
        raise HTTPException(status_code=404, detail="AGM not found")  # pragma: no cover

    result = await db.execute(
        select(Motion)
        .where(Motion.agm_id == agm_id)
        .order_by(Motion.order_index)
    )
    motions = result.scalars().all()
    return [
        MotionOut(
            id=m.id,
            title=m.title,
            description=m.description,
            order_index=m.order_index,
            motion_type=m.motion_type,
        )
        for m in motions
    ]


@router.put("/agm/{agm_id}/draft", response_model=DraftSaveResponse)
async def save_draft_endpoint(
    agm_id: uuid.UUID,
    body: DraftSaveRequest,
    db: AsyncSession = Depends(get_db),
    agm_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> DraftSaveResponse:
    """Auto-save a single motion's draft selection. Requires valid session."""
    session = await get_session(agm_id=agm_id, db=db, agm_session=agm_session, authorization=authorization)

    await save_draft(
        db=db,
        agm_id=agm_id,
        motion_id=body.motion_id,
        voter_email=session.voter_email,
        choice=body.choice,
    )
    await db.commit()
    return DraftSaveResponse(saved=True)


@router.get("/agm/{agm_id}/drafts", response_model=DraftsResponse)
async def get_drafts_endpoint(
    agm_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    agm_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> DraftsResponse:
    """Return all saved draft choices for the voter. Requires valid session."""
    session = await get_session(agm_id=agm_id, db=db, agm_session=agm_session, authorization=authorization)

    drafts = await get_drafts(db=db, agm_id=agm_id, voter_email=session.voter_email)
    return DraftsResponse(drafts=drafts)


@router.post("/agm/{agm_id}/submit", response_model=SubmitResponse)
async def submit_ballot_endpoint(
    agm_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    agm_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> SubmitResponse:
    """Formally submit the ballot. Requires valid session."""
    session = await get_session(agm_id=agm_id, db=db, agm_session=agm_session, authorization=authorization)

    result = await submit_ballot(db=db, agm_id=agm_id, voter_email=session.voter_email)
    await db.commit()
    return result


@router.get("/agm/{agm_id}/my-ballot", response_model=MyBallotResponse)
async def my_ballot_endpoint(
    agm_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    agm_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> MyBallotResponse:
    """Return the submitted ballot for the confirmation screen. Requires valid session."""
    session = await get_session(agm_id=agm_id, db=db, agm_session=agm_session, authorization=authorization)

    return await get_my_ballot(db=db, agm_id=agm_id, voter_email=session.voter_email)
