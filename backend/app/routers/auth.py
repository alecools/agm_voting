"""
Authentication endpoint:
  POST /api/auth/verify
"""
from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.agm import AGM, AGMStatus
from app.models.ballot_submission import BallotSubmission
from app.models.building import Building
from app.models.lot_owner import LotOwner
from app.schemas.auth import AuthVerifyRequest, AuthVerifyResponse
from app.services.auth_service import create_session

router = APIRouter()


@router.post("/auth/verify", response_model=AuthVerifyResponse)
async def verify_auth(
    request: AuthVerifyRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> AuthVerifyResponse:
    """
    Authenticate a lot owner by lot_number + email + building_id,
    verify the AGM belongs to that building and is open,
    create a session, and return whether a ballot was already submitted.
    """
    # 1. Verify lot_number + email + building_id exists
    lot_result = await db.execute(
        select(LotOwner).where(
            LotOwner.building_id == request.building_id,
            LotOwner.lot_number == request.lot_number,
            LotOwner.email == request.email,
        )
    )
    lot_owner = lot_result.scalar_one_or_none()
    if lot_owner is None:
        raise HTTPException(
            status_code=401,
            detail="Lot number and email address do not match our records",
        )

    # 2. Verify AGM belongs to building_id
    agm_result = await db.execute(
        select(AGM).where(
            AGM.id == request.agm_id,
            AGM.building_id == request.building_id,
        )
    )
    agm = agm_result.scalar_one_or_none()
    if agm is None:
        raise HTTPException(status_code=404, detail="AGM not found for this building")

    # 3. Check for existing ballot submission
    submission_result = await db.execute(
        select(BallotSubmission).where(
            BallotSubmission.agm_id == request.agm_id,
            BallotSubmission.voter_email == request.email,
        )
    )
    already_submitted = submission_result.scalar_one_or_none() is not None

    # 5. Create session
    token = await create_session(
        db=db,
        voter_email=request.email,
        building_id=request.building_id,
        agm_id=request.agm_id,
    )
    await db.commit()

    response.set_cookie(
        key="agm_session",
        value=token,
        httponly=True,
        samesite="lax",
    )

    return AuthVerifyResponse(
        already_submitted=already_submitted,
        voter_email=request.email,
        agm_status=agm.status.value,
    )
