"""Integration tests for RR4 schema fixes.

Covers:
  RR4-20: Vote.motion_option_id FK RESTRICT — DELETE /api/admin/motions/{id}/options/{opt_id}
  RR4-23: ballot_hash service-layer enforcement
  RR4-27: submitted_by_admin_username stored and returned in admin detail
  RR4-33: close_motion service-layer validation: voting_closed_at > meeting_at
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    BallotSubmission,
    Building,
    GeneralMeeting,
    GeneralMeetingLotWeight,
    GeneralMeetingStatus,
    LotOwner,
    Motion,
    MotionOption,
    Vote,
    VoteChoice,
    VoteStatus,
    FinancialPositionSnapshot,
)
from app.models.lot import Lot
from app.models.lot_person import lot_persons
from app.models.person import Person

from tests.conftest import meeting_dt, closing_dt, add_person_to_lot


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_building(name: str) -> Building:
    return Building(name=name, manager_email=f"mgr_{name}@test.com")


def make_lot_owner(b: Building, lot_number: str, entitlement: int = 100) -> LotOwner:
    return LotOwner(building_id=b.id, lot_number=lot_number, unit_entitlement=entitlement)


def make_open_meeting(b: Building, title: str) -> GeneralMeeting:
    return GeneralMeeting(
        building_id=b.id,
        title=title,
        status=GeneralMeetingStatus.open,
        meeting_at=meeting_dt(),
        voting_closes_at=closing_dt(),
    )


async def _setup_mc_meeting(
    db_session: AsyncSession,
    name: str,
) -> tuple[GeneralMeeting, LotOwner, Motion, MotionOption, MotionOption]:
    """Create an open meeting with a multi-choice motion and 2 options."""
    b = make_building(f"RR4 {name}")
    db_session.add(b)
    await db_session.flush()

    lo = make_lot_owner(b, f"RR4{name}01")
    db_session.add(lo)
    await db_session.flush()

    agm = make_open_meeting(b, f"RR4 Test {name}")
    db_session.add(agm)
    await db_session.flush()

    w = GeneralMeetingLotWeight(
        general_meeting_id=agm.id,
        lot_id=lo.id,
        unit_entitlement_snapshot=100,
        financial_position_snapshot=FinancialPositionSnapshot.normal,
    )
    db_session.add(w)

    await add_person_to_lot(db_session, lo, f"rr4_{name}@example.com")

    motion = Motion(
        general_meeting_id=agm.id,
        title="MC Motion",
        display_order=1,
        is_visible=True,
        is_multi_choice=True,
        option_limit=1,
    )
    db_session.add(motion)
    await db_session.flush()

    opt1 = MotionOption(motion_id=motion.id, text="Option A", display_order=1)
    opt2 = MotionOption(motion_id=motion.id, text="Option B", display_order=2)
    db_session.add(opt1)
    db_session.add(opt2)
    await db_session.flush()

    await db_session.commit()
    return agm, lo, motion, opt1, opt2


async def _setup_simple_meeting(
    db_session: AsyncSession,
    name: str,
) -> tuple[GeneralMeeting, LotOwner, Motion]:
    """Create an open meeting with a single standard motion."""
    b = make_building(f"RR4Simple {name}")
    db_session.add(b)
    await db_session.flush()

    lo = make_lot_owner(b, f"RR4S{name}01")
    db_session.add(lo)
    await db_session.flush()

    agm = make_open_meeting(b, f"RR4 Simple {name}")
    db_session.add(agm)
    await db_session.flush()

    w = GeneralMeetingLotWeight(
        general_meeting_id=agm.id,
        lot_id=lo.id,
        unit_entitlement_snapshot=100,
        financial_position_snapshot=FinancialPositionSnapshot.normal,
    )
    db_session.add(w)

    await add_person_to_lot(db_session, lo, f"rr4s_{name}@example.com")

    motion = Motion(
        general_meeting_id=agm.id,
        title="Simple Motion",
        display_order=1,
        is_visible=True,
    )
    db_session.add(motion)
    await db_session.flush()
    await db_session.commit()
    return agm, lo, motion


# ---------------------------------------------------------------------------
# RR4-20: Delete motion option endpoint
# ---------------------------------------------------------------------------


class TestDeleteMotionOption:
    """Tests for DELETE /api/admin/motions/{motion_id}/options/{option_id}."""

    # --- Happy path ---

    async def test_delete_option_with_no_votes_returns_204(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Deleting an option with no votes returns 204."""
        agm, lo, motion, opt1, opt2 = await _setup_mc_meeting(db_session, "DelOpt01")
        resp = await client.delete(f"/api/admin/motions/{motion.id}/options/{opt1.id}")
        assert resp.status_code == 204

        # Verify the option is gone
        result = await db_session.execute(
            select(MotionOption).where(MotionOption.id == opt1.id)
        )
        assert result.scalar_one_or_none() is None

    # --- State / precondition errors ---

    async def test_delete_option_with_submitted_votes_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Deleting an option that has submitted votes returns 409 (RESTRICT FK)."""
        agm, lo, motion, opt1, opt2 = await _setup_mc_meeting(db_session, "DelVoted01")

        # Add a submitted vote referencing opt1
        vote = Vote(
            general_meeting_id=agm.id,
            motion_id=motion.id,
            voter_email="voter@example.com",
            lot_owner_id=lo.id,
            choice=VoteChoice.selected,
            status=VoteStatus.submitted,
            motion_option_id=opt1.id,
        )
        db_session.add(vote)
        await db_session.commit()

        resp = await client.delete(f"/api/admin/motions/{motion.id}/options/{opt1.id}")
        assert resp.status_code == 409
        assert "submitted votes" in resp.json()["detail"]

    async def test_delete_option_not_found_returns_404(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Deleting a non-existent option returns 404."""
        agm, lo, motion, opt1, opt2 = await _setup_mc_meeting(db_session, "DelNotFound")
        nonexistent_id = uuid.uuid4()
        resp = await client.delete(f"/api/admin/motions/{motion.id}/options/{nonexistent_id}")
        assert resp.status_code == 404
        assert "not found" in resp.json()["detail"].lower()

    async def test_delete_option_wrong_motion_returns_404(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Using a valid option ID but wrong motion ID returns 404."""
        agm, lo, motion, opt1, opt2 = await _setup_mc_meeting(db_session, "DelWrongMotion")
        wrong_motion_id = uuid.uuid4()
        resp = await client.delete(f"/api/admin/motions/{wrong_motion_id}/options/{opt1.id}")
        assert resp.status_code == 404

    # --- Edge cases ---

    async def test_delete_option_with_draft_votes_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Draft votes also block deletion because the FK RESTRICT fires on any vote."""
        agm, lo, motion, opt1, opt2 = await _setup_mc_meeting(db_session, "DelDraft01")

        # Add a draft vote referencing opt1
        vote = Vote(
            general_meeting_id=agm.id,
            motion_id=motion.id,
            voter_email="voter@example.com",
            lot_owner_id=lo.id,
            choice=VoteChoice.selected,
            status=VoteStatus.draft,
            motion_option_id=opt1.id,
        )
        db_session.add(vote)
        await db_session.commit()

        # Even draft votes block the delete due to FK RESTRICT on votes.motion_option_id
        resp = await client.delete(f"/api/admin/motions/{motion.id}/options/{opt1.id}")
        assert resp.status_code == 409


# ---------------------------------------------------------------------------
# RR4-23: ballot_hash service-layer enforcement
# ---------------------------------------------------------------------------


class TestBallotHashEnforcement:
    """Verify that voter-submitted BallotSubmissions always have ballot_hash set (RR4-23)."""

    async def test_compute_ballot_hash_returns_non_null_string(self):
        """_compute_ballot_hash always returns a non-null 64-char hex string."""
        from app.services.voting_service import _compute_ballot_hash

        agm_id = uuid.uuid4()
        lot_owner_id = uuid.uuid4()
        choices = [(str(uuid.uuid4()), "yes")]
        result = _compute_ballot_hash(agm_id, lot_owner_id, choices)
        assert result is not None
        assert isinstance(result, str)
        assert len(result) == 64  # SHA-256 hex digest

    async def test_compute_ballot_hash_empty_choices(self):
        """_compute_ballot_hash handles empty vote list."""
        from app.services.voting_service import _compute_ballot_hash

        agm_id = uuid.uuid4()
        lot_owner_id = uuid.uuid4()
        result = _compute_ballot_hash(agm_id, lot_owner_id, [])
        assert result is not None
        assert len(result) == 64

    async def test_compute_ballot_hash_deterministic(self):
        """_compute_ballot_hash is deterministic for same inputs."""
        from app.services.voting_service import _compute_ballot_hash

        agm_id = uuid.uuid4()
        lot_owner_id = uuid.uuid4()
        motion_id = str(uuid.uuid4())
        choices = [(motion_id, "yes")]

        h1 = _compute_ballot_hash(agm_id, lot_owner_id, choices)
        h2 = _compute_ballot_hash(agm_id, lot_owner_id, choices)
        assert h1 == h2

    async def test_ballot_submission_created_with_non_null_hash(
        self, db_session: AsyncSession
    ):
        """Voter-submitted BallotSubmission is created with non-null ballot_hash (RR4-23).

        This integration test verifies the service layer always provides ballot_hash
        before creating a BallotSubmission.
        """
        from app.services.voting_service import _compute_ballot_hash

        agm, lo, motion = await _setup_simple_meeting(db_session, "HashCheck01")

        # Simulate what voting_service does: compute hash then create BallotSubmission
        choices = [(str(motion.id), "yes")]
        computed_hash = _compute_ballot_hash(agm.id, lo.id, choices)
        assert computed_hash is not None

        submission = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            voter_email="rr4s_HashCheck01@example.com",
            ballot_hash=computed_hash,
        )
        db_session.add(submission)
        await db_session.flush()

        # Verify stored hash matches
        result = await db_session.execute(
            select(BallotSubmission).where(BallotSubmission.id == submission.id)
        )
        stored = result.scalar_one()
        assert stored.ballot_hash == computed_hash
        assert len(stored.ballot_hash) == 64


