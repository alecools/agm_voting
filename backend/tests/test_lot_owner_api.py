"""
Tests for the lot owner API endpoints (Phase 2).

Endpoints covered:
  GET  /api/server-time
  GET  /api/buildings
  GET  /api/buildings/{building_id}/general-meetings
  POST /api/auth/verify
  GET  /api/general-meeting/{agm_id}/motions
  PUT  /api/general-meeting/{agm_id}/draft
  GET  /api/general-meeting/{agm_id}/drafts
  POST /api/general-meeting/{agm_id}/submit
  GET  /api/general-meeting/{agm_id}/my-ballot

Test sections within each class:
  # --- Happy path ---
  # --- Input validation ---
  # --- Boundary values ---
  # --- State / precondition errors ---
  # --- Edge cases ---
"""
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    AuthOtp,
    GeneralMeeting,
    GeneralMeetingLotWeight,
    GeneralMeetingStatus,
    BallotSubmission,
    Building,
    FinancialPositionSnapshot,
    LotOwner,
    Motion,
    MotionType,
    SessionRecord,
    Vote,
    VoteChoice,
    VoteStatus,
)
from app.models.lot_owner_email import LotOwnerEmail

# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------


def utcnow() -> datetime:
    return datetime.now(UTC)


def make_building(name: str = "Test Tower", email: str = "mgr@example.com") -> Building:
    return Building(name=name, manager_email=email)


def make_agm(building: Building, status: GeneralMeetingStatus = GeneralMeetingStatus.open, title: str = "GeneralMeeting 2026") -> GeneralMeeting:
    now = utcnow()
    return GeneralMeeting(
        building_id=building.id,
        title=title,
        status=status,
        meeting_at=now - timedelta(hours=1),  # past so meeting is effectively open
        voting_closes_at=now + timedelta(days=2),
    )


def make_lot_owner(
    building: Building,
    lot_number: str = "1A",
    entitlement: int = 100,
) -> LotOwner:
    return LotOwner(
        building_id=building.id,
        lot_number=lot_number,
        unit_entitlement=entitlement,
    )


async def add_email(db: AsyncSession, lo: LotOwner, email: str) -> LotOwnerEmail:
    lo_email = LotOwnerEmail(lot_owner_id=lo.id, email=email)
    db.add(lo_email)
    await db.flush()
    return lo_email


def make_motion(agm: GeneralMeeting, title: str = "Motion 1", order_index: int = 1) -> Motion:
    return Motion(general_meeting_id=agm.id, title=title, order_index=order_index)


async def make_otp(db: AsyncSession, email: str, meeting_id: uuid.UUID) -> str:
    """Insert a valid AuthOtp row and return the code."""
    code = "TESTCODE"
    otp = AuthOtp(
        email=email,
        meeting_id=meeting_id,
        code=code,
        expires_at=datetime.now(UTC) + timedelta(minutes=5),
    )
    db.add(otp)
    await db.flush()
    return code


async def make_session(
    db: AsyncSession,
    voter_email: str,
    building_id: uuid.UUID,
    general_meeting_id: uuid.UUID,
    expired: bool = False,
) -> str:
    import secrets

    token = secrets.token_urlsafe(32)
    now = utcnow()
    expires_at = now - timedelta(hours=1) if expired else now + timedelta(hours=24)
    session = SessionRecord(
        session_token=token,
        voter_email=voter_email,
        building_id=building_id,
        general_meeting_id=general_meeting_id,
        expires_at=expires_at,
    )
    db.add(session)
    await db.flush()
    return token


@pytest.fixture
def transport(app):
    return ASGITransport(app=app)


# ---------------------------------------------------------------------------
# GET /api/server-time
# ---------------------------------------------------------------------------


