"""Tests for admin in-person vote entry (US-AVE-01, US-AVE-02, US-AVE-03)."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
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
    FinancialPosition,
    FinancialPositionSnapshot,
)
from app.models.lot_owner_email import LotOwnerEmail

from tests.conftest import meeting_dt, closing_dt


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_building(name: str) -> Building:
    return Building(name=name, manager_email=f"mgr_{name}@test.com")


def make_lot_owner(b: Building, lot_number: str, entitlement: int = 100, financial_position: str = "normal") -> LotOwner:
    return LotOwner(building_id=b.id, lot_number=lot_number, unit_entitlement=entitlement, financial_position=financial_position)


def make_open_meeting(b: Building, title: str) -> GeneralMeeting:
    return GeneralMeeting(
        building_id=b.id,
        title=title,
        status=GeneralMeetingStatus.open,
        meeting_at=meeting_dt(),
        voting_closes_at=closing_dt(),
    )


async def _setup_meeting_with_lots(
    db_session: AsyncSession,
    name: str,
    n_lots: int = 2,
    with_motion: bool = True,
    in_arrear_idx: int | None = None,
) -> tuple[GeneralMeeting, list[LotOwner], list[Motion]]:
    b = make_building(f"VE {name}")
    db_session.add(b)
    await db_session.flush()

    lots = []
    for i in range(n_lots):
        fp = "in_arrear" if in_arrear_idx == i else "normal"
        lo = make_lot_owner(b, f"VE{name}{i}", financial_position=fp)
        db_session.add(lo)
        lots.append(lo)
    await db_session.flush()

    agm = make_open_meeting(b, f"VE Test {name}")
    db_session.add(agm)
    await db_session.flush()

    # Create snapshot weights
    for lo in lots:
        fp_snap = FinancialPositionSnapshot.in_arrear if lo.financial_position == "in_arrear" else FinancialPositionSnapshot.normal
        w = GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=lo.unit_entitlement,
            financial_position_snapshot=fp_snap,
        )
        db_session.add(w)

    motions = []
    if with_motion:
        m = Motion(
            general_meeting_id=agm.id,
            title="VE Motion",
            display_order=1,
            is_visible=True,
        )
        db_session.add(m)
        motions.append(m)

    await db_session.commit()
    await db_session.refresh(agm)
    for lo in lots:
        await db_session.refresh(lo)
    for m in motions:
        await db_session.refresh(m)

    return agm, lots, motions


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestAdminVoteEntry:

    async def test_happy_path_creates_ballot_submissions(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Admin submits votes for 2 lots; both get BallotSubmission(submitted_by_admin=True)."""
        agm, lots, motions = await _setup_meeting_with_lots(db_session, "HappyPath")

        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lots[0].id),
                    "votes": [{"motion_id": str(motions[0].id), "choice": "yes"}],
                    "multi_choice_votes": [],
                },
                {
                    "lot_owner_id": str(lots[1].id),
                    "votes": [{"motion_id": str(motions[0].id), "choice": "no"}],
                    "multi_choice_votes": [],
                },
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["submitted_count"] == 2
        assert data["skipped_count"] == 0

        # Verify DB state
        await db_session.flush()  # ensure session is synced
        subs_result = await db_session.execute(
            select(BallotSubmission).where(BallotSubmission.general_meeting_id == agm.id)
        )
        subs = list(subs_result.scalars().all())
        assert len(subs) == 2
        assert all(s.submitted_by_admin for s in subs)
        assert all(s.voter_email == "admin" for s in subs)

    async def test_skip_lot_with_all_motions_already_voted(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """A lot that has already voted on all visible motions is skipped; skipped_count = 1."""
        agm, lots, motions = await _setup_meeting_with_lots(db_session, "SkipExisting")

        # Create an existing submission + vote for lots[0] on the only visible motion
        existing_sub = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lots[0].id,
            voter_email="voter@test.com",
            submitted_by_admin=False,
        )
        db_session.add(existing_sub)
        existing_vote = Vote(
            general_meeting_id=agm.id,
            motion_id=motions[0].id,
            voter_email="voter@test.com",
            lot_owner_id=lots[0].id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        )
        db_session.add(existing_vote)
        await db_session.commit()

        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lots[0].id),
                    "votes": [{"motion_id": str(motions[0].id), "choice": "no"}],
                    "multi_choice_votes": [],
                },
                {
                    "lot_owner_id": str(lots[1].id),
                    "votes": [{"motion_id": str(motions[0].id), "choice": "yes"}],
                    "multi_choice_votes": [],
                },
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["submitted_count"] == 1
        assert data["skipped_count"] == 1

    async def test_in_arrear_lot_general_motion_not_eligible(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """In-arrear lot + general motion → vote recorded as not_eligible."""
        agm, lots, motions = await _setup_meeting_with_lots(
            db_session, "InArrear", in_arrear_idx=0
        )

        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lots[0].id),
                    "votes": [{"motion_id": str(motions[0].id), "choice": "yes"}],
                    "multi_choice_votes": [],
                },
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200

        await db_session.flush()  # ensure session is synced
        vote_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lots[0].id,
            )
        )
        vote = vote_result.scalar_one()
        assert vote.choice == VoteChoice.not_eligible

    async def test_closed_meeting_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Submitting to a closed meeting returns 409."""
        b = make_building("VE Closed")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, "VE-C1")
        db_session.add(lo)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="VE Closed AGM",
            status=GeneralMeetingStatus.closed,
            meeting_at=meeting_dt(),
            voting_closes_at=datetime.now(UTC) - timedelta(hours=1),
            closed_at=datetime.now(UTC),
        )
        db_session.add(agm)
        await db_session.commit()

        payload = {"entries": [{"lot_owner_id": str(lo.id), "votes": [], "multi_choice_votes": []}]}
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 409

    async def test_unknown_lot_owner_id_returns_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Unknown lot_owner_id returns 422."""
        agm, _, _ = await _setup_meeting_with_lots(db_session, "UnknownLot")
        fake_id = str(uuid.uuid4())
        payload = {"entries": [{"lot_owner_id": fake_id, "votes": [], "multi_choice_votes": []}]}
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 422

    async def test_not_found_meeting_returns_404(
        self, client: AsyncClient
    ):
        """Non-existent meeting ID returns 404."""
        fake_id = str(uuid.uuid4())
        payload = {"entries": []}
        resp = await client.post(f"/api/admin/general-meetings/{fake_id}/enter-votes", json=payload)
        assert resp.status_code == 404

    async def test_multi_choice_option_limit_not_enforced_on_for(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Sending more option_ids than option_limit is now allowed (option_limit is for tally only)."""
        b = make_building("VE MC Limit")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, "VE-MC1")
        db_session.add(lo)
        await db_session.flush()
        agm = make_open_meeting(b, "VE MC AGM")
        db_session.add(agm)
        await db_session.flush()
        w = GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=lo.unit_entitlement,
            financial_position_snapshot=FinancialPositionSnapshot.normal,
        )
        db_session.add(w)
        m = Motion(
            general_meeting_id=agm.id,
            title="MC Motion",
            display_order=1,
            is_visible=True,
            is_multi_choice=True,
            option_limit=2,
        )
        db_session.add(m)
        await db_session.flush()
        opts = [MotionOption(motion_id=m.id, text=f"Opt{i}", display_order=i+1) for i in range(3)]
        for opt in opts:
            db_session.add(opt)
        await db_session.commit()
        await db_session.refresh(agm)
        await db_session.refresh(lo)
        for opt in opts:
            await db_session.refresh(opt)

        # All 3 options as "for" with option_limit=2 — should now succeed
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lo.id),
                    "votes": [],
                    "multi_choice_votes": [
                        {"motion_id": str(m.id), "option_ids": [str(opts[0].id), str(opts[1].id), str(opts[2].id)]}
                    ],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200
        assert resp.json()["submitted_count"] == 1

    async def test_multi_choice_happy_path(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Multi-choice votes within limit are recorded correctly."""
        b = make_building("VE MC Happy")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, "VE-MCH1")
        db_session.add(lo)
        await db_session.flush()
        agm = make_open_meeting(b, "VE MC Happy AGM")
        db_session.add(agm)
        await db_session.flush()
        w = GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=lo.unit_entitlement,
            financial_position_snapshot=FinancialPositionSnapshot.normal,
        )
        db_session.add(w)
        m = Motion(
            general_meeting_id=agm.id,
            title="MC Motion Happy",
            display_order=1,
            is_visible=True,
            is_multi_choice=True,
            option_limit=2,
        )
        db_session.add(m)
        await db_session.flush()
        opts = [MotionOption(motion_id=m.id, text=f"Opt{i}", display_order=i+1) for i in range(3)]
        for opt in opts:
            db_session.add(opt)
        await db_session.commit()
        await db_session.refresh(agm)
        await db_session.refresh(lo)
        for opt in opts:
            await db_session.refresh(opt)

        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lo.id),
                    "votes": [],
                    "multi_choice_votes": [
                        {"motion_id": str(m.id), "option_ids": [str(opts[0].id), str(opts[1].id)]}
                    ],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["submitted_count"] == 1

        await db_session.flush()  # ensure session is synced
        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lo.id,
                Vote.choice == VoteChoice.selected,
            )
        )
        votes = list(votes_result.scalars().all())
        assert len(votes) == 2

    async def test_invalid_choice_returns_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """An unrecognized choice string returns 422."""
        agm, lots, motions = await _setup_meeting_with_lots(db_session, "InvalidChoice")
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lots[0].id),
                    "votes": [{"motion_id": str(motions[0].id), "choice": "invalid_choice"}],
                    "multi_choice_votes": [],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 422

    async def test_invalid_motion_id_in_votes_returns_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """An unrecognized motion_id in votes returns 422."""
        agm, lots, _ = await _setup_meeting_with_lots(db_session, "InvalidMotion")
        fake_motion_id = str(uuid.uuid4())
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lots[0].id),
                    "votes": [{"motion_id": fake_motion_id, "choice": "yes"}],
                    "multi_choice_votes": [],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 422

    async def test_invalid_motion_id_in_mc_votes_returns_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """An unrecognized motion_id in multi_choice_votes returns 422."""
        agm, lots, _ = await _setup_meeting_with_lots(db_session, "InvalidMCMotion")
        fake_motion_id = str(uuid.uuid4())
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lots[0].id),
                    "votes": [],
                    "multi_choice_votes": [{"motion_id": fake_motion_id, "option_ids": []}],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 422

    async def test_invalid_option_id_returns_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """An option_id that doesn't belong to the motion returns 422."""
        b = make_building("VE InvOpt")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, "VE-IO1")
        db_session.add(lo)
        await db_session.flush()
        agm = make_open_meeting(b, "VE InvOpt AGM")
        db_session.add(agm)
        await db_session.flush()
        w = GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=lo.unit_entitlement,
            financial_position_snapshot=FinancialPositionSnapshot.normal,
        )
        db_session.add(w)
        m = Motion(
            general_meeting_id=agm.id,
            title="InvOpt Motion",
            display_order=1,
            is_visible=True,
            is_multi_choice=True,
            option_limit=1,
        )
        db_session.add(m)
        await db_session.flush()
        opt = MotionOption(motion_id=m.id, text="Valid Opt", display_order=1)
        db_session.add(opt)
        await db_session.commit()
        await db_session.refresh(agm)
        await db_session.refresh(lo)

        fake_opt_id = str(uuid.uuid4())
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lo.id),
                    "votes": [],
                    "multi_choice_votes": [
                        {"motion_id": str(m.id), "option_ids": [fake_opt_id]}
                    ],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 422

    async def test_empty_entries_returns_success(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Empty entries list is a no-op returning 200 with zeros."""
        agm, _, _ = await _setup_meeting_with_lots(db_session, "EmptyEntries")
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json={"entries": []})
        assert resp.status_code == 200
        data = resp.json()
        assert data["submitted_count"] == 0
        assert data["skipped_count"] == 0

    async def test_no_vote_provided_records_no_vote(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """When no vote is provided for a visible motion, no vote is recorded (no auto-abstain).
        The frontend only sends motions the admin explicitly set, so an absent motion
        means no choice was made and it is left unrecorded for future entry."""
        agm, lots, motions = await _setup_meeting_with_lots(db_session, "NoVoteRecorded")
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lots[0].id),
                    "votes": [],  # no vote provided
                    "multi_choice_votes": [],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200
        # submitted_count is 0 because no votes were actually added
        data = resp.json()
        assert data["submitted_count"] == 0
        assert data["skipped_count"] == 1

        await db_session.flush()  # ensure session is synced
        vote_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lots[0].id,
            )
        )
        votes = list(vote_result.scalars().all())
        assert len(votes) == 0

    async def test_submitted_by_admin_false_on_voter_submission(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """BallotSubmission created via admin vote entry has submitted_by_admin=True."""
        agm, lots, motions = await _setup_meeting_with_lots(db_session, "FlagCheck")
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lots[0].id),
                    "votes": [{"motion_id": str(motions[0].id), "choice": "yes"}],
                    "multi_choice_votes": [],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200

        await db_session.flush()  # ensure session is synced
        sub_result = await db_session.execute(
            select(BallotSubmission).where(
                BallotSubmission.general_meeting_id == agm.id,
                BallotSubmission.lot_owner_id == lots[0].id,
            )
        )
        sub = sub_result.scalar_one()
        assert sub.submitted_by_admin is True

    async def test_multi_choice_no_options_records_no_vote(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Multi-choice motion with no options submitted records no vote (no auto-abstain).
        The frontend only sends MC motions the admin explicitly interacted with, so an
        empty option_ids means no choice was made and it is left unrecorded."""
        b = make_building("VE MC NoVoteDefault")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, "VE-MCN1")
        db_session.add(lo)
        await db_session.flush()
        agm = make_open_meeting(b, "VE MC NoVote AGM")
        db_session.add(agm)
        await db_session.flush()
        w = GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=lo.unit_entitlement,
            financial_position_snapshot=FinancialPositionSnapshot.normal,
        )
        db_session.add(w)
        m = Motion(
            general_meeting_id=agm.id,
            title="MC NoVote Motion",
            display_order=1,
            is_visible=True,
            is_multi_choice=True,
            option_limit=2,
        )
        db_session.add(m)
        await db_session.flush()
        opt = MotionOption(motion_id=m.id, text="Opt", display_order=1)
        db_session.add(opt)
        await db_session.commit()
        await db_session.refresh(agm)
        await db_session.refresh(lo)

        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lo.id),
                    "votes": [],
                    "multi_choice_votes": [
                        {"motion_id": str(m.id), "option_ids": []}
                    ],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["submitted_count"] == 0
        assert data["skipped_count"] == 1

        await db_session.flush()  # ensure session is synced
        vote_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lo.id,
            )
        )
        votes = list(vote_result.scalars().all())
        assert len(votes) == 0

    async def test_in_arrear_lot_multi_choice_not_eligible(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """In-arrear lot + multi-choice motion → not_eligible."""
        b = make_building("VE MC InArrear")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, "VE-MCIA1", financial_position="in_arrear")
        db_session.add(lo)
        await db_session.flush()
        agm = make_open_meeting(b, "VE MC InArrear AGM")
        db_session.add(agm)
        await db_session.flush()
        w = GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=lo.unit_entitlement,
            financial_position_snapshot=FinancialPositionSnapshot.in_arrear,
        )
        db_session.add(w)
        m = Motion(
            general_meeting_id=agm.id,
            title="MC InArrear Motion",
            display_order=1,
            is_visible=True,
            is_multi_choice=True,
            option_limit=1,
        )
        db_session.add(m)
        await db_session.flush()
        opt = MotionOption(motion_id=m.id, text="Opt", display_order=1)
        db_session.add(opt)
        await db_session.commit()
        await db_session.refresh(agm)
        await db_session.refresh(lo)
        await db_session.refresh(opt)

        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lo.id),
                    "votes": [],
                    "multi_choice_votes": [
                        {"motion_id": str(m.id), "option_ids": [str(opt.id)]}
                    ],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200

        await db_session.flush()  # ensure session is synced
        vote_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lo.id,
            )
        )
        vote = vote_result.scalar_one()
        assert vote.choice == VoteChoice.not_eligible

    async def test_submitted_by_admin_in_voter_list(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """get_general_meeting_detail includes submitted_by_admin on voter list entries."""
        agm, lots, motions = await _setup_meeting_with_lots(db_session, "VoterListFlag")

        # Submit as admin
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lots[0].id),
                    "votes": [{"motion_id": str(motions[0].id), "choice": "yes"}],
                    "multi_choice_votes": [],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200

        # Fetch detail and check submitted_by_admin flag in voter_lists
        detail_resp = await client.get(f"/api/admin/general-meetings/{agm.id}")
        assert detail_resp.status_code == 200
        detail = detail_resp.json()

        motion_detail = detail["motions"][0]
        yes_voters = motion_detail["voter_lists"]["yes"]
        assert len(yes_voters) == 1
        assert yes_voters[0]["submitted_by_admin"] is True

    async def test_building_id_in_meeting_detail(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """get_general_meeting_detail includes building_id."""
        agm, _, _ = await _setup_meeting_with_lots(db_session, "BuildingIdCheck")
        detail_resp = await client.get(f"/api/admin/general-meetings/{agm.id}")
        assert detail_resp.status_code == 200
        detail = detail_resp.json()
        assert "building_id" in detail
        assert detail["building_id"] == str(agm.building_id)

    async def test_integrity_error_on_flush_skips_lot(
        self, db_session: AsyncSession
    ):
        """When a concurrent flush raises IntegrityError, that lot is skipped."""
        from app.schemas.admin import AdminVoteEntry, AdminVoteEntryRequest
        from app.services.admin_service import enter_votes_for_meeting

        agm, lots, motions = await _setup_meeting_with_lots(db_session, "IntegrityRace")

        request = AdminVoteEntryRequest(
            entries=[
                AdminVoteEntry(
                    lot_owner_id=lots[0].id,
                    votes=[{"motion_id": str(motions[0].id), "choice": "yes"}],
                    multi_choice_votes=[],
                )
            ]
        )

        # Patch db.flush to raise IntegrityError, simulating a concurrent submission
        original_flush = db_session.flush
        call_count = 0

        async def patched_flush(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            # Raise on the very first flush inside the try block (count resets per test call)
            if call_count == 1:
                raise IntegrityError("duplicate key", {}, Exception())
            return await original_flush(*args, **kwargs)

        # Replace flush AFTER setup is done (and reset count here)
        db_session.flush = patched_flush  # type: ignore[method-assign]
        try:
            result = await enter_votes_for_meeting(agm.id, request, db_session)
        finally:
            db_session.flush = original_flush  # type: ignore[method-assign]

        assert result["submitted_count"] == 0
        assert result["skipped_count"] == 1

    async def test_savepoint_preserves_prior_lots_when_middle_lot_has_integrity_error(
        self, db_session: AsyncSession
    ):
        """RR4-05: When lot B has an IntegrityError, lots A and C must still be committed.

        Using begin_nested() (savepoint) ensures only the failing lot is rolled back;
        the outer transaction retains all successfully flushed lots.
        Previously, db.rollback() wiped the entire session including already-submitted lots.
        """
        from app.schemas.admin import AdminVoteEntry, AdminVoteEntryRequest
        from app.services.admin_service import enter_votes_for_meeting
        from sqlalchemy import select as _select

        # Set up meeting with 3 lots
        agm, lots, motions = await _setup_meeting_with_lots(db_session, "SavepointTest", n_lots=3)
        lot_a, lot_b, lot_c = lots[0], lots[1], lots[2]

        request = AdminVoteEntryRequest(
            entries=[
                AdminVoteEntry(
                    lot_owner_id=lot_a.id,
                    votes=[{"motion_id": str(motions[0].id), "choice": "yes"}],
                    multi_choice_votes=[],
                ),
                AdminVoteEntry(
                    lot_owner_id=lot_b.id,
                    votes=[{"motion_id": str(motions[0].id), "choice": "yes"}],
                    multi_choice_votes=[],
                ),
                AdminVoteEntry(
                    lot_owner_id=lot_c.id,
                    votes=[{"motion_id": str(motions[0].id), "choice": "yes"}],
                    multi_choice_votes=[],
                ),
            ]
        )

        # Track flush count to only fail on lot B (second lot's flush)
        flush_count = 0
        original_flush = db_session.flush

        async def patched_flush(*args, **kwargs):
            nonlocal flush_count
            flush_count += 1
            if flush_count == 2:
                raise IntegrityError("duplicate key for lot B", {}, Exception())
            return await original_flush(*args, **kwargs)

        db_session.flush = patched_flush  # type: ignore[method-assign]
        try:
            result = await enter_votes_for_meeting(agm.id, request, db_session)
        finally:
            db_session.flush = original_flush  # type: ignore[method-assign]

        # Lots A and C must succeed; lot B must be skipped
        assert result["submitted_count"] == 2, "Lots A and C must be submitted"
        assert result["skipped_count"] == 1, "Only lot B must be skipped"

        # Verify lots A and C have BallotSubmission records in DB
        from app.models import BallotSubmission as BS
        subs_result = await db_session.execute(
            _select(BS.lot_owner_id).where(
                BS.general_meeting_id == agm.id,
                BS.is_absent == False,  # noqa: E712
            )
        )
        submitted_ids = {row[0] for row in subs_result.all()}
        assert lot_a.id in submitted_ids, "Lot A must be recorded"
        assert lot_b.id not in submitted_ids, "Lot B (failed) must NOT be recorded"
        assert lot_c.id in submitted_ids, "Lot C must be recorded"

    # --- Fix 4a: Admin vote entry on partially-submitted lots ---

    async def test_admin_enters_votes_for_newly_visible_motion_on_partially_submitted_lot(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Fix 4a: Admin can enter votes for a newly visible motion on a lot that already
        voted on M1.  No new BallotSubmission is created; only Vote(M2) is inserted."""
        agm, lots, motions = await _setup_meeting_with_lots(db_session, "Fix4aPartial")
        lot = lots[0]
        m1 = motions[0]

        # Add a second visible motion M2
        m2 = Motion(
            general_meeting_id=agm.id,
            title="Fix4a M2",
            display_order=2,
            is_visible=True,
        )
        db_session.add(m2)
        await db_session.flush()

        # Voter already submitted M1
        existing_sub = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lot.id,
            voter_email="voter@test.com",
            submitted_by_admin=False,
        )
        db_session.add(existing_sub)
        existing_vote = Vote(
            general_meeting_id=agm.id,
            motion_id=m1.id,
            voter_email="voter@test.com",
            lot_owner_id=lot.id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        )
        db_session.add(existing_vote)
        await db_session.commit()
        await db_session.refresh(m2)

        # Admin enters vote for M2 only
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lot.id),
                    "votes": [{"motion_id": str(m2.id), "choice": "no"}],
                    "multi_choice_votes": [],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["submitted_count"] == 1
        assert data["skipped_count"] == 0

        await db_session.flush()
        # Exactly one BallotSubmission — the original one from the voter
        subs_result = await db_session.execute(
            select(BallotSubmission).where(BallotSubmission.general_meeting_id == agm.id)
        )
        subs = list(subs_result.scalars().all())
        assert len(subs) == 1
        assert subs[0].voter_email == "voter@test.com"  # not overwritten by admin

        # Two Vote rows: M1 (voter) and M2 (admin)
        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lot.id,
            )
        )
        votes = list(votes_result.scalars().all())
        assert len(votes) == 2
        vote_by_motion = {v.motion_id: v for v in votes}
        assert vote_by_motion[m1.id].choice == VoteChoice.yes  # voter's choice unchanged
        assert vote_by_motion[m2.id].choice == VoteChoice.no   # admin's new vote

    async def test_admin_skips_lot_with_all_motions_voted_when_partially_submitted_lots_present(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Fix 4a: When one lot has all motions voted and another has none, only the
        fully-voted lot is skipped."""
        agm, lots, motions = await _setup_meeting_with_lots(db_session, "Fix4aMixed")
        lot_a, lot_b = lots[0], lots[1]
        m1 = motions[0]

        # lot_a already voted on the only visible motion
        sub_a = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lot_a.id,
            voter_email="voter_a@test.com",
        )
        db_session.add(sub_a)
        vote_a = Vote(
            general_meeting_id=agm.id,
            motion_id=m1.id,
            voter_email="voter_a@test.com",
            lot_owner_id=lot_a.id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        )
        db_session.add(vote_a)
        await db_session.commit()

        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lot_a.id),
                    "votes": [{"motion_id": str(m1.id), "choice": "no"}],
                    "multi_choice_votes": [],
                },
                {
                    "lot_owner_id": str(lot_b.id),
                    "votes": [{"motion_id": str(m1.id), "choice": "yes"}],
                    "multi_choice_votes": [],
                },
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["submitted_count"] == 1
        assert data["skipped_count"] == 1

    async def test_admin_enters_votes_creates_no_new_ballot_submission_on_reentry(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Fix 4a: Re-entry adds Vote rows but does not create a second BallotSubmission."""
        agm, lots, motions = await _setup_meeting_with_lots(db_session, "Fix4aNoNewSub")
        lot = lots[0]
        m1 = motions[0]

        # Add a second visible motion
        m2 = Motion(
            general_meeting_id=agm.id,
            title="Fix4a NoNewSub M2",
            display_order=2,
            is_visible=True,
        )
        db_session.add(m2)
        await db_session.flush()

        # Voter submitted M1
        existing_sub = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lot.id,
            voter_email="voter@test.com",
        )
        db_session.add(existing_sub)
        existing_vote = Vote(
            general_meeting_id=agm.id,
            motion_id=m1.id,
            voter_email="voter@test.com",
            lot_owner_id=lot.id,
            choice=VoteChoice.no,
            status=VoteStatus.submitted,
        )
        db_session.add(existing_vote)
        await db_session.commit()
        await db_session.refresh(m2)

        # Admin submits M2
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lot.id),
                    "votes": [{"motion_id": str(m2.id), "choice": "yes"}],
                    "multi_choice_votes": [],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200
        assert resp.json()["submitted_count"] == 1

        await db_session.flush()
        # Still only one BallotSubmission (the original voter's)
        subs_result = await db_session.execute(
            select(BallotSubmission).where(
                BallotSubmission.general_meeting_id == agm.id,
                BallotSubmission.lot_owner_id == lot.id,
            )
        )
        subs = list(subs_result.scalars().all())
        assert len(subs) == 1
        assert subs[0].submitted_by_admin is False  # voter's, not admin's

    # --- Bug fix: no auto-abstain for already-submitted lots ---

    async def test_new_motion_not_auto_abstained_for_already_submitted_lot(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Bug fix: when admin enters votes for a mix of lots and a lot already has a
        BallotSubmission, a newly visible motion with no explicit choice must NOT be
        auto-recorded as abstained for that lot.

        Setup:
          - M1 is already voted on by lot_a (via an existing submission).
          - M2 is a new visible motion added after lot_a submitted.
          - Admin enters votes for M2 for lot_b only (no entry for lot_a on M2).
          - lot_a should NOT get a Vote(M2, abstained) auto-recorded.
          - lot_b should get Vote(M2, yes) recorded.
        """
        agm, lots, motions = await _setup_meeting_with_lots(db_session, "NoAutoAbstain")
        lot_a, lot_b = lots[0], lots[1]
        m1 = motions[0]

        # Add a second visible motion M2
        m2 = Motion(
            general_meeting_id=agm.id,
            title="NoAutoAbstain M2",
            display_order=2,
            is_visible=True,
        )
        db_session.add(m2)
        await db_session.flush()

        # lot_a already has a submission + vote for M1
        existing_sub = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lot_a.id,
            voter_email="voter_a@test.com",
            submitted_by_admin=False,
        )
        db_session.add(existing_sub)
        existing_vote = Vote(
            general_meeting_id=agm.id,
            motion_id=m1.id,
            voter_email="voter_a@test.com",
            lot_owner_id=lot_a.id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        )
        db_session.add(existing_vote)
        await db_session.commit()
        await db_session.refresh(m2)

        # Admin enters votes for BOTH lots, but only provides M2 for lot_b.
        # lot_a is included with only M1 (already voted) — no M2 entry.
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lot_a.id),
                    "votes": [{"motion_id": str(m1.id), "choice": "yes"}],  # M1 only (already voted)
                    "multi_choice_votes": [],
                },
                {
                    "lot_owner_id": str(lot_b.id),
                    "votes": [{"motion_id": str(m2.id), "choice": "yes"}],
                    "multi_choice_votes": [],
                },
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        # lot_a: M1 already voted → skipped entirely; lot_b: M2 is new → submitted
        assert data["submitted_count"] == 1
        assert data["skipped_count"] == 1

        await db_session.flush()
        # lot_a must still have exactly ONE vote (M1 from voter, choice=yes).
        # M2 must NOT have been auto-recorded for lot_a.
        lot_a_votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lot_a.id,
            )
        )
        lot_a_votes = list(lot_a_votes_result.scalars().all())
        assert len(lot_a_votes) == 1
        assert lot_a_votes[0].motion_id == m1.id
        assert lot_a_votes[0].choice == VoteChoice.yes

        # lot_b has no prior submission. Admin only supplied M2 for lot_b (not M1),
        # so only M2 is recorded — M1 is not auto-abstained (auto-abstain has been removed).
        lot_b_votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lot_b.id,
            )
        )
        lot_b_votes = list(lot_b_votes_result.scalars().all())
        assert len(lot_b_votes) == 1
        assert lot_b_votes[0].motion_id == m2.id
        assert lot_b_votes[0].choice == VoteChoice.yes  # admin's explicit vote

    async def test_explicit_choice_still_recorded_for_already_submitted_lot(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Bug fix guard only skips motions with NO explicit choice.  When admin explicitly
        supplies a choice for a new motion on an already-submitted lot, it is recorded."""
        agm, lots, motions = await _setup_meeting_with_lots(db_session, "ExplicitOnSubmitted")
        lot = lots[0]
        m1 = motions[0]

        # Add a second visible motion M2
        m2 = Motion(
            general_meeting_id=agm.id,
            title="ExplicitOnSubmitted M2",
            display_order=2,
            is_visible=True,
        )
        db_session.add(m2)
        await db_session.flush()

        # lot already voted on M1
        existing_sub = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lot.id,
            voter_email="voter@test.com",
            submitted_by_admin=False,
        )
        db_session.add(existing_sub)
        existing_vote = Vote(
            general_meeting_id=agm.id,
            motion_id=m1.id,
            voter_email="voter@test.com",
            lot_owner_id=lot.id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        )
        db_session.add(existing_vote)
        await db_session.commit()
        await db_session.refresh(m2)

        # Admin explicitly supplies a choice for M2 on the already-submitted lot
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lot.id),
                    "votes": [{"motion_id": str(m2.id), "choice": "no"}],
                    "multi_choice_votes": [],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200
        assert resp.json()["submitted_count"] == 1

        await db_session.flush()
        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lot.id,
            )
        )
        votes = list(votes_result.scalars().all())
        # M1 (original) + M2 (admin explicit) = 2 votes
        assert len(votes) == 2
        vote_by_motion = {v.motion_id: v for v in votes}
        assert vote_by_motion[m1.id].choice == VoteChoice.yes
        assert vote_by_motion[m2.id].choice == VoteChoice.no

    async def test_mc_motion_not_auto_abstained_for_already_submitted_lot(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Bug fix (multi-choice path): when a lot already has a BallotSubmission and no
        options are supplied for a new MC motion, no motion-level abstain is auto-recorded."""
        b = make_building("VE MC NoAutoAbs")
        db_session.add(b)
        await db_session.flush()

        lo_submitted = make_lot_owner(b, "VE-MCNA1")
        lo_new = make_lot_owner(b, "VE-MCNA2")
        db_session.add(lo_submitted)
        db_session.add(lo_new)
        await db_session.flush()

        agm = make_open_meeting(b, "VE MC NoAutoAbs AGM")
        db_session.add(agm)
        await db_session.flush()

        for lo in (lo_submitted, lo_new):
            db_session.add(GeneralMeetingLotWeight(
                general_meeting_id=agm.id,
                lot_owner_id=lo.id,
                unit_entitlement_snapshot=lo.unit_entitlement,
                financial_position_snapshot=FinancialPositionSnapshot.normal,
            ))

        # A standard motion M1 (already voted on by lo_submitted)
        m1 = Motion(
            general_meeting_id=agm.id,
            title="MC NoAutoAbs M1",
            display_order=1,
            is_visible=True,
        )
        db_session.add(m1)
        # A multi-choice motion M2 (newly visible)
        m2 = Motion(
            general_meeting_id=agm.id,
            title="MC NoAutoAbs M2",
            display_order=2,
            is_visible=True,
            is_multi_choice=True,
            option_limit=2,
        )
        db_session.add(m2)
        await db_session.flush()

        opt = MotionOption(motion_id=m2.id, text="Opt1", display_order=1)
        db_session.add(opt)

        # lo_submitted already has BallotSubmission + Vote for M1
        existing_sub = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lo_submitted.id,
            voter_email="voter@test.com",
            submitted_by_admin=False,
        )
        db_session.add(existing_sub)
        existing_vote = Vote(
            general_meeting_id=agm.id,
            motion_id=m1.id,
            voter_email="voter@test.com",
            lot_owner_id=lo_submitted.id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        )
        db_session.add(existing_vote)
        await db_session.commit()
        await db_session.refresh(agm)
        await db_session.refresh(opt)
        await db_session.refresh(m2)

        # Admin enters MC votes for lo_new on M2; lo_submitted is NOT included.
        # No explicit MC vote is supplied for lo_submitted's M2 — it should NOT be
        # auto-abstained.
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lo_new.id),
                    "votes": [],
                    "multi_choice_votes": [
                        {"motion_id": str(m2.id), "option_ids": [str(opt.id)]}
                    ],
                },
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200

        await db_session.flush()
        # lo_submitted must still have only 1 vote (M1)
        sub_votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lo_submitted.id,
            )
        )
        sub_votes = list(sub_votes_result.scalars().all())
        assert len(sub_votes) == 1
        assert sub_votes[0].motion_id == m1.id

    async def test_mc_no_options_new_lot_records_no_vote(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """When a new lot sends an MC motion entry with no options, no vote is recorded.
        Auto-abstain has been removed — missing motions are skipped for future entry."""
        b = make_building("VE MC NoVoteNew")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b, "VE-MVN1")
        db_session.add(lo)
        await db_session.flush()

        agm = make_open_meeting(b, "VE MC NoVoteNew AGM")
        db_session.add(agm)
        await db_session.flush()

        db_session.add(GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=lo.unit_entitlement,
            financial_position_snapshot=FinancialPositionSnapshot.normal,
        ))

        m = Motion(
            general_meeting_id=agm.id,
            title="MC NoVoteNew M1",
            display_order=1,
            is_visible=True,
            is_multi_choice=True,
            option_limit=2,
        )
        db_session.add(m)
        await db_session.flush()
        opt = MotionOption(motion_id=m.id, text="Opt1", display_order=1)
        db_session.add(opt)
        await db_session.commit()
        await db_session.refresh(agm)

        # No prior submission — empty option_ids yields no vote (no auto-abstain)
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lo.id),
                    "votes": [],
                    "multi_choice_votes": [
                        {"motion_id": str(m.id), "option_ids": []}
                    ],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["submitted_count"] == 0
        assert data["skipped_count"] == 1

        await db_session.flush()
        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lo.id,
            )
        )
        assert len(list(votes_result.scalars().all())) == 0

    async def test_standard_motion_no_vote_new_lot_records_no_vote(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """When a new lot sends no vote for a visible motion, no vote is recorded.
        Auto-abstain has been removed — missing motions are skipped for future entry."""
        agm, lots, motions = await _setup_meeting_with_lots(db_session, "StdNoVoteNewLot")
        lot = lots[0]

        # No prior submission — empty votes yields no vote recorded (no auto-abstain)
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lot.id),
                    "votes": [],
                    "multi_choice_votes": [],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["submitted_count"] == 0
        assert data["skipped_count"] == 1

        await db_session.flush()
        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lot.id,
            )
        )
        assert len(list(votes_result.scalars().all())) == 0

    async def test_mc_motion_not_auto_abstained_for_already_submitted_lot(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """MC no-options skip for already-submitted lot (covers admin_service line 3984).

        When the already-submitted lot is explicitly included in the entries payload and
        provides an MC motion entry with empty option_ids, the service must skip (not
        auto-abstain) because the lot already has a BallotSubmission.

        This is distinct from the sibling test where lo_submitted is omitted from entries
        entirely — here mc_lookup[m2.id] == [] is reached and the already_submitted guard
        on the continue branch must fire.
        """
        b = make_building("VE MC SkipAbs")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b, "VE-MCSA1")
        db_session.add(lo)
        await db_session.flush()

        agm = make_open_meeting(b, "VE MC SkipAbs AGM")
        db_session.add(agm)
        await db_session.flush()

        db_session.add(GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=lo.unit_entitlement,
            financial_position_snapshot=FinancialPositionSnapshot.normal,
        ))

        # A standard motion M1 (already voted on by lo)
        m1 = Motion(
            general_meeting_id=agm.id,
            title="MC SkipAbs M1",
            display_order=1,
            is_visible=True,
        )
        db_session.add(m1)
        # A multi-choice motion M2 (newly visible — lot has no vote for it yet)
        m2 = Motion(
            general_meeting_id=agm.id,
            title="MC SkipAbs M2",
            display_order=2,
            is_visible=True,
            is_multi_choice=True,
            option_limit=2,
        )
        db_session.add(m2)
        await db_session.flush()

        opt = MotionOption(motion_id=m2.id, text="Opt1", display_order=1)
        db_session.add(opt)

        # lo already has BallotSubmission + Vote for M1
        existing_sub = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            voter_email="voter@test.com",
            submitted_by_admin=False,
        )
        db_session.add(existing_sub)
        existing_vote = Vote(
            general_meeting_id=agm.id,
            motion_id=m1.id,
            voter_email="voter@test.com",
            lot_owner_id=lo.id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        )
        db_session.add(existing_vote)
        await db_session.commit()
        await db_session.refresh(agm)
        await db_session.refresh(m2)

        # Admin includes lo in entries with an MC entry for M2 but empty option_ids.
        # Because lo already has a BallotSubmission, the service must skip M2 rather than
        # recording a motion-level abstain (the continue on line 3984).
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lo.id),
                    "votes": [],
                    "multi_choice_votes": [
                        {"motion_id": str(m2.id), "option_ids": []}
                    ],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200

        await db_session.flush()
        # lo must still have exactly 1 vote — the original M1 vote.
        # No Vote for M2 must have been created (not auto-abstained).
        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lo.id,
            )
        )
        votes = list(votes_result.scalars().all())
        assert len(votes) == 1
        assert votes[0].motion_id == m1.id
        assert votes[0].choice == VoteChoice.yes

    # --- Bug fix: partial submission — only explicitly answered motions recorded ---

    async def test_partial_submission_only_explicit_motions_recorded(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Admin submits votes for some motions but not all → only submitted motions
        recorded; untouched motions are NOT auto-abstained."""
        agm, lots, motions = await _setup_meeting_with_lots(db_session, "PartialSubmit")
        lot = lots[0]
        m1 = motions[0]

        # Add a second visible motion M2
        m2 = Motion(
            general_meeting_id=agm.id,
            title="PartialSubmit M2",
            display_order=2,
            is_visible=True,
        )
        db_session.add(m2)
        await db_session.commit()
        await db_session.refresh(m2)

        # Admin supplies a choice for M1 only — M2 is omitted
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lot.id),
                    "votes": [{"motion_id": str(m1.id), "choice": "yes"}],
                    "multi_choice_votes": [],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["submitted_count"] == 1
        assert data["skipped_count"] == 0

        await db_session.flush()
        # Only 1 vote recorded (M1); M2 must NOT have been auto-abstained
        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lot.id,
            )
        )
        all_votes = list(votes_result.scalars().all())
        assert len(all_votes) == 1
        assert all_votes[0].motion_id == m1.id
        assert all_votes[0].choice == VoteChoice.yes

    async def test_all_motions_explicit_records_all(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Admin submits explicit choices for all motions → all recorded correctly."""
        agm, lots, motions = await _setup_meeting_with_lots(db_session, "AllExplicit")
        lot = lots[0]
        m1 = motions[0]

        m2 = Motion(
            general_meeting_id=agm.id,
            title="AllExplicit M2",
            display_order=2,
            is_visible=True,
        )
        db_session.add(m2)
        await db_session.commit()
        await db_session.refresh(m2)

        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lot.id),
                    "votes": [
                        {"motion_id": str(m1.id), "choice": "yes"},
                        {"motion_id": str(m2.id), "choice": "no"},
                    ],
                    "multi_choice_votes": [],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["submitted_count"] == 1
        assert data["skipped_count"] == 0

        await db_session.flush()
        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lot.id,
            )
        )
        all_votes = list(votes_result.scalars().all())
        assert len(all_votes) == 2
        by_motion = {v.motion_id: v for v in all_votes}
        assert by_motion[m1.id].choice == VoteChoice.yes
        assert by_motion[m2.id].choice == VoteChoice.no

    async def test_mc_partial_submission_only_explicit_options_recorded(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Multi-choice: admin provides option_choices for one MC motion but omits another
        MC motion → only the supplied MC motion is recorded."""
        b = make_building("VE MC PartialMC")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, "VE-MPM1")
        db_session.add(lo)
        await db_session.flush()
        agm = make_open_meeting(b, "VE MC PartialMC AGM")
        db_session.add(agm)
        await db_session.flush()
        db_session.add(GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=lo.unit_entitlement,
            financial_position_snapshot=FinancialPositionSnapshot.normal,
        ))
        m1 = Motion(
            general_meeting_id=agm.id,
            title="MC PartialMC M1",
            display_order=1,
            is_visible=True,
            is_multi_choice=True,
            option_limit=2,
        )
        m2 = Motion(
            general_meeting_id=agm.id,
            title="MC PartialMC M2",
            display_order=2,
            is_visible=True,
            is_multi_choice=True,
            option_limit=1,
        )
        db_session.add(m1)
        db_session.add(m2)
        await db_session.flush()
        opt1 = MotionOption(motion_id=m1.id, text="Opt1", display_order=1)
        opt2 = MotionOption(motion_id=m2.id, text="Opt2", display_order=1)
        db_session.add(opt1)
        db_session.add(opt2)
        await db_session.commit()
        await db_session.refresh(agm)
        await db_session.refresh(lo)
        await db_session.refresh(opt1)
        await db_session.refresh(opt2)

        # Admin provides option_choices for M1 but omits M2 entirely
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lo.id),
                    "votes": [],
                    "multi_choice_votes": [
                        {
                            "motion_id": str(m1.id),
                            "option_choices": [
                                {"option_id": str(opt1.id), "choice": "for"},
                            ],
                        }
                    ],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["submitted_count"] == 1
        assert data["skipped_count"] == 0

        await db_session.flush()
        # Only 1 vote for M1 (opt1); M2 must NOT have any vote
        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lo.id,
            )
        )
        all_votes = list(votes_result.scalars().all())
        assert len(all_votes) == 1
        assert all_votes[0].motion_id == m1.id
        assert all_votes[0].motion_option_id == opt1.id
        assert all_votes[0].choice == VoteChoice.selected

    async def test_mc_all_motions_explicit_records_all(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Multi-choice: admin provides option_choices for all MC motions → all recorded."""
        b = make_building("VE MC AllMC")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, "VE-MAM1")
        db_session.add(lo)
        await db_session.flush()
        agm = make_open_meeting(b, "VE MC AllMC AGM")
        db_session.add(agm)
        await db_session.flush()
        db_session.add(GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=lo.unit_entitlement,
            financial_position_snapshot=FinancialPositionSnapshot.normal,
        ))
        m1 = Motion(
            general_meeting_id=agm.id,
            title="MC AllMC M1",
            display_order=1,
            is_visible=True,
            is_multi_choice=True,
            option_limit=1,
        )
        m2 = Motion(
            general_meeting_id=agm.id,
            title="MC AllMC M2",
            display_order=2,
            is_visible=True,
            is_multi_choice=True,
            option_limit=1,
        )
        db_session.add(m1)
        db_session.add(m2)
        await db_session.flush()
        opt1 = MotionOption(motion_id=m1.id, text="OptA", display_order=1)
        opt2 = MotionOption(motion_id=m2.id, text="OptB", display_order=1)
        db_session.add(opt1)
        db_session.add(opt2)
        await db_session.commit()
        await db_session.refresh(agm)
        await db_session.refresh(lo)
        await db_session.refresh(opt1)
        await db_session.refresh(opt2)

        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lo.id),
                    "votes": [],
                    "multi_choice_votes": [
                        {
                            "motion_id": str(m1.id),
                            "option_choices": [{"option_id": str(opt1.id), "choice": "for"}],
                        },
                        {
                            "motion_id": str(m2.id),
                            "option_choices": [{"option_id": str(opt2.id), "choice": "against"}],
                        },
                    ],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["submitted_count"] == 1

        await db_session.flush()
        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lo.id,
            )
        )
        all_votes = list(votes_result.scalars().all())
        assert len(all_votes) == 2
        by_motion = {v.motion_id: v for v in all_votes}
        assert by_motion[m1.id].choice == VoteChoice.selected
        assert by_motion[m2.id].choice == VoteChoice.against


