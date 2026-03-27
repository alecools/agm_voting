"""
Draft save and ballot submit service logic.
"""
import uuid
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.general_meeting import GeneralMeeting, GeneralMeetingStatus, get_effective_status
from app.models.general_meeting_lot_weight import GeneralMeetingLotWeight, FinancialPositionSnapshot
from app.models.ballot_submission import BallotSubmission
from app.models.lot_owner import LotOwner
from app.models.lot_owner_email import LotOwnerEmail
from app.models.lot_proxy import LotProxy
from app.models.motion import Motion, MotionType
from app.models.vote import Vote, VoteChoice, VoteStatus
from app.schemas.voting import (
    BallotVoteItem,
    DraftItem,
    DraftsResponse,
    LotBallotResult,
    LotBallotSummary,
    MyBallotResponse,
    SubmitResponse,
    VoteSummaryItem,
)


async def save_draft(
    db: AsyncSession,
    general_meeting_id: uuid.UUID,
    motion_id: uuid.UUID,
    voter_email: str,
    choice: VoteChoice | None,
    lot_owner_id: uuid.UUID | None = None,
) -> None:
    """
    Upsert a draft Vote for (general_meeting_id, motion_id, voter_email[, lot_owner_id]).
    If choice is None, delete the existing draft record.
    Raises 422 if motion does not belong to general_meeting_id.
    Raises 403 if meeting is closed.
    Raises 409 if ballot already submitted.
    """
    # Verify the General Meeting exists and is open
    meeting_result = await db.execute(select(GeneralMeeting).where(GeneralMeeting.id == general_meeting_id))
    general_meeting = meeting_result.scalar_one_or_none()
    if general_meeting is None:  # pragma: no cover
        raise HTTPException(status_code=404, detail="General Meeting not found")  # pragma: no cover

    effective = get_effective_status(general_meeting)
    if effective == GeneralMeetingStatus.pending:
        raise HTTPException(status_code=403, detail="Voting has not started yet for this General Meeting")
    if effective == GeneralMeetingStatus.closed:
        raise HTTPException(status_code=403, detail="Voting is closed for this meeting")

    # Check not already submitted — check by lot_owner_id if provided, else by voter_email
    if lot_owner_id is not None:
        submission_result = await db.execute(
            select(BallotSubmission).where(
                BallotSubmission.general_meeting_id == general_meeting_id,
                BallotSubmission.lot_owner_id == lot_owner_id,
            )
        )
    else:
        submission_result = await db.execute(
            select(BallotSubmission).where(
                BallotSubmission.general_meeting_id == general_meeting_id,
                BallotSubmission.voter_email == voter_email,
            )
        )
    if submission_result.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="Ballot already submitted for this voter")

    # Verify motion belongs to this general meeting
    motion_result = await db.execute(
        select(Motion).where(Motion.id == motion_id, Motion.general_meeting_id == general_meeting_id)
    )
    motion = motion_result.scalar_one_or_none()
    if motion is None:
        raise HTTPException(
            status_code=422, detail="Motion does not belong to this meeting"
        )

    # Build the filter for the vote record
    vote_filter = [
        Vote.general_meeting_id == general_meeting_id,
        Vote.motion_id == motion_id,
        Vote.voter_email == voter_email,
        Vote.status == VoteStatus.draft,
    ]
    if lot_owner_id is not None:
        vote_filter.append(Vote.lot_owner_id == lot_owner_id)

    if choice is None:
        # Delete the draft if it exists
        await db.execute(delete(Vote).where(*vote_filter))
    else:
        # Upsert: look for existing draft only — never match submitted votes
        existing_filter = [
            Vote.general_meeting_id == general_meeting_id,
            Vote.motion_id == motion_id,
            Vote.voter_email == voter_email,
            Vote.status == VoteStatus.draft,
        ]
        if lot_owner_id is not None:
            existing_filter.append(Vote.lot_owner_id == lot_owner_id)

        existing_result = await db.execute(
            select(Vote).where(*existing_filter)
        )
        existing = existing_result.scalar_one_or_none()
        if existing is not None:
            existing.choice = choice
            existing.status = VoteStatus.draft
        else:
            vote = Vote(
                general_meeting_id=general_meeting_id,
                motion_id=motion_id,
                voter_email=voter_email,
                lot_owner_id=lot_owner_id,
                choice=choice,
                status=VoteStatus.draft,
            )
            db.add(vote)

    await db.flush()


