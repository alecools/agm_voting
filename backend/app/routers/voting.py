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
from app.models.motion_option import MotionOption
from app.models.session_record import SessionRecord
from app.models.vote import Vote, VoteChoice, VoteStatus
from app.schemas.voting import (
    DraftSaveRequest,
    DraftSaveResponse,
    DraftsResponse,
    MultiChoiceVoteItem,
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
    multi_choice_votes: list[MultiChoiceVoteItem] = []


@router.get("/general-meeting/{general_meeting_id}/motions", response_model=list[MotionOut])
async def list_motions(
    general_meeting_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    agm_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> list[MotionOut]:
    """List motions for a General Meeting. Requires valid session.

    Returns visible motions PLUS any motions the voter has already submitted votes for.
    Hidden motion titles are never leaked for unvoted motions (server-side filtering).
    """
    session = await get_session(general_meeting_id=general_meeting_id, db=db, agm_session=agm_session, authorization=authorization)

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

    # Get submitted vote motion IDs, choices, and option IDs for this voter's lots
    voted_result = await db.execute(
        select(Vote.motion_id, Vote.choice, Vote.motion_option_id).where(
            Vote.general_meeting_id == general_meeting_id,
            Vote.lot_owner_id.in_(all_lot_owner_ids),
            Vote.status == VoteStatus.submitted,
        )
    )
    # Build a dict preferring a non-not_eligible choice when multiple lots vote on the same motion.
    # For multi-choice motions, use VoteChoice.selected as the submitted_choice sentinel
    # (indicates "you voted" without implying a specific binary choice).
    voted_choice_by_motion: dict[uuid.UUID, VoteChoice] = {}
    submitted_option_ids_by_motion: dict[uuid.UUID, list[uuid.UUID]] = {}
    for motion_id, choice, motion_option_id in voted_result.all():
        existing = voted_choice_by_motion.get(motion_id)
        if existing is None or existing == VoteChoice.not_eligible:
            voted_choice_by_motion[motion_id] = choice
        if choice == VoteChoice.selected and motion_option_id is not None:
            submitted_option_ids_by_motion.setdefault(motion_id, [])
            if motion_option_id not in submitted_option_ids_by_motion[motion_id]:
                submitted_option_ids_by_motion[motion_id].append(motion_option_id)
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
        .order_by(Motion.display_order)
    )
    motions = list(result.scalars().all())

    # Load options for multi-choice motions
    mc_motion_ids = [m.id for m in motions if m.is_multi_choice]
    options_by_motion: dict[uuid.UUID, list] = {}
    if mc_motion_ids:
        opts_result = await db.execute(
            select(MotionOption)
            .where(MotionOption.motion_id.in_(mc_motion_ids))
            .order_by(MotionOption.display_order)
        )
        for opt in opts_result.scalars().all():
            options_by_motion.setdefault(opt.motion_id, []).append(opt)

    return [
        MotionOut(
            id=m.id,
            title=m.title,
            description=m.description,
            display_order=m.display_order,
            motion_number=m.motion_number,
            motion_type=m.motion_type,
            is_multi_choice=m.is_multi_choice,
            is_visible=m.is_visible,
            already_voted=m.id in voted_motion_ids,
            submitted_choice=voted_choice_by_motion.get(m.id),
            submitted_option_ids=submitted_option_ids_by_motion.get(m.id, []),
            option_limit=m.option_limit,
            options=[
                {"id": opt.id, "text": opt.text, "display_order": opt.display_order}
                for opt in options_by_motion.get(m.id, [])
            ],
        )
        for m in motions
    ]


async def _verify_lot_ownership(
    db: AsyncSession,
    voter_email: str,
    lot_owner_id: uuid.UUID,
    building_id: uuid.UUID,
) -> None:
    """Raise 403 if lot_owner_id does not belong to the authenticated voter's session email.

    Ownership is confirmed when the voter is either:
      - a direct lot owner (LotOwnerEmail record linking email → lot in this building), or
      - a nominated proxy (LotProxy record linking proxy_email → lot in this building).
    """
    # Check direct ownership
    direct_result = await db.execute(
        select(LotOwnerEmail)
        .join(LotOwner, LotOwnerEmail.lot_owner_id == LotOwner.id)
        .where(
            LotOwnerEmail.email == voter_email,
            LotOwnerEmail.lot_owner_id == lot_owner_id,
            LotOwner.building_id == building_id,
        )
    )
    if direct_result.scalar_one_or_none() is not None:
        return

    # Check proxy ownership
    proxy_result = await db.execute(
        select(LotProxy)
        .join(LotOwner, LotProxy.lot_owner_id == LotOwner.id)
        .where(
            LotProxy.proxy_email == voter_email,
            LotProxy.lot_owner_id == lot_owner_id,
            LotOwner.building_id == building_id,
        )
    )
    if proxy_result.scalar_one_or_none() is not None:
        return

    raise HTTPException(
        status_code=403,
        detail="You are not authorised to access this lot's draft",
    )


@router.put("/general-meeting/{general_meeting_id}/draft", response_model=DraftSaveResponse)
async def save_draft_endpoint(
    general_meeting_id: uuid.UUID,
    body: DraftSaveRequest,
    db: AsyncSession = Depends(get_db),
    agm_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> DraftSaveResponse:
    """Auto-save a single motion's draft selection. Requires valid session."""
    session = await get_session(general_meeting_id=general_meeting_id, db=db, agm_session=agm_session, authorization=authorization)

    # Ownership check: when lot_owner_id is supplied, verify it belongs to the
    # authenticated voter.  Without this check a voter with a valid session could
    # overwrite another voter's draft by supplying an arbitrary lot_owner_id.
    #
    # When lot_owner_id is None the service filters by voter_email only.
    # The DELETE path (choice=None) is safe without a lot_owner_id because no new
    # Vote row is inserted; the UPDATE path finds an existing draft by voter_email.
    # Inserting a new Vote with lot_owner_id=None is blocked by a DB NOT NULL
    # constraint, so the None path cannot create orphaned rows.
    # The None case is preserved for backward compatibility with older frontend
    # clients that do not yet supply lot_owner_id on every call.
    if body.lot_owner_id is not None:
        meeting_result = await db.execute(
            select(GeneralMeeting).where(GeneralMeeting.id == general_meeting_id)
        )
        meeting = meeting_result.scalar_one_or_none()
        if meeting is None:  # pragma: no cover — session existence implies meeting exists
            raise HTTPException(status_code=404, detail="General Meeting not found")
        await _verify_lot_ownership(db, session.voter_email, body.lot_owner_id, meeting.building_id)

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
    agm_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> DraftsResponse:
    """Return all saved draft choices for the voter. Requires valid session."""
    session = await get_session(general_meeting_id=general_meeting_id, db=db, agm_session=agm_session, authorization=authorization)

    # When a specific lot_owner_id is requested, verify it belongs to this voter
    # to prevent cross-voter draft reads.
    if lot_owner_id is not None:
        meeting_result = await db.execute(
            select(GeneralMeeting).where(GeneralMeeting.id == general_meeting_id)
        )
        meeting = meeting_result.scalar_one_or_none()
        if meeting is None:  # pragma: no cover — session existence implies meeting exists
            raise HTTPException(status_code=404, detail="General Meeting not found")
        await _verify_lot_ownership(db, session.voter_email, lot_owner_id, meeting.building_id)

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
    agm_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> SubmitResponse:
    """Formally submit the ballot for the specified lots. Requires valid session."""
    session = await get_session(general_meeting_id=general_meeting_id, db=db, agm_session=agm_session, authorization=authorization)

    result = await submit_ballot(
        db=db,
        general_meeting_id=general_meeting_id,
        voter_email=session.voter_email,
        lot_owner_ids=body.lot_owner_ids,
        inline_votes={item.motion_id: item.choice for item in body.votes},
        multi_choice_votes={item.motion_id: item.option_ids for item in body.multi_choice_votes},
    )
    await db.commit()
    return result


@router.get("/general-meeting/{general_meeting_id}/my-ballot", response_model=MyBallotResponse)
async def my_ballot_endpoint(
    general_meeting_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    agm_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> MyBallotResponse:
    """Return the submitted ballot for the confirmation screen. Requires valid session."""
    session = await get_session(general_meeting_id=general_meeting_id, db=db, agm_session=agm_session, authorization=authorization)

    return await get_my_ballot(db=db, general_meeting_id=general_meeting_id, voter_email=session.voter_email)
