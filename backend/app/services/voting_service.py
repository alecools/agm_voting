"""
Draft save and ballot submit service logic.
"""
import uuid
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agm import AGM, AGMStatus
from app.models.ballot_submission import BallotSubmission
from app.models.motion import Motion
from app.models.vote import Vote, VoteChoice, VoteStatus
from app.schemas.voting import BallotVoteItem, DraftItem, SubmitResponse, VoteSummaryItem


async def save_draft(
    db: AsyncSession,
    agm_id: uuid.UUID,
    motion_id: uuid.UUID,
    voter_email: str,
    choice: VoteChoice | None,
) -> None:
    """
    Upsert a draft Vote for (agm_id, motion_id, voter_email).
    If choice is None, delete the existing draft record.
    Raises 422 if motion does not belong to agm_id.
    Raises 403 if agm is closed.
    Raises 409 if ballot already submitted.
    """
    # Verify the AGM exists and is open
    agm_result = await db.execute(select(AGM).where(AGM.id == agm_id))
    agm = agm_result.scalar_one_or_none()
    if agm is None:  # pragma: no cover
        raise HTTPException(status_code=404, detail="AGM not found")  # pragma: no cover

    if agm.status != AGMStatus.open:
        raise HTTPException(status_code=403, detail="Voting is closed for this AGM")

    # Check not already submitted
    submission_result = await db.execute(
        select(BallotSubmission).where(
            BallotSubmission.agm_id == agm_id,
            BallotSubmission.voter_email == voter_email,
        )
    )
    if submission_result.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="Ballot already submitted for this voter")

    # Verify motion belongs to this agm
    motion_result = await db.execute(
        select(Motion).where(Motion.id == motion_id, Motion.agm_id == agm_id)
    )
    motion = motion_result.scalar_one_or_none()
    if motion is None:
        raise HTTPException(
            status_code=422, detail="Motion does not belong to this AGM"
        )

    if choice is None:
        # Delete the draft if it exists
        await db.execute(
            delete(Vote).where(
                Vote.agm_id == agm_id,
                Vote.motion_id == motion_id,
                Vote.voter_email == voter_email,
                Vote.status == VoteStatus.draft,
            )
        )
    else:
        # Upsert: look for existing draft
        existing_result = await db.execute(
            select(Vote).where(
                Vote.agm_id == agm_id,
                Vote.motion_id == motion_id,
                Vote.voter_email == voter_email,
            )
        )
        existing = existing_result.scalar_one_or_none()
        if existing is not None:
            existing.choice = choice
            existing.status = VoteStatus.draft
        else:
            vote = Vote(
                agm_id=agm_id,
                motion_id=motion_id,
                voter_email=voter_email,
                choice=choice,
                status=VoteStatus.draft,
            )
            db.add(vote)

    await db.flush()


async def get_drafts(
    db: AsyncSession,
    agm_id: uuid.UUID,
    voter_email: str,
) -> list[DraftItem]:
    """Return all current draft choices for the voter for this AGM."""
    result = await db.execute(
        select(Vote).where(
            Vote.agm_id == agm_id,
            Vote.voter_email == voter_email,
            Vote.status == VoteStatus.draft,
            Vote.choice.is_not(None),
        )
    )
    votes = result.scalars().all()
    return [DraftItem(motion_id=v.motion_id, choice=v.choice) for v in votes]