class TestServerTime:
    # --- Happy path ---

    async def test_returns_utc_string(self, transport):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/server-time")
        assert response.status_code == 200
        data = response.json()
        assert "utc" in data
        # Should parse as ISO datetime ending in Z
        utc_str = data["utc"]
        assert utc_str.endswith("Z")
        # Should be a valid datetime
        parsed = datetime.strptime(utc_str, "%Y-%m-%dT%H:%M:%SZ")
        assert parsed is not None

    async def test_time_is_recent(self, transport):
        before = utcnow()
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/server-time")
        after = utcnow()
        utc_str = response.json()["utc"]
        parsed = datetime.strptime(utc_str, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
        assert before.replace(microsecond=0) <= parsed <= after.replace(microsecond=0) + timedelta(seconds=1)


# ---------------------------------------------------------------------------
# GET /api/buildings
# ---------------------------------------------------------------------------


class TestListBuildings:
    # --- Happy path ---

    async def test_returns_buildings_with_agms(self, transport, db_session: AsyncSession):
        b = make_building("Tower With GeneralMeeting")
        db_session.add(b)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/buildings")

        assert response.status_code == 200
        names = [item["name"] for item in response.json()]
        assert "Tower With GeneralMeeting" in names

    async def test_returns_buildings_without_agms(self, transport, db_session: AsyncSession):
        """Buildings without AGMs appear (GeneralMeeting list will be empty)."""
        b = make_building("No GeneralMeeting Tower")
        db_session.add(b)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/buildings")

        names = [item["name"] for item in response.json()]
        assert "No GeneralMeeting Tower" in names

    async def test_building_fields(self, transport, db_session: AsyncSession):
        b = make_building("Field Check Tower")
        db_session.add(b)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/buildings")

        buildings = response.json()
        matching = [item for item in buildings if item["name"] == "Field Check Tower"]
        assert len(matching) == 1
        item = matching[0]
        assert "id" in item
        assert "name" in item

    async def test_empty_buildings_returns_empty_list(self, transport):
        """When no buildings exist, returns empty list."""
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/buildings")
        assert response.status_code == 200
        assert isinstance(response.json(), list)


# ---------------------------------------------------------------------------
# GET /api/buildings/{building_id}/general-meetings
# ---------------------------------------------------------------------------


class TestListAGMs:
    # --- Happy path ---

    async def test_returns_agms_for_building(self, transport, db_session: AsyncSession):
        b = make_building("GeneralMeeting List Building")
        db_session.add(b)
        await db_session.flush()
        agm = make_agm(b, title="Target GeneralMeeting")
        db_session.add(agm)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/buildings/{b.id}/general-meetings")

        assert response.status_code == 200
        data = response.json()
        titles = [a["title"] for a in data]
        assert "Target GeneralMeeting" in titles

    async def test_agm_fields_present(self, transport, db_session: AsyncSession):
        b = make_building("GeneralMeeting Fields Building")
        db_session.add(b)
        await db_session.flush()
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/buildings/{b.id}/general-meetings")

        agm_data = response.json()[0]
        assert "id" in agm_data
        assert "title" in agm_data
        assert "status" in agm_data
        assert "meeting_at" in agm_data
        assert "voting_closes_at" in agm_data

    async def test_does_not_return_other_buildings_agms(self, transport, db_session: AsyncSession):
        b1 = make_building("Building One")
        b2 = make_building("Building Two")
        db_session.add_all([b1, b2])
        await db_session.flush()
        agm1 = make_agm(b1, title="B1 GeneralMeeting")
        agm2 = make_agm(b2, title="B2 GeneralMeeting")
        db_session.add_all([agm1, agm2])
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/buildings/{b1.id}/general-meetings")

        titles = [a["title"] for a in response.json()]
        assert "B1 GeneralMeeting" in titles
        assert "B2 GeneralMeeting" not in titles

    # --- State / precondition errors ---

    async def test_unknown_building_returns_404(self, transport):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/buildings/{uuid.uuid4()}/general-meetings")
        assert response.status_code == 404

    async def test_no_agms_returns_empty_list(self, transport, db_session: AsyncSession):
        b = make_building("No GeneralMeeting Building 2")
        db_session.add(b)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/buildings/{b.id}/general-meetings")

        assert response.status_code == 200
        assert response.json() == []


# ---------------------------------------------------------------------------
# POST /api/auth/verify
# ---------------------------------------------------------------------------


class TestAuthVerify:
    # --- Happy path ---

    async def test_valid_credentials_returns_200(self, transport, db_session: AsyncSession):
        b = make_building("Auth Happy Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="A1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "voter@auth.com")
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        code = await make_otp(db_session, "voter@auth.com", agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "email": "voter@auth.com",
                "general_meeting_id": str(agm.id),
                "code": code,
            })

        assert response.status_code == 200
        data = response.json()
        assert data["voter_email"] == "voter@auth.com"
        assert "lots" in data
        assert len(data["lots"]) == 1
        assert data["lots"][0]["already_submitted"] is False

    async def test_sets_session_cookie(self, transport, db_session: AsyncSession):
        b = make_building("Cookie Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="B2")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "cookie@auth.com")
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        code = await make_otp(db_session, "cookie@auth.com", agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "email": "cookie@auth.com",
                "general_meeting_id": str(agm.id),
                "code": code,
            })

        assert "meeting_session" in response.cookies

    async def test_already_submitted_flag(self, transport, db_session: AsyncSession):
        b = make_building("Already Submitted Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="C3")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "submitted@auth.com")
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        # Pre-existing ballot submission
        sub = BallotSubmission(general_meeting_id=agm.id, lot_owner_id=lo.id, voter_email="submitted@auth.com")
        db_session.add(sub)
        code = await make_otp(db_session, "submitted@auth.com", agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "email": "submitted@auth.com",
                "general_meeting_id": str(agm.id),
                "code": code,
            })

        assert response.status_code == 200
        data = response.json()
        assert data["lots"][0]["already_submitted"] is True

    async def test_lot_info_in_response(self, transport, db_session: AsyncSession):
        """Response lots array contains lot_owner_id, lot_number, financial_position."""
        b = make_building("Lot Info Auth Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="LI1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "lotinfo@auth.com")
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        code = await make_otp(db_session, "lotinfo@auth.com", agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "email": "lotinfo@auth.com",
                "general_meeting_id": str(agm.id),
                "code": code,
            })

        lot = response.json()["lots"][0]
        assert lot["lot_owner_id"] == str(lo.id)
        assert lot["lot_number"] == "LI1"
        assert "financial_position" in lot
        assert "already_submitted" in lot

    # --- Input validation ---

    async def test_wrong_email_returns_401(self, transport, db_session: AsyncSession):
        b = make_building("Wrong Email Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="D4")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "correct@auth.com")
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        # Insert OTP for wrong email — will pass OTP check but fail lot lookup
        code = await make_otp(db_session, "wrong@auth.com", agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "email": "wrong@auth.com",
                "general_meeting_id": str(agm.id),
                "code": code,
            })

        assert response.status_code == 401

    async def test_empty_email_returns_422(self, transport, db_session: AsyncSession):
        b = make_building("Empty Email Building")
        db_session.add(b)
        await db_session.flush()
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "email": "  ",
                "general_meeting_id": str(agm.id),
                "code": "TESTCODE",
            })

        assert response.status_code == 422

    async def test_invalid_general_meeting_uuid_returns_422(self, transport):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "email": "x@y.com",
                "general_meeting_id": "not-a-uuid",
                "code": "TESTCODE",
            })
        assert response.status_code == 422

    async def test_missing_fields_returns_422(self, transport):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "email": "x@y.com",
            })
        assert response.status_code == 422

    # --- State / precondition errors ---

    async def test_email_not_in_meeting_building_returns_401(self, transport, db_session: AsyncSession):
        """Voter email exists in b1 but the meeting belongs to b2 — backend derives
        building_id from the meeting (b2) and can't find the email there, so 401."""
        b1 = make_building("Building One Auth")
        b2 = make_building("Building Two Auth")
        db_session.add_all([b1, b2])
        await db_session.flush()

        lo = make_lot_owner(b1, lot_number="E5")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "e5@auth.com")
        agm_b2 = make_agm(b2)  # GeneralMeeting belongs to b2
        db_session.add(agm_b2)
        await db_session.flush()
        code = await make_otp(db_session, "e5@auth.com", agm_b2.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "email": "e5@auth.com",
                "general_meeting_id": str(agm_b2.id),   # GeneralMeeting is in b2
                "code": code,
            })

        # Email exists only in b1; meeting is in b2 → email not found in b2 → 401
        assert response.status_code == 401

    async def test_closed_agm_returns_200_with_closed_status(self, transport, db_session: AsyncSession):
        """Closed AGMs allow auth so lot owners can view their submission."""
        b = make_building("Closed Auth Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="F6")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "f6@auth.com")
        agm = make_agm(b, status=GeneralMeetingStatus.closed)
        agm.closed_at = utcnow()
        db_session.add(agm)
        await db_session.flush()
        code = await make_otp(db_session, "f6@auth.com", agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "email": "f6@auth.com",
                "general_meeting_id": str(agm.id),
                "code": code,
            })

        assert response.status_code == 200
        data = response.json()
        assert data["agm_status"] == "closed"
        assert data["lots"][0]["already_submitted"] is False

    async def test_open_agm_returns_open_status(self, transport, db_session: AsyncSession):
        """Open GeneralMeeting (meeting_at in the past, voting still open) returns agm_status=open."""
        b = make_building("Open Status Auth Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="F7")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "f7@auth.com")
        # Use a meeting whose start time has already passed but voting is still open,
        # so get_effective_status returns "open".
        now = utcnow()
        agm = GeneralMeeting(
            building_id=b.id,
            title="GeneralMeeting 2026",
            status=GeneralMeetingStatus.open,
            meeting_at=now - timedelta(hours=1),
            voting_closes_at=now + timedelta(days=2),
        )
        db_session.add(agm)
        await db_session.flush()
        code = await make_otp(db_session, "f7@auth.com", agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "email": "f7@auth.com",
                "general_meeting_id": str(agm.id),
                "code": code,
            })

        assert response.status_code == 200
        assert response.json()["agm_status"] == "open"

    async def test_email_in_different_building_returns_401(self, transport, db_session: AsyncSession):
        b1 = make_building("Lot Building One")
        b2 = make_building("Lot Building Two")
        db_session.add_all([b1, b2])
        await db_session.flush()

        # Email belongs to b1 only
        lo = make_lot_owner(b1, lot_number="G7")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "g7@auth.com")
        agm = make_agm(b2)  # GeneralMeeting in b2
        db_session.add(agm)
        await db_session.flush()
        code = await make_otp(db_session, "g7@auth.com", agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "email": "g7@auth.com",
                "general_meeting_id": str(agm.id),  # GeneralMeeting is in b2; email only in b1
                "code": code,
            })

        assert response.status_code == 401

    # --- Edge cases ---

    async def test_multi_lot_owner_same_email_returns_multiple_lots(self, transport, db_session: AsyncSession):
        """Two lots sharing the same email — response lots array contains both."""
        b = make_building("Multi Lot Auth Building")
        db_session.add(b)
        await db_session.flush()

        lo1 = make_lot_owner(b, lot_number="ML1")
        lo2 = make_lot_owner(b, lot_number="ML2")
        db_session.add_all([lo1, lo2])
        await db_session.flush()
        await add_email(db_session, lo1, "multi@auth.com")
        await add_email(db_session, lo2, "multi@auth.com")
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        code = await make_otp(db_session, "multi@auth.com", agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            r = await client.post("/api/auth/verify", json={
                "email": "multi@auth.com",
                "general_meeting_id": str(agm.id),
                "code": code,
            })
        assert r.status_code == 200
        data = r.json()
        lot_numbers = {lot["lot_number"] for lot in data["lots"]}
        assert "ML1" in lot_numbers
        assert "ML2" in lot_numbers

    async def test_email_with_plus_tag_authenticates(self, transport, db_session: AsyncSession):
        """Email with + tag is treated as a distinct email address."""
        b = make_building("Plus Tag Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="PT1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "user+tag@domain.co")
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        code = await make_otp(db_session, "user+tag@domain.co", agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "email": "user+tag@domain.co",
                "general_meeting_id": str(agm.id),
                "code": code,
            })

        assert response.status_code == 200


