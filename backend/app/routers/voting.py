"""
Voting endpoints (all require valid session):
  GET  /api/general-meeting/{general_meeting_id}/motions
  PUT  /api/general-meeting/{general_meeting_id}/draft
  GET  /api/general-meeting/{general_meeting_id}/drafts
  POST /api/general-meeting/{general_meeting_id}/submit
  GET  /api/general-meeting/{general_meeting_id}/my-ballot
"""
import uuid
from typing import Optional

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.general_meeting import GeneralMeeting
from app.models.lot_owner import LotOwner
from app.models.lot_owner_email import LotOwnerEmail
from app.models.lot_proxy import LotProxy
from app.models.motion import Motion
from app.models.session_record import SessionRecord
from app.models.vote import Vote, VoteChoice, VoteStatus
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


class VoteInlineItem(BaseModel):
    motion_id: uuid.UUID
    choice: VoteChoice


class SubmitBallotRequest(BaseModel):
    lot_owner_ids: list[uuid.UUID]
    votes: list[VoteInlineItem] = []


@router.get("/general-meeting/{general_meeting_id}/motions", response_model=list[MotionOut])
async def list_motions(
    general_meeting_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    meeting_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> list[MotionOut]:
    """List motions for a General Meeting. Requires valid session.

    Returns visible motions PLUS any motions the voter has already submitted votes for.
    Hidden motion titles are never leaked for unvoted motions (server-side filtering).
    """
    session = await get_session(general_meeting_id=general_meeting_id, db=db, meeting_session=meeting_session, authorization=authorization)

    # Verify General Meeting exists
    meeting_result = await db.execute(select(GeneralMeeting).where(GeneralMeeting.id == general_meeting_id))
    meeting = meeting_result.scalar_one_or_none()
    if meeting is None:  # pragma: no cover
        raise HTTPException(status_code=404, detail="General Meeting not found")  # pragma: no cover

    voter_email = session.voter_email

    # Find all lot_owner_ids for this voter (direct ownership + proxy)
    email_lots_result = await db.execute(
        select(LotOwnerEmail.lot_owner_id)
        .join(LotOwner, LotOwnerEmail.lot_owner_id == LotOwner.id)
        .where(
            LotOwnerEmail.email == voter_email,
            LotOwner.building_id == meeting.building_id,
        )
    )
    direct_lot_owner_ids = {row[0] for row in email_lots_result.all()}

    proxy_lots_result = await db.execute(
        select(LotProxy.lot_owner_id)
        .join(LotOwner, LotProxy.lot_owner_id == LotOwner.id)
        .where(
            LotProxy.proxy_email == voter_email,
            LotOwner.building_id == meeting.building_id,
        )
    )
    proxy_lot_owner_ids = {row[0] for row in proxy_lots_result.all()}

    all_lot_owner_ids = direct_lot_owner_ids | proxy_lot_owner_ids

    # Get submitted vote motion IDs and choices for this voter's lots
    voted_result = await db.execute(
        select(Vote.motion_id, Vote.choice).where(
            Vote.general_meeting_id == general_meeting_id,
            Vote.lot_owner_id.in_(all_lot_owner_ids),
            Vote.status == VoteStatus.submitted,
        )
    )
    # Build a dict preferring a non-not_eligible choice when multiple lots vote on the same motion
    voted_choice_by_motion: dict[uuid.UUID, VoteChoice] = {}
    for motion_id, choice in voted_result.all():
        existing = voted_choice_by_motion.get(motion_id)
        if existing is None or existing == VoteChoice.not_eligible:
            voted_choice_by_motion[motion_id] = choice
    voted_motion_ids = set(voted_choice_by_motion.keys())

    # Fetch motions that are visible OR already voted on by this voter
    result = await db.execute(
        select(Motion)
        .where(
            Motion.general_meeting_id == general_meeting_id,
            or_(
                Motion.is_visible == True,  # noqa: E712
                Motion.id.in_(voted_motion_ids),
            ),
        )
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
            is_visible=m.is_visible,
            already_voted=m.id in voted_motion_ids,
            submitted_choice=voted_choice_by_motion.get(m.id),
        )
        for m in motions
    ]


@router.put("/general-meeting/{general_meeting_id}/draft", response_model=DraftSaveResponse)
async def save_draft_endpoint(
    general_meeting_id: uuid.UUID,
    body: DraftSaveRequest,
    db: AsyncSession = Depends(get_db),
    meeting_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> DraftSaveResponse:
    """Auto-save a single motion's draft selection. Requires valid session."""
    session = await get_session(general_meeting_id=general_meeting_id, db=db, meeting_session=meeting_session, authorization=authorization)

    await save_draft(
        db=db,
        general_meeting_id=general_meeting_id,
        motion_id=body.motion_id,
        voter_email=session.voter_email,
        choice=body.choice,
        lot_owner_id=body.lot_owner_id,
    )
    await db.commit()
    return DraftSaveResponse(saved=True)


@router.get("/general-meeting/{general_meeting_id}/drafts", response_model=DraftsResponse)
async def get_drafts_endpoint(
    general_meeting_id: uuid.UUID,
    lot_owner_id: Optional[uuid.UUID] = None,
    db: AsyncSession = Depends(get_db),
    meeting_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> DraftsResponse:
    """Return all saved draft choices for the voter. Requires valid session."""
    session = await get_session(general_meeting_id=general_meeting_id, db=db, meeting_session=meeting_session, authorization=authorization)

    drafts = await get_drafts(
        db=db,
        general_meeting_id=general_meeting_id,
        voter_email=session.voter_email,
        lot_owner_id=lot_owner_id,
    )
    return DraftsResponse(drafts=drafts)


@router.post("/general-meeting/{general_meeting_id}/submit", response_model=SubmitResponse)
async def submit_ballot_endpoint(
    general_meeting_id: uuid.UUID,
    body: SubmitBallotRequest,
    db: AsyncSession = Depends(get_db),
    meeting_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> SubmitResponse:
    """Formally submit the ballot for the specified lots. Requires valid session."""
    session = await get_session(general_meeting_id=general_meeting_id, db=db, meeting_session=meeting_session, authorization=authorization)

    result = await submit_ballot(
        db=db,
        general_meeting_id=general_meeting_id,
        voter_email=session.voter_email,
        lot_owner_ids=body.lot_owner_ids,
        inline_votes={item.motion_id: item.choice for item in body.votes},
    )
    await db.commit()
    return result


@router.get("/general-meeting/{general_meeting_id}/my-ballot", response_model=MyBallotResponse)
async def my_ballot_endpoint(
    general_meeting_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    meeting_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> MyBallotResponse:
    """Return the submitted ballot for the confirmation screen. Requires valid session."""
    session = await get_session(general_meeting_id=general_meeting_id, db=db, meeting_session=meeting_session, authorization=authorization)

    return await get_my_ballot(db=db, general_meeting_id=general_meeting_id, voter_email=session.voter_email)