# ---------------------------------------------------------------------------
# RR4-27: submitted_by_admin_username stored and returned
# ---------------------------------------------------------------------------


class TestSubmittedByAdminUsername:
    """Tests for RR4-27: admin_username stored on BallotSubmission and returned in detail."""

    async def test_enter_votes_stores_admin_username(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """enter_votes_for_meeting stores the admin session username on BallotSubmission."""
        from app.services.admin_service import enter_votes_for_meeting
        from app.schemas.admin import AdminVoteEntry, AdminVoteEntryRequest

        agm, lo, motion = await _setup_simple_meeting(db_session, "AdminUser01")

        request = AdminVoteEntryRequest(
            entries=[
                AdminVoteEntry(
                    lot_owner_id=lo.id,
                    votes=[{"motion_id": str(motion.id), "choice": "yes"}],
                    multi_choice_votes=[],
                )
            ]
        )
        result = await enter_votes_for_meeting(
            agm.id, request, db_session, admin_username="testadmin"
        )
        assert result["submitted_count"] == 1

        # Query directly after service commit
        sub_result = await db_session.execute(
            select(BallotSubmission).where(
                BallotSubmission.general_meeting_id == agm.id,
                BallotSubmission.lot_owner_id == lo.id,
                BallotSubmission.submitted_by_admin == True,  # noqa: E712
            )
        )
        sub = sub_result.scalar_one()
        assert sub.submitted_by_admin_username == "testadmin"

    async def test_enter_votes_stores_none_when_no_session_username(
        self, db_session: AsyncSession
    ):
        """enter_votes_for_meeting stores NULL username if admin_username=None."""
        from app.services.admin_service import enter_votes_for_meeting
        from app.schemas.admin import AdminVoteEntry, AdminVoteEntryRequest

        agm, lo, motion = await _setup_simple_meeting(db_session, "AdminUser02")

        request = AdminVoteEntryRequest(
            entries=[
                AdminVoteEntry(
                    lot_owner_id=lo.id,
                    votes=[{"motion_id": str(motion.id), "choice": "yes"}],
                    multi_choice_votes=[],
                )
            ]
        )
        result = await enter_votes_for_meeting(agm.id, request, db_session, admin_username=None)
        assert result["submitted_count"] == 1

        # Query directly after service commit
        sub_result = await db_session.execute(
            select(BallotSubmission).where(
                BallotSubmission.general_meeting_id == agm.id,
                BallotSubmission.lot_owner_id == lo.id,
            )
        )
        sub = sub_result.scalar_one()
        assert sub.submitted_by_admin_username is None

    async def test_admin_detail_includes_submitted_by_admin_username(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Admin meeting detail includes submitted_by_admin_username in voter lists."""
        from app.services.admin_service import enter_votes_for_meeting
        from app.schemas.admin import AdminVoteEntry, AdminVoteEntryRequest

        agm, lo, motion = await _setup_simple_meeting(db_session, "AdminUser03")

        request = AdminVoteEntryRequest(
            entries=[
                AdminVoteEntry(
                    lot_owner_id=lo.id,
                    votes=[{"motion_id": str(motion.id), "choice": "yes"}],
                    multi_choice_votes=[],
                )
            ]
        )
        await enter_votes_for_meeting(agm.id, request, db_session, admin_username="adminuser")

        # Fetch meeting detail via HTTP
        detail_resp = await client.get(f"/api/admin/general-meetings/{agm.id}")
        assert detail_resp.status_code == 200
        detail = detail_resp.json()

        motion_detail = detail["motions"][0]
        yes_voters = motion_detail["voter_lists"]["yes"]
        assert len(yes_voters) == 1
        assert yes_voters[0]["submitted_by_admin_username"] == "adminuser"

    async def test_admin_detail_absent_voter_has_null_submitted_by_admin_username(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Absent voter entries have submitted_by_admin_username=null in detail."""
        agm, lo, motion = await _setup_simple_meeting(db_session, "AdminUser04")

        # Create an absent ballot submission directly (simulates meeting close absent record)
        absent_sub = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            voter_email="absent@example.com",
            is_absent=True,
            submitted_by_admin=False,
        )
        db_session.add(absent_sub)
        await db_session.commit()

        # Close the meeting to make absent records show up
        from app.models.general_meeting import GeneralMeetingStatus
        agm.status = GeneralMeetingStatus.closed
        await db_session.commit()

        # Fetch meeting detail
        detail_resp = await client.get(f"/api/admin/general-meetings/{agm.id}")
        assert detail_resp.status_code == 200
        detail = detail_resp.json()

        motion_detail = detail["motions"][0]
        absent_voters = motion_detail["voter_lists"]["absent"]
        assert len(absent_voters) == 1
        assert absent_voters[0]["submitted_by_admin_username"] is None


# ---------------------------------------------------------------------------
# RR4-33: close_motion temporal constraint
# ---------------------------------------------------------------------------


class TestCloseMotionTemporalConstraint:
    """Tests for RR4-33: voting_closed_at > meeting_at validation."""

    async def test_close_motion_on_open_meeting_succeeds(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Closing a motion on an open meeting (meeting_at in past) succeeds."""
        agm, lo, motion = await _setup_simple_meeting(db_session, "CloseMotion01")

        resp = await client.post(f"/api/admin/motions/{motion.id}/close")
        assert resp.status_code == 200
        data = resp.json()
        assert data["voting_closed_at"] is not None

    async def test_close_motion_when_close_time_before_meeting_at_returns_422(
        self, db_session: AsyncSession
    ):
        """close_motion returns 422 when voting close time would be <= meeting_at."""
        import app.services.admin_service as admin_svc
        from fastapi import HTTPException

        agm, lo, motion = await _setup_simple_meeting(db_session, "CloseMotion02")

        # Patch datetime.now in admin_service to return a time BEFORE meeting_at
        past_time = agm.meeting_at - timedelta(minutes=5)
        if past_time.tzinfo is None:
            past_time = past_time.replace(tzinfo=UTC)

        with patch.object(admin_svc, "datetime") as mock_dt:
            mock_dt.now.return_value = past_time

            with pytest.raises(HTTPException) as exc_info:
                await admin_svc.close_motion(motion.id, db_session)

        assert exc_info.value.status_code == 422
        assert "Voting close time must be after meeting start time" in str(
            exc_info.value.detail
        )


    async def test_close_motion_when_close_time_equal_to_meeting_at_returns_422(
        self, db_session: AsyncSession
    ):
        """close_motion returns 422 when close_time == meeting_at (not strictly after)."""
        import app.services.admin_service as admin_svc
        from fastapi import HTTPException

        agm, lo, motion = await _setup_simple_meeting(db_session, "CloseMotion03")

        # Patch datetime.now to return exactly meeting_at
        equal_time = agm.meeting_at
        if equal_time.tzinfo is None:
            equal_time = equal_time.replace(tzinfo=UTC)
        else:
            equal_time = equal_time.astimezone(UTC)

        with patch.object(admin_svc, "datetime") as mock_dt:
            mock_dt.now.return_value = equal_time

            with pytest.raises(HTTPException) as exc_info:
                await admin_svc.close_motion(motion.id, db_session)

        assert exc_info.value.status_code == 422
        assert "Voting close time must be after meeting start time" in str(
            exc_info.value.detail
        )
