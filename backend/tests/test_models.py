"""
Unit tests for all SQLAlchemy models.

Covers:
- Building: create, name uniqueness constraint
- LotOwner: create, lot_number uniqueness per building, unit_entitlement >= 0
- LotOwnerEmail: create, unique constraint (lot_owner_id, email)
- GeneralMeeting: create open status default, voting_closes_at > meeting_at constraint
- Motion: create, order_index uniqueness per GeneralMeeting
- GeneralMeetingLotWeight: create, UniqueConstraint(general_meeting_id, lot_owner_id), financial_position_snapshot
- Vote: create draft, UniqueConstraint(agm_id, motion_id, voter_email), status transitions
- BallotSubmission: create, UniqueConstraint(general_meeting_id, lot_owner_id), proxy_email nullable
- LotProxy: create, unique constraint on lot_owner_id, index on proxy_email, cascade delete
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
    GeneralMeeting,
    GeneralMeetingLotWeight,
    GeneralMeetingStatus,
    BallotSubmission,
    Building,
    EmailDelivery,
    EmailDeliveryStatus,
    FinancialPositionSnapshot,
    LotOwner,
    LotOwnerEmail,
    LotProxy,
    Motion,
    SessionRecord,
    Vote,
    VoteChoice,
    VoteStatus,
    get_effective_status,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

UTC = timezone.utc


def utcnow() -> datetime:
    return datetime.now(UTC)


def make_building(name: str = "Test Building", email: str = "mgr@example.com") -> Building:
    return Building(name=name, manager_email=email)


def make_lot_owner(building: Building, lot_number: str = "1A", entitlement: int = 100) -> LotOwner:
    return LotOwner(
        building_id=building.id,
        lot_number=lot_number,
        unit_entitlement=entitlement,
    )


def make_agm(building: Building, title: str = "GeneralMeeting 2026") -> GeneralMeeting:
    now = utcnow()
    return GeneralMeeting(
        building_id=building.id,
        title=title,
        meeting_at=now + timedelta(days=1),
        voting_closes_at=now + timedelta(days=2),
    )


def make_motion(agm: GeneralMeeting, title: str = "Motion 1", order_index: int = 1) -> Motion:
    return Motion(general_meeting_id=agm.id, title=title, order_index=order_index)


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

    async def test_multiple_lots_no_email_required(self, db_session: AsyncSession):
        """Lot owners do not require email — emails are optional in lot_owner_emails."""
        b = make_building("Multi Lot Building")
        db_session.add(b)
        await db_session.flush()

        lo1 = make_lot_owner(b, lot_number="1A")
        lo2 = make_lot_owner(b, lot_number="1B")
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

        lo2 = make_lot_owner(b, lot_number="SAME")
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
# LotOwnerEmail tests
# ---------------------------------------------------------------------------


class TestLotOwnerEmail:
    """Tests for LotOwnerEmail model."""

    # --- Happy path ---

    async def test_create_lot_owner_email(self, db_session: AsyncSession):
        b = make_building("Email Bldg")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b)
        db_session.add(lo)
        await db_session.flush()

        email_rec = LotOwnerEmail(lot_owner_id=lo.id, email="owner@example.com")
        db_session.add(email_rec)
        await db_session.flush()

        assert email_rec.id is not None
        assert email_rec.lot_owner_id == lo.id
        assert email_rec.email == "owner@example.com"

    async def test_multiple_emails_per_lot_owner(self, db_session: AsyncSession):
        b = make_building("Multi Email Bldg")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b)
        db_session.add(lo)
        await db_session.flush()

        e1 = LotOwnerEmail(lot_owner_id=lo.id, email="first@example.com")
        e2 = LotOwnerEmail(lot_owner_id=lo.id, email="second@example.com")
        db_session.add_all([e1, e2])
        await db_session.flush()
        assert e1.id != e2.id

    async def test_same_email_different_lot_owners(self, db_session: AsyncSession):
        b = make_building("Shared Email Bldg")
        db_session.add(b)
        await db_session.flush()

        lo1 = make_lot_owner(b, lot_number="1A")
        lo2 = make_lot_owner(b, lot_number="2B")
        db_session.add_all([lo1, lo2])
        await db_session.flush()

        e1 = LotOwnerEmail(lot_owner_id=lo1.id, email="shared@example.com")
        e2 = LotOwnerEmail(lot_owner_id=lo2.id, email="shared@example.com")
        db_session.add_all([e1, e2])
        await db_session.flush()  # Should NOT raise
        assert e1.id != e2.id

    async def test_null_email_allowed(self, db_session: AsyncSession):
        """Email can be null."""
        b = make_building("Null Email Bldg")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b)
        db_session.add(lo)
        await db_session.flush()

        email_rec = LotOwnerEmail(lot_owner_id=lo.id, email=None)
        db_session.add(email_rec)
        await db_session.flush()
        assert email_rec.email is None

    # --- Constraints ---

    async def test_unique_constraint_owner_email(self, db_session: AsyncSession):
        """Same (lot_owner_id, email) pair raises IntegrityError."""
        b = make_building("Dup Email Bldg")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b)
        db_session.add(lo)
        await db_session.flush()

        e1 = LotOwnerEmail(lot_owner_id=lo.id, email="dup@example.com")
        db_session.add(e1)
        await db_session.flush()

        e2 = LotOwnerEmail(lot_owner_id=lo.id, email="dup@example.com")
        db_session.add(e2)
        with pytest.raises(IntegrityError):
            await db_session.flush()


# ---------------------------------------------------------------------------
# GeneralMeeting tests
# ---------------------------------------------------------------------------


class TestAGM:
    """Happy path and constraint tests for GeneralMeeting model."""

    # --- Happy path ---

    async def test_create_agm_defaults_to_open(self, db_session: AsyncSession):
        b = make_building("GeneralMeeting Test Building")
        db_session.add(b)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        assert agm.id is not None
        assert agm.status == GeneralMeetingStatus.open
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

        agm.status = GeneralMeetingStatus.closed
        agm.closed_at = utcnow()
        await db_session.flush()

        assert agm.status == GeneralMeetingStatus.closed
        assert agm.closed_at is not None

    async def test_agm_meeting_times_stored(self, db_session: AsyncSession):
        b = make_building("Time Test Bldg")
        db_session.add(b)
        await db_session.flush()

        now = utcnow()
        meeting = now + timedelta(hours=2)
        closes = now + timedelta(hours=4)
        agm = GeneralMeeting(building_id=b.id, title="Timed GeneralMeeting", meeting_at=meeting, voting_closes_at=closes)
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
        agm = GeneralMeeting(
            building_id=b.id,
            title="Bad GeneralMeeting",
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
        agm = GeneralMeeting(
            building_id=b.id,
            title="Equal Time GeneralMeeting",
            meeting_at=same_time,
            voting_closes_at=same_time,
        )
        db_session.add(agm)
        with pytest.raises(IntegrityError):
            await db_session.flush()

    # --- State / precondition ---

    async def test_multiple_agms_per_building_allowed_at_db_level(self, db_session: AsyncSession):
        """DB allows multiple open AGMs; the one-per-building rule is enforced at app level."""
        b = make_building("Multi GeneralMeeting Bldg")
        db_session.add(b)
        await db_session.flush()

        agm1 = make_agm(b, title="GeneralMeeting One")
        agm2 = make_agm(b, title="GeneralMeeting Two")
        db_session.add_all([agm1, agm2])
        await db_session.flush()  # Should succeed at DB level
        assert agm1.id != agm2.id


# ---------------------------------------------------------------------------
# get_effective_status unit tests (US-PS01)
# ---------------------------------------------------------------------------


class _FakeMeeting:
    """Minimal stand-in for GeneralMeeting to unit-test get_effective_status without DB."""

    def __init__(
        self,
        status: GeneralMeetingStatus,
        voting_closes_at,
        meeting_at=None,
    ):
        self.status = status
        self.voting_closes_at = voting_closes_at
        self.meeting_at = meeting_at


class TestGetEffectiveStatus:
    """Unit tests for get_effective_status helper (US-PS01)."""

    def test_pending_stored_status_with_future_meeting_at_returns_pending(self):
        """Meeting stored as pending with future meeting_at returns pending."""
        m = _FakeMeeting(
            GeneralMeetingStatus.pending,
            datetime.now(UTC) + timedelta(days=2),
            meeting_at=datetime.now(UTC) + timedelta(days=1),
        )
        assert get_effective_status(m) == GeneralMeetingStatus.pending  # type: ignore[arg-type]

    def test_open_stored_status_with_future_meeting_at_returns_pending(self):
        """Meeting stored as open but with future meeting_at returns pending."""
        m = _FakeMeeting(
            GeneralMeetingStatus.open,
            datetime.now(UTC) + timedelta(days=2),
            meeting_at=datetime.now(UTC) + timedelta(days=1),
        )
        assert get_effective_status(m) == GeneralMeetingStatus.pending  # type: ignore[arg-type]

    def test_open_stored_status_with_past_meeting_at_future_closes_at_returns_open(self):
        """Meeting whose start has passed but voting is still open returns open."""
        m = _FakeMeeting(
            GeneralMeetingStatus.open,
            datetime.now(UTC) + timedelta(days=1),
            meeting_at=datetime.now(UTC) - timedelta(hours=1),
        )
        assert get_effective_status(m) == GeneralMeetingStatus.open  # type: ignore[arg-type]

    def test_open_stored_status_with_past_closes_at_returns_closed(self):
        """Meeting whose voting_closes_at has passed is effectively closed."""
        m = _FakeMeeting(
            GeneralMeetingStatus.open,
            datetime.now(UTC) - timedelta(seconds=1),
            meeting_at=datetime.now(UTC) - timedelta(hours=2),
        )
        assert get_effective_status(m) == GeneralMeetingStatus.closed  # type: ignore[arg-type]

    def test_closed_stored_status_with_future_voting_closes_at_returns_closed(self):
        """Manually closed meeting returns closed even if voting_closes_at is in the future."""
        m = _FakeMeeting(
            GeneralMeetingStatus.closed,
            datetime.now(UTC) + timedelta(days=1),
            meeting_at=datetime.now(UTC) + timedelta(days=1),
        )
        assert get_effective_status(m) == GeneralMeetingStatus.closed  # type: ignore[arg-type]

    def test_pending_stored_status_with_both_timestamps_past_returns_closed(self):
        """Meeting stored as pending but both timestamps past returns closed (voting_closes_at wins)."""
        m = _FakeMeeting(
            GeneralMeetingStatus.pending,
            datetime.now(UTC) - timedelta(hours=1),
            meeting_at=datetime.now(UTC) - timedelta(hours=2),
        )
        assert get_effective_status(m) == GeneralMeetingStatus.closed  # type: ignore[arg-type]

    def test_future_meeting_at_but_past_voting_closes_at_returns_closed(self):
        """voting_closes_at in the past takes priority even if meeting_at is in the future."""
        m = _FakeMeeting(
            GeneralMeetingStatus.open,
            datetime.now(UTC) - timedelta(seconds=1),
            meeting_at=datetime.now(UTC) + timedelta(days=1),
        )
        assert get_effective_status(m) == GeneralMeetingStatus.closed  # type: ignore[arg-type]

    def test_open_with_none_meeting_at_and_future_closes_at_returns_open(self):
        """Meeting with no meeting_at and future voting_closes_at returns open."""
        m = _FakeMeeting(GeneralMeetingStatus.open, datetime.now(UTC) + timedelta(days=1))
        assert get_effective_status(m) == GeneralMeetingStatus.open  # type: ignore[arg-type]

    def test_open_with_none_closes_at_and_none_meeting_at_returns_open(self):
        """Meeting with no timestamps at all returns open (edge case)."""
        m = _FakeMeeting(GeneralMeetingStatus.open, None)
        assert get_effective_status(m) == GeneralMeetingStatus.open  # type: ignore[arg-type]

    def test_naive_future_meeting_at_returns_pending(self):
        """Naive (tz-unaware) meeting_at far in the future derives pending."""
        m = _FakeMeeting(
            GeneralMeetingStatus.open,
            datetime(2099, 12, 31, 23, 59, 59),
            meeting_at=datetime(2099, 12, 31, 12, 0, 0),
        )
        assert get_effective_status(m) == GeneralMeetingStatus.pending  # type: ignore[arg-type]

    def test_naive_past_closes_at_returns_closed(self):
        """Naive (tz-unaware) voting_closes_at in the past is treated as UTC and returns closed."""
        m = _FakeMeeting(
            GeneralMeetingStatus.open,
            datetime(2000, 1, 1, 0, 0, 0),
            meeting_at=datetime.now(UTC) - timedelta(days=1),
        )
        assert get_effective_status(m) == GeneralMeetingStatus.closed  # type: ignore[arg-type]


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
        assert motion.general_meeting_id == agm.id
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

        motion = Motion(general_meeting_id=agm.id, title="Approve Budget", description="Approve the 2026 budget of $500k", order_index=1)
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
            db_session.add(Motion(general_meeting_id=agm.id, title=f"Motion {i}", order_index=i))
        await db_session.flush()  # Should succeed

    # --- Input validation / constraints ---

    async def test_order_index_uniqueness_per_agm(self, db_session: AsyncSession):
        """Two motions with the same order_index in the same GeneralMeeting violate the unique constraint."""
        b = make_building("Order Index Bldg")
        db_session.add(b)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        m1 = Motion(general_meeting_id=agm.id, title="Motion A", order_index=1)
        db_session.add(m1)
        await db_session.flush()

        m2 = Motion(general_meeting_id=agm.id, title="Motion B", order_index=1)
        db_session.add(m2)
        with pytest.raises(IntegrityError):
            await db_session.flush()

    async def test_same_order_index_different_agms_allowed(self, db_session: AsyncSession):
        b = make_building("Cross GeneralMeeting Motion Bldg")
        db_session.add(b)
        await db_session.flush()

        agm1 = make_agm(b, title="GeneralMeeting A")
        agm2 = make_agm(b, title="GeneralMeeting B")
        db_session.add_all([agm1, agm2])
        await db_session.flush()

        m1 = Motion(general_meeting_id=agm1.id, title="Motion 1", order_index=1)
        m2 = Motion(general_meeting_id=agm2.id, title="Motion 1", order_index=1)
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

        m = Motion(general_meeting_id=agm.id, title="Preamble", order_index=0)
        db_session.add(m)
        await db_session.flush()
        assert m.order_index == 0


# ---------------------------------------------------------------------------
# GeneralMeetingLotWeight tests
# ---------------------------------------------------------------------------


class TestGeneralMeetingLotWeight:
    """Happy path and constraint tests for GeneralMeetingLotWeight model."""

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

        weight = GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=250,
        )
        db_session.add(weight)
        await db_session.flush()

        assert weight.id is not None
        assert weight.unit_entitlement_snapshot == 250
        assert weight.financial_position_snapshot == FinancialPositionSnapshot.normal

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

        weight = GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=0,
        )
        db_session.add(weight)
        await db_session.flush()
        assert weight.unit_entitlement_snapshot == 0

    async def test_in_arrear_snapshot(self, db_session: AsyncSession):
        b = make_building("Arrear Snapshot Bldg")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b)
        db_session.add(lo)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        weight = GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=100,
            financial_position_snapshot=FinancialPositionSnapshot.in_arrear,
        )
        db_session.add(weight)
        await db_session.flush()
        assert weight.financial_position_snapshot == FinancialPositionSnapshot.in_arrear

    # --- Input validation / constraints ---

    async def test_unique_constraint_agm_lot_owner(self, db_session: AsyncSession):
        """Same (general_meeting_id, lot_owner_id) pair raises IntegrityError."""
        b = make_building("Dup Weight Bldg")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b)
        db_session.add(lo)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        w1 = GeneralMeetingLotWeight(general_meeting_id=agm.id, lot_owner_id=lo.id, unit_entitlement_snapshot=100)
        db_session.add(w1)
        await db_session.flush()

        w2 = GeneralMeetingLotWeight(general_meeting_id=agm.id, lot_owner_id=lo.id, unit_entitlement_snapshot=200)
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

        w = GeneralMeetingLotWeight(general_meeting_id=agm.id, lot_owner_id=lo.id, unit_entitlement_snapshot=-5)
        db_session.add(w)
        with pytest.raises(IntegrityError):
            await db_session.flush()

    async def test_same_lot_different_agms_allowed(self, db_session: AsyncSession):
        """Same lot owner can have weight records across multiple AGMs."""
        b = make_building("Multi GeneralMeeting Weight Bldg")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b)
        db_session.add(lo)
        await db_session.flush()

        agm1 = make_agm(b, title="First GeneralMeeting")
        agm2 = make_agm(b, title="Second GeneralMeeting")
        db_session.add_all([agm1, agm2])
        await db_session.flush()

        w1 = GeneralMeetingLotWeight(general_meeting_id=agm1.id, lot_owner_id=lo.id, unit_entitlement_snapshot=100)
        w2 = GeneralMeetingLotWeight(general_meeting_id=agm2.id, lot_owner_id=lo.id, unit_entitlement_snapshot=150)
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
            general_meeting_id=agm.id,
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
            general_meeting_id=agm.id,
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
            general_meeting_id=agm.id,
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
            general_meeting_id=agm.id,
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
            general_meeting_id=agm.id,
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

    async def test_unique_constraint_agm_motion_lot_owner(self, db_session: AsyncSession):
        """Same (agm_id, motion_id, lot_owner_id) raises IntegrityError."""
        b, agm, motion = await self._setup_vote_context(db_session, " Dup")

        lo = make_lot_owner(b, lot_number="Dup1")
        db_session.add(lo)
        await db_session.flush()

        v1 = Vote(general_meeting_id=agm.id, motion_id=motion.id, voter_email="dup@example.com", lot_owner_id=lo.id, choice=VoteChoice.yes)
        db_session.add(v1)
        await db_session.flush()

        v2 = Vote(general_meeting_id=agm.id, motion_id=motion.id, voter_email="dup@example.com", lot_owner_id=lo.id, choice=VoteChoice.no)
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

        m1 = Motion(general_meeting_id=agm.id, title="Motion A", order_index=1)
        m2 = Motion(general_meeting_id=agm.id, title="Motion B", order_index=2)
        db_session.add_all([m1, m2])
        await db_session.flush()

        v1 = Vote(general_meeting_id=agm.id, motion_id=m1.id, voter_email="multi@example.com", choice=VoteChoice.yes)
        v2 = Vote(general_meeting_id=agm.id, motion_id=m2.id, voter_email="multi@example.com", choice=VoteChoice.no)
        db_session.add_all([v1, v2])
        await db_session.flush()  # Should NOT raise

    async def test_vote_timestamps_set(self, db_session: AsyncSession):
        _, agm, motion = await self._setup_vote_context(db_session, " Timestamps")

        vote = Vote(general_meeting_id=agm.id, motion_id=motion.id, voter_email="ts@example.com")
        db_session.add(vote)
        await db_session.flush()
        assert vote.created_at is not None
        assert vote.updated_at is not None

    async def test_vote_with_lot_owner_id(self, db_session: AsyncSession):
        b, agm, motion = await self._setup_vote_context(db_session, " LotOwner")

        lo = make_lot_owner(b)
        db_session.add(lo)
        await db_session.flush()

        vote = Vote(
            general_meeting_id=agm.id,
            motion_id=motion.id,
            voter_email="voter@example.com",
            lot_owner_id=lo.id,
            choice=VoteChoice.yes,
        )
        db_session.add(vote)
        await db_session.flush()
        assert vote.lot_owner_id == lo.id


# ---------------------------------------------------------------------------
# BallotSubmission tests
# ---------------------------------------------------------------------------


class TestBallotSubmission:
    """Happy path and constraint tests for BallotSubmission model."""

    async def _setup(self, db_session: AsyncSession, suffix: str = ""):
        b = make_building(f"Ballot Bldg{suffix}")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b)
        db_session.add(lo)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        return b, lo, agm

    # --- Happy path ---

    async def test_create_ballot_submission(self, db_session: AsyncSession):
        _, lo, agm = await self._setup(db_session, " Create")

        sub = BallotSubmission(general_meeting_id=agm.id, lot_owner_id=lo.id, voter_email="voter@example.com")
        db_session.add(sub)
        await db_session.flush()

        assert sub.id is not None
        assert sub.general_meeting_id == agm.id
        assert sub.lot_owner_id == lo.id
        assert sub.voter_email == "voter@example.com"
        assert sub.submitted_at is not None

    # --- Input validation / constraints ---

    async def test_unique_constraint_agm_lot_owner(self, db_session: AsyncSession):
        """Same (general_meeting_id, lot_owner_id) pair raises IntegrityError."""
        _, lo, agm = await self._setup(db_session, " Dup")

        s1 = BallotSubmission(general_meeting_id=agm.id, lot_owner_id=lo.id, voter_email="dup@example.com")
        db_session.add(s1)
        await db_session.flush()

        s2 = BallotSubmission(general_meeting_id=agm.id, lot_owner_id=lo.id, voter_email="dup@example.com")
        db_session.add(s2)
        with pytest.raises(IntegrityError):
            await db_session.flush()

    async def test_same_lot_owner_different_agms_allowed(self, db_session: AsyncSession):
        b = make_building("Same Voter Diff GeneralMeeting Bldg")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b)
        db_session.add(lo)
        await db_session.flush()

        agm1 = make_agm(b, title="GeneralMeeting Alpha")
        agm2 = make_agm(b, title="GeneralMeeting Beta")
        db_session.add_all([agm1, agm2])
        await db_session.flush()

        s1 = BallotSubmission(general_meeting_id=agm1.id, lot_owner_id=lo.id, voter_email="voter@example.com")
        s2 = BallotSubmission(general_meeting_id=agm2.id, lot_owner_id=lo.id, voter_email="voter@example.com")
        db_session.add_all([s1, s2])
        await db_session.flush()  # Should NOT raise

    async def test_ballot_submission_proxy_email_null_by_default(self, db_session: AsyncSession):
        """proxy_email defaults to NULL when not supplied (direct vote)."""
        _, lo, agm = await self._setup(db_session, " ProxyNull")

        sub = BallotSubmission(general_meeting_id=agm.id, lot_owner_id=lo.id, voter_email="direct@example.com")
        db_session.add(sub)
        await db_session.flush()

        assert sub.proxy_email is None

    async def test_ballot_submission_proxy_email_stored(self, db_session: AsyncSession):
        """proxy_email can be set when a proxy votes on behalf of a lot owner."""
        _, lo, agm = await self._setup(db_session, " ProxySet")

        sub = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            voter_email="owner@example.com",
            proxy_email="proxy@example.com",
        )
        db_session.add(sub)
        await db_session.flush()

        assert sub.proxy_email == "proxy@example.com"


# ---------------------------------------------------------------------------
# LotProxy tests
# ---------------------------------------------------------------------------


class TestLotProxy:
    """Happy path and constraint tests for LotProxy model."""

    async def _setup(self, db_session: AsyncSession, suffix: str = ""):
        b = make_building(f"Proxy Bldg{suffix}")
        db_session.add(b)
        await db_session.flush()

        lo = make_lot_owner(b)
        db_session.add(lo)
        await db_session.flush()

        return b, lo

    # --- Happy path ---

    async def test_create_lot_proxy(self, db_session: AsyncSession):
        """A LotProxy record is created with the expected fields."""
        _, lo = await self._setup(db_session, " Create")

        proxy = LotProxy(lot_owner_id=lo.id, proxy_email="proxy@example.com")
        db_session.add(proxy)
        await db_session.flush()

        assert proxy.id is not None
        assert isinstance(proxy.id, uuid.UUID)
        assert proxy.lot_owner_id == lo.id
        assert proxy.proxy_email == "proxy@example.com"
        assert proxy.created_at is not None

    async def test_lot_proxy_relationship_via_lot_owner(self, db_session: AsyncSession):
        """LotProxy is accessible through the lot_owner relationship."""
        _, lo = await self._setup(db_session, " Rel")

        proxy = LotProxy(lot_owner_id=lo.id, proxy_email="relproxy@example.com")
        db_session.add(proxy)
        await db_session.flush()

        # Expire the cached lo object so the relationship is reloaded
        await db_session.refresh(lo, ["lot_proxy"])
        assert lo.lot_proxy is not None
        assert lo.lot_proxy.proxy_email == "relproxy@example.com"

    async def test_multiple_lot_owners_can_have_different_proxies(self, db_session: AsyncSession):
        """Different lot owners can each have their own proxy."""
        b = make_building("Multi Proxy Bldg")
        db_session.add(b)
        await db_session.flush()

        lo1 = make_lot_owner(b, lot_number="P1")
        lo2 = make_lot_owner(b, lot_number="P2")
        db_session.add_all([lo1, lo2])
        await db_session.flush()

        p1 = LotProxy(lot_owner_id=lo1.id, proxy_email="proxyA@example.com")
        p2 = LotProxy(lot_owner_id=lo2.id, proxy_email="proxyB@example.com")
        db_session.add_all([p1, p2])
        await db_session.flush()  # Should NOT raise

        assert p1.id != p2.id

    async def test_same_proxy_email_for_multiple_lots(self, db_session: AsyncSession):
        """The same proxy email can represent multiple lots (no unique constraint on proxy_email)."""
        b = make_building("Shared Proxy Bldg")
        db_session.add(b)
        await db_session.flush()

        lo1 = make_lot_owner(b, lot_number="S1")
        lo2 = make_lot_owner(b, lot_number="S2")
        db_session.add_all([lo1, lo2])
        await db_session.flush()

        p1 = LotProxy(lot_owner_id=lo1.id, proxy_email="shared@example.com")
        p2 = LotProxy(lot_owner_id=lo2.id, proxy_email="shared@example.com")
        db_session.add_all([p1, p2])
        await db_session.flush()  # Should NOT raise — same email, different lots

        assert p1.id != p2.id

    # --- Input validation / constraints ---

    async def test_unique_constraint_lot_owner_id(self, db_session: AsyncSession):
        """Only one proxy per lot_owner_id — second insert raises IntegrityError."""
        _, lo = await self._setup(db_session, " UniqueOwner")

        p1 = LotProxy(lot_owner_id=lo.id, proxy_email="first@example.com")
        db_session.add(p1)
        await db_session.flush()

        p2 = LotProxy(lot_owner_id=lo.id, proxy_email="second@example.com")
        db_session.add(p2)
        with pytest.raises(IntegrityError):
            await db_session.flush()

    async def test_cascade_delete_when_lot_owner_deleted(self, db_session: AsyncSession):
        """Deleting a LotOwner cascades and removes its LotProxy record."""
        _, lo = await self._setup(db_session, " Cascade")

        proxy = LotProxy(lot_owner_id=lo.id, proxy_email="cascade@example.com")
        db_session.add(proxy)
        await db_session.flush()
        proxy_id = proxy.id

        await db_session.delete(lo)
        await db_session.flush()

        result = await db_session.get(LotProxy, proxy_id)
        assert result is None

    # --- Boundary values ---

    async def test_lot_proxy_long_email(self, db_session: AsyncSession):
        """proxy_email accepts long email-like strings."""
        _, lo = await self._setup(db_session, " LongEmail")

        long_email = "a" * 200 + "@example.com"
        proxy = LotProxy(lot_owner_id=lo.id, proxy_email=long_email)
        db_session.add(proxy)
        await db_session.flush()
        assert proxy.proxy_email == long_email

    async def test_lot_proxy_tagged_email(self, db_session: AsyncSession):
        """proxy_email accepts tagged emails (user+tag@domain)."""
        _, lo = await self._setup(db_session, " Tagged")

        proxy = LotProxy(lot_owner_id=lo.id, proxy_email="proxy+tag@domain.co.nz")
        db_session.add(proxy)
        await db_session.flush()
        assert proxy.proxy_email == "proxy+tag@domain.co.nz"


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
            general_meeting_id=agm.id,
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

        s1 = SessionRecord(session_token=token, voter_email="a@a.com", building_id=b.id, general_meeting_id=agm.id, expires_at=expires)
        db_session.add(s1)
        await db_session.flush()

        s2 = SessionRecord(session_token=token, voter_email="b@b.com", building_id=b.id, general_meeting_id=agm.id, expires_at=expires)
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
            general_meeting_id=agm.id,
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

        ed = EmailDelivery(general_meeting_id=agm.id)
        db_session.add(ed)
        await db_session.flush()

        assert ed.id is not None
        assert ed.status == EmailDeliveryStatus.pending
        assert ed.total_attempts == 0
        assert ed.last_error is None
        assert ed.next_retry_at is None

    async def test_email_delivery_status_transitions(self, db_session: AsyncSession):
        _, agm = await self._setup(db_session, " Transition")

        ed = EmailDelivery(general_meeting_id=agm.id)
        db_session.add(ed)
        await db_session.flush()

        ed.status = EmailDeliveryStatus.delivered
        ed.total_attempts = 1
        await db_session.flush()
        assert ed.status == EmailDeliveryStatus.delivered

    async def test_email_delivery_failed_with_error(self, db_session: AsyncSession):
        _, agm = await self._setup(db_session, " Failed")

        ed = EmailDelivery(general_meeting_id=agm.id)
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
        ed = EmailDelivery(general_meeting_id=agm.id, next_retry_at=retry_time)
        db_session.add(ed)
        await db_session.flush()
        assert ed.next_retry_at is not None

    # --- Input validation / constraints ---

    async def test_unique_per_agm(self, db_session: AsyncSession):
        """Only one EmailDelivery per GeneralMeeting — violating raises IntegrityError."""
        _, agm = await self._setup(db_session, " UniqueAGM")

        ed1 = EmailDelivery(general_meeting_id=agm.id)
        db_session.add(ed1)
        await db_session.flush()

        ed2 = EmailDelivery(general_meeting_id=agm.id)
        db_session.add(ed2)
        with pytest.raises(IntegrityError):
            await db_session.flush()

    async def test_different_agms_allowed(self, db_session: AsyncSession):
        b = make_building("Two GeneralMeeting Email Bldg")
        db_session.add(b)
        await db_session.flush()

        agm1 = make_agm(b, title="GeneralMeeting X")
        agm2 = make_agm(b, title="GeneralMeeting Y")
        db_session.add_all([agm1, agm2])
        await db_session.flush()

        ed1 = EmailDelivery(general_meeting_id=agm1.id)
        ed2 = EmailDelivery(general_meeting_id=agm2.id)
        db_session.add_all([ed1, ed2])
        await db_session.flush()  # Should NOT raise

    # --- Boundary values ---

    async def test_email_delivery_attempt_count_zero(self, db_session: AsyncSession):
        _, agm = await self._setup(db_session, " Zero Attempts")
        ed = EmailDelivery(general_meeting_id=agm.id, total_attempts=0)
        db_session.add(ed)
        await db_session.flush()
        assert ed.total_attempts == 0

    async def test_email_delivery_attempt_count_max(self, db_session: AsyncSession):
        _, agm = await self._setup(db_session, " Max Attempts")
        ed = EmailDelivery(general_meeting_id=agm.id, total_attempts=30)
        db_session.add(ed)
        await db_session.flush()
        assert ed.total_attempts == 30
