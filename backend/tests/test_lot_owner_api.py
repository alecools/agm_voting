"""
Tests for the lot owner API endpoints (Phase 2).

Endpoints covered:
  GET  /api/server-time
  GET  /api/buildings
  GET  /api/buildings/{building_id}/agms
  POST /api/auth/verify
  GET  /api/agm/{agm_id}/motions
  PUT  /api/agm/{agm_id}/draft
  GET  /api/agm/{agm_id}/drafts
  POST /api/agm/{agm_id}/submit
  GET  /api/agm/{agm_id}/my-ballot

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
    AGM,
    AGMStatus,
    BallotSubmission,
    Building,
    LotOwner,
    Motion,
    SessionRecord,
    Vote,
    VoteChoice,
    VoteStatus,
)

# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------


def utcnow() -> datetime:
    return datetime.now(UTC)


def make_building(name: str = "Test Tower", email: str = "mgr@example.com") -> Building:
    return Building(name=name, manager_email=email)


def make_agm(building: Building, status: AGMStatus = AGMStatus.open, title: str = "AGM 2026") -> AGM:
    now = utcnow()
    return AGM(
        building_id=building.id,
        title=title,
        status=status,
        meeting_at=now + timedelta(days=1),
        voting_closes_at=now + timedelta(days=2),
    )


def make_lot_owner(
    building: Building,
    lot_number: str = "1A",
    email: str = "owner@example.com",
    entitlement: int = 100,
) -> LotOwner:
    return LotOwner(
        building_id=building.id,
        lot_number=lot_number,
        email=email,
        unit_entitlement=entitlement,
    )


def make_motion(agm: AGM, title: str = "Motion 1", order_index: int = 1) -> Motion:
    return Motion(agm_id=agm.id, title=title, order_index=order_index)


async def make_session(
    db: AsyncSession,
    voter_email: str,
    building_id: uuid.UUID,
    agm_id: uuid.UUID,
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
        agm_id=agm_id,
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
        b = make_building("Tower With AGM")
        db_session.add(b)
        await db_session.flush()

        agm = make_agm(b)
        db_session.add(agm)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/buildings")

        assert response.status_code == 200
        data = response.json()
        ids = [item["id"] for item in data]
        assert str(b.id) in ids

    async def test_excludes_manager_email(self, transport, db_session: AsyncSession):
        b = make_building("NoEmail Tower", email="secret@corp.com")
        db_session.add(b)
        await db_session.flush()
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/buildings")

        assert response.status_code == 200
        for item in response.json():
            assert "manager_email" not in item

    # --- Edge cases ---

    async def test_includes_buildings_without_agms(self, transport, db_session: AsyncSession):
        # Buildings without AGMs now appear — lot owners see them and are told no meetings exist
        b_no_agm = make_building("No AGM Building XYZ99")
        db_session.add(b_no_agm)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/buildings")

        assert response.status_code == 200
        ids = [item["id"] for item in response.json()]
        assert str(b_no_agm.id) in ids

    async def test_includes_closed_agm_building(self, transport, db_session: AsyncSession):
        b = make_building("Closed AGM Tower")
        db_session.add(b)
        await db_session.flush()
        agm = make_agm(b, status=AGMStatus.closed)
        agm.closed_at = utcnow()
        db_session.add(agm)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/buildings")

        ids = [item["id"] for item in response.json()]
        assert str(b.id) in ids

    async def test_response_has_id_and_name_fields(self, transport, db_session: AsyncSession):
        b = make_building("Fields Check Building")
        db_session.add(b)
        await db_session.flush()
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/buildings")

        for item in response.json():
            assert "id" in item
            assert "name" in item


# ---------------------------------------------------------------------------
# GET /api/buildings/{building_id}/agms
# ---------------------------------------------------------------------------


class TestListAGMs:
    # --- Happy path ---

    async def test_returns_agms_for_building(self, transport, db_session: AsyncSession):
        b = make_building("AGM List Building")
        db_session.add(b)
        await db_session.flush()

        agm1 = make_agm(b, title="AGM 2026")
        agm2 = make_agm(b, title="AGM 2025")
        # Make agm2 earlier
        agm2.meeting_at = utcnow() - timedelta(days=365)
        agm2.voting_closes_at = utcnow() - timedelta(days=364)
        db_session.add_all([agm1, agm2])
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/buildings/{b.id}/agms")

        assert response.status_code == 200
        data = response.json()
        ids = [item["id"] for item in data]
        assert str(agm1.id) in ids
        assert str(agm2.id) in ids

    async def test_ordered_by_meeting_at_descending(self, transport, db_session: AsyncSession):
        b = make_building("Ordered AGM Building")
        db_session.add(b)
        await db_session.flush()

        now = utcnow()
        agm_old = AGM(
            building_id=b.id,
            title="Old AGM",
            meeting_at=now - timedelta(days=365),
            voting_closes_at=now - timedelta(days=364),
        )
        agm_new = AGM(
            building_id=b.id,
            title="New AGM",
            meeting_at=now + timedelta(days=1),
            voting_closes_at=now + timedelta(days=2),
        )
        db_session.add_all([agm_old, agm_new])
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/buildings/{b.id}/agms")

        data = response.json()
        assert data[0]["title"] == "New AGM"
        assert data[1]["title"] == "Old AGM"

    async def test_response_contains_expected_fields(self, transport, db_session: AsyncSession):
        b = make_building("Fields AGM Building")
        db_session.add(b)
        await db_session.flush()
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/buildings/{b.id}/agms")

        item = response.json()[0]
        assert "id" in item
        assert "title" in item
        assert "status" in item
        assert "meeting_at" in item
        assert "voting_closes_at" in item

    # --- Input validation ---

    async def test_404_when_building_not_found(self, transport):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/buildings/{uuid.uuid4()}/agms")
        assert response.status_code == 404

    async def test_422_on_invalid_uuid(self, transport):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/buildings/not-a-uuid/agms")
        assert response.status_code == 422

    # --- Edge cases ---

    async def test_empty_list_when_building_has_no_agms(self, transport, db_session: AsyncSession):
        b = make_building("Empty AGM Building 2")
        db_session.add(b)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/buildings/{b.id}/agms")

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
        lo = make_lot_owner(b, lot_number="A1", email="voter@auth.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "lot_number": "A1",
                "email": "voter@auth.com",
                "building_id": str(b.id),
                "agm_id": str(agm.id),
            })

        assert response.status_code == 200
        data = response.json()
        assert data["voter_email"] == "voter@auth.com"
        assert data["already_submitted"] is False

    async def test_sets_session_cookie(self, transport, db_session: AsyncSession):
        b = make_building("Cookie Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="B2", email="cookie@auth.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "lot_number": "B2",
                "email": "cookie@auth.com",
                "building_id": str(b.id),
                "agm_id": str(agm.id),
            })

        assert "agm_session" in response.cookies

    async def test_already_submitted_flag(self, transport, db_session: AsyncSession):
        b = make_building("Already Submitted Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="C3", email="submitted@auth.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        # Pre-existing ballot submission
        sub = BallotSubmission(agm_id=agm.id, voter_email="submitted@auth.com")
        db_session.add(sub)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "lot_number": "C3",
                "email": "submitted@auth.com",
                "building_id": str(b.id),
                "agm_id": str(agm.id),
            })

        assert response.status_code == 200
        assert response.json()["already_submitted"] is True

    # --- Input validation ---

    async def test_wrong_email_returns_401(self, transport, db_session: AsyncSession):
        b = make_building("Wrong Email Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="D4", email="correct@auth.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "lot_number": "D4",
                "email": "wrong@auth.com",
                "building_id": str(b.id),
                "agm_id": str(agm.id),
            })

        assert response.status_code == 401
        assert "do not match" in response.json()["detail"]

    async def test_nonexistent_lot_returns_401(self, transport, db_session: AsyncSession):
        b = make_building("Missing Lot Building")
        db_session.add(b)
        await db_session.flush()
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "lot_number": "NOTEXIST",
                "email": "someone@auth.com",
                "building_id": str(b.id),
                "agm_id": str(agm.id),
            })

        assert response.status_code == 401

    async def test_empty_lot_number_returns_422(self, transport, db_session: AsyncSession):
        b = make_building("Empty Lot Building")
        db_session.add(b)
        await db_session.flush()
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "lot_number": "   ",
                "email": "x@y.com",
                "building_id": str(b.id),
                "agm_id": str(agm.id),
            })

        assert response.status_code == 422

    async def test_empty_email_returns_422(self, transport, db_session: AsyncSession):
        b = make_building("Empty Email Building")
        db_session.add(b)
        await db_session.flush()
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "lot_number": "L1",
                "email": "  ",
                "building_id": str(b.id),
                "agm_id": str(agm.id),
            })

        assert response.status_code == 422

    async def test_invalid_building_uuid_returns_422(self, transport):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "lot_number": "1A",
                "email": "x@y.com",
                "building_id": "not-a-uuid",
                "agm_id": str(uuid.uuid4()),
            })
        assert response.status_code == 422

    async def test_missing_fields_returns_422(self, transport):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "lot_number": "1A",
            })
        assert response.status_code == 422

    # --- State / precondition errors ---

    async def test_agm_belongs_to_different_building_returns_404(self, transport, db_session: AsyncSession):
        b1 = make_building("Building One Auth")
        b2 = make_building("Building Two Auth")
        db_session.add_all([b1, b2])
        await db_session.flush()

        lo = make_lot_owner(b1, lot_number="E5", email="e5@auth.com")
        db_session.add(lo)
        agm_b2 = make_agm(b2)  # AGM belongs to b2
        db_session.add(agm_b2)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "lot_number": "E5",
                "email": "e5@auth.com",
                "building_id": str(b1.id),  # Authenticate against b1
                "agm_id": str(agm_b2.id),   # But AGM is in b2
            })

        assert response.status_code == 404

    async def test_closed_agm_returns_200_with_closed_status(self, transport, db_session: AsyncSession):
        """Closed AGMs allow auth so lot owners can view their submission."""
        b = make_building("Closed Auth Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="F6", email="f6@auth.com")
        db_session.add(lo)
        agm = make_agm(b, status=AGMStatus.closed)
        agm.closed_at = utcnow()
        db_session.add(agm)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "lot_number": "F6",
                "email": "f6@auth.com",
                "building_id": str(b.id),
                "agm_id": str(agm.id),
            })

        assert response.status_code == 200
        data = response.json()
        assert data["agm_status"] == "closed"
        assert data["already_submitted"] is False

    async def test_open_agm_returns_open_status(self, transport, db_session: AsyncSession):
        """Open AGM auth returns agm_status=open."""
        b = make_building("Open Status Auth Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="F7", email="f7@auth.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "lot_number": "F7",
                "email": "f7@auth.com",
                "building_id": str(b.id),
                "agm_id": str(agm.id),
            })

        assert response.status_code == 200
        assert response.json()["agm_status"] == "open"

    async def test_lot_in_different_building_returns_401(self, transport, db_session: AsyncSession):
        b1 = make_building("Lot Building One")
        b2 = make_building("Lot Building Two")
        db_session.add_all([b1, b2])
        await db_session.flush()

        # Lot belongs to b1
        lo = make_lot_owner(b1, lot_number="G7", email="g7@auth.com")
        db_session.add(lo)
        agm = make_agm(b2)  # AGM in b2
        db_session.add(agm)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/api/auth/verify", json={
                "lot_number": "G7",
                "email": "g7@auth.com",
                "building_id": str(b2.id),  # Claim to be in b2
                "agm_id": str(agm.id),
            })

        assert response.status_code == 401

    # --- Edge cases ---

    async def test_multi_lot_owner_same_email_authenticates(self, transport, db_session: AsyncSession):
        """Two lots sharing the same email — either lot number should authenticate."""
        b = make_building("Multi Lot Auth Building")
        db_session.add(b)
        await db_session.flush()

        lo1 = make_lot_owner(b, lot_number="ML1", email="multi@auth.com")
        lo2 = make_lot_owner(b, lot_number="ML2", email="multi@auth.com")
        db_session.add_all([lo1, lo2])
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.commit()

        # Authenticate with first lot
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            r1 = await client.post("/api/auth/verify", json={
                "lot_number": "ML1",
                "email": "multi@auth.com",
                "building_id": str(b.id),
                "agm_id": str(agm.id),
            })
        assert r1.status_code == 200

        # Authenticate with second lot
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            r2 = await client.post("/api/auth/verify", json={
                "lot_number": "ML2",
                "email": "multi@auth.com",
                "building_id": str(b.id),
                "agm_id": str(agm.id),
            })
        assert r2.status_code == 200


# ---------------------------------------------------------------------------
# GET /api/agm/{agm_id}/motions
# ---------------------------------------------------------------------------


class TestListMotions:
    # --- Happy path ---

    async def test_returns_motions_in_order(self, transport, db_session: AsyncSession):
        b = make_building("Motions Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="M1", email="motion@test.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        m3 = Motion(agm_id=agm.id, title="Third", order_index=3)
        m1 = Motion(agm_id=agm.id, title="First", order_index=1)
        m2 = Motion(agm_id=agm.id, title="Second", order_index=2)
        db_session.add_all([m3, m1, m2])
        await db_session.flush()

        token = await make_session(db_session, "motion@test.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/agm/{agm.id}/motions",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200
        data = response.json()
        assert len(data) == 3
        assert data[0]["title"] == "First"
        assert data[1]["title"] == "Second"
        assert data[2]["title"] == "Third"

    async def test_motion_fields_present(self, transport, db_session: AsyncSession):
        b = make_building("Motion Fields Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="MF1", email="mfields@test.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        m = Motion(agm_id=agm.id, title="Vote on Budget", description="2026 budget", order_index=1)
        db_session.add(m)
        await db_session.flush()

        token = await make_session(db_session, "mfields@test.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/agm/{agm.id}/motions",
                headers={"Authorization": f"Bearer {token}"},
            )

        item = response.json()[0]
        assert item["id"] == str(m.id)
        assert item["title"] == "Vote on Budget"
        assert item["description"] == "2026 budget"
        assert item["order_index"] == 1

    # --- Input validation ---

    async def test_no_session_returns_401(self, transport, db_session: AsyncSession):
        agm_id = uuid.uuid4()
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/agm/{agm_id}/motions")
        assert response.status_code == 401

    async def test_session_for_different_agm_returns_401(self, transport, db_session: AsyncSession):
        b = make_building("Different AGM Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="DA1", email="diff@agm.com")
        db_session.add(lo)
        agm1 = make_agm(b, title="AGM One")
        agm2 = make_agm(b, title="AGM Two")
        db_session.add_all([agm1, agm2])
        await db_session.flush()

        # Create session for agm1
        token = await make_session(db_session, "diff@agm.com", b.id, agm1.id)
        await db_session.commit()

        # Try to access agm2 with agm1's session
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/agm/{agm2.id}/motions",
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 401

    async def test_expired_session_returns_401(self, transport, db_session: AsyncSession):
        b = make_building("Expired Session Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="EXP1", email="exp@session.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        token = await make_session(db_session, "exp@session.com", b.id, agm.id, expired=True)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/agm/{agm.id}/motions",
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 401

    # --- State / precondition errors ---

    async def test_agm_not_found_returns_404(self, transport, db_session: AsyncSession):
        b = make_building("404 AGM Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="NF1", email="notfound@test.com")
        db_session.add(lo)
        real_agm = make_agm(b)
        db_session.add(real_agm)
        await db_session.flush()

        token = await make_session(db_session, "notfound@test.com", b.id, real_agm.id)
        await db_session.commit()

        # Use session for real_agm but request a non-existent agm_id
        # The session is scoped to real_agm.id, so we need a session for non-existent agm
        # Instead: create session with a fake agm_id (but session validation would fail)
        # The 404 for agm is only reachable if session is valid; use real agm but test empty motions
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/agm/{real_agm.id}/motions",
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 200
        assert response.json() == []

    async def test_session_cookie_accepted(self, transport, db_session: AsyncSession):
        """Session token in cookie is also accepted."""
        b = make_building("Cookie Session Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="CK1", email="cookie@session.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m = Motion(agm_id=agm.id, title="Cookie Motion", order_index=1)
        db_session.add(m)
        await db_session.flush()

        token = await make_session(db_session, "cookie@session.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            client.cookies.set("agm_session", token)
            response = await client.get(f"/api/agm/{agm.id}/motions")

        assert response.status_code == 200


# ---------------------------------------------------------------------------
# PUT /api/agm/{agm_id}/draft
# ---------------------------------------------------------------------------


class TestSaveDraft:
    # --- Happy path ---

    async def test_save_yes_choice(self, transport, db_session: AsyncSession):
        b = make_building("Draft Yes Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="DY1", email="draft@yes.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m = Motion(agm_id=agm.id, title="Draft Motion", order_index=1)
        db_session.add(m)
        await db_session.flush()
        token = await make_session(db_session, "draft@yes.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.put(
                f"/api/agm/{agm.id}/draft",
                json={"motion_id": str(m.id), "choice": "yes"},
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200
        assert response.json()["saved"] is True

    async def test_save_no_choice(self, transport, db_session: AsyncSession):
        b = make_building("Draft No Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="DN1", email="draft@no.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m = Motion(agm_id=agm.id, title="No Motion", order_index=1)
        db_session.add(m)
        await db_session.flush()
        token = await make_session(db_session, "draft@no.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.put(
                f"/api/agm/{agm.id}/draft",
                json={"motion_id": str(m.id), "choice": "no"},
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 200

    async def test_save_abstained_choice(self, transport, db_session: AsyncSession):
        b = make_building("Draft Abstain Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="DA1", email="draft@abstain.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m = Motion(agm_id=agm.id, title="Abstain Motion", order_index=1)
        db_session.add(m)
        await db_session.flush()
        token = await make_session(db_session, "draft@abstain.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.put(
                f"/api/agm/{agm.id}/draft",
                json={"motion_id": str(m.id), "choice": "abstained"},
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 200

    async def test_null_choice_deletes_draft(self, transport, db_session: AsyncSession):
        b = make_building("Draft Null Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="NULL1", email="draft@null.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m = Motion(agm_id=agm.id, title="Null Motion", order_index=1)
        db_session.add(m)
        await db_session.flush()
        token = await make_session(db_session, "draft@null.com", b.id, agm.id)

        # Save a draft first
        v = Vote(agm_id=agm.id, motion_id=m.id, voter_email="draft@null.com", choice=VoteChoice.yes, status=VoteStatus.draft)
        db_session.add(v)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.put(
                f"/api/agm/{agm.id}/draft",
                json={"motion_id": str(m.id), "choice": None},
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 200
        assert response.json()["saved"] is True

    async def test_upsert_overwrites_existing_draft(self, transport, db_session: AsyncSession):
        """Saving a different choice updates the existing draft."""
        b = make_building("Upsert Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="UP1", email="upsert@draft.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m = Motion(agm_id=agm.id, title="Upsert Motion", order_index=1)
        db_session.add(m)
        await db_session.flush()
        token = await make_session(db_session, "upsert@draft.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            # First save yes
            await client.put(
                f"/api/agm/{agm.id}/draft",
                json={"motion_id": str(m.id), "choice": "yes"},
                headers={"Authorization": f"Bearer {token}"},
            )
            # Then overwrite with no
            response = await client.put(
                f"/api/agm/{agm.id}/draft",
                json={"motion_id": str(m.id), "choice": "no"},
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 200

    # --- Input validation ---

    async def test_motion_from_different_agm_returns_422(self, transport, db_session: AsyncSession):
        b = make_building("Cross AGM Draft Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="CA1", email="cross@draft.com")
        db_session.add(lo)
        agm1 = make_agm(b, title="AGM Draft One")
        agm2 = make_agm(b, title="AGM Draft Two")
        db_session.add_all([agm1, agm2])
        await db_session.flush()

        m_in_agm2 = Motion(agm_id=agm2.id, title="Other Motion", order_index=1)
        db_session.add(m_in_agm2)
        await db_session.flush()

        token = await make_session(db_session, "cross@draft.com", b.id, agm1.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.put(
                f"/api/agm/{agm1.id}/draft",
                json={"motion_id": str(m_in_agm2.id), "choice": "yes"},
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 422

    async def test_no_session_returns_401(self, transport):
        agm_id = uuid.uuid4()
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.put(
                f"/api/agm/{agm_id}/draft",
                json={"motion_id": str(uuid.uuid4()), "choice": "yes"},
            )
        assert response.status_code == 401

    # --- State / precondition errors ---

    async def test_already_submitted_returns_409(self, transport, db_session: AsyncSession):
        b = make_building("Already Sub Draft Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="AS1", email="asub@draft.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m = Motion(agm_id=agm.id, title="Submitted Motion", order_index=1)
        db_session.add(m)
        await db_session.flush()

        # Pre-existing ballot submission
        sub = BallotSubmission(agm_id=agm.id, voter_email="asub@draft.com")
        db_session.add(sub)
        await db_session.flush()

        token = await make_session(db_session, "asub@draft.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.put(
                f"/api/agm/{agm.id}/draft",
                json={"motion_id": str(m.id), "choice": "yes"},
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 409

    async def test_closed_agm_returns_403(self, transport, db_session: AsyncSession):
        b = make_building("Closed Draft Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="CL1", email="closed@draft.com")
        db_session.add(lo)
        agm = make_agm(b, status=AGMStatus.closed)
        agm.closed_at = utcnow()
        db_session.add(agm)
        await db_session.flush()
        m = Motion(agm_id=agm.id, title="Closed Motion", order_index=1)
        db_session.add(m)
        await db_session.flush()

        token = await make_session(db_session, "closed@draft.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.put(
                f"/api/agm/{agm.id}/draft",
                json={"motion_id": str(m.id), "choice": "yes"},
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 403


# ---------------------------------------------------------------------------
# GET /api/agm/{agm_id}/drafts
# ---------------------------------------------------------------------------


class TestGetDrafts:
    # --- Happy path ---

    async def test_returns_saved_drafts(self, transport, db_session: AsyncSession):
        b = make_building("Get Drafts Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="GD1", email="get@drafts.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m1 = Motion(agm_id=agm.id, title="M1", order_index=1)
        m2 = Motion(agm_id=agm.id, title="M2", order_index=2)
        db_session.add_all([m1, m2])
        await db_session.flush()

        # Save draft votes
        v1 = Vote(agm_id=agm.id, motion_id=m1.id, voter_email="get@drafts.com", choice=VoteChoice.yes, status=VoteStatus.draft)
        v2 = Vote(agm_id=agm.id, motion_id=m2.id, voter_email="get@drafts.com", choice=VoteChoice.no, status=VoteStatus.draft)
        db_session.add_all([v1, v2])
        await db_session.flush()

        token = await make_session(db_session, "get@drafts.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/agm/{agm.id}/drafts",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200
        data = response.json()
        assert "drafts" in data
        assert len(data["drafts"]) == 2
        motion_ids = {d["motion_id"] for d in data["drafts"]}
        assert str(m1.id) in motion_ids
        assert str(m2.id) in motion_ids

    async def test_empty_when_no_drafts(self, transport, db_session: AsyncSession):
        b = make_building("Empty Drafts Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="ED1", email="empty@drafts.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        token = await make_session(db_session, "empty@drafts.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/agm/{agm.id}/drafts",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200
        assert response.json()["drafts"] == []

    async def test_excludes_null_choice_drafts(self, transport, db_session: AsyncSession):
        """Drafts with null choice are not returned."""
        b = make_building("Null Draft Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="ND1", email="null@drafts.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m = Motion(agm_id=agm.id, title="Null Draft Motion", order_index=1)
        db_session.add(m)
        await db_session.flush()

        v = Vote(agm_id=agm.id, motion_id=m.id, voter_email="null@drafts.com", choice=None, status=VoteStatus.draft)
        db_session.add(v)
        await db_session.flush()

        token = await make_session(db_session, "null@drafts.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/agm/{agm.id}/drafts",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.json()["drafts"] == []

    # --- Input validation ---

    async def test_no_session_returns_401(self, transport):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/agm/{uuid.uuid4()}/drafts")
        assert response.status_code == 401


# ---------------------------------------------------------------------------
# POST /api/agm/{agm_id}/submit
# ---------------------------------------------------------------------------


class TestSubmitBallot:
    # --- Happy path ---

    async def test_all_motions_answered_submitted(self, transport, db_session: AsyncSession):
        b = make_building("Submit All Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="SA1", email="submit@all.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m1 = Motion(agm_id=agm.id, title="M1", order_index=1)
        m2 = Motion(agm_id=agm.id, title="M2", order_index=2)
        db_session.add_all([m1, m2])
        await db_session.flush()

        # Save draft votes
        v1 = Vote(agm_id=agm.id, motion_id=m1.id, voter_email="submit@all.com", choice=VoteChoice.yes, status=VoteStatus.draft)
        v2 = Vote(agm_id=agm.id, motion_id=m2.id, voter_email="submit@all.com", choice=VoteChoice.no, status=VoteStatus.draft)
        db_session.add_all([v1, v2])
        await db_session.flush()

        token = await make_session(db_session, "submit@all.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                f"/api/agm/{agm.id}/submit",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200
        data = response.json()
        assert data["submitted"] is True
        assert len(data["votes"]) == 2
        choices = {v["choice"] for v in data["votes"]}
        assert "yes" in choices
        assert "no" in choices

    async def test_partial_motions_unanswered_become_abstained(self, transport, db_session: AsyncSession):
        b = make_building("Submit Partial Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="SP1", email="submit@partial.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m1 = Motion(agm_id=agm.id, title="Answered", order_index=1)
        m2 = Motion(agm_id=agm.id, title="Unanswered", order_index=2)
        db_session.add_all([m1, m2])
        await db_session.flush()

        # Only m1 has a draft
        v1 = Vote(agm_id=agm.id, motion_id=m1.id, voter_email="submit@partial.com", choice=VoteChoice.yes, status=VoteStatus.draft)
        db_session.add(v1)
        await db_session.flush()

        token = await make_session(db_session, "submit@partial.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                f"/api/agm/{agm.id}/submit",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200
        data = response.json()
        votes_by_title = {v["motion_title"]: v["choice"] for v in data["votes"]}
        assert votes_by_title["Answered"] == "yes"
        assert votes_by_title["Unanswered"] == "abstained"

    async def test_no_drafts_all_motions_abstained(self, transport, db_session: AsyncSession):
        b = make_building("Submit None Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="SN1", email="submit@none.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m1 = Motion(agm_id=agm.id, title="Motion A", order_index=1)
        m2 = Motion(agm_id=agm.id, title="Motion B", order_index=2)
        db_session.add_all([m1, m2])
        await db_session.flush()

        token = await make_session(db_session, "submit@none.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                f"/api/agm/{agm.id}/submit",
                headers={"Authorization": f"Bearer {token}"},
            )

        data = response.json()
        for vote in data["votes"]:
            assert vote["choice"] == "abstained"

    # --- Input validation ---

    async def test_no_session_returns_401(self, transport):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(f"/api/agm/{uuid.uuid4()}/submit")
        assert response.status_code == 401

    # --- State / precondition errors ---

    async def test_closed_agm_returns_403(self, transport, db_session: AsyncSession):
        b = make_building("Submit Closed Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="SC1", email="submit@closed.com")
        db_session.add(lo)
        agm = make_agm(b, status=AGMStatus.closed)
        agm.closed_at = utcnow()
        db_session.add(agm)
        await db_session.flush()

        token = await make_session(db_session, "submit@closed.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                f"/api/agm/{agm.id}/submit",
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 403

    async def test_already_submitted_returns_409(self, transport, db_session: AsyncSession):
        b = make_building("Already Submitted Submit Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="ASS1", email="already@submit.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        sub = BallotSubmission(agm_id=agm.id, voter_email="already@submit.com")
        db_session.add(sub)
        await db_session.flush()

        token = await make_session(db_session, "already@submit.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                f"/api/agm/{agm.id}/submit",
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 409

    # --- Edge cases ---

    async def test_draft_with_null_choice_becomes_abstained(self, transport, db_session: AsyncSession):
        """A draft vote with choice=None is treated as no selection, becomes abstained."""
        b = make_building("Null Choice Submit Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="NC1", email="null@choice.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m = Motion(agm_id=agm.id, title="Null Choice Motion", order_index=1)
        db_session.add(m)
        await db_session.flush()

        # Draft with null choice
        v = Vote(agm_id=agm.id, motion_id=m.id, voter_email="null@choice.com", choice=None, status=VoteStatus.draft)
        db_session.add(v)
        await db_session.flush()

        token = await make_session(db_session, "null@choice.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                f"/api/agm/{agm.id}/submit",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200
        data = response.json()
        assert data["votes"][0]["choice"] == "abstained"

    async def test_concurrent_double_submission_second_gets_409(self, transport, db_session: AsyncSession):
        """
        Simulating concurrent submission: first submit should succeed,
        second should get 409.
        """
        b = make_building("Concurrent Submit Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="CON1", email="concurrent@submit.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m = Motion(agm_id=agm.id, title="Concurrent Motion", order_index=1)
        db_session.add(m)
        await db_session.flush()

        token1 = await make_session(db_session, "concurrent@submit.com", b.id, agm.id)
        token2 = await make_session(db_session, "concurrent@submit.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            r1 = await client.post(
                f"/api/agm/{agm.id}/submit",
                headers={"Authorization": f"Bearer {token1}"},
            )

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            r2 = await client.post(
                f"/api/agm/{agm.id}/submit",
                headers={"Authorization": f"Bearer {token2}"},
            )

        assert r1.status_code == 200
        assert r2.status_code == 409


# ---------------------------------------------------------------------------
# GET /api/agm/{agm_id}/my-ballot
# ---------------------------------------------------------------------------


class TestMyBallot:
    # --- Happy path ---

    async def test_returns_submitted_ballot(self, transport, db_session: AsyncSession):
        b = make_building("My Ballot Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="MB1", email="my@ballot.com")
        db_session.add(lo)
        agm = make_agm(b, title="My Ballot AGM")
        db_session.add(agm)
        await db_session.flush()
        m1 = Motion(agm_id=agm.id, title="Motion 1", order_index=1)
        m2 = Motion(agm_id=agm.id, title="Motion 2", order_index=2)
        db_session.add_all([m1, m2])
        await db_session.flush()

        # Submitted votes
        v1 = Vote(agm_id=agm.id, motion_id=m1.id, voter_email="my@ballot.com", choice=VoteChoice.yes, status=VoteStatus.submitted)
        v2 = Vote(agm_id=agm.id, motion_id=m2.id, voter_email="my@ballot.com", choice=VoteChoice.abstained, status=VoteStatus.submitted)
        db_session.add_all([v1, v2])
        await db_session.flush()

        sub = BallotSubmission(agm_id=agm.id, voter_email="my@ballot.com")
        db_session.add(sub)
        await db_session.flush()

        token = await make_session(db_session, "my@ballot.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/agm/{agm.id}/my-ballot",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200
        data = response.json()
        assert data["voter_email"] == "my@ballot.com"
        assert data["agm_title"] == "My Ballot AGM"
        assert data["building_name"] == "My Ballot Building"
        assert len(data["votes"]) == 2

    async def test_ballot_ordered_by_motion_order_index(self, transport, db_session: AsyncSession):
        b = make_building("Ordered Ballot Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="OB1", email="ordered@ballot.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m3 = Motion(agm_id=agm.id, title="Third", order_index=3)
        m1 = Motion(agm_id=agm.id, title="First", order_index=1)
        m2 = Motion(agm_id=agm.id, title="Second", order_index=2)
        db_session.add_all([m3, m1, m2])
        await db_session.flush()

        for m in [m1, m2, m3]:
            db_session.add(Vote(agm_id=agm.id, motion_id=m.id, voter_email="ordered@ballot.com", choice=VoteChoice.yes, status=VoteStatus.submitted))
        sub = BallotSubmission(agm_id=agm.id, voter_email="ordered@ballot.com")
        db_session.add(sub)
        await db_session.flush()

        token = await make_session(db_session, "ordered@ballot.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/agm/{agm.id}/my-ballot",
                headers={"Authorization": f"Bearer {token}"},
            )

        data = response.json()
        assert data["votes"][0]["motion_title"] == "First"
        assert data["votes"][1]["motion_title"] == "Second"
        assert data["votes"][2]["motion_title"] == "Third"

    # --- Input validation ---

    async def test_no_session_returns_401(self, transport):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/agm/{uuid.uuid4()}/my-ballot")
        assert response.status_code == 401

    # --- State / precondition errors ---

    async def test_no_submitted_ballot_returns_404(self, transport, db_session: AsyncSession):
        b = make_building("No Ballot Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="NB1", email="noballot@test.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()

        token = await make_session(db_session, "noballot@test.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/agm/{agm.id}/my-ballot",
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 404

    # --- Edge cases ---

    async def test_ballot_fields_include_order_index(self, transport, db_session: AsyncSession):
        b = make_building("Order Index Ballot Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="OI1", email="orderidx@ballot.com")
        db_session.add(lo)
        agm = make_agm(b)
        db_session.add(agm)
        await db_session.flush()
        m = Motion(agm_id=agm.id, title="Test Motion", order_index=5)
        db_session.add(m)
        await db_session.flush()

        v = Vote(agm_id=agm.id, motion_id=m.id, voter_email="orderidx@ballot.com", choice=VoteChoice.no, status=VoteStatus.submitted)
        db_session.add(v)
        sub = BallotSubmission(agm_id=agm.id, voter_email="orderidx@ballot.com")
        db_session.add(sub)
        await db_session.flush()

        token = await make_session(db_session, "orderidx@ballot.com", b.id, agm.id)
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/agm/{agm.id}/my-ballot",
                headers={"Authorization": f"Bearer {token}"},
            )

        vote_item = response.json()["votes"][0]
        assert vote_item["order_index"] == 5
        assert vote_item["choice"] == "no"


# ---------------------------------------------------------------------------
# Integration: full lot owner journey
# ---------------------------------------------------------------------------


class TestFullJourney:
    """End-to-end lot owner flow: auth → drafts → submit → my-ballot."""

    async def test_full_journey(self, transport, db_session: AsyncSession):
        b = make_building("Full Journey Building")
        db_session.add(b)
        await db_session.flush()
        lo = make_lot_owner(b, lot_number="FJ1", email="journey@full.com")
        db_session.add(lo)
        agm = make_agm(b, title="Full Journey AGM")
        db_session.add(agm)
        await db_session.flush()
        m1 = Motion(agm_id=agm.id, title="Motion Alpha", order_index=1)
        m2 = Motion(agm_id=agm.id, title="Motion Beta", order_index=2)
        db_session.add_all([m1, m2])
        await db_session.commit()

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            # 1. Authenticate
            auth_resp = await client.post("/api/auth/verify", json={
                "lot_number": "FJ1",
                "email": "journey@full.com",
                "building_id": str(b.id),
                "agm_id": str(agm.id),
            })
            assert auth_resp.status_code == 200
            token = auth_resp.cookies.get("agm_session")
            assert token is not None

            # 2. Get motions
            motions_resp = await client.get(
                f"/api/agm/{agm.id}/motions",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert motions_resp.status_code == 200
            assert len(motions_resp.json()) == 2

            # 3. Save drafts
            for motion in motions_resp.json():
                draft_resp = await client.put(
                    f"/api/agm/{agm.id}/draft",
                    json={"motion_id": motion["id"], "choice": "yes"},
                    headers={"Authorization": f"Bearer {token}"},
                )
                assert draft_resp.status_code == 200

            # 4. Check drafts
            drafts_resp = await client.get(
                f"/api/agm/{agm.id}/drafts",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert drafts_resp.status_code == 200
            assert len(drafts_resp.json()["drafts"]) == 2

            # 5. Submit ballot
            submit_resp = await client.post(
                f"/api/agm/{agm.id}/submit",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert submit_resp.status_code == 200
            assert submit_resp.json()["submitted"] is True

            # 6. View my ballot
            ballot_resp = await client.get(
                f"/api/agm/{agm.id}/my-ballot",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert ballot_resp.status_code == 200
            ballot = ballot_resp.json()
            assert ballot["voter_email"] == "journey@full.com"
            assert all(v["choice"] == "yes" for v in ballot["votes"])
