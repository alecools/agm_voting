"""
Authentication endpoint:
  POST /api/auth/verify
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.general_meeting import GeneralMeeting, GeneralMeetingStatus, get_effective_status
from app.models.ballot_submission import BallotSubmission
from app.models.lot_owner import LotOwner
from app.models.lot_owner_email import LotOwnerEmail
from app.models.lot_proxy import LotProxy
from app.schemas.auth import AuthVerifyRequest, AuthVerifyResponse, LotInfo
from app.services.auth_service import create_session

router = APIRouter()


@router.post("/auth/verify", response_model=AuthVerifyResponse)
async def verify_auth(
    request: AuthVerifyRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> AuthVerifyResponse:
    """
    Authenticate a voter by email + building_id.
    Looks up all lot owners for this building that have the given email (direct ownership)
    AND lots where this email is a nominated proxy.
    Returns the merged list of lots along with their submission status.
    """
    # 1. Find all LotOwnerEmail records matching email for this building (direct owners)
    emails_result = await db.execute(
        select(LotOwnerEmail)
        .join(LotOwner, LotOwnerEmail.lot_owner_id == LotOwner.id)
        .where(
            LotOwnerEmail.email == request.email,
            LotOwner.building_id == request.building_id,
        )
    )
    email_records = list(emails_result.scalars().all())
    direct_lot_owner_ids: set[uuid.UUID] = {er.lot_owner_id for er in email_records}

    # 2. Find all LotProxy records where proxy_email matches and lot is in this building
    proxy_result = await db.execute(
        select(LotProxy)
        .join(LotOwner, LotProxy.lot_owner_id == LotOwner.id)
        .where(
            LotProxy.proxy_email == request.email,
            LotOwner.building_id == request.building_id,
        )
    )
    proxy_records = list(proxy_result.scalars().all())
    proxy_lot_owner_ids: set[uuid.UUID] = {pr.lot_owner_id for pr in proxy_records}

    # 3. Merge: union of direct and proxy lots
    all_lot_owner_ids = direct_lot_owner_ids | proxy_lot_owner_ids

    if not all_lot_owner_ids:
        raise HTTPException(
            status_code=401,
            detail="Email address not found for this building",
        )

    # 4. Verify General Meeting belongs to building_id
    meeting_result = await db.execute(
        select(GeneralMeeting).where(
            GeneralMeeting.id == request.general_meeting_id,
            GeneralMeeting.building_id == request.building_id,
        )
    )
    meeting = meeting_result.scalar_one_or_none()
    if meeting is None:
        raise HTTPException(status_code=404, detail="General Meeting not found for this building")

    # 5. Fetch all relevant LotOwner records
    lots_result = await db.execute(
        select(LotOwner).where(LotOwner.id.in_(all_lot_owner_ids))
    )
    lot_owners = {lo.id: lo for lo in lots_result.scalars().all()}

    # 6. Check submissions per lot owner
    submissions_result = await db.execute(
        select(BallotSubmission).where(
            BallotSubmission.general_meeting_id == request.general_meeting_id,
            BallotSubmission.lot_owner_id.in_(all_lot_owner_ids),
        )
    )
    submitted_lot_ids: set[uuid.UUID] = {s.lot_owner_id for s in submissions_result.scalars().all()}

    lots = []
    for lot_owner_id in all_lot_owner_ids:
        lo = lot_owners.get(lot_owner_id)
        if lo is None:  # pragma: no cover  # FK constraint guarantees lot_owner always exists
            continue
        # Direct owner takes precedence: is_proxy=False if voter is a direct owner of this lot
        is_proxy = lot_owner_id not in direct_lot_owner_ids
        fp = lo.financial_position
        lots.append(LotInfo(
            lot_owner_id=lo.id,
            lot_number=lo.lot_number,
            financial_position=fp.value if hasattr(fp, "value") else fp,
            already_submitted=lo.id in submitted_lot_ids,
            is_proxy=is_proxy,
        ))

    # Sort by lot_number for consistent ordering
    lots.sort(key=lambda l: l.lot_number)

    # 7. Create session
    token = await create_session(
        db=db,
        voter_email=request.email,
        building_id=request.building_id,
        general_meeting_id=request.general_meeting_id,
    )
    await db.commit()

    response.set_cookie(
        key="meeting_session",
        value=token,
        httponly=True,
        samesite="lax",
    )

    return AuthVerifyResponse(
        lots=lots,
        voter_email=request.email,
        # Use effective status so past-voting_closes_at meetings report as closed
        # even before the auto-close job has run (US-CD03).
        agm_status=get_effective_status(meeting).value,
    )
