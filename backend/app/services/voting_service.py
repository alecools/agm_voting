"""
Draft save and ballot submit service logic.
"""
import hashlib
import json
import logging
import uuid
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.logging_config import get_logger

logger = get_logger(__name__)

from app.models.general_meeting import GeneralMeeting, GeneralMeetingStatus, get_effective_status
from app.models.general_meeting_lot_weight import GeneralMeetingLotWeight, FinancialPositionSnapshot
from app.models.ballot_submission import BallotSubmission
from app.models.lot_owner import LotOwner
from app.models.lot_owner_email import LotOwnerEmail
from app.models.lot_proxy import LotProxy
from app.models.motion import Motion, MotionType
from app.models.motion_option import MotionOption
from app.models.vote import Vote, VoteChoice, VoteStatus
from app.schemas.voting import (
    BallotOptionChoiceItem,
    BallotVoteItem,
    DraftItem,
    DraftsResponse,
    LotBallotResult,
    LotBallotSummary,
    MultiChoiceOptionChoice,
    MultiChoiceVoteItem,
    MyBallotResponse,
    SubmitResponse,
    VoteSummaryItem,
)


def _compute_ballot_hash(
    agm_id: uuid.UUID,
    lot_owner_id: uuid.UUID,
    vote_choices: list[tuple[str, str]],
) -> str:
    """Compute a SHA-256 hex digest for ballot audit purposes (US-VIL-03).

    The hash is derived from: agm_id + lot_owner_id + sorted vote choices.
    vote_choices is a list of (motion_id_str, choice_str) tuples.
    Sorting ensures the hash is deterministic regardless of iteration order.
    """
    payload = json.dumps(
        {
            "agm_id": str(agm_id),
            "lot_owner_id": str(lot_owner_id),
            "votes": sorted(vote_choices),
        },
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()


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

    # Check not already submitted — check by lot_owner_id if provided, else by voter_email.
    # Exclude is_absent=True records (contact-email snapshots) — they are not real votes.
    if lot_owner_id is not None:
        submission_result = await db.execute(
            select(BallotSubmission).where(
                BallotSubmission.general_meeting_id == general_meeting_id,
                BallotSubmission.lot_owner_id == lot_owner_id,
                BallotSubmission.is_absent == False,  # noqa: E712
            )
        )
    else:
        submission_result = await db.execute(
            select(BallotSubmission).where(
                BallotSubmission.general_meeting_id == general_meeting_id,
                BallotSubmission.voter_email == voter_email,
                BallotSubmission.is_absent == False,  # noqa: E712
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
    multi_choice_votes: dict[uuid.UUID, list[MultiChoiceOptionChoice]] | None = None,
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
        logger.warning(
            "ballot_denied",
            reason="voting_not_started",
            agm_id=str(general_meeting_id),
            voter_email=voter_email,
        )
        raise HTTPException(status_code=403, detail="Voting has not started yet for this General Meeting")
    if effective_submit == GeneralMeetingStatus.closed:
        logger.warning(
            "ballot_denied",
            reason="meeting_closed",
            agm_id=str(general_meeting_id),
            voter_email=voter_email,
        )
        raise HTTPException(status_code=403, detail="Voting is closed for this meeting")

    if not lot_owner_ids:
        raise HTTPException(status_code=422, detail="At least one lot_owner_id is required")

    # Verify all lot_owner_ids belong to the authenticated voter_email
    # (either as direct owner via LotOwnerEmail, or as proxy via LotProxy)
    # Batch both lookups with IN queries to avoid O(N) round-trips (RR3-12).
    # Also determine proxy_email per lot for audit trail.
    direct_owner_result = await db.execute(
        select(LotOwnerEmail.lot_owner_id).where(
            LotOwnerEmail.lot_owner_id.in_(lot_owner_ids),
            LotOwnerEmail.email == voter_email,
        )
    )
    direct_owner_ids: set[uuid.UUID] = {row[0] for row in direct_owner_result.all()}

    proxy_result = await db.execute(
        select(LotProxy.lot_owner_id).where(
            LotProxy.lot_owner_id.in_(lot_owner_ids),
            LotProxy.proxy_email == voter_email,
        )
    )
    proxy_lot_ids: set[uuid.UUID] = {row[0] for row in proxy_result.all()}

    proxy_email_by_lot: dict[uuid.UUID, str | None] = {}
    for lot_owner_id in lot_owner_ids:
        if lot_owner_id in direct_owner_ids:
            proxy_email_by_lot[lot_owner_id] = None
        elif lot_owner_id in proxy_lot_ids:
            proxy_email_by_lot[lot_owner_id] = voter_email
        else:
            raise HTTPException(
                status_code=403,
                detail=f"Lot owner {lot_owner_id} does not belong to authenticated voter",
            )

    # Get existing real submissions for these lots — use SELECT FOR UPDATE to serialize
    # concurrent requests on the same (meeting, lot) rows and prevent double-submission.
    # Exclude is_absent=True records so absent-lot snapshots don't block re-voting
    # (which is anyway prevented earlier by the meeting-closed 403 check).
    existing_subs_result = await db.execute(
        select(BallotSubmission)
        .where(
            BallotSubmission.general_meeting_id == general_meeting_id,
            BallotSubmission.lot_owner_id.in_(lot_owner_ids),
            BallotSubmission.is_absent == False,  # noqa: E712
        )
        .with_for_update()
    )
    existing_subs_by_lot: dict[uuid.UUID, BallotSubmission] = {
        s.lot_owner_id: s for s in existing_subs_result.scalars().all()
    }

    # Get already-voted motion IDs per lot — single IN query instead of N queries (RR3-12).
    all_voted_result = await db.execute(
        select(Vote.lot_owner_id, Vote.motion_id).where(
            Vote.general_meeting_id == general_meeting_id,
            Vote.lot_owner_id.in_(lot_owner_ids),
            Vote.status == VoteStatus.submitted,
        )
    )
    already_voted_by_lot: dict[uuid.UUID, set[uuid.UUID]] = {}
    for row in all_voted_result.all():
        already_voted_by_lot.setdefault(row[0], set()).add(row[1])

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
    valid_motion_ids = {m.id for m in visible_motions}
    if inline_votes:
        unknown = [str(v) for v in inline_votes if v not in valid_motion_ids]
        if unknown:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown motion IDs: {unknown}",
            )
    if multi_choice_votes:
        unknown_mc = [str(v) for v in multi_choice_votes if v not in valid_motion_ids]
        if unknown_mc:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown motion IDs: {unknown_mc}",
            )

    # Check that none of the targeted motions have been individually closed
    motion_by_id = {m.id: m for m in visible_motions}
    all_targeted_motion_ids: set[uuid.UUID] = set()
    if inline_votes:
        all_targeted_motion_ids.update(inline_votes.keys())
    if multi_choice_votes:
        all_targeted_motion_ids.update(multi_choice_votes.keys())
    for mid in all_targeted_motion_ids:
        motion = motion_by_id.get(mid)
        if motion is not None and motion.voting_closed_at is not None:
            motion_label = motion.motion_number or str(motion.display_order)
            raise HTTPException(
                status_code=422,
                detail=f"Voting has closed for motion: {motion_label}",
            )

    # Load options for all visible multi-choice motions (single query to avoid N+1)
    mc_motion_ids = [m.id for m in visible_motions if m.is_multi_choice]
    mc_options_map: dict[uuid.UUID, set[uuid.UUID]] = {}  # motion_id -> set of valid option ids
    mc_motion_map: dict[uuid.UUID, Motion] = {}
    if mc_motion_ids:
        opts_result = await db.execute(
            select(MotionOption).where(MotionOption.motion_id.in_(mc_motion_ids))
        )
        for opt in opts_result.scalars().all():
            mc_options_map.setdefault(opt.motion_id, set()).add(opt.id)
        mc_motion_map = {m.id: m for m in visible_motions if m.is_multi_choice}

    mc_votes_map: dict[uuid.UUID, list[MultiChoiceOptionChoice]] = dict(multi_choice_votes) if multi_choice_votes else {}

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

        # Votes are built in memory first (no db.add yet) so they can all be
        # flushed atomically together with the BallotSubmission row.  This
        # prevents orphaned Vote rows if a concurrent request causes the
        # BallotSubmission INSERT to raise IntegrityError after some votes
        # have already been flushed (C-8 race condition).
        votes_to_add: list[Vote] = []

        # Multi-choice votes for this lot — keyed by motion_id
        mc_votes_for_lot = mc_votes_map

        for motion in visible_motions:
            # Skip motions this lot has already voted on (re-entry scenario)
            if motion.id in already_voted_for_lot:
                continue

            if motion.is_multi_choice:
                # Multi-choice handling
                if is_in_arrear:
                    # In-arrear lots: record not_eligible for multi-choice as well
                    motions_needing_not_eligible.append(motion)
                    continue

                option_choices = mc_votes_for_lot.get(motion.id, [])

                if not option_choices:
                    # No options interacted with — record motion-level abstain
                    motions_needing_new_vote.append(motion)
                else:
                    # Validate all option_ids belong to this motion
                    valid_opts = mc_options_map.get(motion.id, set())
                    for oc in option_choices:
                        if oc.option_id not in valid_opts:
                            raise HTTPException(
                                status_code=400,
                                detail=f"Invalid option ID {oc.option_id} for motion {motion.id}",
                            )
                    # Validate option limit: only "for" choices count toward the limit
                    for_count = sum(1 for oc in option_choices if oc.choice == "for")
                    mc_motion = mc_motion_map.get(motion.id)
                    if mc_motion and mc_motion.option_limit is not None:
                        if for_count > mc_motion.option_limit:
                            raise HTTPException(
                                status_code=422,
                                detail=f"Selected {for_count} 'for' options but limit is {mc_motion.option_limit}",
                            )
                    # Build one Vote per option_choice (deferred — no db.add yet)
                    for oc in option_choices:
                        if oc.choice == "for":
                            vote_choice = VoteChoice.selected
                        elif oc.choice == "against":
                            vote_choice = VoteChoice.against
                        else:
                            vote_choice = VoteChoice.abstained
                        votes_to_add.append(Vote(
                            general_meeting_id=general_meeting_id,
                            motion_id=motion.id,
                            voter_email=voter_email,
                            lot_owner_id=lot_owner_id,
                            choice=vote_choice,
                            motion_option_id=oc.option_id,
                            status=VoteStatus.submitted,
                        ))
                    # Add a summary item (use 'selected' as the choice sentinel)
                    vote_items.append(VoteSummaryItem(
                        motion_id=motion.id,
                        motion_title=motion.title,
                        choice=VoteChoice.selected,
                    ))
                continue

            # In-arrear lots cannot vote on General Motions — record not_eligible
            if is_in_arrear and motion.motion_type == MotionType.general:
                motions_needing_not_eligible.append(motion)
                continue

            # Use the inline choice if provided; otherwise mark as unanswered (→ abstained)
            choice = choice_by_motion.get(motion.id)
            if choice is not None:
                votes_to_add.append(Vote(
                    general_meeting_id=general_meeting_id,
                    motion_id=motion.id,
                    voter_email=voter_email,
                    lot_owner_id=lot_owner_id,
                    choice=choice,
                    status=VoteStatus.submitted,
                ))
                vote_items.append(VoteSummaryItem(
                    motion_id=motion.id,
                    motion_title=motion.title,
                    choice=choice,
                ))
            else:
                motions_needing_new_vote.append(motion)

        # Build not_eligible votes for in-arrear general motions (deferred — no db.add yet)
        for motion in motions_needing_not_eligible:
            votes_to_add.append(Vote(
                general_meeting_id=general_meeting_id,
                motion_id=motion.id,
                voter_email=voter_email,
                lot_owner_id=lot_owner_id,
                choice=VoteChoice.not_eligible,
                status=VoteStatus.submitted,
            ))
            vote_items.append(
                VoteSummaryItem(
                    motion_id=motion.id,
                    motion_title=motion.title,
                    choice=VoteChoice.not_eligible,
                )
            )

        for motion in motions_needing_new_vote:
            votes_to_add.append(Vote(
                general_meeting_id=general_meeting_id,
                motion_id=motion.id,
                voter_email=voter_email,
                lot_owner_id=lot_owner_id,
                choice=VoteChoice.abstained,
                status=VoteStatus.submitted,
            ))
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

        # Compute cryptographic hash of this ballot for audit trail (US-VIL-03).
        ballot_vote_choices = [
            (str(v.motion_id), v.choice.value if v.choice else "none")
            for v in votes_to_add
        ]
        computed_hash = _compute_ballot_hash(
            general_meeting_id, lot_owner_id, ballot_vote_choices
        )

        # Reuse existing BallotSubmission if present; otherwise create one.
        # The BallotSubmission row and all its Vote rows are added to the session
        # and flushed in a single batch so they are committed or rolled back
        # atomically.  This eliminates the C-8 orphaned-vote race: if a concurrent
        # request's BallotSubmission INSERT raises IntegrityError, the rollback
        # covers the votes too because they haven't been flushed yet.
        if lot_owner_id not in existing_subs_by_lot:
            try:
                submission = BallotSubmission(
                    general_meeting_id=general_meeting_id,
                    lot_owner_id=lot_owner_id,
                    voter_email=voter_email,
                    proxy_email=proxy_email_by_lot.get(lot_owner_id),
                    ballot_hash=computed_hash,
                    submitted_at=datetime.now(UTC),
                )
                db.add(submission)
                for vote in votes_to_add:
                    db.add(vote)
                await db.flush()
            except IntegrityError:
                # Concurrent submission beat this request — treat as already submitted
                await db.rollback()
                logger.warning(
                    "ballot_denied",
                    reason="already_submitted_concurrent",
                    agm_id=str(general_meeting_id),
                    voter_email=voter_email,
                    lot_owner_id=str(lot_owner_id),
                )
                raise HTTPException(status_code=409, detail="Ballot already submitted for this voter")
        else:
            # Re-entry: BallotSubmission already exists.  Add any newly visible
            # motion Vote rows (votes_to_add only contains motions not yet answered,
            # as already_voted_for_lot filters out already-submitted motions above).
            if votes_to_add:
                for vote in votes_to_add:
                    db.add(vote)
                await db.flush()

        lot_results.append(LotBallotResult(
            lot_owner_id=lot_owner_id,
            lot_number=lot_number,
            votes=vote_items,
        ))

    # US-VIL-06: log proxy_email audit trail when proxy submits
    proxy_lots = {str(k): v for k, v in proxy_email_by_lot.items() if v is not None}
    log_kwargs: dict = {
        "agm_id": str(general_meeting_id),
        "voter_email": voter_email,
        "lot_count": len(lot_owner_ids),
    }
    if proxy_lots:
        log_kwargs["proxy_email"] = voter_email
        log_kwargs["proxied_lot_ids"] = list(proxy_lots.keys())
    logger.info("ballot_submitted", **log_kwargs)
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

    # Get all real (non-absent) submissions for this General Meeting and voter.
    # Absent BallotSubmission records (is_absent=True) are created at meeting close
    # as a contact-email snapshot and must NOT be treated as actual votes here —
    # an absent voter must still see "You did not submit a ballot".
    all_subs_result = await db.execute(
        select(BallotSubmission).where(
            BallotSubmission.general_meeting_id == general_meeting_id,
            BallotSubmission.lot_owner_id.in_(all_lot_owner_ids),
            BallotSubmission.is_absent == False,  # noqa: E712
        )
    )
    all_subs = list(all_subs_result.scalars().all())
    submitted_lot_ids = {s.lot_owner_id for s in all_subs}
    # Map lot_owner_id -> BallotSubmission for submitter/proxy info
    submission_by_lot: dict[uuid.UUID, BallotSubmission] = {s.lot_owner_id: s for s in all_subs}
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

    # Get submitted votes for these lots, joining to Motion WITHOUT filtering on
    # is_visible.  The confirmation receipt must show all motions the voter actually
    # voted on, regardless of whether an admin later hides them (RR2-08 / US-TCG-06).
    # Using the Vote records as the driving set preserves the legal audit trail.
    # NOTE: We do NOT filter by voter_email here — a co-owner (different email, same lot)
    # must be able to see the ballot that was submitted by the other owner (US-MOV-01).
    votes_result = await db.execute(
        select(Vote, Motion)
        .join(Motion, Vote.motion_id == Motion.id)
        .where(
            Vote.general_meeting_id == general_meeting_id,
            Vote.lot_owner_id.in_(target_lot_ids),
            Vote.status == VoteStatus.submitted,
        )
        .order_by(Motion.display_order, Vote.created_at)
    )
    rows = votes_result.all()

    # Load motion options for selected votes (for multi-choice confirmation display)
    selected_option_ids = [
        vote.motion_option_id
        for vote, _ in rows
        if vote.motion_option_id is not None
    ]
    options_by_id: dict[uuid.UUID, MotionOption] = {}
    if selected_option_ids:
        opts_result = await db.execute(
            select(MotionOption).where(MotionOption.id.in_(selected_option_ids))
        )
        options_by_id = {opt.id: opt for opt in opts_result.scalars().all()}

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

        # Build the vote items from the voter's actual Vote records (not from the
        # current motion list).  This preserves the confirmation receipt even after
        # an admin hides a motion that was already voted on.
        # For multi-choice motions, group all Vote rows per motion into one item with
        # per-option choices (including "for", "against", and "abstained").
        seen_motion_ids: set[uuid.UUID] = set()
        for vote, motion in lot_vote_rows:
            eligible = not (
                is_in_arrear and motion.motion_type == MotionType.general
            )
            if motion.is_multi_choice:
                if motion.id in seen_motion_ids:
                    # Already have an item for this motion; add to its option_choices
                    if vote.motion_option_id is not None:
                        opt = options_by_id.get(vote.motion_option_id)
                        for existing_item in lot_votes:
                            if existing_item.motion_id == motion.id:
                                # Map stored VoteChoice back to display string
                                if vote.choice == VoteChoice.selected:
                                    choice_str = "for"
                                elif vote.choice == VoteChoice.against:
                                    choice_str = "against"
                                else:
                                    choice_str = "abstained"
                                existing_item.option_choices.append(
                                    BallotOptionChoiceItem(
                                        option_id=vote.motion_option_id,
                                        option_text=opt.text if opt else str(vote.motion_option_id),
                                        choice=choice_str,
                                    )
                                )
                                if vote.choice == VoteChoice.selected and opt is not None:
                                    from app.schemas.admin import MotionOptionOut as AdminMotionOptionOut
                                    existing_item.selected_options.append(
                                        AdminMotionOptionOut(
                                            id=opt.id,
                                            text=opt.text,
                                            display_order=opt.display_order,
                                        )
                                    )
                                break
                    continue
                seen_motion_ids.add(motion.id)
                # Create the BallotVoteItem with per-option choices
                from app.schemas.admin import MotionOptionOut as AdminMotionOptionOut
                selected_opts = []
                initial_option_choices = []
                if vote.motion_option_id is not None:
                    opt = options_by_id.get(vote.motion_option_id)
                    if vote.choice == VoteChoice.selected:
                        choice_str = "for"
                        if opt is not None:
                            selected_opts.append(
                                AdminMotionOptionOut(
                                    id=opt.id,
                                    text=opt.text,
                                    display_order=opt.display_order,
                                )
                            )
                    elif vote.choice == VoteChoice.against:
                        choice_str = "against"
                    else:
                        choice_str = "abstained"
                    initial_option_choices.append(
                        BallotOptionChoiceItem(
                            option_id=vote.motion_option_id,
                            option_text=opt.text if opt else str(vote.motion_option_id),
                            choice=choice_str,
                        )
                    )
                lot_votes.append(BallotVoteItem(
                    motion_id=motion.id,
                    motion_title=motion.title,
                    display_order=motion.display_order,
                    motion_number=motion.motion_number,
                    choice=vote.choice,
                    eligible=eligible,
                    motion_type=motion.motion_type,
                    is_multi_choice=motion.is_multi_choice,
                    selected_options=selected_opts,
                    option_choices=initial_option_choices,
                ))
            else:
                lot_votes.append(BallotVoteItem(
                    motion_id=motion.id,
                    motion_title=motion.title,
                    display_order=motion.display_order,
                    motion_number=motion.motion_number,
                    choice=vote.choice,
                    eligible=eligible,
                    motion_type=motion.motion_type,
                    is_multi_choice=motion.is_multi_choice,
                ))

        sub = submission_by_lot.get(lot_owner_id)
        submitted_lots.append(LotBallotSummary(
            lot_owner_id=lot_owner_id,
            lot_number=lo.lot_number,
            financial_position=fp_str,
            votes=lot_votes,
            submitter_email=sub.voter_email if sub is not None else "",
            proxy_email=sub.proxy_email if sub is not None else None,
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
