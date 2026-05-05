"""
Tests for the _resolve_voter_state helper in app/routers/auth.py.

Verifies that the shared lot-lookup helper used by both verify_auth and
restore_session returns the correct shape and computes already_submitted /
voted_motion_ids correctly.

Structure:
  # --- Happy path ---
  # --- Input validation ---
  # --- Boundary values ---
  # --- State / precondition errors ---
  # --- Edge cases ---
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Building,
    GeneralMeeting,
    GeneralMeetingStatus,
    LotOwner,
    LotProxy,
    Motion,
    Vote,
    VoteChoice,
    VoteStatus,
)
from app.models.lot import Lot
from app.models.lot_person import lot_persons
from app.models.person import Person
from app.routers.auth import _resolve_voter_state


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def meeting_dt() -> datetime:
    return datetime.now(UTC) - timedelta(hours=1)


def closing_dt() -> datetime:
    return datetime.now(UTC) + timedelta(days=2)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def basic_setup(db_session: AsyncSession):
    """One building, one lot owner, one meeting with two visible motions."""
    b = Building(name=f"Helper Bldg {uuid.uuid4().hex[:6]}", manager_email="h@test.com")
    db_session.add(b)
    await db_session.flush()

    lo = Lot(building_id=b.id, lot_number="H-1", unit_entitlement=100)
    db_session.add(lo)
    await db_session.flush()

    p = Person(email="helper_voter@test.com")
    db_session.add(p)
    await db_session.flush()
    await db_session.execute(lot_persons.insert().values(lot_id=lo.id, person_id=p.id))

    agm = GeneralMeeting(
        building_id=b.id,
        title="Helper Meeting",
        status=GeneralMeetingStatus.open,
        meeting_at=meeting_dt(),
        voting_closes_at=closing_dt(),
    )
    db_session.add(agm)
    await db_session.flush()

    m1 = Motion(general_meeting_id=agm.id, title="Motion 1", display_order=1)
    m2 = Motion(general_meeting_id=agm.id, title="Motion 2", display_order=2)
    db_session.add_all([m1, m2])
    await db_session.flush()

    return {
        "building": b,
        "lot_owner": lo,
        "voter_email": "helper_voter@test.com",
        "agm": agm,
        "motions": [m1, m2],
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestResolveVoterState:
    # --- Happy path ---

    async def test_returns_correct_keys(self, db_session: AsyncSession, basic_setup: dict):
        """Helper returns dict with lots, visible_motions, unvoted_visible_count."""
        agm = basic_setup["agm"]
        building = basic_setup["building"]
        result = await _resolve_voter_state(
            db=db_session,
            voter_email=basic_setup["voter_email"],
            general_meeting_id=agm.id,
            building_id=building.id,
        )
        assert "lots" in result
        assert "visible_motions" in result
        assert "unvoted_visible_count" in result

    async def test_direct_owner_returned_as_not_proxy(
        self, db_session: AsyncSession, basic_setup: dict
    ):
        """Direct owner's lot appears with is_proxy=False."""
        agm = basic_setup["agm"]
        building = basic_setup["building"]
        result = await _resolve_voter_state(
            db=db_session,
            voter_email=basic_setup["voter_email"],
            general_meeting_id=agm.id,
            building_id=building.id,
        )
        assert len(result["lots"]) == 1
        assert result["lots"][0].is_proxy is False

    async def test_lots_sorted_by_lot_number(self, db_session: AsyncSession, basic_setup: dict):
        """Lots are sorted by lot_number in ascending order."""
        building = basic_setup["building"]
        agm = basic_setup["agm"]

        lo2 = Lot(building_id=building.id, lot_number="A-1", unit_entitlement=50)
        db_session.add(lo2)
        await db_session.flush()
        # Reuse existing person (same email) — just add lot_persons link
        from sqlalchemy import select as _select
        p2 = (await db_session.execute(
            _select(Person).where(Person.email == basic_setup["voter_email"])
        )).scalar_one()
        await db_session.execute(lot_persons.insert().values(lot_id=lo2.id, person_id=p2.id))
        await db_session.flush()

        result = await _resolve_voter_state(
            db=db_session,
            voter_email=basic_setup["voter_email"],
            general_meeting_id=agm.id,
            building_id=building.id,
        )
        lot_numbers = [l.lot_number for l in result["lots"]]
        assert lot_numbers == sorted(lot_numbers)

    async def test_unvoted_visible_count_equals_visible_motions_when_not_submitted(
        self, db_session: AsyncSession, basic_setup: dict
    ):
        """When no votes submitted, unvoted_visible_count == len(visible_motions)."""
        agm = basic_setup["agm"]
        building = basic_setup["building"]
        result = await _resolve_voter_state(
            db=db_session,
            voter_email=basic_setup["voter_email"],
            general_meeting_id=agm.id,
            building_id=building.id,
        )
        assert result["unvoted_visible_count"] == len(result["visible_motions"])

    async def test_already_submitted_false_when_no_votes(
        self, db_session: AsyncSession, basic_setup: dict
    ):
        """already_submitted is False for a lot with no submitted votes."""
        agm = basic_setup["agm"]
        building = basic_setup["building"]
        result = await _resolve_voter_state(
            db=db_session,
            voter_email=basic_setup["voter_email"],
            general_meeting_id=agm.id,
            building_id=building.id,
        )
        assert result["lots"][0].already_submitted is False

    async def test_already_submitted_true_when_all_motions_voted(
        self, db_session: AsyncSession, basic_setup: dict
    ):
        """already_submitted is True when all visible motions have a submitted vote."""
        agm = basic_setup["agm"]
        building = basic_setup["building"]
        lo = basic_setup["lot_owner"]
        motions = basic_setup["motions"]

        # Submit votes for all motions
        for motion in motions:
            v = Vote(
                general_meeting_id=agm.id,
                lot_owner_id=lo.id,
                motion_id=motion.id,
                choice=VoteChoice.yes,
                status=VoteStatus.submitted,
                voter_email=basic_setup["voter_email"],
            )
            db_session.add(v)
        await db_session.flush()

        result = await _resolve_voter_state(
            db=db_session,
            voter_email=basic_setup["voter_email"],
            general_meeting_id=agm.id,
            building_id=building.id,
        )
        assert result["lots"][0].already_submitted is True
        assert result["unvoted_visible_count"] == 0

    async def test_voted_motion_ids_populated_for_submitted_votes(
        self, db_session: AsyncSession, basic_setup: dict
    ):
        """voted_motion_ids contains IDs of all submitted votes for the lot."""
        agm = basic_setup["agm"]
        building = basic_setup["building"]
        lo = basic_setup["lot_owner"]
        motions = basic_setup["motions"]

        v = Vote(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            motion_id=motions[0].id,
            choice=VoteChoice.no,
            status=VoteStatus.submitted,
            voter_email=basic_setup["voter_email"],
        )
        db_session.add(v)
        await db_session.flush()

        result = await _resolve_voter_state(
            db=db_session,
            voter_email=basic_setup["voter_email"],
            general_meeting_id=agm.id,
            building_id=building.id,
        )
        lot_info = result["lots"][0]
        assert str(motions[0].id) in [str(mid) for mid in lot_info.voted_motion_ids]
        assert str(motions[1].id) not in [str(mid) for mid in lot_info.voted_motion_ids]

    # --- Boundary values ---

    async def test_empty_lots_when_email_not_found(
        self, db_session: AsyncSession, basic_setup: dict
    ):
        """Returns empty lots list when email doesn't match any lot owner or proxy."""
        agm = basic_setup["agm"]
        building = basic_setup["building"]
        result = await _resolve_voter_state(
            db=db_session,
            voter_email="nobody@nowhere.com",
            general_meeting_id=agm.id,
            building_id=building.id,
        )
        assert result["lots"] == []

    async def test_unvoted_visible_count_zero_when_no_motions(
        self, db_session: AsyncSession
    ):
        """unvoted_visible_count is 0 when there are no visible motions."""
        b = Building(name=f"NoMotion Bldg {uuid.uuid4().hex[:4]}", manager_email="nm@test.com")
        db_session.add(b)
        await db_session.flush()

        lo = Lot(building_id=b.id, lot_number="NM-1", unit_entitlement=10)
        db_session.add(lo)
        await db_session.flush()

        p = Person(email="nomotion@test.com")
        db_session.add(p)
        await db_session.flush()
        await db_session.execute(lot_persons.insert().values(lot_id=lo.id, person_id=p.id))

        agm = GeneralMeeting(
            building_id=b.id,
            title="No Motion Meeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        result = await _resolve_voter_state(
            db=db_session,
            voter_email="nomotion@test.com",
            general_meeting_id=agm.id,
            building_id=b.id,
        )
        assert result["unvoted_visible_count"] == 0
        assert result["lots"][0].already_submitted is False

    # --- Edge cases ---

    async def test_proxy_voter_lot_returned_as_proxy(
        self, db_session: AsyncSession, basic_setup: dict
    ):
        """A lot where the voter is a proxy is returned with is_proxy=True."""
        building = basic_setup["building"]
        agm = basic_setup["agm"]
        proxy_email = "proxy_helper@test.com"

        # Create a different lot with a proxy
        lo2 = Lot(building_id=building.id, lot_number="H-Proxy", unit_entitlement=75)
        db_session.add(lo2)
        await db_session.flush()

        proxy_person = Person(email=proxy_email)
        db_session.add(proxy_person)
        await db_session.flush()
        lp = LotProxy(lot_id=lo2.id, person_id=proxy_person.id)
        db_session.add(lp)
        await db_session.flush()

        result = await _resolve_voter_state(
            db=db_session,
            voter_email=proxy_email,
            general_meeting_id=agm.id,
            building_id=building.id,
        )
        assert len(result["lots"]) == 1
        proxy_lot = result["lots"][0]
        assert proxy_lot.is_proxy is True
        assert proxy_lot.lot_number == "H-Proxy"

    async def test_direct_owner_beats_proxy_for_same_lot(
        self, db_session: AsyncSession, basic_setup: dict
    ):
        """When an email is both direct owner and proxy for the same lot, is_proxy=False."""
        building = basic_setup["building"]
        agm = basic_setup["agm"]
        lo = basic_setup["lot_owner"]
        voter_email = basic_setup["voter_email"]

        # Also add a proxy record for the same lot using the same email
        from sqlalchemy import select as _sel
        voter_person = (await db_session.execute(
            _sel(Person).where(Person.email == voter_email)
        )).scalar_one()
        lp = LotProxy(lot_id=lo.id, person_id=voter_person.id)
        db_session.add(lp)
        await db_session.flush()

        result = await _resolve_voter_state(
            db=db_session,
            voter_email=voter_email,
            general_meeting_id=agm.id,
            building_id=building.id,
        )
        # Should only appear once and as a direct owner (not proxy)
        matching = [l for l in result["lots"] if l.lot_number == lo.lot_number]
        assert len(matching) == 1
        assert matching[0].is_proxy is False

    async def test_hidden_motions_excluded_from_visible_motions(
        self, db_session: AsyncSession, basic_setup: dict
    ):
        """Motions with is_visible=False are not included in visible_motions."""
        agm = basic_setup["agm"]
        building = basic_setup["building"]

        # Add a hidden motion
        hidden = Motion(
            general_meeting_id=agm.id,
            title="Hidden Motion",
            display_order=99,
            is_visible=False,
        )
        db_session.add(hidden)
        await db_session.flush()

        result = await _resolve_voter_state(
            db=db_session,
            voter_email=basic_setup["voter_email"],
            general_meeting_id=agm.id,
            building_id=building.id,
        )
        motion_ids = [m.id for m in result["visible_motions"]]
        assert hidden.id not in motion_ids