async def get_drafts(
    db: AsyncSession,
    general_meeting_id: uuid.UUID,
    voter_email: str,
    lot_owner_id: uuid.UUID | None = None,
) -> list[DraftItem]:
    """Return all current draft choices for the voter for this General Meeting."""
    filters = [
        Vote.general_meeting_id == general_meeting_id,
        Vote.voter_email == voter_email,
        Vote.status == VoteStatus.draft,
        Vote.choice.is_not(None),
    ]
    if lot_owner_id is not None:
        filters.append(Vote.lot_owner_id == lot_owner_id)

    result = await db.execute(select(Vote).where(*filters))
    votes = result.scalars().all()
    return [DraftItem(motion_id=v.motion_id, choice=v.choice, lot_owner_id=v.lot_owner_id) for v in votes]


async def submit_ballot(
    db: AsyncSession,
    general_meeting_id: uuid.UUID,
    voter_email: str,
    lot_owner_ids: list[uuid.UUID],
    inline_votes: dict[uuid.UUID, VoteChoice] | None = None,
) -> SubmitResponse:
    """
    Formally submit the ballot for the specified lot owners.
    Creates one BallotSubmission per lot_owner_id in a single transaction.
    Raises 400 if any submitted motion IDs are not part of the meeting.
    Raises 403 if meeting is closed.
    Raises 409 if any lot already submitted (no partial commit).
    Raises 403 if any lot_owner_id doesn't belong to authenticated voter_email.
    Silently drops General Motion votes for in-arrear lots.
    """
    # Fetch General Meeting
    meeting_result = await db.execute(select(GeneralMeeting).where(GeneralMeeting.id == general_meeting_id))
    general_meeting = meeting_result.scalar_one_or_none()
    if general_meeting is None:  # pragma: no cover
        raise HTTPException(status_code=404, detail="General Meeting not found")  # pragma: no cover

    effective_submit = get_effective_status(general_meeting)
    if effective_submit == GeneralMeetingStatus.pending:
        raise HTTPException(status_code=403, detail="Voting has not started yet for this General Meeting")
    if effective_submit == GeneralMeetingStatus.closed:
        raise HTTPException(status_code=403, detail="Voting is closed for this meeting")

    if not lot_owner_ids:
        raise HTTPException(status_code=422, detail="At least one lot_owner_id is required")

    # Verify all lot_owner_ids belong to the authenticated voter_email
    # (either as direct owner via LotOwnerEmail, or as proxy via LotProxy)
    # Also determine proxy_email per lot for audit trail
    proxy_email_by_lot: dict[uuid.UUID, str | None] = {}
    for lot_owner_id in lot_owner_ids:
        email_check = await db.execute(
            select(LotOwnerEmail).where(
                LotOwnerEmail.lot_owner_id == lot_owner_id,
                LotOwnerEmail.email == voter_email,
            )
        )
        is_direct_owner = email_check.scalar_one_or_none() is not None

        if is_direct_owner:
            proxy_email_by_lot[lot_owner_id] = None
        else:
            # Check if voter is a proxy for this lot
            proxy_check = await db.execute(
                select(LotProxy).where(
                    LotProxy.lot_owner_id == lot_owner_id,
                    LotProxy.proxy_email == voter_email,
                )
            )
            is_proxy = proxy_check.scalar_one_or_none() is not None
            if not is_proxy:
                raise HTTPException(
                    status_code=403,
                    detail=f"Lot owner {lot_owner_id} does not belong to authenticated voter",
                )
            proxy_email_by_lot[lot_owner_id] = voter_email

    # Get existing submissions for these lots — use SELECT FOR UPDATE to serialize
    # concurrent requests on the same (meeting, lot) rows and prevent double-submission.
    existing_subs_result = await db.execute(
        select(BallotSubmission)
        .where(
            BallotSubmission.general_meeting_id == general_meeting_id,
            BallotSubmission.lot_owner_id.in_(lot_owner_ids),
        )
        .with_for_update()
    )
    existing_subs_by_lot: dict[uuid.UUID, BallotSubmission] = {
        s.lot_owner_id: s for s in existing_subs_result.scalars().all()
    }

    # Get already-voted motion IDs per lot (to skip duplicating submitted votes)
    already_voted_by_lot: dict[uuid.UUID, set[uuid.UUID]] = {}
    for lot_owner_id in lot_owner_ids:
        voted_result = await db.execute(
            select(Vote.motion_id).where(
                Vote.general_meeting_id == general_meeting_id,
                Vote.lot_owner_id == lot_owner_id,
                Vote.status == VoteStatus.submitted,
            )
        )
        already_voted_by_lot[lot_owner_id] = {row[0] for row in voted_result.all()}

    # Get all visible motions for this General Meeting
    motions_result = await db.execute(
        select(Motion)
        .where(
            Motion.general_meeting_id == general_meeting_id,
            Motion.is_visible == True,  # noqa: E712
        )
        .order_by(Motion.display_order)
    )
    visible_motions = list(motions_result.scalars().all())

    # Validate that every motion_id in the submitted votes belongs to this meeting.
    # Unknown motion IDs are rejected with a 400 so clients cannot inject votes for
    # motions that belong to a different meeting.
    if inline_votes:
        valid_motion_ids = {m.id for m in visible_motions}
        unknown = [str(v) for v in inline_votes if v not in valid_motion_ids]
        if unknown:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown motion IDs: {unknown}",
            )

    # Get GeneralMeetingLotWeight records for financial position snapshots
    weights_result = await db.execute(
        select(GeneralMeetingLotWeight).where(
            GeneralMeetingLotWeight.general_meeting_id == general_meeting_id,
            GeneralMeetingLotWeight.lot_owner_id.in_(lot_owner_ids),
        )
    )
    weight_by_lot: dict[uuid.UUID, GeneralMeetingLotWeight] = {
        w.lot_owner_id: w for w in weights_result.scalars().all()
    }

    # Get lot number info
    lot_owners_result = await db.execute(
        select(LotOwner).where(LotOwner.id.in_(lot_owner_ids))
    )
    lot_owners_by_id: dict[uuid.UUID, LotOwner] = {
        lo.id: lo for lo in lot_owners_result.scalars().all()
    }

    # Build a choice lookup from the inline votes supplied in the request.
    # If no inline votes are provided (e.g. legacy calls), fall back to an
    # empty dict so unanswered motions are recorded as abstained.
    choice_by_motion: dict[uuid.UUID, VoteChoice] = dict(inline_votes) if inline_votes else {}

    # Delete any existing draft Vote rows for the lots being submitted so that
    # new submitted Vote inserts don't collide with the unique constraint on
    # (general_meeting_id, motion_id, lot_owner_id).
    await db.execute(
        delete(Vote).where(
            Vote.general_meeting_id == general_meeting_id,
            Vote.voter_email == voter_email,
            Vote.lot_owner_id.in_(lot_owner_ids),
            Vote.status == VoteStatus.draft,
        )
    )
    # Also delete shared (NULL lot_owner_id) draft rows for this voter.
    await db.execute(
        delete(Vote).where(
            Vote.general_meeting_id == general_meeting_id,
            Vote.voter_email == voter_email,
            Vote.lot_owner_id.is_(None),
            Vote.status == VoteStatus.draft,
        )
    )
    await db.flush()

    lot_results: list[LotBallotResult] = []

    for lot_owner_id in lot_owner_ids:
        weight = weight_by_lot.get(lot_owner_id)
        is_in_arrear = (
            weight is not None
            and weight.financial_position_snapshot == FinancialPositionSnapshot.in_arrear
        )
        lo = lot_owners_by_id.get(lot_owner_id)
        lot_number = lo.lot_number if lo else str(lot_owner_id)

        already_voted_for_lot: set[uuid.UUID] = already_voted_by_lot.get(lot_owner_id, set())

        motions_needing_new_vote: list[Motion] = []
        motions_needing_not_eligible: list[Motion] = []
        vote_items: list[VoteSummaryItem] = []

        for motion in visible_motions:
            # Skip motions this lot has already voted on (re-entry scenario)
            if motion.id in already_voted_for_lot:
                continue

            # In-arrear lots cannot vote on General Motions — record not_eligible
            if is_in_arrear and motion.motion_type == MotionType.general:
                motions_needing_not_eligible.append(motion)
                continue

            # Use the inline choice if provided; otherwise mark as unanswered (→ abstained)
            choice = choice_by_motion.get(motion.id)
            if choice is not None:
                new_submitted = Vote(
                    general_meeting_id=general_meeting_id,
                    motion_id=motion.id,
                    voter_email=voter_email,
                    lot_owner_id=lot_owner_id,
                    choice=choice,
                    status=VoteStatus.submitted,
                )
                db.add(new_submitted)
                vote_items.append(VoteSummaryItem(
                    motion_id=motion.id,
                    motion_title=motion.title,
                    choice=choice,
                ))
            else:
                motions_needing_new_vote.append(motion)

        # Flush before inserting not_eligible / abstained rows
        await db.flush()

        # Now insert not_eligible votes for in-arrear general motions
        for motion in motions_needing_not_eligible:
            not_eligible_vote = Vote(
                general_meeting_id=general_meeting_id,
                motion_id=motion.id,
                voter_email=voter_email,
                lot_owner_id=lot_owner_id,
                choice=VoteChoice.not_eligible,
                status=VoteStatus.submitted,
            )
            db.add(not_eligible_vote)
            vote_items.append(
                VoteSummaryItem(
                    motion_id=motion.id,
                    motion_title=motion.title,
                    choice=VoteChoice.not_eligible,
                )
            )

        for motion in motions_needing_new_vote:
            new_vote = Vote(
                general_meeting_id=general_meeting_id,
                motion_id=motion.id,
                voter_email=voter_email,
                lot_owner_id=lot_owner_id,
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
        motion_order = {m.id: m.display_order for m in visible_motions}
        vote_items.sort(key=lambda v: motion_order.get(v.motion_id, 0))

        # Reuse existing BallotSubmission if present; otherwise create one.
        # Catch IntegrityError from a concurrent submission that beat us through the
        # SELECT FOR UPDATE window and convert it to an already-submitted response
        # rather than a 500 so the client gets a clean 409-equivalent signal.
        if lot_owner_id not in existing_subs_by_lot:
            try:
                submission = BallotSubmission(
                    general_meeting_id=general_meeting_id,
                    lot_owner_id=lot_owner_id,
                    voter_email=voter_email,
                    proxy_email=proxy_email_by_lot.get(lot_owner_id),
                    submitted_at=datetime.now(UTC),
                )
                db.add(submission)
                await db.flush()
            except IntegrityError:
                # Concurrent submission beat this request — treat as already submitted
                await db.rollback()
                raise HTTPException(status_code=409, detail="Ballot already submitted for this voter")

        lot_results.append(LotBallotResult(
            lot_owner_id=lot_owner_id,
            lot_number=lot_number,
            votes=vote_items,
        ))

    return SubmitResponse(submitted=True, lots=lot_results)


async def get_my_ballot(
    db: AsyncSession,
    general_meeting_id: uuid.UUID,
    voter_email: str,
    lot_owner_ids: list[uuid.UUID] | None = None,
) -> MyBallotResponse:
    """Return the submitted ballot(s) for the confirmation screen.

    If lot_owner_ids is provided, return only those lots' ballots.
    Also returns remaining unsubmitted lot_owner_ids for the voter.
    """
    from app.models.building import Building

    # Get General Meeting with building
    meeting_result = await db.execute(select(GeneralMeeting).where(GeneralMeeting.id == general_meeting_id))
    general_meeting = meeting_result.scalar_one_or_none()
    if general_meeting is None:
        raise HTTPException(status_code=404, detail="General Meeting not found")  # pragma: no cover

    building_result = await db.execute(
        select(Building).where(Building.id == general_meeting.building_id)
    )
    building = building_result.scalar_one_or_none()

    # Find all lot owners for this voter email in this building
    # (direct ownership via LotOwnerEmail, plus proxy lots via LotProxy)
    all_email_lots_result = await db.execute(
        select(LotOwnerEmail)
        .join(LotOwner, LotOwnerEmail.lot_owner_id == LotOwner.id)
        .where(
            LotOwnerEmail.email == voter_email,
            LotOwner.building_id == general_meeting.building_id,
        )
    )
    direct_lot_owner_ids = [r.lot_owner_id for r in all_email_lots_result.scalars().all()]

    all_proxy_lots_result = await db.execute(
        select(LotProxy)
        .join(LotOwner, LotProxy.lot_owner_id == LotOwner.id)
        .where(
            LotProxy.proxy_email == voter_email,
            LotOwner.building_id == general_meeting.building_id,
        )
    )
    proxy_lot_owner_ids = [r.lot_owner_id for r in all_proxy_lots_result.scalars().all()]

    # Merge without duplicates
    all_lot_owner_ids_set = set(direct_lot_owner_ids) | set(proxy_lot_owner_ids)
    all_lot_owner_ids = list(all_lot_owner_ids_set)

    # Get all submissions for this General Meeting and voter
    all_subs_result = await db.execute(
        select(BallotSubmission).where(
            BallotSubmission.general_meeting_id == general_meeting_id,
            BallotSubmission.lot_owner_id.in_(all_lot_owner_ids),
        )
    )
    all_subs = list(all_subs_result.scalars().all())
    submitted_lot_ids = {s.lot_owner_id for s in all_subs}
    remaining_lot_owner_ids = [lid for lid in all_lot_owner_ids if lid not in submitted_lot_ids]

    # If specific lot_owner_ids requested, filter to those; else show all submitted
    if lot_owner_ids is not None:
        target_lot_ids = [lid for lid in lot_owner_ids if lid in submitted_lot_ids]
    else:
        target_lot_ids = list(submitted_lot_ids)

    if not target_lot_ids:
        raise HTTPException(status_code=404, detail="No submitted ballot found")

    # Get lot owner info
    lot_owners_result = await db.execute(
        select(LotOwner).where(LotOwner.id.in_(target_lot_ids))
    )
    lot_owners_by_id: dict[uuid.UUID, LotOwner] = {
        lo.id: lo for lo in lot_owners_result.scalars().all()
    }

    # Get GeneralMeetingLotWeight for financial position snapshot
    weights_result = await db.execute(
        select(GeneralMeetingLotWeight).where(
            GeneralMeetingLotWeight.general_meeting_id == general_meeting_id,
            GeneralMeetingLotWeight.lot_owner_id.in_(target_lot_ids),
        )
    )
    weight_by_lot: dict[uuid.UUID, GeneralMeetingLotWeight] = {
        w.lot_owner_id: w for w in weights_result.scalars().all()
    }

    # Get all visible motions (hidden motions must not appear on the confirmation/summary page)
    motions_result = await db.execute(
        select(Motion).where(
            Motion.general_meeting_id == general_meeting_id,
            Motion.is_visible == True,  # noqa: E712
        ).order_by(Motion.display_order)
    )
    motions = list(motions_result.scalars().all())

    # Get submitted votes for these lots

    votes_result = await db.execute(
        select(Vote, Motion)
        .join(Motion, Vote.motion_id == Motion.id)
        .where(
            Vote.general_meeting_id == general_meeting_id,
            Vote.voter_email == voter_email,
            Vote.lot_owner_id.in_(target_lot_ids),
            Vote.status == VoteStatus.submitted,
        )
        .order_by(Motion.display_order)
    )
    rows = votes_result.all()

    # Group votes by lot_owner_id
    votes_by_lot: dict[uuid.UUID, list] = {}
    for vote, motion in rows:
        lid = vote.lot_owner_id
        if lid not in votes_by_lot:
            votes_by_lot[lid] = []
        votes_by_lot[lid].append((vote, motion))

    submitted_lots = []
    for lot_owner_id in target_lot_ids:
        lo = lot_owners_by_id.get(lot_owner_id)
        if lo is None:  # pragma: no cover  # FK constraint guarantees lot_owner always exists
            continue
        weight = weight_by_lot.get(lot_owner_id)
        is_in_arrear = (
            weight is not None
            and weight.financial_position_snapshot == FinancialPositionSnapshot.in_arrear
        )
        fp_str = "in_arrear" if is_in_arrear else "normal"

        lot_votes: list[BallotVoteItem] = []
        lot_vote_rows = votes_by_lot.get(lot_owner_id, [])

        voted_motion_ids = {m.id for _, m in lot_vote_rows}

        for motion in motions:
            if is_in_arrear and motion.motion_type == MotionType.general:
                # Show as "not eligible" — the DB row should have choice=not_eligible
                # Find the actual vote for this motion if it exists
                not_eligible_choice = VoteChoice.not_eligible
                for vote, m in lot_vote_rows:
                    if m.id == motion.id:
                        not_eligible_choice = vote.choice if vote.choice is not None else VoteChoice.not_eligible
                        break
                lot_votes.append(BallotVoteItem(
                    motion_id=motion.id,
                    motion_title=motion.title,
                    display_order=motion.display_order,
                    motion_number=motion.motion_number,
                    choice=not_eligible_choice,
                    eligible=False,
                ))
            elif motion.id in voted_motion_ids:
                for vote, m in lot_vote_rows:
                    if m.id == motion.id:
                        lot_votes.append(BallotVoteItem(
                            motion_id=m.id,
                            motion_title=m.title,
                            display_order=m.display_order,
                            motion_number=m.motion_number,
                            choice=vote.choice,
                            eligible=True,
                        ))
                        break
            else:
                # Motion not voted on — show as abstained
                lot_votes.append(BallotVoteItem(
                    motion_id=motion.id,
                    motion_title=motion.title,
                    display_order=motion.display_order,
                    motion_number=motion.motion_number,
                    choice=VoteChoice.abstained,
                    eligible=True,
                ))

        submitted_lots.append(LotBallotSummary(
            lot_owner_id=lot_owner_id,
            lot_number=lo.lot_number,
            financial_position=fp_str,
            votes=lot_votes,
        ))

    # Sort by lot_number
    submitted_lots.sort(key=lambda l: l.lot_number)

    return MyBallotResponse(
        voter_email=voter_email,
        meeting_title=general_meeting.title,
        building_name=building.name if building else "",
        submitted_lots=submitted_lots,
        remaining_lot_owner_ids=remaining_lot_owner_ids,
    )
