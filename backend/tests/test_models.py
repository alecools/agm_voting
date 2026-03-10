"""
Unit tests for all SQLAlchemy models.

Covers:
- Building: create, name uniqueness constraint
- LotOwner: create, lot_number uniqueness per building, unit_entitlement >= 0
- AGM: create open status default, voting_closes_at > meeting_at constraint
- Motion: create, order_index uniqueness per AGM
- AGMLotWeight: create, UniqueConstraint(agm_id, lot_owner_id)
- Vote: create draft, UniqueConstraint(agm_id, motion_id, voter_email), status transitions
- BallotSubmission: create, UniqueConstraint(agm_id, voter_email)
- SessionRecord: create
- EmailDelivery: create, unique per agm_id
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    AGM,
    AGMLotWeight,
    AGMStatus,
    BallotSubmission,
    Building,
    EmailDelivery,
    EmailDeliveryStatus,
    LotOwner,
    Motion,
    SessionRecord,
    Vote,
    VoteChoice,
    VoteStatus,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

UTC = timezone.utc


def utcnow() -> datetime:
    return datetime.now(UTC)


def make_building(name: str = "Test Building", email: str = "mgr@example.com") -> Building:
    return Building(name=name, manager_email=email)


def make_lot_owner(building: Building, lot_number: str = "1A", email: str = "owner@example.com", entitlement: int = 100) -> LotOwner:
    return LotOwner(
        building_id=building.id,
        lot_number=lot_number,
        email=email,
        unit_entitlement=entitlement,
    )


def make_agm(building: Building, title: str = "AGM 2026") -> AGM:
    now = utcnow()
    return AGM(
        building_id=building.id,
        title=title,
        meeting_at=now + timedelta(days=1),
        voting_closes_at=now + timedelta(days=2),
    )


def make_motion(agm: AGM, title: str = "Motion 1", order_index: int = 1) -> Motion:
    return Motion(agm_id=agm.id, title=title, order_index=order_index)


# ---------------------------------------------------------------------------
# Building tests
# ---------------------------------------------------------------------------


class TestBuilding:
    """Happy path and constraint tests for Building model."""

    # --- Happy path ---

    async def test_create_building(self, db_session: AsyncSession):
        building = make_building()
        db_session.add(building)
        await db_session.flush()

        assert building.id is not None
        assert isinstance(building.id, uuid.UUID)
        assert building.name == "Test Building"
        assert building.manager_email == "mgr@example.com"
        # created_at is set by server_default on flush
        assert building.created_at is not None

    async def test_building_id_is_uuid4(self, db_session: AsyncSession):
        b1 = make_building("Building Alpha")
        b2 = make_building("Building Beta")
        db_session.add_all([b1, b2])
        await db_session.flush()
        assert b1.id != b2.id

    async def test_building_repr_fields(self, db_session: AsyncSession):
        """Building stores name and manager_email correctly."""
        b = Building(name="Unique Corp Tower", manager_email="boss@corp.com")
        db_session.add(b)
        await db_session.flush()
        assert b.name == "Unique Corp Tower"
        assert b.manager_email == "boss@corp.com"

    # --- Input validation / constraints ---

    async def test_building_name_uniqueness(self, db_session: AsyncSession):
        """Two buildings with the same name violate the unique constraint."""
        b1 = make_building("Duplicate Name")
        db_session.add(b1)
        await db_session.flush()

        b2 = make_building("Duplicate Name")
        db_session.add(b2)
        with pytest.raises(IntegrityError):
            await db_session.flush()

    async def test_building_name_case_sensitive_uniqueness(self, db_session: AsyncSession):
        """Different-case names are treated as distinct by PostgreSQL."""
        b1 = make_building("CaseSensitive")
        b2 = make_building("casesensitive")
        db_session.add_all([b1, b2])
        await db_session.flush()  # Should NOT raise — different strings

        assert b1.id != b2.id

    # --- Boundary values ---

    async def test_building_with_minimal_name(self, db_session: AsyncSession):
        b = Building(name="X", manager_email="x@x.com")
        db_session.add(b)
        await db_session.flush()
        assert b.name == "X"

    async def test_building_with_long_name(self, db_session: AsyncSession):
        long_name = "B" * 500
        b = Building(name=long_name, manager_email="long@example.com")
        db_session.add(b)
        await db_session.flush()
        assert b.name == long_name


# ---------------------------------------------------------------------------
# LotOwner tests
# ---------------------------------------------------------------------------


class TestLotOwner:
    """Happy path and constraint tests for LotOwner model."""

    # --- Happy path ---

    async def test_create_lot_owner(self, db_session: AsyncSession):
        b = make_building("LotOwner Building")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b)
        db_session.add(lo)
        await db_session.flush()

        assert lo.id is not None
        assert lo.building_id == b.id
        assert lo.lot_number == "1A"
        assert lo.email == "owner@example.com"
        assert lo.unit_entitlement == 100

    async def test_lot_owner_zero_entitlement(self, db_session: AsyncSession):
        """unit_entitlement = 0 is the minimum valid value."""
        b = make_building("Zero Entitlement Building")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b, entitlement=0)
        db_session.add(lo)
        await db_session.flush()
        assert lo.unit_entitlement == 0

    async def test_lot_owner_large_entitlement(self, db_session: AsyncSession):
        b = make_building("Large Entitlement Bldg")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b, entitlement=2_147_483_647)  # max int4
        db_session.add(lo)
        await db_session.flush()
        assert lo.unit_entitlement == 2_147_483_647

    async def test_multiple_lots_same_email(self, db_session: AsyncSession):
        """Multiple lots can share the same email within a building."""
        b = make_building("Multi Lot Building")
        db_session.add(b)
        await db_session.flush()

        lo1 = make_lot_owner(b, lot_number="1A", email="shared@example.com")
        lo2 = make_lot_owner(b, lot_number="1B", email="shared@example.com")
        db_session.add_all([lo1, lo2])
        await db_session.flush()
        assert lo1.id != lo2.id

    # --- Input validation / constraints ---

    async def test_lot_number_uniqueness_per_building(self, db_session: AsyncSession):
        """Same lot number in same building raises IntegrityError."""
        b = make_building("UniqueBuilding")
        db_session.add(b)
        await db_session.flush()

        lo1 = make_lot_owner(b, lot_number="SAME")
        db_session.add(lo1)
        await db_session.flush()

        lo2 = make_lot_owner(b, lot_number="SAME", email="other@example.com")
        db_session.add(lo2)
        with pytest.raises(IntegrityError):
            await db_session.flush()

    async def test_same_lot_number_different_buildings_allowed(self, db_session: AsyncSession):
        """Same lot number is allowed in different buildings."""
        b1 = make_building("Building One")
        b2 = make_building("Building Two")
        db_session.add_all([b1, b2])
        await db_session.flush()

        lo1 = make_lot_owner(b1, lot_number="SHARED_LOT")
        lo2 = make_lot_owner(b2, lot_number="SHARED_LOT")
        db_session.add_all([lo1, lo2])
        await db_session.flush()  # Should NOT raise
        assert lo1.id != lo2.id

    async def test_negative_unit_entitlement_rejected(self, db_session: AsyncSession):
        """unit_entitlement < 0 violates the check constraint."""
        b = make_building("Neg Entitlement Bldg")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b, entitlement=-1)
        db_session.add(lo)
        with pytest.raises(IntegrityError):
            await db_session.flush()

    # --- Boundary values ---

    async def test_lot_number_as_numeric_string(self, db_session: AsyncSession):
        """lot_number is a string — numeric strings are valid."""
        b = make_building("Numeric Lot Bldg")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b, lot_number="42")
        db_session.add(lo)
        await db_session.flush()
        assert lo.lot_number == "42"


# ---------------------------------------------------------------------------
# AGM tests
# ---------------------------------------------------------------------------


class TestAGM:
    """Happy path and constraint tests for AGM model."""

    # --- Happy path ---

    async def test_create_agm_defaults_to_open(self, db_session: AsyncSession):
        b = make_building("AGM Test Building")
        db_session.add(b)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        assert agm.id is not None
        assert agm.status == AGMStatus.open
        assert agm.closed_at is None
        assert agm.building_id == b.id

    async def test_agm_title_stored(self, db_session: AsyncSession):
        b = make_building("Title Test Bldg")
        db_session.add(b)
        await db_session.flush()

        agm = make_agm(b, title="Special General Meeting 2026")
        db_session.add(agm)
        await db_session.flush()
        assert agm.title == "Special General Meeting 2026"

    async def test_agm_can_be_closed(self, db_session: AsyncSession):
        b = make_building("Close Test Bldg")
        db_session.add(b)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        agm.status = AGMStatus.closed
        agm.closed_at = utcnow()
        await db_session.flush()

        assert agm.status == AGMStatus.closed
        assert agm.closed_at is not None

    async def test_agm_meeting_times_stored(self, db_session: AsyncSession):
        b = make_building("Time Test Bldg")
        db_session.add(b)
        await db_session.flush()

        now = utcnow()
        meeting = now + timedelta(hours=2)
        closes = now + timedelta(hours=4)
        agm = AGM(building_id=b.id, title="Timed AGM", meeting_at=meeting, voting_closes_at=closes)
        db_session.add(agm)
        await db_session.flush()

        assert agm.meeting_at.tzinfo is not None
        assert agm.voting_closes_at.tzinfo is not None

    # --- Input validation / constraints ---

    async def test_voting_closes_at_must_be_after_meeting_at(self, db_session: AsyncSession):
        """voting_closes_at <= meeting_at violates the check constraint."""
        b = make_building("Constraint Test Bldg")
        db_session.add(b)
        await db_session.flush()

        now = utcnow()
        agm = AGM(
            building_id=b.id,
            title="Bad AGM",
            meeting_at=now + timedelta(days=2),
            voting_closes_at=now + timedelta(days=1),  # BEFORE meeting_at
        )
        db_session.add(agm)
        with pytest.raises(IntegrityError):
            await db_session.flush()

    async def test_voting_closes_equal_meeting_at_rejected(self, db_session: AsyncSession):
        """voting_closes_at == meeting_at also violates the strict > constraint."""
        b = make_building("Equal Time Bldg")
        db_session.add(b)
        await db_session.flush()

        same_time = utcnow() + timedelta(days=1)
        agm = AGM(
            building_id=b.id,
            title="Equal Time AGM",
            meeting_at=same_time,
            voting_closes_at=same_time,
        )
        db_session.add(agm)
        with pytest.raises(IntegrityError):
            await db_session.flush()

    # --- State / precondition ---

    async def test_multiple_agms_per_building_allowed_at_db_level(self, db_session: AsyncSession):
        """DB allows multiple open AGMs; the one-per-building rule is enforced at app level."""
        b = make_building("Multi AGM Bldg")
        db_session.add(b)
        await db_session.flush()

        agm1 = make_agm(b, title="AGM One")
        agm2 = make_agm(b, title="AGM Two")
        db_session.add_all([agm1, agm2])
        await db_session.flush()  # Should succeed at DB level
        assert agm1.id != agm2.id


# ---------------------------------------------------------------------------
# Motion tests
# ---------------------------------------------------------------------------


class TestMotion:
    """Happy path and constraint tests for Motion model."""

    # --- Happy path ---

    async def test_create_motion(self, db_session: AsyncSession):
        b = make_building("Motion Building")
        db_session.add(b)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        motion = make_motion(agm)
        db_session.add(motion)
        await db_session.flush()

        assert motion.id is not None
        assert motion.agm_id == agm.id
        assert motion.title == "Motion 1"
        assert motion.order_index == 1
        assert motion.description is None

    async def test_motion_with_description(self, db_session: AsyncSession):
        b = make_building("Motion Desc Bldg")
        db_session.add(b)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(agm_id=agm.id, title="Approve Budget", description="Approve the 2026 budget of $500k", order_index=1)
        db_session.add(motion)
        await db_session.flush()
        assert motion.description == "Approve the 2026 budget of $500k"

    async def test_multiple_motions_in_order(self, db_session: AsyncSession):
        b = make_building("Multi Motion Bldg")
        db_session.add(b)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        for i in range(1, 6):
            db_session.add(Motion(agm_id=agm.id, title=f"Motion {i}", order_index=i))
        await db_session.flush()  # Should succeed

    # --- Input validation / constraints ---

    async def test_order_index_uniqueness_per_agm(self, db_session: AsyncSession):
        """Two motions with the same order_index in the same AGM violate the unique constraint."""
        b = make_building("Order Index Bldg")
        db_session.add(b)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        m1 = Motion(agm_id=agm.id, title="Motion A", order_index=1)
        db_session.add(m1)
        await db_session.flush()

        m2 = Motion(agm_id=agm.id, title="Motion B", order_index=1)
        db_session.add(m2)
        with pytest.raises(IntegrityError):
            await db_session.flush()

    async def test_same_order_index_different_agms_allowed(self, db_session: AsyncSession):
        b = make_building("Cross AGM Motion Bldg")
        db_session.add(b)
        await db_session.flush()

        agm1 = make_agm(b, title="AGM A")
        agm2 = make_agm(b, title="AGM B")
        db_session.add_all([agm1, agm2])
        await db_session.flush()

        m1 = Motion(agm_id=agm1.id, title="Motion 1", order_index=1)
        m2 = Motion(agm_id=agm2.id, title="Motion 1", order_index=1)
        db_session.add_all([m1, m2])
        await db_session.flush()  # Should NOT raise
        assert m1.id != m2.id

    # --- Boundary values ---

    async def test_motion_order_index_zero(self, db_session: AsyncSession):
        b = make_building("Zero Index Bldg")
        db_session.add(b)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        m = Motion(agm_id=agm.id, title="Preamble", order_index=0)
        db_session.add(m)
        await db_session.flush()
        assert m.order_index == 0


# ---------------------------------------------------------------------------
# AGMLotWeight tests
# ---------------------------------------------------------------------------


class TestAGMLotWeight:
    """Happy path and constraint tests for AGMLotWeight model."""

    # --- Happy path ---

    async def test_create_agm_lot_weight(self, db_session: AsyncSession):
        b = make_building("Weight Building")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b, entitlement=250)
        db_session.add(lo)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        weight = AGMLotWeight(
            agm_id=agm.id,
            lot_owner_id=lo.id,
            voter_email=lo.email,
            unit_entitlement_snapshot=250,
        )
        db_session.add(weight)
        await db_session.flush()

        assert weight.id is not None
        assert weight.unit_entitlement_snapshot == 250
        assert weight.voter_email == "owner@example.com"

    async def test_snapshot_zero_entitlement(self, db_session: AsyncSession):
        b = make_building("Zero Snapshot Bldg")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b, entitlement=0)
        db_session.add(lo)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        weight = AGMLotWeight(
            agm_id=agm.id,
            lot_owner_id=lo.id,
            voter_email=lo.email,
            unit_entitlement_snapshot=0,
        )
        db_session.add(weight)
        await db_session.flush()
        assert weight.unit_entitlement_snapshot == 0

    # --- Input validation / constraints ---

    async def test_unique_constraint_agm_lot_owner(self, db_session: AsyncSession):
        """Same (agm_id, lot_owner_id) pair raises IntegrityError."""
        b = make_building("Dup Weight Bldg")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b)
        db_session.add(lo)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        w1 = AGMLotWeight(agm_id=agm.id, lot_owner_id=lo.id, voter_email=lo.email, unit_entitlement_snapshot=100)
        db_session.add(w1)
        await db_session.flush()

        w2 = AGMLotWeight(agm_id=agm.id, lot_owner_id=lo.id, voter_email=lo.email, unit_entitlement_snapshot=200)
        db_session.add(w2)
        with pytest.raises(IntegrityError):
            await db_session.flush()

    async def test_negative_snapshot_rejected(self, db_session: AsyncSession):
        b = make_building("Neg Snapshot Bldg")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b)
        db_session.add(lo)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        w = AGMLotWeight(agm_id=agm.id, lot_owner_id=lo.id, voter_email=lo.email, unit_entitlement_snapshot=-5)
        db_session.add(w)
        with pytest.raises(IntegrityError):
            await db_session.flush()

    async def test_same_lot_different_agms_allowed(self, db_session: AsyncSession):
        """Same lot owner can have weight records across multiple AGMs."""
        b = make_building("Multi AGM Weight Bldg")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b)
        db_session.add(lo)
        await db_session.flush()

        agm1 = make_agm(b, title="First AGM")
        agm2 = make_agm(b, title="Second AGM")
        db_session.add_all([agm1, agm2])
        await db_session.flush()

        w1 = AGMLotWeight(agm_id=agm1.id, lot_owner_id=lo.id, voter_email=lo.email, unit_entitlement_snapshot=100)
        w2 = AGMLotWeight(agm_id=agm2.id, lot_owner_id=lo.id, voter_email=lo.email, unit_entitlement_snapshot=150)
        db_session.add_all([w1, w2])
        await db_session.flush()  # Should NOT raise


# ---------------------------------------------------------------------------
# Vote tests
# ---------------------------------------------------------------------------


class TestVote:
    """Happy path and constraint tests for Vote model."""

    async def _setup_vote_context(self, db_session: AsyncSession, suffix: str = ""):
        b = make_building(f"Vote Bldg{suffix}")
        db_session.add(b)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        motion = make_motion(agm)
        db_session.add(motion)
        await db_session.flush()

        return b, agm, motion

    # --- Happy path ---

    async def test_create_draft_vote(self, db_session: AsyncSession):
        _, agm, motion = await self._setup_vote_context(db_session, " Draft")

        vote = Vote(
            agm_id=agm.id,
            motion_id=motion.id,
            voter_email="voter@example.com",
        )
        db_session.add(vote)
        await db_session.flush()

        assert vote.id is not None
        assert vote.status == VoteStatus.draft
        assert vote.choice is None

    async def test_create_vote_with_yes_choice(self, db_session: AsyncSession):
        _, agm, motion = await self._setup_vote_context(db_session, " Yes")

        vote = Vote(
            agm_id=agm.id,
            motion_id=motion.id,
            voter_email="yes@example.com",
            choice=VoteChoice.yes,
        )
        db_session.add(vote)
        await db_session.flush()
        assert vote.choice == VoteChoice.yes

    async def test_create_vote_with_no_choice(self, db_session: AsyncSession):
        _, agm, motion = await self._setup_vote_context(db_session, " No")

        vote = Vote(
            agm_id=agm.id,
            motion_id=motion.id,
            voter_email="no@example.com",
            choice=VoteChoice.no,
        )
        db_session.add(vote)
        await db_session.flush()
        assert vote.choice == VoteChoice.no

    async def test_create_vote_with_abstained_choice(self, db_session: AsyncSession):
        _, agm, motion = await self._setup_vote_context(db_session, " Abstain")

        vote = Vote(
            agm_id=agm.id,
            motion_id=motion.id,
            voter_email="abs@example.com",
            choice=VoteChoice.abstained,
        )
        db_session.add(vote)
        await db_session.flush()
        assert vote.choice == VoteChoice.abstained

    async def test_draft_to_submitted_status_transition(self, db_session: AsyncSession):
        _, agm, motion = await self._setup_vote_context(db_session, " Transition")

        vote = Vote(
            agm_id=agm.id,
            motion_id=motion.id,
            voter_email="transition@example.com",
            choice=VoteChoice.yes,
        )
        db_session.add(vote)
        await db_session.flush()
        assert vote.status == VoteStatus.draft

        vote.status = VoteStatus.submitted
        await db_session.flush()
        assert vote.status == VoteStatus.submitted

    # --- Input validation / constraints ---

    async def test_unique_constraint_agm_motion_voter(self, db_session: AsyncSession):
        """Same (agm_id, motion_id, voter_email) raises IntegrityError."""
        _, agm, motion = await self._setup_vote_context(db_session, " Dup")

        v1 = Vote(agm_id=agm.id, motion_id=motion.id, voter_email="dup@example.com", choice=VoteChoice.yes)
        db_session.add(v1)
        await db_session.flush()

        v2 = Vote(agm_id=agm.id, motion_id=motion.id, voter_email="dup@example.com", choice=VoteChoice.no)
        db_session.add(v2)
        with pytest.raises(IntegrityError):
            await db_session.flush()

    async def test_same_voter_different_motions_allowed(self, db_session: AsyncSession):
        b = make_building("Multi Motion Vote Bldg")
        db_session.add(b)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        m1 = Motion(agm_id=agm.id, title="Motion A", order_index=1)
        m2 = Motion(agm_id=agm.id, title="Motion B", order_index=2)
        db_session.add_all([m1, m2])
        await db_session.flush()

        v1 = Vote(agm_id=agm.id, motion_id=m1.id, voter_email="multi@example.com", choice=VoteChoice.yes)
        v2 = Vote(agm_id=agm.id, motion_id=m2.id, voter_email="multi@example.com", choice=VoteChoice.no)
        db_session.add_all([v1, v2])
        await db_session.flush()  # Should NOT raise

    async def test_vote_timestamps_set(self, db_session: AsyncSession):
        _, agm, motion = await self._setup_vote_context(db_session, " Timestamps")

        vote = Vote(agm_id=agm.id, motion_id=motion.id, voter_email="ts@example.com")
        db_session.add(vote)
        await db_session.flush()
        assert vote.created_at is not None
        assert vote.updated_at is not None


# ---------------------------------------------------------------------------
# BallotSubmission tests
# ---------------------------------------------------------------------------


class TestBallotSubmission:
    """Happy path and constraint tests for BallotSubmission model."""

    async def _setup(self, db_session: AsyncSession, suffix: str = ""):
        b = make_building(f"Ballot Bldg{suffix}")
        db_session.add(b)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        return b, agm

    # --- Happy path ---

    async def test_create_ballot_submission(self, db_session: AsyncSession):
        _, agm = await self._setup(db_session, " Create")

        sub = BallotSubmission(agm_id=agm.id, voter_email="voter@example.com")
        db_session.add(sub)
        await db_session.flush()

        assert sub.id is not None
        assert sub.agm_id == agm.id
        assert sub.voter_email == "voter@example.com"
        assert sub.submitted_at is not None

    # --- Input validation / constraints ---

    async def test_unique_constraint_agm_voter(self, db_session: AsyncSession):
        """Same (agm_id, voter_email) pair raises IntegrityError."""
        _, agm = await self._setup(db_session, " Dup")

        s1 = BallotSubmission(agm_id=agm.id, voter_email="dup@example.com")
        db_session.add(s1)
        await db_session.flush()

        s2 = BallotSubmission(agm_id=agm.id, voter_email="dup@example.com")
        db_session.add(s2)
        with pytest.raises(IntegrityError):
            await db_session.flush()

    async def test_same_voter_different_agms_allowed(self, db_session: AsyncSession):
        b = make_building("Same Voter Diff AGM Bldg")
        db_session.add(b)
        await db_session.flush()

        agm1 = make_agm(b, title="AGM Alpha")
        agm2 = make_agm(b, title="AGM Beta")
        db_session.add_all([agm1, agm2])
        await db_session.flush()

        s1 = BallotSubmission(agm_id=agm1.id, voter_email="voter@example.com")
        s2 = BallotSubmission(agm_id=agm2.id, voter_email="voter@example.com")
        db_session.add_all([s1, s2])
        await db_session.flush()  # Should NOT raise


# ---------------------------------------------------------------------------
# SessionRecord tests
# ---------------------------------------------------------------------------


class TestSessionRecord:
    """Happy path tests for SessionRecord model."""

    # --- Happy path ---

    async def test_create_session_record(self, db_session: AsyncSession):
        b = make_building("Session Building")
        db_session.add(b)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        token = str(uuid.uuid4())
        expires = utcnow() + timedelta(hours=24)
        session = SessionRecord(
            session_token=token,
            voter_email="sess@example.com",
            building_id=b.id,
            agm_id=agm.id,
            expires_at=expires,
        )
        db_session.add(session)
        await db_session.flush()

        assert session.id is not None
        assert session.session_token == token
        assert session.voter_email == "sess@example.com"
        assert session.created_at is not None

    async def test_session_token_unique(self, db_session: AsyncSession):
        """Two sessions with the same token raise IntegrityError."""
        b = make_building("Token Unique Bldg")
        db_session.add(b)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        token = "same-token-12345"
        expires = utcnow() + timedelta(hours=1)

        s1 = SessionRecord(session_token=token, voter_email="a@a.com", building_id=b.id, agm_id=agm.id, expires_at=expires)
        db_session.add(s1)
        await db_session.flush()

        s2 = SessionRecord(session_token=token, voter_email="b@b.com", building_id=b.id, agm_id=agm.id, expires_at=expires)
        db_session.add(s2)
        with pytest.raises(IntegrityError):
            await db_session.flush()

    # --- Boundary values ---

    async def test_session_expires_in_past(self, db_session: AsyncSession):
        """DB allows past expiry times — enforcement is at application level."""
        b = make_building("Past Expiry Bldg")
        db_session.add(b)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        past = utcnow() - timedelta(days=1)
        session = SessionRecord(
            session_token="expired-token",
            voter_email="old@example.com",
            building_id=b.id,
            agm_id=agm.id,
            expires_at=past,
        )
        db_session.add(session)
        await db_session.flush()
        assert session.expires_at < utcnow()


# ---------------------------------------------------------------------------
# EmailDelivery tests
# ---------------------------------------------------------------------------


class TestEmailDelivery:
    """Happy path and constraint tests for EmailDelivery model."""

    async def _setup(self, db_session: AsyncSession, suffix: str = ""):
        b = make_building(f"Email Bldg{suffix}")
        db_session.add(b)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        return b, agm

    # --- Happy path ---

    async def test_create_email_delivery_pending(self, db_session: AsyncSession):
        _, agm = await self._setup(db_session, " Pending")

        ed = EmailDelivery(agm_id=agm.id)
        db_session.add(ed)
        await db_session.flush()

        assert ed.id is not None
        assert ed.status == EmailDeliveryStatus.pending
        assert ed.total_attempts == 0
        assert ed.last_error is None
        assert ed.next_retry_at is None

    async def test_email_delivery_status_transitions(self, db_session: AsyncSession):
        _, agm = await self._setup(db_session, " Transition")

        ed = EmailDelivery(agm_id=agm.id)
        db_session.add(ed)
        await db_session.flush()

        ed.status = EmailDeliveryStatus.delivered
        ed.total_attempts = 1
        await db_session.flush()
        assert ed.status == EmailDeliveryStatus.delivered

    async def test_email_delivery_failed_with_error(self, db_session: AsyncSession):
        _, agm = await self._setup(db_session, " Failed")

        ed = EmailDelivery(agm_id=agm.id)
        db_session.add(ed)
        await db_session.flush()

        ed.status = EmailDeliveryStatus.failed
        ed.total_attempts = 30
        ed.last_error = "Connection timeout"
        ed.next_retry_at = None
        await db_session.flush()

        assert ed.status == EmailDeliveryStatus.failed
        assert ed.total_attempts == 30
        assert ed.last_error == "Connection timeout"

    async def test_email_delivery_with_retry_at(self, db_session: AsyncSession):
        _, agm = await self._setup(db_session, " Retry")

        retry_time = utcnow() + timedelta(minutes=5)
        ed = EmailDelivery(agm_id=agm.id, next_retry_at=retry_time)
        db_session.add(ed)
        await db_session.flush()
        assert ed.next_retry_at is not None

    # --- Input validation / constraints ---

    async def test_unique_per_agm(self, db_session: AsyncSession):
        """Only one EmailDelivery per AGM — violating raises IntegrityError."""
        _, agm = await self._setup(db_session, " UniqueAGM")

        ed1 = EmailDelivery(agm_id=agm.id)
        db_session.add(ed1)
        await db_session.flush()

        ed2 = EmailDelivery(agm_id=agm.id)
        db_session.add(ed2)
        with pytest.raises(IntegrityError):
            await db_session.flush()

    async def test_different_agms_allowed(self, db_session: AsyncSession):
        b = make_building("Two AGM Email Bldg")
        db_session.add(b)
        await db_session.flush()

        agm1 = make_agm(b, title="AGM X")
        agm2 = make_agm(b, title="AGM Y")
        db_session.add_all([agm1, agm2])
        await db_session.flush()

        ed1 = EmailDelivery(agm_id=agm1.id)
        ed2 = EmailDelivery(agm_id=agm2.id)
        db_session.add_all([ed1, ed2])
        await db_session.flush()  # Should NOT raise

    # --- Boundary values ---

    async def test_email_delivery_attempt_count_zero(self, db_session: AsyncSession):
        _, agm = await self._setup(db_session, " Zero Attempts")
        ed = EmailDelivery(agm_id=agm.id, total_attempts=0)
        db_session.add(ed)
        await db_session.flush()
        assert ed.total_attempts == 0

    async def test_email_delivery_attempt_count_max(self, db_session: AsyncSession):
        _, agm = await self._setup(db_session, " Max Attempts")
        ed = EmailDelivery(agm_id=agm.id, total_attempts=30)
        db_session.add(ed)
        await db_session.flush()
        assert ed.total_attempts == 30