# ---------------------------------------------------------------------------
# Slice 9 — US-AVE2-01: For/Against/Abstain per multi-choice option
# ---------------------------------------------------------------------------


async def _setup_mc_meeting(
    db_session: AsyncSession,
    name: str,
    option_limit: int = 2,
    n_options: int = 3,
    financial_position: str = "normal",
) -> tuple:
    """Helper: creates a building, lot, open meeting, MC motion + options."""
    b = make_building(f"S9 {name}")
    db_session.add(b)
    await db_session.flush()
    lo = make_lot_owner(b, f"S9-{name[:6]}", financial_position=financial_position)
    db_session.add(lo)
    await db_session.flush()
    agm = make_open_meeting(b, f"S9 {name} AGM")
    db_session.add(agm)
    await db_session.flush()
    fp_snap = (
        FinancialPositionSnapshot.in_arrear
        if financial_position == "in_arrear"
        else FinancialPositionSnapshot.normal
    )
    w = GeneralMeetingLotWeight(
        general_meeting_id=agm.id,
        lot_owner_id=lo.id,
        unit_entitlement_snapshot=lo.unit_entitlement,
        financial_position_snapshot=fp_snap,
    )
    db_session.add(w)
    m = Motion(
        general_meeting_id=agm.id,
        title=f"S9 MC {name}",
        display_order=1,
        is_visible=True,
        is_multi_choice=True,
        option_limit=option_limit,
    )
    db_session.add(m)
    await db_session.flush()
    opts = [
        MotionOption(motion_id=m.id, text=f"Opt{i+1}", display_order=i + 1)
        for i in range(n_options)
    ]
    for opt in opts:
        db_session.add(opt)
    await db_session.commit()
    await db_session.refresh(agm)
    await db_session.refresh(lo)
    for opt in opts:
        await db_session.refresh(opt)
    return agm, lo, m, opts