# ---------------------------------------------------------------------------
# GET /api/general-meeting/{agm_id}/motions
# ---------------------------------------------------------------------------


class TestListMotions:
    # --- Happy path ---

    async def test_returns_all_motions(self, transport, db_session: AsyncSession):
        b = make_building("Motion List Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="M1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "motion@test.com")
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m1 = Motion(general_meeting_id=agm.id, title="Motion One", order_index=1)
        m2 = Motion(general_meeting_id=agm.id, title="Motion Two", order_index=2)
        m3 = Motion(general_meeting_id=agm.id, title="Motion Three", order_index=3)
        db_session.add_all([m1, m2, m3])
        await db_session.flush()

        token = await make_session(db_session, "motion@test.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/general-meeting/{agm.id}/motions",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200
        assert len(response.json()) == 3

    async def test_motions_fields_present(self, transport, db_session: AsyncSession):
        b = make_building("Motion Fields Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="MF1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "mfields@test.com")
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m = Motion(general_meeting_id=agm.id, title="Fields Motion", order_index=1, description="desc")
        db_session.add(m)
        await db_session.flush()

        token = await make_session(db_session, "mfields@test.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/general-meeting/{agm.id}/motions",
                headers={"Authorization": f"Bearer {token}"},
            )

        motion = response.json()[0]
        assert "id" in motion
        assert "title" in motion
        assert "description" in motion
        assert "order_index" in motion

    async def test_motions_ordered_by_order_index(self, transport, db_session: AsyncSession):
        b = make_building("Motion Order Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="MO1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "order@motions.com")
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        # Add in reverse order
        m3 = Motion(general_meeting_id=agm.id, title="Third", order_index=3)
        m1 = Motion(general_meeting_id=agm.id, title="First", order_index=1)
        m2 = Motion(general_meeting_id=agm.id, title="Second", order_index=2)
        db_session.add_all([m3, m1, m2])
        await db_session.flush()

        token = await make_session(db_session, "order@motions.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/general-meeting/{agm.id}/motions",
                headers={"Authorization": f"Bearer {token}"},
            )

        titles = [m["title"] for m in response.json()]
        assert titles == ["First", "Second", "Third"]

    async def test_empty_motions_returns_empty_list(self, transport, db_session: AsyncSession):
        b = make_building("No Motion Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="DA1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "diff@agm.com")
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        token = await make_session(db_session, "diff@agm.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/general-meeting/{agm.id}/motions",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.json() == []

    # --- State / precondition errors ---

    async def test_expired_session_returns_401(self, transport, db_session: AsyncSession):
        b = make_building("Expired Session Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="EXP1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "exp@session.com")
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        token = await make_session(db_session, "exp@session.com", b.id, agm.id, expired=True)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/general-meeting/{agm.id}/motions",
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 401

    async def test_no_session_returns_401(self, transport):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/general-meeting/{uuid.uuid4()}/motions")
        assert response.status_code == 401

    async def test_wrong_token_returns_401(self, transport, db_session: AsyncSession):
        b = make_building("Not Found Session Building")
        db_session.add(b)
        await db_session.flush()
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/general-meeting/{agm.id}/motions",
                headers={"Authorization": "Bearer notarealtoken"},
            )
        assert response.status_code == 401

    # --- Edge cases ---

    async def test_session_via_cookie(self, transport, db_session: AsyncSession):
        b = make_building("Cookie Session Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="CK1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "cookie@session.com")
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m = Motion(general_meeting_id=agm.id, title="Cookie Motion", order_index=1)
        db_session.add(m)
        await db_session.flush()

        token = await make_session(db_session, "cookie@session.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/general-meeting/{agm.id}/motions",
                cookies={"meeting_session": token},
            )
        assert response.status_code == 200


# ---------------------------------------------------------------------------
# PUT /api/general-meeting/{agm_id}/draft
# ---------------------------------------------------------------------------


class TestSaveDraft:
    async def _setup(self, db_session: AsyncSession, lot_number="DY1", email="draft@yes.com"):
        b = make_building(f"Draft Building {lot_number}")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number=lot_number)
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, email)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m = Motion(general_meeting_id=agm.id, title="Draft Motion", order_index=1)
        db_session.add(m)
        await db_session.flush()
        return b, lo, agm, m, email

    # --- Happy path ---

    async def test_save_yes(self, transport, db_session: AsyncSession):
        b, lo, agm, m, email = await self._setup(db_session, "DY1", "draft@yes.com")
        token = await make_session(db_session, email, b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.put(
                f"/api/general-meeting/{agm.id}/draft",
                json={"motion_id": str(m.id), "choice": "yes", "lot_owner_id": str(lo.id)},
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200
        assert response.json()["saved"] is True

    async def test_save_no(self, transport, db_session: AsyncSession):
        b, lo, agm, m, email = await self._setup(db_session, "DN1", "draft@no.com")
        token = await make_session(db_session, email, b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.put(
                f"/api/general-meeting/{agm.id}/draft",
                json={"motion_id": str(m.id), "choice": "no", "lot_owner_id": str(lo.id)},
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200

    async def test_save_abstained(self, transport, db_session: AsyncSession):
        b, lo, agm, m, email = await self._setup(db_session, "DA1", "draft@abstain.com")
        token = await make_session(db_session, email, b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.put(
                f"/api/general-meeting/{agm.id}/draft",
                json={"motion_id": str(m.id), "choice": "abstained", "lot_owner_id": str(lo.id)},
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200

    async def test_null_choice_deletes_draft(self, transport, db_session: AsyncSession):
        b, lo, agm, m, email = await self._setup(db_session, "NULL1", "draft@null.com")
        token = await make_session(db_session, email, b.id, agm.id)

        # First save a draft
        v = Vote(general_meeting_id=agm.id, motion_id=m.id, voter_email=email, lot_owner_id=lo.id, choice=VoteChoice.yes, status=VoteStatus.draft)
        db_session.add(v)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.put(
                f"/api/general-meeting/{agm.id}/draft",
                json={"motion_id": str(m.id), "choice": None, "lot_owner_id": str(lo.id)},
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200

    async def test_upsert_updates_existing_draft(self, transport, db_session: AsyncSession):
        b, lo, agm, m, email = await self._setup(db_session, "UP1", "upsert@draft.com")
        token = await make_session(db_session, email, b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            # Save yes
            await client.put(
                f"/api/general-meeting/{agm.id}/draft",
                json={"motion_id": str(m.id), "choice": "yes", "lot_owner_id": str(lo.id)},
                headers={"Authorization": f"Bearer {token}"},
            )
            # Update to no
            response = await client.put(
                f"/api/general-meeting/{agm.id}/draft",
                json={"motion_id": str(m.id), "choice": "no", "lot_owner_id": str(lo.id)},
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200

    # --- Input validation ---

    async def test_cross_agm_motion_returns_422(self, transport, db_session: AsyncSession):
        b, lo, agm, m, email = await self._setup(db_session, "CA1", "cross@draft.com")
        token = await make_session(db_session, email, b.id, agm.id)

        # Create a motion for a different GeneralMeeting
        b2 = make_building("Cross GeneralMeeting Building")
        db_session.add(b2)
        await db_session.flush()
        agm2 = make_agm(b2)
        db_session.add(agm2)
        await db_session.flush()
        m_other = Motion(general_meeting_id=agm2.id, title="Other GeneralMeeting Motion", order_index=1)
        db_session.add(m_other)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.put(
                f"/api/general-meeting/{agm.id}/draft",
                json={"motion_id": str(m_other.id), "choice": "yes"},
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 422

    async def test_no_session_returns_401(self, transport):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.put(
                f"/api/general-meeting/{uuid.uuid4()}/draft",
                json={"motion_id": str(uuid.uuid4()), "choice": "yes"},
            )
        assert response.status_code == 401

    # --- State / precondition errors ---

    async def test_already_submitted_returns_409(self, transport, db_session: AsyncSession):
        b, lo, agm, m, email = await self._setup(db_session, "AS1", "asub@draft.com")
        sub = BallotSubmission(general_meeting_id=agm.id, lot_owner_id=lo.id, voter_email=email)
        db_session.add(sub)
        token = await make_session(db_session, email, b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.put(
                f"/api/general-meeting/{agm.id}/draft",
                json={"motion_id": str(m.id), "choice": "yes", "lot_owner_id": str(lo.id)},
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 409

    async def test_closed_agm_returns_403(self, transport, db_session: AsyncSession):
        b = make_building("Closed Draft Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="CL1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "closed@draft.com")
        agm = make_agm(b, status=GeneralMeetingStatus.closed)
        agm.closed_at = utcnow()
        db_session.add(agm)
        await db_session.flush()
        m = Motion(general_meeting_id=agm.id, title="Closed Motion", order_index=1)
        db_session.add(m)
        await db_session.flush()

        token = await make_session(db_session, "closed@draft.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.put(
                f"/api/general-meeting/{agm.id}/draft",
                json={"motion_id": str(m.id), "choice": "yes"},
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 403


# ---------------------------------------------------------------------------
# GET /api/general-meeting/{agm_id}/drafts
# ---------------------------------------------------------------------------


class TestGetDrafts:
    # --- Happy path ---

    async def test_returns_saved_drafts(self, transport, db_session: AsyncSession):
        b = make_building("Get Drafts Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="GD1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "get@drafts.com")
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m1 = Motion(general_meeting_id=agm.id, title="M1", order_index=1)
        m2 = Motion(general_meeting_id=agm.id, title="M2", order_index=2)
        db_session.add_all([m1, m2])
        await db_session.flush()

        v1 = Vote(general_meeting_id=agm.id, motion_id=m1.id, voter_email="get@drafts.com", lot_owner_id=lo.id, choice=VoteChoice.yes, status=VoteStatus.draft)
        v2 = Vote(general_meeting_id=agm.id, motion_id=m2.id, voter_email="get@drafts.com", lot_owner_id=lo.id, choice=VoteChoice.no, status=VoteStatus.draft)
        db_session.add_all([v1, v2])
        token = await make_session(db_session, "get@drafts.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/general-meeting/{agm.id}/drafts",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200
        drafts = response.json()["drafts"]
        assert len(drafts) == 2
        choices = {d["choice"] for d in drafts}
        assert "yes" in choices
        assert "no" in choices

    async def test_returns_empty_when_no_drafts(self, transport, db_session: AsyncSession):
        b = make_building("Empty Drafts Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="ED1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "empty@drafts.com")
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        token = await make_session(db_session, "empty@drafts.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/general-meeting/{agm.id}/drafts",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.json()["drafts"] == []

    async def test_excludes_null_choice_drafts(self, transport, db_session: AsyncSession):
        """Drafts with null choice are not returned."""
        b = make_building("Null Draft Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="ND1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "null@drafts.com")
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m = Motion(general_meeting_id=agm.id, title="Null Draft Motion", order_index=1)
        db_session.add(m)
        await db_session.flush()

        v = Vote(general_meeting_id=agm.id, motion_id=m.id, voter_email="null@drafts.com", lot_owner_id=lo.id, choice=None, status=VoteStatus.draft)
        db_session.add(v)
        token = await make_session(db_session, "null@drafts.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/general-meeting/{agm.id}/drafts",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.json()["drafts"] == []

    # --- Input validation ---

    async def test_no_session_returns_401(self, transport):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/general-meeting/{uuid.uuid4()}/drafts")
        assert response.status_code == 401


# ---------------------------------------------------------------------------
# POST /api/general-meeting/{agm_id}/submit
# ---------------------------------------------------------------------------


class TestSubmitBallot:
    async def _setup(self, db_session: AsyncSession, lot_number="SA1", email="submit@all.com"):
        b = make_building(f"Submit Building {lot_number}")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number=lot_number)
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, email)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m1 = Motion(general_meeting_id=agm.id, title="M1", order_index=1)
        m2 = Motion(general_meeting_id=agm.id, title="M2", order_index=2)
        db_session.add_all([m1, m2])
        await db_session.flush()
        return b, lo, agm, m1, m2, email

    # --- Happy path ---

    async def test_all_motions_answered_submitted(self, transport, db_session: AsyncSession):
        b, lo, agm, m1, m2, email = await self._setup(db_session, "SA1", "submit@all.com")

        token = await make_session(db_session, email, b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                f"/api/general-meeting/{agm.id}/submit",
                json={
                    "lot_owner_ids": [str(lo.id)],
                    "votes": [
                        {"motion_id": str(m1.id), "choice": "yes"},
                        {"motion_id": str(m2.id), "choice": "no"},
                    ],
                },
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200
        data = response.json()
        assert data["submitted"] is True
        assert len(data["lots"]) == 1
        votes = data["lots"][0]["votes"]
        assert len(votes) == 2
        choices = {v["choice"] for v in votes}
        assert "yes" in choices
        assert "no" in choices

    async def test_partial_motions_unanswered_become_abstained(self, transport, db_session: AsyncSession):
        b, lo, agm, m1, m2, email = await self._setup(db_session, "SP1", "submit@partial.com")

        token = await make_session(db_session, email, b.id, agm.id)
        await db_session.commit()

        # Only m1 has an inline vote — m2 is unanswered and becomes abstained
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                f"/api/general-meeting/{agm.id}/submit",
                json={
                    "lot_owner_ids": [str(lo.id)],
                    "votes": [{"motion_id": str(m1.id), "choice": "yes"}],
                },
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200
        votes_by_title = {v["motion_title"]: v["choice"] for v in response.json()["lots"][0]["votes"]}
        assert votes_by_title["M1"] == "yes"
        assert votes_by_title["M2"] == "abstained"

    async def test_no_drafts_all_motions_abstained(self, transport, db_session: AsyncSession):
        b, lo, agm, m1, m2, email = await self._setup(db_session, "SN1", "submit@none.com")
        token = await make_session(db_session, email, b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                f"/api/general-meeting/{agm.id}/submit",
                json={"lot_owner_ids": [str(lo.id)]},
                headers={"Authorization": f"Bearer {token}"},
            )

        data = response.json()
        for vote in data["lots"][0]["votes"]:
            assert vote["choice"] == "abstained"

    # --- Input validation ---

    async def test_no_session_returns_401(self, transport):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                f"/api/general-meeting/{uuid.uuid4()}/submit",
                json={"lot_owner_ids": [str(uuid.uuid4())]},
            )
        assert response.status_code == 401

    async def test_empty_lot_owner_ids_returns_422(self, transport, db_session: AsyncSession):
        b, lo, agm, m1, m2, email = await self._setup(db_session, "ELI1", "empty@lotids.com")
        token = await make_session(db_session, email, b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                f"/api/general-meeting/{agm.id}/submit",
                json={"lot_owner_ids": []},
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 422

    # --- State / precondition errors ---

    async def test_closed_agm_returns_403(self, transport, db_session: AsyncSession):
        b = make_building("Submit Closed Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="SC1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "submit@closed.com")
        agm = make_agm(b, status=GeneralMeetingStatus.closed)
        agm.closed_at = utcnow()
        db_session.add(agm)
        await db_session.flush()

        token = await make_session(db_session, "submit@closed.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                f"/api/general-meeting/{agm.id}/submit",
                json={"lot_owner_ids": [str(lo.id)]},
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 403

    async def test_already_submitted_returns_409(self, transport, db_session: AsyncSession):
        b, lo, agm, m1, m2, email = await self._setup(db_session, "ASS1", "already@submit.com")
        sub = BallotSubmission(general_meeting_id=agm.id, lot_owner_id=lo.id, voter_email=email)
        db_session.add(sub)
        token = await make_session(db_session, email, b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                f"/api/general-meeting/{agm.id}/submit",
                json={"lot_owner_ids": [str(lo.id)]},
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 409

    async def test_lot_not_belonging_to_voter_returns_403(self, transport, db_session: AsyncSession):
        """Submitting on behalf of a lot with a different email → 403."""
        b = make_building("Forbidden Submit Building")
        db_session.add(b)
        await db_session.flush()

        lo_mine = make_lot_owner(b, lot_number="NC1")
        lo_other = make_lot_owner(b, lot_number="NC2")
        db_session.add_all([lo_mine, lo_other])
        await db_session.flush()
        await add_email(db_session, lo_mine, "null@choice.com")
        await add_email(db_session, lo_other, "other@choice.com")

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m = Motion(general_meeting_id=agm.id, title="NM", order_index=1)
        db_session.add(m)
        await db_session.flush()

        token = await make_session(db_session, "null@choice.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                f"/api/general-meeting/{agm.id}/submit",
                json={"lot_owner_ids": [str(lo_other.id)]},
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 403

    # --- Edge cases ---

    async def test_concurrent_submit_second_returns_409(self, transport, db_session: AsyncSession):
        """If a ballot was submitted between check and submit, return 409."""
        b, lo, agm, m1, m2, email = await self._setup(db_session, "CON1", "concurrent@submit.com")
        token = await make_session(db_session, email, b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            # First submit — succeeds
            r1 = await client.post(
                f"/api/general-meeting/{agm.id}/submit",
                json={"lot_owner_ids": [str(lo.id)]},
                headers={"Authorization": f"Bearer {token}"},
            )
            assert r1.status_code == 200

            # Second submit — should fail
            r2 = await client.post(
                f"/api/general-meeting/{agm.id}/submit",
                json={"lot_owner_ids": [str(lo.id)]},
                headers={"Authorization": f"Bearer {token}"},
            )
        assert r2.status_code == 409


# ---------------------------------------------------------------------------
# GET /api/general-meeting/{agm_id}/my-ballot
# ---------------------------------------------------------------------------


class TestMyBallot:
    # --- Happy path ---

    async def test_returns_ballot_after_submit(self, transport, db_session: AsyncSession):
        b = make_building("My Ballot Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="MB1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "my@ballot.com")
        agm = make_agm(b, title="My Ballot GeneralMeeting")
        db_session.add(agm)
        await db_session.flush()
        m1 = Motion(general_meeting_id=agm.id, title="Motion 1", order_index=1)
        m2 = Motion(general_meeting_id=agm.id, title="Motion 2", order_index=2)
        db_session.add_all([m1, m2])
        await db_session.flush()

        # Submitted votes
        v1 = Vote(general_meeting_id=agm.id, motion_id=m1.id, voter_email="my@ballot.com", lot_owner_id=lo.id, choice=VoteChoice.yes, status=VoteStatus.submitted)
        v2 = Vote(general_meeting_id=agm.id, motion_id=m2.id, voter_email="my@ballot.com", lot_owner_id=lo.id, choice=VoteChoice.abstained, status=VoteStatus.submitted)
        db_session.add_all([v1, v2])
        await db_session.flush()

        sub = BallotSubmission(general_meeting_id=agm.id, lot_owner_id=lo.id, voter_email="my@ballot.com")
        db_session.add(sub)
        token = await make_session(db_session, "my@ballot.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/general-meeting/{agm.id}/my-ballot",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200
        data = response.json()
        assert data["voter_email"] == "my@ballot.com"
        assert data["meeting_title"] == "My Ballot GeneralMeeting"
        assert data["building_name"] == "My Ballot Building"
        assert len(data["submitted_lots"]) == 1
        assert len(data["submitted_lots"][0]["votes"]) == 2

    async def test_ballot_ordered_by_motion_order_index(self, transport, db_session: AsyncSession):
        b = make_building("Ordered Ballot Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="OB1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "ordered@ballot.com")
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m3 = Motion(general_meeting_id=agm.id, title="Third", order_index=3)
        m1 = Motion(general_meeting_id=agm.id, title="First", order_index=1)
        m2 = Motion(general_meeting_id=agm.id, title="Second", order_index=2)
        db_session.add_all([m3, m1, m2])
        await db_session.flush()

        for m in [m1, m2, m3]:
            db_session.add(Vote(general_meeting_id=agm.id, motion_id=m.id, voter_email="ordered@ballot.com", lot_owner_id=lo.id, choice=VoteChoice.yes, status=VoteStatus.submitted))
        sub = BallotSubmission(general_meeting_id=agm.id, lot_owner_id=lo.id, voter_email="ordered@ballot.com")
        db_session.add(sub)
        token = await make_session(db_session, "ordered@ballot.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/general-meeting/{agm.id}/my-ballot",
                headers={"Authorization": f"Bearer {token}"},
            )

        data = response.json()
        votes = data["submitted_lots"][0]["votes"]
        assert votes[0]["motion_title"] == "First"
        assert votes[1]["motion_title"] == "Second"
        assert votes[2]["motion_title"] == "Third"

    # --- Input validation ---

    async def test_no_session_returns_401(self, transport):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/general-meeting/{uuid.uuid4()}/my-ballot")
        assert response.status_code == 401

    # --- State / precondition errors ---

    async def test_no_submitted_ballot_returns_404(self, transport, db_session: AsyncSession):
        b = make_building("No Ballot Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="NB1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "noballot@test.com")
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        token = await make_session(db_session, "noballot@test.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/general-meeting/{agm.id}/my-ballot",
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 404

    # --- Edge cases ---

    async def test_ballot_fields_include_order_index(self, transport, db_session: AsyncSession):
        b = make_building("Order Index Ballot Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="OI1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "orderidx@ballot.com")
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m = Motion(general_meeting_id=agm.id, title="Test Motion", order_index=5)
        db_session.add(m)
        await db_session.flush()

        v = Vote(general_meeting_id=agm.id, motion_id=m.id, voter_email="orderidx@ballot.com", lot_owner_id=lo.id, choice=VoteChoice.no, status=VoteStatus.submitted)
        db_session.add(v)
        sub = BallotSubmission(general_meeting_id=agm.id, lot_owner_id=lo.id, voter_email="orderidx@ballot.com")
        db_session.add(sub)
        token = await make_session(db_session, "orderidx@ballot.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/general-meeting/{agm.id}/my-ballot",
                headers={"Authorization": f"Bearer {token}"},
            )

        vote_item = response.json()["submitted_lots"][0]["votes"][0]
        assert vote_item["order_index"] == 5
        assert vote_item["choice"] == "no"

    async def test_remaining_lot_owner_ids_populated(self, transport, db_session: AsyncSession):
        """remaining_lot_owner_ids includes unsubmitted lots for the same voter_email."""
        b = make_building("Remaining Lots Building")
        db_session.add(b)
        await db_session.flush()
        lo1 = make_lot_owner(b, lot_number="RL1")
        lo2 = make_lot_owner(b, lot_number="RL2")
        db_session.add_all([lo1, lo2])
        await db_session.flush()
        await add_email(db_session, lo1, "remaining@lots.com")
        await add_email(db_session, lo2, "remaining@lots.com")

        agm = make_agm(b, title="Remaining Lots GeneralMeeting")
        db_session.add(agm)
        await db_session.flush()
        m = Motion(general_meeting_id=agm.id, title="RL Motion", order_index=1)
        db_session.add(m)
        await db_session.flush()

        # Submit ballot for lo1 only
        v = Vote(general_meeting_id=agm.id, motion_id=m.id, voter_email="remaining@lots.com", lot_owner_id=lo1.id, choice=VoteChoice.yes, status=VoteStatus.submitted)
        db_session.add(v)
        sub = BallotSubmission(general_meeting_id=agm.id, lot_owner_id=lo1.id, voter_email="remaining@lots.com")
        db_session.add(sub)
        token = await make_session(db_session, "remaining@lots.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/general-meeting/{agm.id}/my-ballot",
                headers={"Authorization": f"Bearer {token}"},
            )

        data = response.json()
        assert str(lo2.id) in [str(lid) for lid in data["remaining_lot_owner_ids"]]


# ---------------------------------------------------------------------------
# Integration: full lot owner journey
# ---------------------------------------------------------------------------


class TestFullJourney:
    """End-to-end lot owner flow: auth → drafts → submit → my-ballot."""

    async def test_full_journey(self, transport, db_session: AsyncSession):
        b = make_building("Full Journey Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="FJ1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "journey@full.com")
        agm = make_agm(b, title="Full Journey GeneralMeeting")
        db_session.add(agm)
        await db_session.flush()
        m1 = Motion(general_meeting_id=agm.id, title="Motion Alpha", order_index=1)
        m2 = Motion(general_meeting_id=agm.id, title="Motion Beta", order_index=2)
        db_session.add_all([m1, m2])
        await db_session.flush()
        otp_code = await make_otp(db_session, "journey@full.com", agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            # 1. Authenticate
            auth_resp = await client.post("/api/auth/verify", json={
                "email": "journey@full.com",
                "general_meeting_id": str(agm.id),
                "code": otp_code,
            })
            assert auth_resp.status_code == 200
            auth_data = auth_resp.json()
            assert len(auth_data["lots"]) == 1
            lot_owner_id = auth_data["lots"][0]["lot_owner_id"]
            token = auth_resp.cookies.get("meeting_session")
            assert token is not None

            # 2. Get motions
            motions_resp = await client.get(
                f"/api/general-meeting/{agm.id}/motions",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert motions_resp.status_code == 200
            assert len(motions_resp.json()) == 2

            # 3. Save drafts
            for motion in motions_resp.json():
                draft_resp = await client.put(
                    f"/api/general-meeting/{agm.id}/draft",
                    json={"motion_id": motion["id"], "choice": "yes", "lot_owner_id": lot_owner_id},
                    headers={"Authorization": f"Bearer {token}"},
                )
                assert draft_resp.status_code == 200

            # 4. Check drafts
            drafts_resp = await client.get(
                f"/api/general-meeting/{agm.id}/drafts",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert drafts_resp.status_code == 200
            assert len(drafts_resp.json()["drafts"]) == 2

            # 5. Submit ballot — pass choices inline (draft API is only for persistence,
            # choices must be included in the submit request)
            motion_ids = [m["id"] for m in motions_resp.json()]
            submit_resp = await client.post(
                f"/api/general-meeting/{agm.id}/submit",
                json={
                    "lot_owner_ids": [lot_owner_id],
                    "votes": [{"motion_id": mid, "choice": "yes"} for mid in motion_ids],
                },
                headers={"Authorization": f"Bearer {token}"},
            )
            assert submit_resp.status_code == 200
            assert submit_resp.json()["submitted"] is True

            # 6. View my ballot
            ballot_resp = await client.get(
                f"/api/general-meeting/{agm.id}/my-ballot",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert ballot_resp.status_code == 200
            ballot = ballot_resp.json()
            assert ballot["voter_email"] == "journey@full.com"
            assert len(ballot["submitted_lots"]) == 1
            assert all(v["choice"] == "yes" for v in ballot["submitted_lots"][0]["votes"])


# ---------------------------------------------------------------------------
# In-arrear lot voting edge cases (voting_service.py coverage)
# ---------------------------------------------------------------------------


class TestInArrearVoting:
    """Tests for in-arrear lot behaviour during submit and my-ballot."""

    # --- Happy path ---

    async def test_in_arrear_general_motion_not_eligible_on_submit(
        self, transport, db_session: AsyncSession
    ):
        """In-arrear lot: submit with inline votes must record not_eligible for general
        motions and use the inline choice for special motions (US-V08)."""
        b = make_building("In Arrear Submit Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="IA1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "inarrear@submit.com")

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        # One general motion and one special motion
        m_general = Motion(
            general_meeting_id=agm.id,
            title="General Motion",
            order_index=1,
            motion_type=MotionType.general,
        )
        m_special = Motion(
            general_meeting_id=agm.id,
            title="Special Motion",
            order_index=2,
            motion_type=MotionType.special,
        )
        db_session.add_all([m_general, m_special])
        await db_session.flush()

        # GeneralMeetingLotWeight with in_arrear snapshot
        weight = GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=100,
            financial_position_snapshot=FinancialPositionSnapshot.in_arrear,
        )
        db_session.add(weight)
        await db_session.flush()

        token = await make_session(db_session, "inarrear@submit.com", b.id, agm.id)
        await db_session.commit()

        # Voter provides inline choices for both motions — general motion choice is
        # ignored (overridden by not_eligible), special motion choice is recorded.
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                f"/api/general-meeting/{agm.id}/submit",
                json={
                    "lot_owner_ids": [str(lo.id)],
                    "votes": [
                        {"motion_id": str(m_general.id), "choice": "yes"},
                        {"motion_id": str(m_special.id), "choice": "yes"},
                    ],
                },
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200
        data = response.json()
        assert data["submitted"] is True
        # Both motions appear — general motion gets not_eligible, special motion gets yes
        votes = data["lots"][0]["votes"]
        votes_by_title = {v["motion_title"]: v for v in votes}
        assert "Special Motion" in votes_by_title
        assert votes_by_title["Special Motion"]["choice"] == "yes"
        assert "General Motion" in votes_by_title
        assert votes_by_title["General Motion"]["choice"] == "not_eligible"

    # --- Edge cases ---

    async def test_my_ballot_in_arrear_shows_general_motion_not_eligible(
        self, transport, db_session: AsyncSession
    ):
        """my-ballot for in-arrear lot shows general motions as not eligible
        (voting_service.py lines 424, 437-444)."""
        b = make_building("In Arrear MyBallot Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="IAB1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "inarrear@myballot.com")

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        m_general = Motion(
            general_meeting_id=agm.id,
            title="General Motion",
            order_index=1,
            motion_type=MotionType.general,
        )
        m_special = Motion(
            general_meeting_id=agm.id,
            title="Special Motion",
            order_index=2,
            motion_type=MotionType.special,
        )
        db_session.add_all([m_general, m_special])
        await db_session.flush()

        # GeneralMeetingLotWeight with in_arrear snapshot
        weight = GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=100,
            financial_position_snapshot=FinancialPositionSnapshot.in_arrear,
        )
        db_session.add(weight)
        await db_session.flush()

        # Only voted on special motion (general skipped due to in-arrear)
        v_special = Vote(
            general_meeting_id=agm.id,
            motion_id=m_special.id,
            voter_email="inarrear@myballot.com",
            lot_owner_id=lo.id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        )
        db_session.add(v_special)
        sub = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            voter_email="inarrear@myballot.com",
        )
        db_session.add(sub)
        token = await make_session(db_session, "inarrear@myballot.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/general-meeting/{agm.id}/my-ballot",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200
        votes = response.json()["submitted_lots"][0]["votes"]
        # Both motions appear in the ballot summary
        titles = {v["motion_title"]: v for v in votes}
        assert "General Motion" in titles
        assert titles["General Motion"]["eligible"] is False
        assert "Special Motion" in titles
        assert titles["Special Motion"]["eligible"] is True

    async def test_my_ballot_with_specific_lot_owner_ids(
        self, transport, db_session: AsyncSession
    ):
        """get_my_ballot called with lot_owner_ids filters to those specific lots
        (voting_service.py line 366)."""
        b = make_building("Specific Lots Building")
        db_session.add(b)
        await db_session.flush()
        lo1 = make_lot_owner(b, lot_number="SL1")
        lo2 = make_lot_owner(b, lot_number="SL2")
        db_session.add_all([lo1, lo2])
        await db_session.flush()
        await add_email(db_session, lo1, "specific@lots.com")
        await add_email(db_session, lo2, "specific@lots.com")

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m = Motion(general_meeting_id=agm.id, title="SL Motion", order_index=1)
        db_session.add(m)
        await db_session.flush()

        # Submit both lots
        for lo in [lo1, lo2]:
            db_session.add(Vote(
                general_meeting_id=agm.id,
                motion_id=m.id,
                voter_email="specific@lots.com",
                lot_owner_id=lo.id,
                choice=VoteChoice.yes,
                status=VoteStatus.submitted,
            ))
            db_session.add(BallotSubmission(
                general_meeting_id=agm.id,
                lot_owner_id=lo.id,
                voter_email="specific@lots.com",
            ))
        await db_session.flush()
        await db_session.commit()

        # Call service directly with specific lot_owner_ids to exercise line 366
        from app.services.voting_service import get_my_ballot

        result = await get_my_ballot(
            db=db_session,
            general_meeting_id=agm.id,
            voter_email="specific@lots.com",
            lot_owner_ids=[lo1.id],  # only request lo1's ballot
        )

        # Only lo1's lot should be in the result
        assert len(result.submitted_lots) == 1
        assert result.submitted_lots[0].lot_owner_id == lo1.id

    async def test_my_ballot_fallback_vote_via_voter_email(
        self, transport, db_session: AsyncSession
    ):
        """Votes that have lot_owner_id=None (old path) should be found via voter_email
        fallback (voting_service.py line 469)."""
        b = make_building("Fallback Vote Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="FV1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "fallback@vote.com")

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m = Motion(general_meeting_id=agm.id, title="FV Motion", order_index=1)
        db_session.add(m)
        await db_session.flush()

        # Create a vote with lot_owner_id=None (old path vote)
        old_vote = Vote(
            general_meeting_id=agm.id,
            motion_id=m.id,
            voter_email="fallback@vote.com",
            lot_owner_id=None,  # old-style vote without lot_owner_id
            choice=VoteChoice.no,
            status=VoteStatus.submitted,
        )
        db_session.add(old_vote)
        sub = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            voter_email="fallback@vote.com",
        )
        db_session.add(sub)
        token = await make_session(db_session, "fallback@vote.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/general-meeting/{agm.id}/my-ballot",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200
        votes = response.json()["submitted_lots"][0]["votes"]
        assert len(votes) == 1
        assert votes[0]["choice"] == "no"

    async def test_my_ballot_fallback_not_contaminated_for_multi_lot_voter(
        self, transport, db_session: AsyncSession
    ):
        """Multi-lot voter: fallback query must not raise MultipleResultsFound.

        When a multi-lot voter has old-path votes (lot_owner_id=None) for a
        motion, the fallback must add IS NULL so it matches exactly one row
        rather than scanning all submitted votes for that (meeting, motion,
        email) tuple across every lot.

        Also verifies that each lot's ballot is independent — no cross-lot
        vote contamination.
        """
        b = make_building("Multi Lot Fallback Building")
        db_session.add(b)
        await db_session.flush()
        lo1 = make_lot_owner(b, lot_number="MLF1")
        lo2 = make_lot_owner(b, lot_number="MLF2")
        db_session.add_all([lo1, lo2])
        await db_session.flush()
        await add_email(db_session, lo1, "multifall@voter.com")
        await add_email(db_session, lo2, "multifall@voter.com")

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        m1 = Motion(general_meeting_id=agm.id, title="MF Motion 1", order_index=1)
        m2 = Motion(general_meeting_id=agm.id, title="MF Motion 2", order_index=2)
        db_session.add_all([m1, m2])
        await db_session.flush()

        # lo1: new-path votes (with lot_owner_id) for both motions
        for motion, choice in [(m1, VoteChoice.yes), (m2, VoteChoice.no)]:
            db_session.add(Vote(
                general_meeting_id=agm.id,
                motion_id=motion.id,
                voter_email="multifall@voter.com",
                lot_owner_id=lo1.id,
                choice=choice,
                status=VoteStatus.submitted,
            ))

        # lo2: old-path votes (lot_owner_id=None) for both motions
        for motion, choice in [(m1, VoteChoice.abstained), (m2, VoteChoice.yes)]:
            db_session.add(Vote(
                general_meeting_id=agm.id,
                motion_id=motion.id,
                voter_email="multifall@voter.com",
                lot_owner_id=None,  # old-style, no lot_owner_id
                choice=choice,
                status=VoteStatus.submitted,
            ))

        # BallotSubmissions for both lots
        for lo in [lo1, lo2]:
            db_session.add(BallotSubmission(
                general_meeting_id=agm.id,
                lot_owner_id=lo.id,
                voter_email="multifall@voter.com",
            ))

        token = await make_session(db_session, "multifall@voter.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/general-meeting/{agm.id}/my-ballot",
                headers={"Authorization": f"Bearer {token}"},
            )

        # Must not 500 (MultipleResultsFound)
        assert response.status_code == 200
        data = response.json()
        lots_by_id = {s["lot_owner_id"]: s for s in data["submitted_lots"]}

        # lo1 should have its own new-path votes (not lo2's old-path votes)
        lo1_votes = {v["motion_title"]: v["choice"] for v in lots_by_id[str(lo1.id)]["votes"]}
        assert lo1_votes["MF Motion 1"] == "yes"
        assert lo1_votes["MF Motion 2"] == "no"

        # lo2's ballot uses the old-path fallback — must find the NULL-lot_owner_id votes
        lo2_votes = {v["motion_title"]: v["choice"] for v in lots_by_id[str(lo2.id)]["votes"]}
        assert lo2_votes["MF Motion 1"] == "abstained"
        assert lo2_votes["MF Motion 2"] == "yes"

    async def test_my_ballot_in_arrear_with_not_eligible_vote_in_db(
        self, transport, db_session: AsyncSession
    ):
        """my-ballot for in-arrear lot reads the not_eligible choice from the DB vote row
        (voting_service.py lines 464-466: existing not_eligible vote found in lot_vote_rows)."""
        b = make_building("In Arrear DB Vote Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="NE-DB1")
        db_session.add(lo)
        await db_session.flush()
        await add_email(db_session, lo, "inarrear@dbvote.com")

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        m_general = Motion(
            general_meeting_id=agm.id,
            title="General Motion DB",
            order_index=1,
            motion_type=MotionType.general,
        )
        m_special = Motion(
            general_meeting_id=agm.id,
            title="Special Motion DB",
            order_index=2,
            motion_type=MotionType.special,
        )
        db_session.add_all([m_general, m_special])
        await db_session.flush()

        weight = GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=100,
            financial_position_snapshot=FinancialPositionSnapshot.in_arrear,
        )
        db_session.add(weight)
        await db_session.flush()

        # Seed a not_eligible vote in the DB (as would be created by the new submit logic)
        v_not_eligible = Vote(
            general_meeting_id=agm.id,
            motion_id=m_general.id,
            voter_email="inarrear@dbvote.com",
            lot_owner_id=lo.id,
            choice=VoteChoice.not_eligible,
            status=VoteStatus.submitted,
        )
        v_special = Vote(
            general_meeting_id=agm.id,
            motion_id=m_special.id,
            voter_email="inarrear@dbvote.com",
            lot_owner_id=lo.id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        )
        db_session.add_all([v_not_eligible, v_special])
        sub = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            voter_email="inarrear@dbvote.com",
        )
        db_session.add(sub)
        token = await make_session(db_session, "inarrear@dbvote.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/general-meeting/{agm.id}/my-ballot",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200
        votes = response.json()["submitted_lots"][0]["votes"]
        votes_by_title = {v["motion_title"]: v for v in votes}
        # General motion should show not_eligible from the DB row (lines 464-466 exercised)
        assert "General Motion DB" in votes_by_title
        assert votes_by_title["General Motion DB"]["choice"] == "not_eligible"
        assert votes_by_title["General Motion DB"]["eligible"] is False
        # Special motion shows the actual vote
        assert "Special Motion DB" in votes_by_title
        assert votes_by_title["Special Motion DB"]["choice"] == "yes"
        assert votes_by_title["Special Motion DB"]["eligible"] is True