async def submit_ballot(
    db: AsyncSession,
    agm_id: uuid.UUID,
    voter_email: str,
) -> SubmitResponse:
    """
    Formally submit the ballot for the voter.
    Raises 403 if agm is closed.
    Raises 409 if already submitted (returns same summary).
    """
    # Fetch AGM
    agm_result = await db.execute(select(AGM).where(AGM.id == agm_id))
    agm = agm_result.scalar_one_or_none()
    if agm is None:  # pragma: no cover
        raise HTTPException(status_code=404, detail="AGM not found")  # pragma: no cover

    if agm.status != AGMStatus.open:
        raise HTTPException(status_code=403, detail="Voting is closed for this AGM")

    # Check if already submitted
    existing_sub_result = await db.execute(
        select(BallotSubmission).where(
            BallotSubmission.agm_id == agm_id,
            BallotSubmission.voter_email == voter_email,
        )
    )
    existing_sub = existing_sub_result.scalar_one_or_none()
    if existing_sub is not None:
        # Return existing summary
        votes_result = await db.execute(
            select(Vote, Motion)
            .join(Motion, Vote.motion_id == Motion.id)
            .where(
                Vote.agm_id == agm_id,
                Vote.voter_email == voter_email,
                Vote.status == VoteStatus.submitted,
            )
            .order_by(Motion.order_index)
        )
        rows = votes_result.all()
        vote_items = [
            VoteSummaryItem(
                motion_id=row.Motion.id,
                motion_title=row.Motion.title,
                choice=row.Vote.choice,
            )
            for row in rows
        ]
        raise HTTPException(
            status_code=409,
            detail="Ballot already submitted for this voter",
        )

    # Get all motions for this AGM
    motions_result = await db.execute(
        select(Motion).where(Motion.agm_id == agm_id).order_by(Motion.order_index)
    )
    motions = motions_result.scalars().all()

    # Get existing draft votes
    drafts_result = await db.execute(
        select(Vote).where(
            Vote.agm_id == agm_id,
            Vote.voter_email == voter_email,
            Vote.status == VoteStatus.draft,
        )
    )
    drafts = {v.motion_id: v for v in drafts_result.scalars().all()}

    # First pass: promote drafts with a choice, collect motions needing new votes,
    # and delete any null-choice drafts
    motions_needing_new_vote: list[Motion] = []
    vote_items: list[VoteSummaryItem] = []

    for motion in motions:
        draft = drafts.get(motion.id)
        if draft is not None and draft.choice is not None:
            draft.status = VoteStatus.submitted
            vote_items.append(
                VoteSummaryItem(
                    motion_id=motion.id,
                    motion_title=motion.title,
                    choice=draft.choice,
                )
            )
        else:
            if draft is not None and draft.choice is None:
                # Delete null-choice draft before inserting new abstained vote
                await db.delete(draft)
            motions_needing_new_vote.append(motion)

    # Flush all deletes before inserting new abstained votes to avoid unique constraint
    await db.flush()

    for motion in motions_needing_new_vote:
        new_vote = Vote(
            agm_id=agm_id,
            motion_id=motion.id,
            voter_email=voter_email,
            choice=VoteChoice.abstained,
            status=VoteStatus.submitted,
        )
        db.add(new_vote)
        vote_items.append(
            VoteSummaryItem(
                motion_id=motion.id,
                motion_title=motion.title,
                choice=VoteChoice.abstained,
            )
        )

    # Re-sort vote_items to match motion order
    motion_order = {m.id: m.order_index for m in motions}
    vote_items.sort(key=lambda v: motion_order[v.motion_id])

    # Insert BallotSubmission
    submission = BallotSubmission(
        agm_id=agm_id,
        voter_email=voter_email,
        submitted_at=datetime.now(UTC),
    )
    db.add(submission)
    await db.flush()

    return SubmitResponse(submitted=True, votes=vote_items)


async def get_my_ballot(
    db: AsyncSession,
    agm_id: uuid.UUID,
    voter_email: str,
):
    """Return the submitted ballot for the confirmation screen."""
    from app.models.building import Building
    from app.schemas.voting import MyBallotResponse

    # Verify submission exists
    sub_result = await db.execute(
        select(BallotSubmission).where(
            BallotSubmission.agm_id == agm_id,
            BallotSubmission.voter_email == voter_email,
        )
    )
    sub = sub_result.scalar_one_or_none()
    if sub is None:
        raise HTTPException(status_code=404, detail="No submitted ballot found")

    # Get AGM with building
    agm_result = await db.execute(
        select(AGM).where(AGM.id == agm_id)
    )
    agm = agm_result.scalar_one_or_none()
    if agm is None:
        raise HTTPException(status_code=404, detail="AGM not found")  # pragma: no cover

    building_result = await db.execute(
        select(Building).where(Building.id == agm.building_id)
    )
    building = building_result.scalar_one_or_none()

    # Get submitted votes with motion details
    votes_result = await db.execute(
        select(Vote, Motion)
        .join(Motion, Vote.motion_id == Motion.id)
        .where(
            Vote.agm_id == agm_id,
            Vote.voter_email == voter_email,
            Vote.status == VoteStatus.submitted,
        )
        .order_by(Motion.order_index)
    )
    rows = votes_result.all()

    from app.schemas.voting import BallotVoteItem

    ballot_votes = [
        BallotVoteItem(
            motion_id=row.Motion.id,
            motion_title=row.Motion.title,
            order_index=row.Motion.order_index,
            choice=row.Vote.choice,
        )
        for row in rows
    ]

    return MyBallotResponse(
        voter_email=voter_email,
        agm_title=agm.title,
        building_name=building.name,
        votes=ballot_votes,
    )