class TestAdminMultiChoiceOptionChoiceSchema:
    """Unit tests for the AdminMultiChoiceOptionChoice Pydantic schema validator."""

    def test_valid_choices_accepted(self):
        from app.schemas.admin import AdminMultiChoiceOptionChoice
        import uuid as _uuid

        for choice in ("for", "against", "abstained"):
            obj = AdminMultiChoiceOptionChoice(option_id=_uuid.uuid4(), choice=choice)
            assert obj.choice == choice

    def test_invalid_choice_raises(self):
        from app.schemas.admin import AdminMultiChoiceOptionChoice
        from pydantic import ValidationError
        import uuid as _uuid

        with pytest.raises(ValidationError):
            AdminMultiChoiceOptionChoice(option_id=_uuid.uuid4(), choice="bad_value")


@pytest.mark.asyncio(loop_scope="session")
class TestAdminVoteEntrySlice9:
    """Tests for US-AVE2-01: For/Against/Abstain per multi-choice option."""

    async def test_for_choices_create_selected_votes(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """For on 2 options (at limit) → 2 VoteChoice.selected rows."""
        agm, lo, m, opts = await _setup_mc_meeting(db_session, "ForHappy", option_limit=2)
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lo.id),
                    "votes": [],
                    "multi_choice_votes": [
                        {
                            "motion_id": str(m.id),
                            "option_choices": [
                                {"option_id": str(opts[0].id), "choice": "for"},
                                {"option_id": str(opts[1].id), "choice": "for"},
                            ],
                        }
                    ],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200
        assert resp.json()["submitted_count"] == 1

        await db_session.flush()
        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lo.id,
                Vote.choice == VoteChoice.selected,
            )
        )
        assert len(list(votes_result.scalars().all())) == 2

    async def test_against_choice_creates_against_vote(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Against on 1 option → 1 VoteChoice.against row."""
        agm, lo, m, opts = await _setup_mc_meeting(db_session, "AgainstHappy")
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lo.id),
                    "votes": [],
                    "multi_choice_votes": [
                        {
                            "motion_id": str(m.id),
                            "option_choices": [
                                {"option_id": str(opts[0].id), "choice": "against"},
                            ],
                        }
                    ],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200

        await db_session.flush()
        vote_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lo.id,
                Vote.choice == VoteChoice.against,
            )
        )
        assert len(list(vote_result.scalars().all())) == 1

    async def test_abstained_choice_creates_abstained_vote_with_option_id(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Abstained on 1 option → 1 VoteChoice.abstained row with motion_option_id set."""
        agm, lo, m, opts = await _setup_mc_meeting(db_session, "AbstainOpt")
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lo.id),
                    "votes": [],
                    "multi_choice_votes": [
                        {
                            "motion_id": str(m.id),
                            "option_choices": [
                                {"option_id": str(opts[0].id), "choice": "abstained"},
                            ],
                        }
                    ],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200

        await db_session.flush()
        vote_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lo.id,
                Vote.choice == VoteChoice.abstained,
                Vote.motion_option_id == opts[0].id,
            )
        )
        assert vote_result.scalar_one_or_none() is not None

    async def test_blank_options_not_auto_abstained(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Options with no entry in option_choices create no Vote rows for those options."""
        agm, lo, m, opts = await _setup_mc_meeting(db_session, "BlankOpts", n_options=3)
        # Only vote on opts[0]; opts[1] and opts[2] get no entry
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lo.id),
                    "votes": [],
                    "multi_choice_votes": [
                        {
                            "motion_id": str(m.id),
                            "option_choices": [
                                {"option_id": str(opts[0].id), "choice": "for"},
                            ],
                        }
                    ],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200

        await db_session.flush()
        # Only 1 vote row (for opts[0]); opts[1] and opts[2] have no row
        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lo.id,
            )
        )
        all_votes = list(votes_result.scalars().all())
        # 1 "for" vote with motion_option_id = opts[0].id; no rows for opts[1/2]
        assert len(all_votes) == 1
        assert all_votes[0].choice == VoteChoice.selected
        assert all_votes[0].motion_option_id == opts[0].id

    async def test_for_choices_unlimited_with_option_limit(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Voters can select For on more options than option_limit (limit is for tally only)."""
        agm, lo, m, opts = await _setup_mc_meeting(db_session, "LimitFor", option_limit=2, n_options=3)
        # All 3 For with option_limit=2 — should succeed
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lo.id),
                    "votes": [],
                    "multi_choice_votes": [
                        {
                            "motion_id": str(m.id),
                            "option_choices": [
                                {"option_id": str(opts[0].id), "choice": "for"},
                                {"option_id": str(opts[1].id), "choice": "for"},
                                {"option_id": str(opts[2].id), "choice": "for"},
                            ],
                        }
                    ],
                }
            ]
        }
        resp = await client.post(
            f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload
        )
        assert resp.status_code == 200
        assert resp.json()["submitted_count"] == 1

    async def test_legacy_option_ids_still_works(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Legacy option_ids format (all treated as For) still produces VoteChoice.selected rows."""
        agm, lo, m, opts = await _setup_mc_meeting(db_session, "LegacyIds", option_limit=2)
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lo.id),
                    "votes": [],
                    "multi_choice_votes": [
                        {
                            "motion_id": str(m.id),
                            "option_ids": [str(opts[0].id), str(opts[1].id)],
                        }
                    ],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200
        assert resp.json()["submitted_count"] == 1

        await db_session.flush()
        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lo.id,
                Vote.choice == VoteChoice.selected,
            )
        )
        assert len(list(votes_result.scalars().all())) == 2

    async def test_empty_option_choices_records_no_vote(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Empty option_choices (no options entered) → no vote recorded (no auto-abstain).
        The frontend only sends MC motions the admin explicitly interacted with."""
        agm, lo, m, opts = await _setup_mc_meeting(db_session, "EmptyChoices")
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lo.id),
                    "votes": [],
                    "multi_choice_votes": [
                        {
                            "motion_id": str(m.id),
                            "option_choices": [],
                        }
                    ],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["submitted_count"] == 0
        assert data["skipped_count"] == 1

        await db_session.flush()
        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.lot_owner_id == lo.id,
            )
        )
        assert len(list(votes_result.scalars().all())) == 0

    async def test_invalid_choice_string_returns_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Unknown choice string in option_choices → 422."""
        agm, lo, m, opts = await _setup_mc_meeting(db_session, "BadChoiceStr")
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lo.id),
                    "votes": [],
                    "multi_choice_votes": [
                        {
                            "motion_id": str(m.id),
                            "option_choices": [
                                {"option_id": str(opts[0].id), "choice": "invalid"},
                            ],
                        }
                    ],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 422

    async def test_invalid_option_id_in_option_choices_returns_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Unknown option_id in option_choices → 422."""
        agm, lo, m, opts = await _setup_mc_meeting(db_session, "BadOptId")
        fake_opt = str(uuid.uuid4())
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lo.id),
                    "votes": [],
                    "multi_choice_votes": [
                        {
                            "motion_id": str(m.id),
                            "option_choices": [
                                {"option_id": fake_opt, "choice": "for"},
                            ],
                        }
                    ],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 422

    async def test_mixed_for_against_abstained_creates_correct_rows(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """For, Against, Abstained choices all recorded correctly in a single entry."""
        agm, lo, m, opts = await _setup_mc_meeting(
            db_session, "MixedChoices", option_limit=2, n_options=3
        )
        payload = {
            "entries": [
                {
                    "lot_owner_id": str(lo.id),
                    "votes": [],
                    "multi_choice_votes": [
                        {
                            "motion_id": str(m.id),
                            "option_choices": [
                                {"option_id": str(opts[0].id), "choice": "for"},
                                {"option_id": str(opts[1].id), "choice": "against"},
                                {"option_id": str(opts[2].id), "choice": "abstained"},
                            ],
                        }
                    ],
                }
            ]
        }
        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/enter-votes", json=payload)
        assert resp.status_code == 200

        await db_session.flush()
        for opt, expected_choice in zip(opts, [VoteChoice.selected, VoteChoice.against, VoteChoice.abstained]):
            vote_result = await db_session.execute(
                select(Vote).where(
                    Vote.general_meeting_id == agm.id,
                    Vote.lot_owner_id == lo.id,
                    Vote.motion_option_id == opt.id,
                )
            )
            vote = vote_result.scalar_one()
            assert vote.choice == expected_choice
