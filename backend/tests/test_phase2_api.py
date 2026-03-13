"""
Tests for Phase 2 API endpoints:
  - Public endpoints (server-time, buildings, agms)
  - Auth endpoint (verify)
  - Voting endpoints (motions, draft, submit, my-ballot)

Covers all code in app/routers/public.py, app/routers/auth.py, app/routers/voting.py,
app/services/auth_service.py, app/services/voting_service.py.

Structure:
  # --- Happy path ---
  # --- Input validation ---
  # --- State / precondition errors ---
  # --- Edge cases ---
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    GeneralMeeting,
    GeneralMeetingStatus,
    BallotSubmission,
    Building,
    LotOwner,
    LotProxy,
    Motion,
    SessionRecord,
    Vote,
    VoteChoice,
    VoteStatus,
)
from app.models.lot_owner_email import LotOwnerEmail
from app.models.general_meeting import get_effective_status
from app.models.general_meeting_lot_weight import GeneralMeetingLotWeight


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def meeting_dt() -> datetime:
    """Return a past meeting_at so meetings are effectively open (not pending)."""
    return datetime.now(UTC) - timedelta(hours=1)


def closing_dt() -> datetime:
    return datetime.now(UTC) + timedelta(days=2)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def client(app):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        yield ac


@pytest_asyncio.fixture
async def building_with_agm(db_session: AsyncSession):
    """Building with one open GeneralMeeting and one lot owner with email."""
    b = Building(name="P2 Building", manager_email="p2@test.com")
    db_session.add(b)
    await db_session.flush()

    lo = LotOwner(
        building_id=b.id, lot_number="P2-1", unit_entitlement=100
    )
    db_session.add(lo)
    await db_session.flush()

    lo_email = LotOwnerEmail(lot_owner_id=lo.id, email="voter@p2test.com")
    db_session.add(lo_email)

    agm = GeneralMeeting(
        building_id=b.id,
        title="P2 GeneralMeeting",
        status=GeneralMeetingStatus.open,
        meeting_at=meeting_dt(),
        voting_closes_at=closing_dt(),
    )
    db_session.add(agm)
    await db_session.flush()

    m1 = Motion(general_meeting_id=agm.id, title="P2 Motion 1", order_index=1, description="First")
    m2 = Motion(general_meeting_id=agm.id, title="P2 Motion 2", order_index=2, description=None)
    db_session.add_all([m1, m2])
    await db_session.flush()

    # lo.email is no longer a column; use the LotOwnerEmail row
    return {"building": b, "lot_owner": lo, "voter_email": "voter@p2test.com", "agm": agm, "motions": [m1, m2]}


async def create_session(
    db_session: AsyncSession,
    voter_email: str,
    building_id: uuid.UUID,
    general_meeting_id: uuid.UUID,
) -> str:
    """Helper to create a session token directly in DB."""
    import secrets
    token = secrets.token_urlsafe(32)
    now = datetime.now(UTC)
    session = SessionRecord(
        session_token=token,
        voter_email=voter_email,
        building_id=building_id,
        general_meeting_id=general_meeting_id,
        expires_at=now + timedelta(hours=24),
    )
    db_session.add(session)
    await db_session.flush()
    return token


# ---------------------------------------------------------------------------
# GET /api/server-time
# ---------------------------------------------------------------------------


class TestServerTime:
    # --- Happy path ---

    async def test_server_time_returns_200(self, client: AsyncClient):
        response = await client.get("/api/server-time")
        assert response.status_code == 200

    async def test_server_time_has_utc_field(self, client: AsyncClient):
        response = await client.get("/api/server-time")
        data = response.json()
        assert "utc" in data
        assert "T" in data["utc"]


# ---------------------------------------------------------------------------
# GET /api/buildings
# ---------------------------------------------------------------------------


class TestPublicListBuildings:
    # --- Happy path ---

    async def test_returns_buildings_with_agms(
        self, client: AsyncClient, building_with_agm: dict
    ):
        response = await client.get("/api/buildings")
        assert response.status_code == 200
        data = response.json()
        names = [b["name"] for b in data]
        assert "P2 Building" in names

    async def test_building_has_id_and_name(
        self, client: AsyncClient, building_with_agm: dict
    ):
        response = await client.get("/api/buildings")
        data = response.json()
        assert len(data) > 0
        first = data[0]
        assert "id" in first
        assert "name" in first

    async def test_building_without_agm_is_listed(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Buildings without AGMs now appear — the GeneralMeeting list for that building will be empty."""
        b = Building(name="No GeneralMeeting Building P2", manager_email="noagm@test.com")
        db_session.add(b)
        await db_session.flush()

        response = await client.get("/api/buildings")
        data = response.json()
        names = [item["name"] for item in data]
        assert "No GeneralMeeting Building P2" in names


# ---------------------------------------------------------------------------
# GET /api/buildings/{building_id}/agms
# ---------------------------------------------------------------------------


class TestPublicListAGMs:
    # --- Happy path ---

    async def test_returns_agms_for_building(
        self, client: AsyncClient, building_with_agm: dict
    ):
        building = building_with_agm["building"]
        response = await client.get(f"/api/buildings/{building.id}/general-meetings")
        assert response.status_code == 200
        data = response.json()
        assert len(data) >= 1
        titles = [a["title"] for a in data]
        assert "P2 GeneralMeeting" in titles

    async def test_agm_has_required_fields(
        self, client: AsyncClient, building_with_agm: dict
    ):
        building = building_with_agm["building"]
        response = await client.get(f"/api/buildings/{building.id}/general-meetings")
        data = response.json()
        agm = data[0]
        assert "id" in agm
        assert "title" in agm
        assert "status" in agm
        assert "meeting_at" in agm
        assert "voting_closes_at" in agm

    # --- State / precondition errors ---

    async def test_building_not_found_returns_404(self, client: AsyncClient):
        response = await client.get(f"/api/buildings/{uuid.uuid4()}/general-meetings")
        assert response.status_code == 404


# ---------------------------------------------------------------------------
# POST /api/auth/verify
# ---------------------------------------------------------------------------


class TestAuthVerify:
    # --- Happy path ---

    async def test_valid_auth_returns_200(
        self, client: AsyncClient, building_with_agm: dict
    ):
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        building = building_with_agm["building"]

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "building_id": str(building.id),
                "general_meeting_id": str(agm.id),
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["voter_email"] == voter_email
        assert "lots" in data
        assert len(data["lots"]) == 1
        assert data["lots"][0]["already_submitted"] is False

    async def test_valid_auth_already_submitted(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        building = building_with_agm["building"]

        # Create a ballot submission for this lot owner
        bs = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            voter_email=voter_email,
        )
        db_session.add(bs)
        await db_session.flush()

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "building_id": str(building.id),
                "general_meeting_id": str(agm.id),
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["lots"][0]["already_submitted"] is True

    async def test_sets_session_cookie(
        self, client: AsyncClient, building_with_agm: dict
    ):
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        building = building_with_agm["building"]

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "building_id": str(building.id),
                "general_meeting_id": str(agm.id),
            },
        )
        assert response.status_code == 200
        assert "meeting_session" in response.cookies

    async def test_lots_contain_lot_info(
        self, client: AsyncClient, building_with_agm: dict
    ):
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        building = building_with_agm["building"]

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "building_id": str(building.id),
                "general_meeting_id": str(agm.id),
            },
        )
        assert response.status_code == 200
        data = response.json()
        lot = data["lots"][0]
        assert lot["lot_owner_id"] == str(lo.id)
        assert lot["lot_number"] == lo.lot_number
        assert "financial_position" in lot
        assert "already_submitted" in lot
        assert "is_proxy" in lot
        assert lot["is_proxy"] is False  # direct owner, not proxy

    # --- Input validation ---

    async def test_empty_email_returns_422(
        self, client: AsyncClient, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        building = building_with_agm["building"]

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": "",
                "building_id": str(building.id),
                "general_meeting_id": str(agm.id),
            },
        )
        assert response.status_code == 422

    # --- State / precondition errors ---

    async def test_wrong_email_returns_401(
        self, client: AsyncClient, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        building = building_with_agm["building"]

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": "wrong@email.com",
                "building_id": str(building.id),
                "general_meeting_id": str(agm.id),
            },
        )
        assert response.status_code == 401

    async def test_agm_not_found_for_building_returns_404(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "building_id": str(building.id),
                "general_meeting_id": str(uuid.uuid4()),
            },
        )
        assert response.status_code == 404

    async def test_closed_agm_returns_200_with_closed_status(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Closed AGMs allow auth so lot owners can view their submission."""
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        # Create a closed GeneralMeeting in the same building
        closed_agm = GeneralMeeting(
            building_id=building.id,
            title="Closed P2 GeneralMeeting",
            status=GeneralMeetingStatus.closed,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
            closed_at=datetime.now(UTC),
        )
        db_session.add(closed_agm)
        await db_session.flush()

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "building_id": str(building.id),
                "general_meeting_id": str(closed_agm.id),
            },
        )
        assert response.status_code == 200
        assert response.json()["agm_status"] == "closed"

    async def test_email_in_different_building_returns_401(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """An email that belongs to a different building returns 401."""
        agm = building_with_agm["agm"]

        # Create a second building with no matching email
        b2 = Building(name="Other Building", manager_email="other@test.com")
        db_session.add(b2)
        await db_session.flush()
        agm2 = GeneralMeeting(
            building_id=b2.id,
            title="Other GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm2)
        await db_session.flush()

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": "voter@p2test.com",
                "building_id": str(b2.id),
                "general_meeting_id": str(agm2.id),
            },
        )
        assert response.status_code == 401


# ---------------------------------------------------------------------------
# auth_service tests (get_session)
# ---------------------------------------------------------------------------


class TestAuthService:
    # --- Happy path ---

    async def test_get_session_with_bearer_token(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Session can be validated via Authorization: Bearer header."""
        agm = building_with_agm["agm"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.get(
            f"/api/general-meeting/{agm.id}/motions",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200

    async def test_no_session_returns_401(
        self, client: AsyncClient, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        response = await client.get(f"/api/general-meeting/{agm.id}/motions")
        assert response.status_code == 401

    async def test_invalid_token_returns_401(
        self, client: AsyncClient, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        response = await client.get(
            f"/api/general-meeting/{agm.id}/motions",
            headers={"Authorization": "Bearer invalid_token_xyz"},
        )
        assert response.status_code == 401

    async def test_authorization_without_bearer_prefix_returns_401(
        self, client: AsyncClient, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        response = await client.get(
            f"/api/general-meeting/{agm.id}/motions",
            headers={"Authorization": "notabearer token"},
        )
        assert response.status_code == 401

    async def test_expired_session_returns_401(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        import secrets
        token = secrets.token_urlsafe(32)
        expired_session = SessionRecord(
            session_token=token,
            voter_email=voter_email,
            building_id=building.id,
            general_meeting_id=agm.id,
            expires_at=datetime.now(UTC) - timedelta(hours=1),
        )
        db_session.add(expired_session)
        await db_session.flush()

        response = await client.get(
            f"/api/general-meeting/{agm.id}/motions",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 401


# ---------------------------------------------------------------------------
# GET /api/general-meeting/{agm_id}/motions
# ---------------------------------------------------------------------------


class TestListMotions:
    # --- Happy path ---

    async def test_returns_motions(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.get(
            f"/api/general-meeting/{agm.id}/motions",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 2

    async def test_motion_fields(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.get(
            f"/api/general-meeting/{agm.id}/motions",
            headers={"Authorization": f"Bearer {token}"},
        )
        data = response.json()
        motion = data[0]
        assert "id" in motion
        assert "title" in motion
        assert "description" in motion
        assert "order_index" in motion


# ---------------------------------------------------------------------------
# PUT /api/general-meeting/{agm_id}/draft
# ---------------------------------------------------------------------------


class TestSaveDraft:
    # --- Happy path ---

    async def test_save_draft_yes(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.put(
            f"/api/general-meeting/{agm.id}/draft",
            json={"motion_id": str(motions[0].id), "choice": "yes", "lot_owner_id": str(lo.id)},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        assert response.json()["saved"] is True

    async def test_save_draft_no(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.put(
            f"/api/general-meeting/{agm.id}/draft",
            json={"motion_id": str(motions[0].id), "choice": "no", "lot_owner_id": str(lo.id)},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200

    async def test_save_draft_without_lot_owner_id(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Draft can be saved without lot_owner_id (legacy/fallback path)."""
        agm = building_with_agm["agm"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.put(
            f"/api/general-meeting/{agm.id}/draft",
            json={"motion_id": str(motions[0].id), "choice": "yes"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        assert response.json()["saved"] is True

    async def test_save_draft_update_existing(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Saving draft twice updates the existing record."""
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        # Save once
        await client.put(
            f"/api/general-meeting/{agm.id}/draft",
            json={"motion_id": str(motions[0].id), "choice": "yes", "lot_owner_id": str(lo.id)},
            headers={"Authorization": f"Bearer {token}"},
        )

        # Save again with different choice
        response = await client.put(
            f"/api/general-meeting/{agm.id}/draft",
            json={"motion_id": str(motions[0].id), "choice": "no", "lot_owner_id": str(lo.id)},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200

    async def test_save_draft_null_choice_deletes_draft(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Saving with null choice (deselect) removes the draft."""
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        # Save first
        await client.put(
            f"/api/general-meeting/{agm.id}/draft",
            json={"motion_id": str(motions[0].id), "choice": "yes", "lot_owner_id": str(lo.id)},
            headers={"Authorization": f"Bearer {token}"},
        )

        # Then deselect (null choice)
        response = await client.put(
            f"/api/general-meeting/{agm.id}/draft",
            json={"motion_id": str(motions[0].id), "choice": None, "lot_owner_id": str(lo.id)},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200

    async def test_save_draft_null_choice_no_existing_draft(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Saving with null choice when no draft exists is a no-op."""
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.put(
            f"/api/general-meeting/{agm.id}/draft",
            json={"motion_id": str(motions[0].id), "choice": None, "lot_owner_id": str(lo.id)},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200

    # --- State / precondition errors ---

    async def test_save_draft_closed_agm_returns_403(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        building = building_with_agm["building"]
        voter_email = building_with_agm["voter_email"]

        closed_agm = GeneralMeeting(
            building_id=building.id,
            title="Closed Draft GeneralMeeting",
            status=GeneralMeetingStatus.closed,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
            closed_at=datetime.now(UTC),
        )
        db_session.add(closed_agm)
        await db_session.flush()

        motion = Motion(general_meeting_id=closed_agm.id, title="CM1", order_index=1)
        db_session.add(motion)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, closed_agm.id)

        response = await client.put(
            f"/api/general-meeting/{closed_agm.id}/draft",
            json={"motion_id": str(motion.id), "choice": "yes"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 403

    async def test_save_draft_pending_agm_returns_403(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Draft save returns 403 when meeting is pending (not yet started, US-PS03)."""
        building = building_with_agm["building"]
        voter_email = building_with_agm["voter_email"]

        pending_agm = GeneralMeeting(
            building_id=building.id,
            title="Pending Draft GeneralMeeting",
            status=GeneralMeetingStatus.pending,
            meeting_at=datetime.now(UTC) + timedelta(days=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=2),
        )
        db_session.add(pending_agm)
        await db_session.flush()

        motion = Motion(general_meeting_id=pending_agm.id, title="PM1", order_index=1)
        db_session.add(motion)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, pending_agm.id)

        response = await client.put(
            f"/api/general-meeting/{pending_agm.id}/draft",
            json={"motion_id": str(motion.id), "choice": "yes"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 403
        assert "not started" in response.json()["detail"].lower()

    async def test_save_draft_already_submitted_returns_409(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        # Submit ballot for this lot owner
        bs = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            voter_email=voter_email,
        )
        db_session.add(bs)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.put(
            f"/api/general-meeting/{agm.id}/draft",
            json={"motion_id": str(motions[0].id), "choice": "yes", "lot_owner_id": str(lo.id)},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 409

    async def test_save_draft_wrong_agm_motion_returns_422(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.put(
            f"/api/general-meeting/{agm.id}/draft",
            json={"motion_id": str(uuid.uuid4()), "choice": "yes"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 422

    async def test_no_session_returns_401(
        self, client: AsyncClient, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        motions = building_with_agm["motions"]
        response = await client.put(
            f"/api/general-meeting/{agm.id}/draft",
            json={"motion_id": str(motions[0].id), "choice": "yes"},
        )
        assert response.status_code == 401


# ---------------------------------------------------------------------------
# GET /api/general-meeting/{agm_id}/drafts
# ---------------------------------------------------------------------------


class TestGetDrafts:
    # --- Happy path ---

    async def test_get_drafts_empty(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.get(
            f"/api/general-meeting/{agm.id}/drafts",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        assert response.json()["drafts"] == []

    async def test_get_drafts_with_saved_drafts(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        # Save a draft
        vote = Vote(
            general_meeting_id=agm.id,
            motion_id=motions[0].id,
            voter_email=voter_email,
            lot_owner_id=lo.id,
            choice=VoteChoice.yes,
            status=VoteStatus.draft,
        )
        db_session.add(vote)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.get(
            f"/api/general-meeting/{agm.id}/drafts",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["drafts"]) == 1
        assert data["drafts"][0]["choice"] == "yes"

    async def test_get_drafts_filtered_by_lot_owner_id(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Drafts endpoint accepts optional lot_owner_id query param."""
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        vote = Vote(
            general_meeting_id=agm.id,
            motion_id=motions[0].id,
            voter_email=voter_email,
            lot_owner_id=lo.id,
            choice=VoteChoice.yes,
            status=VoteStatus.draft,
        )
        db_session.add(vote)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.get(
            f"/api/general-meeting/{agm.id}/drafts?lot_owner_id={lo.id}",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["drafts"]) == 1

    async def test_null_choice_drafts_excluded(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        # Save a draft with null choice
        vote = Vote(
            general_meeting_id=agm.id,
            motion_id=motions[0].id,
            voter_email=voter_email,
            lot_owner_id=lo.id,
            choice=None,
            status=VoteStatus.draft,
        )
        db_session.add(vote)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.get(
            f"/api/general-meeting/{agm.id}/drafts",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        assert response.json()["drafts"] == []


# ---------------------------------------------------------------------------
# POST /api/general-meeting/{agm_id}/submit
# ---------------------------------------------------------------------------


class TestSubmitBallot:
    # --- Happy path ---

    async def test_submit_all_answered(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        # Save drafts for both motions
        for i, motion in enumerate(motions):
            vote = Vote(
                general_meeting_id=agm.id,
                motion_id=motion.id,
                voter_email=voter_email,
                lot_owner_id=lo.id,
                choice=VoteChoice.yes if i == 0 else VoteChoice.no,
                status=VoteStatus.draft,
            )
            db_session.add(vote)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={"lot_owner_ids": [str(lo.id)]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["submitted"] is True
        assert len(data["lots"]) == 1
        assert len(data["lots"][0]["votes"]) == 2

    async def test_submit_unanswered_motions_recorded_as_abstained(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        # Save draft only for first motion
        vote = Vote(
            general_meeting_id=agm.id,
            motion_id=motions[0].id,
            voter_email=voter_email,
            lot_owner_id=lo.id,
            choice=VoteChoice.yes,
            status=VoteStatus.draft,
        )
        db_session.add(vote)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={"lot_owner_ids": [str(lo.id)]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        data = response.json()
        # Second motion should be abstained
        votes = data["lots"][0]["votes"]
        choices = {v["motion_id"]: v["choice"] for v in votes}
        assert choices[str(motions[0].id)] == "yes"
        assert choices[str(motions[1].id)] == "abstained"

    async def test_submit_no_drafts_all_abstained(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={"lot_owner_ids": [str(lo.id)]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        data = response.json()
        assert all(v["choice"] == "abstained" for v in data["lots"][0]["votes"])

    async def test_submit_with_null_choice_draft_gets_abstained(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """A draft with null choice should be treated as abstained on submit."""
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        # Save draft with null choice
        vote = Vote(
            general_meeting_id=agm.id,
            motion_id=motions[0].id,
            voter_email=voter_email,
            lot_owner_id=lo.id,
            choice=None,
            status=VoteStatus.draft,
        )
        db_session.add(vote)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={"lot_owner_ids": [str(lo.id)]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        votes = response.json()["lots"][0]["votes"]
        choices = {v["motion_id"]: v["choice"] for v in votes}
        assert choices[str(motions[0].id)] == "abstained"

    async def test_submit_uses_draft_without_lot_owner_id(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """
        Regression: drafts saved by the frontend omit lot_owner_id (NULL).
        submit_ballot must still find and use those drafts instead of recording
        all votes as abstained.
        """
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        # Save drafts WITHOUT lot_owner_id — this is what the frontend actually sends
        for i, motion in enumerate(motions):
            vote = Vote(
                general_meeting_id=agm.id,
                motion_id=motion.id,
                voter_email=voter_email,
                lot_owner_id=None,  # frontend never sends lot_owner_id
                choice=VoteChoice.yes if i == 0 else VoteChoice.no,
                status=VoteStatus.draft,
            )
            db_session.add(vote)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={"lot_owner_ids": [str(lo.id)]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        data = response.json()
        votes = data["lots"][0]["votes"]
        choices = {v["motion_id"]: v["choice"] for v in votes}
        assert choices[str(motions[0].id)] == "yes"
        assert choices[str(motions[1].id)] == "no"

    async def test_submit_multi_lot_with_shared_null_lot_owner_id_drafts(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """
        Multi-lot voter: a single NULL-lot_owner_id draft should apply to every lot
        being submitted.  Both lots must receive the voter's actual choice, not
        abstained.
        """
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        # Add a second lot for the same voter
        lo2 = LotOwner(building_id=building.id, lot_number="P2-multi-2", unit_entitlement=30)
        db_session.add(lo2)
        await db_session.flush()
        lo2_email = LotOwnerEmail(lot_owner_id=lo2.id, email=voter_email)
        db_session.add(lo2_email)
        agm_weight2 = GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo2.id,
            unit_entitlement_snapshot=30,
        )
        db_session.add(agm_weight2)
        await db_session.flush()

        # Save shared drafts (NULL lot_owner_id) — one per motion
        for motion in motions:
            vote = Vote(
                general_meeting_id=agm.id,
                motion_id=motion.id,
                voter_email=voter_email,
                lot_owner_id=None,
                choice=VoteChoice.yes,
                status=VoteStatus.draft,
            )
            db_session.add(vote)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={"lot_owner_ids": [str(lo.id), str(lo2.id)]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["lots"]) == 2
        for lot_result in data["lots"]:
            for vote in lot_result["votes"]:
                assert vote["choice"] == "yes", (
                    f"Expected 'yes' for lot {lot_result['lot_number']}, "
                    f"motion {vote['motion_id']}, got {vote['choice']!r}"
                )

    # --- Input validation ---

    async def test_submit_empty_lot_owner_ids_returns_422(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={"lot_owner_ids": []},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 422

    async def test_submit_lot_owner_not_belonging_to_voter_returns_403(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Submitting on behalf of a lot that doesn't belong to this email → 403."""
        agm = building_with_agm["agm"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        # Create another lot owner with a different email
        lo2 = LotOwner(building_id=building.id, lot_number="P2-OTHER", unit_entitlement=50)
        db_session.add(lo2)
        await db_session.flush()
        lo2_email = LotOwnerEmail(lot_owner_id=lo2.id, email="other@p2test.com")
        db_session.add(lo2_email)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={"lot_owner_ids": [str(lo2.id)]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 403

    # --- State / precondition errors ---

    async def test_submit_closed_agm_returns_403(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        building = building_with_agm["building"]
        voter_email = building_with_agm["voter_email"]

        closed_agm = GeneralMeeting(
            building_id=building.id,
            title="Closed Submit GeneralMeeting",
            status=GeneralMeetingStatus.closed,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
            closed_at=datetime.now(UTC),
        )
        db_session.add(closed_agm)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, closed_agm.id)

        lo = building_with_agm["lot_owner"]
        response = await client.post(
            f"/api/general-meeting/{closed_agm.id}/submit",
            json={"lot_owner_ids": [str(lo.id)]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 403

    async def test_submit_pending_agm_returns_403(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Submit returns 403 when meeting is pending (not yet started, US-PS03)."""
        building = building_with_agm["building"]
        voter_email = building_with_agm["voter_email"]

        pending_agm = GeneralMeeting(
            building_id=building.id,
            title="Pending Submit GeneralMeeting",
            status=GeneralMeetingStatus.pending,
            meeting_at=datetime.now(UTC) + timedelta(days=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=2),
        )
        db_session.add(pending_agm)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, pending_agm.id)

        lo = building_with_agm["lot_owner"]
        response = await client.post(
            f"/api/general-meeting/{pending_agm.id}/submit",
            json={"lot_owner_ids": [str(lo.id)]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 403
        assert "not started" in response.json()["detail"].lower()

    async def test_submit_already_submitted_returns_409(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        # Submit ballot already
        bs = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            voter_email=voter_email,
        )
        db_session.add(bs)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={"lot_owner_ids": [str(lo.id)]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 409

    async def test_no_session_returns_401(
        self, client: AsyncClient, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={"lot_owner_ids": [str(lo.id)]},
        )
        assert response.status_code == 401


# ---------------------------------------------------------------------------
# GET /api/general-meeting/{agm_id}/my-ballot
# ---------------------------------------------------------------------------


class TestMyBallot:
    # --- Happy path ---

    async def test_my_ballot_after_submit(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        # Add submitted votes and ballot submission
        for motion in motions:
            vote = Vote(
                general_meeting_id=agm.id,
                motion_id=motion.id,
                voter_email=voter_email,
                lot_owner_id=lo.id,
                choice=VoteChoice.yes,
                status=VoteStatus.submitted,
            )
            db_session.add(vote)
        bs = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            voter_email=voter_email,
        )
        db_session.add(bs)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.get(
            f"/api/general-meeting/{agm.id}/my-ballot",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["voter_email"] == voter_email
        assert data["meeting_title"] == agm.title
        assert data["building_name"] == building.name
        assert len(data["submitted_lots"]) == 1
        assert len(data["submitted_lots"][0]["votes"]) == 2

    async def test_my_ballot_has_remaining_lot_owner_ids(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Unsubmitted lots appear in remaining_lot_owner_ids."""
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        # Add a second lot for same voter_email, not yet submitted
        lo2 = LotOwner(building_id=building.id, lot_number="P2-2", unit_entitlement=50)
        db_session.add(lo2)
        await db_session.flush()
        lo2_email = LotOwnerEmail(lot_owner_id=lo2.id, email=voter_email)
        db_session.add(lo2_email)
        await db_session.flush()

        # Submit ballot for lo only
        bs = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            voter_email=voter_email,
        )
        db_session.add(bs)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.get(
            f"/api/general-meeting/{agm.id}/my-ballot",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        data = response.json()
        assert str(lo2.id) in [str(lid) for lid in data["remaining_lot_owner_ids"]]

    # --- State / precondition errors ---

    async def test_my_ballot_not_submitted_returns_404(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.get(
            f"/api/general-meeting/{agm.id}/my-ballot",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 404

    async def test_no_session_returns_401(
        self, client: AsyncClient, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        response = await client.get(f"/api/general-meeting/{agm.id}/my-ballot")
        assert response.status_code == 401


# ---------------------------------------------------------------------------
# US-PX04: Proxy auth tests
# ---------------------------------------------------------------------------


class TestProxyAuth:
    """Tests for US-PX04: auth endpoint resolves proxy lots."""

    # --- Happy path ---

    async def test_proxy_voter_auth_succeeds_with_proxy_lot(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """A proxy voter (no direct lot) can auth if they have a proxy nomination."""
        building = building_with_agm["building"]
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]

        proxy_email = "proxy@test.com"
        lp = LotProxy(lot_owner_id=lo.id, proxy_email=proxy_email)
        db_session.add(lp)
        await db_session.flush()

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": proxy_email,
                "building_id": str(building.id),
                "general_meeting_id": str(agm.id),
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["lots"]) == 1
        assert data["lots"][0]["lot_owner_id"] == str(lo.id)
        assert data["lots"][0]["is_proxy"] is True

    async def test_direct_owner_has_is_proxy_false(
        self, client: AsyncClient, building_with_agm: dict
    ):
        """A direct lot owner gets is_proxy=False."""
        building = building_with_agm["building"]
        agm = building_with_agm["agm"]
        voter_email = building_with_agm["voter_email"]

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "building_id": str(building.id),
                "general_meeting_id": str(agm.id),
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["lots"][0]["is_proxy"] is False

    async def test_voter_sees_own_and_proxy_lots(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Voter who owns one lot and is proxy for another sees both."""
        building = building_with_agm["building"]
        agm = building_with_agm["agm"]
        voter_email = building_with_agm["voter_email"]

        # Add a second lot with voter as proxy
        lo2 = LotOwner(building_id=building.id, lot_number="PROXY-LOT", unit_entitlement=50)
        db_session.add(lo2)
        await db_session.flush()
        lo2_email = LotOwnerEmail(lot_owner_id=lo2.id, email="other@owner.com")
        db_session.add(lo2_email)
        lp = LotProxy(lot_owner_id=lo2.id, proxy_email=voter_email)
        db_session.add(lp)
        await db_session.flush()

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "building_id": str(building.id),
                "general_meeting_id": str(agm.id),
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["lots"]) == 2
        by_lot = {l["lot_owner_id"]: l for l in data["lots"]}
        lo = building_with_agm["lot_owner"]
        assert by_lot[str(lo.id)]["is_proxy"] is False
        assert by_lot[str(lo2.id)]["is_proxy"] is True

    async def test_voter_owns_lot_and_is_proxy_for_same_lot_deduplication(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """If voter is both owner and proxy for same lot, is_proxy=False (own lot wins)."""
        building = building_with_agm["building"]
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]

        # Also set voter as proxy for their own lot
        lp = LotProxy(lot_owner_id=lo.id, proxy_email=voter_email)
        db_session.add(lp)
        await db_session.flush()

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "building_id": str(building.id),
                "general_meeting_id": str(agm.id),
            },
        )
        assert response.status_code == 200
        data = response.json()
        # Lot appears once
        assert len(data["lots"]) == 1
        # Own lot takes precedence — is_proxy=False
        assert data["lots"][0]["is_proxy"] is False

    async def test_proxy_already_submitted_shows_already_submitted(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """already_submitted for proxy lot reflects BallotSubmission."""
        building = building_with_agm["building"]
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]

        proxy_email = "proxy2@test.com"
        lp = LotProxy(lot_owner_id=lo.id, proxy_email=proxy_email)
        db_session.add(lp)
        bs = BallotSubmission(general_meeting_id=agm.id, lot_owner_id=lo.id, voter_email=proxy_email)
        db_session.add(bs)
        await db_session.flush()

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": proxy_email,
                "building_id": str(building.id),
                "general_meeting_id": str(agm.id),
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["lots"][0]["already_submitted"] is True
        assert data["lots"][0]["is_proxy"] is True

    # --- State / precondition errors ---

    async def test_proxy_voter_no_proxy_records_returns_401(
        self, client: AsyncClient, building_with_agm: dict
    ):
        """Email not in any owner or proxy list → 401."""
        building = building_with_agm["building"]
        agm = building_with_agm["agm"]

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": "notaproxy@test.com",
                "building_id": str(building.id),
                "general_meeting_id": str(agm.id),
            },
        )
        assert response.status_code == 401
        assert response.json()["detail"] == "Email address not found for this building"

    async def test_proxy_in_different_building_returns_401(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Proxy nomination in different building does not grant access."""
        agm = building_with_agm["agm"]

        b2 = Building(name="Other Proxy Building", manager_email="other@b2.com")
        db_session.add(b2)
        await db_session.flush()
        lo2 = LotOwner(building_id=b2.id, lot_number="B2-1", unit_entitlement=10)
        db_session.add(lo2)
        await db_session.flush()
        lo2_email = LotOwnerEmail(lot_owner_id=lo2.id, email="b2owner@test.com")
        db_session.add(lo2_email)
        proxy_email = "crossbuildingproxy@test.com"
        lp = LotProxy(lot_owner_id=lo2.id, proxy_email=proxy_email)
        db_session.add(lp)
        await db_session.flush()

        building = building_with_agm["building"]
        response = await client.post(
            "/api/auth/verify",
            json={
                "email": proxy_email,
                "building_id": str(building.id),
                "general_meeting_id": str(agm.id),
            },
        )
        assert response.status_code == 401


# ---------------------------------------------------------------------------
# US-PX06: Proxy audit trail on ballot submission tests
# ---------------------------------------------------------------------------


class TestProxyBallotSubmission:
    """Tests for US-PX06: proxy audit trail on ballot submission."""

    # --- Happy path ---

    async def test_submit_as_proxy_stores_proxy_email_in_db(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """When proxy submits, BallotSubmission.proxy_email = voter_email."""
        from sqlalchemy import select as sa_select
        building = building_with_agm["building"]
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]

        proxy_email = "proxy_audit@test.com"
        lp = LotProxy(lot_owner_id=lo.id, proxy_email=proxy_email)
        db_session.add(lp)
        await db_session.flush()

        token = await create_session(db_session, proxy_email, building.id, agm.id)

        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={"lot_owner_ids": [str(lo.id)]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200

        # Verify proxy_email stored in DB
        result = await db_session.execute(
            sa_select(BallotSubmission).where(
                BallotSubmission.general_meeting_id == agm.id,
                BallotSubmission.lot_owner_id == lo.id,
            )
        )
        sub = result.scalar_one_or_none()
        assert sub is not None
        assert sub.proxy_email == proxy_email

    async def test_submit_as_owner_proxy_email_is_null(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """When owner submits directly, BallotSubmission.proxy_email = NULL."""
        from sqlalchemy import select as sa_select
        building = building_with_agm["building"]
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={"lot_owner_ids": [str(lo.id)]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200

        # Verify proxy_email is NULL in DB
        result = await db_session.execute(
            sa_select(BallotSubmission).where(
                BallotSubmission.general_meeting_id == agm.id,
                BallotSubmission.lot_owner_id == lo.id,
            )
        )
        sub = result.scalar_one_or_none()
        assert sub is not None
        assert sub.proxy_email is None

    async def test_submit_multiple_lots_mixed_proxy_and_own(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Voter submitting own lot + proxy lot: proxy_email set only for proxy lot."""
        from sqlalchemy import select as sa_select
        building = building_with_agm["building"]
        agm = building_with_agm["agm"]
        lo_own = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]

        # Add proxy lot
        lo_proxy = LotOwner(building_id=building.id, lot_number="PROXY-SUBMIT", unit_entitlement=50)
        db_session.add(lo_proxy)
        await db_session.flush()
        lo_proxy_email = LotOwnerEmail(lot_owner_id=lo_proxy.id, email="proxy_other@test.com")
        db_session.add(lo_proxy_email)
        lp = LotProxy(lot_owner_id=lo_proxy.id, proxy_email=voter_email)
        db_session.add(lp)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={"lot_owner_ids": [str(lo_own.id), str(lo_proxy.id)]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200

        subs_result = await db_session.execute(
            sa_select(BallotSubmission).where(
                BallotSubmission.general_meeting_id == agm.id,
                BallotSubmission.lot_owner_id.in_([lo_own.id, lo_proxy.id]),
            )
        )
        subs = {s.lot_owner_id: s for s in subs_result.scalars().all()}
        assert subs[lo_own.id].proxy_email is None
        assert subs[lo_proxy.id].proxy_email == voter_email

    # --- State / precondition errors ---

    async def test_submit_for_unrelated_lot_returns_403(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Submitting for a lot the voter neither owns nor is proxy for → 403."""
        building = building_with_agm["building"]
        agm = building_with_agm["agm"]
        voter_email = building_with_agm["voter_email"]

        # Create unrelated lot
        lo_other = LotOwner(building_id=building.id, lot_number="UNRELATED", unit_entitlement=10)
        db_session.add(lo_other)
        await db_session.flush()
        lo_other_email = LotOwnerEmail(lot_owner_id=lo_other.id, email="unrelated@test.com")
        db_session.add(lo_other_email)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={"lot_owner_ids": [str(lo_other.id)]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 403

    async def test_proxy_submit_response_does_not_expose_proxy_email(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """proxy_email is NOT exposed in the submit API response."""
        building = building_with_agm["building"]
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]

        proxy_email = "proxy_hidden@test.com"
        lp = LotProxy(lot_owner_id=lo.id, proxy_email=proxy_email)
        db_session.add(lp)
        await db_session.flush()

        token = await create_session(db_session, proxy_email, building.id, agm.id)

        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={"lot_owner_ids": [str(lo.id)]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        # proxy_email should not appear in any part of the response
        response_text = response.text
        assert "proxy_email" not in response_text


# ---------------------------------------------------------------------------
# US-PX04 my-ballot with proxy lots
# ---------------------------------------------------------------------------


class TestMyBallotProxyLots:
    """Test that get_my_ballot correctly handles proxy lots for remaining_lot_owner_ids."""

    async def test_my_ballot_includes_proxy_lots_in_remaining(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Proxy lots appear in remaining_lot_owner_ids when not yet submitted."""
        building = building_with_agm["building"]
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        motions = building_with_agm["motions"]

        # Create proxy lot (owned by someone else, voter is proxy)
        lo_proxy = LotOwner(building_id=building.id, lot_number="REMAINING-PROXY", unit_entitlement=30)
        db_session.add(lo_proxy)
        await db_session.flush()
        lo_proxy_owner_email = LotOwnerEmail(lot_owner_id=lo_proxy.id, email="realowner@test.com")
        db_session.add(lo_proxy_owner_email)
        lp = LotProxy(lot_owner_id=lo_proxy.id, proxy_email=voter_email)
        db_session.add(lp)
        await db_session.flush()

        # Submit own lot only
        for motion in motions:
            vote = Vote(
                general_meeting_id=agm.id,
                motion_id=motion.id,
                voter_email=voter_email,
                lot_owner_id=lo.id,
                choice=VoteChoice.yes,
                status=VoteStatus.submitted,
            )
            db_session.add(vote)
        bs = BallotSubmission(general_meeting_id=agm.id, lot_owner_id=lo.id, voter_email=voter_email)
        db_session.add(bs)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.get(
            f"/api/general-meeting/{agm.id}/my-ballot",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        data = response.json()
        # Proxy lot should appear in remaining
        remaining = [str(lid) for lid in data["remaining_lot_owner_ids"]]
        assert str(lo_proxy.id) in remaining


# ---------------------------------------------------------------------------
# verify_auth returns effective status for past-voting_closes_at AGMs (US-CD03)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestAuthVerifyEffectiveStatus:
    """verify_auth returns agm_status='closed' for past-voting_closes_at AGMs."""

    async def test_verify_auth_past_closes_at_returns_closed_status(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """An open GeneralMeeting whose voting_closes_at is in the past returns agm_status=closed."""
        b = Building(name="EffStatus Auth Bldg", manager_email="effauth@test.com")
        db_session.add(b)
        await db_session.flush()

        lo = LotOwner(building_id=b.id, lot_number="EA1", unit_entitlement=100)
        db_session.add(lo)
        await db_session.flush()
        db_session.add(LotOwnerEmail(lot_owner_id=lo.id, email="effauth@voter.test"))

        # GeneralMeeting is status=open but voting_closes_at is in the past
        past_agm = GeneralMeeting(
            building_id=b.id,
            title="Expired GeneralMeeting Auth",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) - timedelta(days=3),
            voting_closes_at=datetime.now(UTC) - timedelta(days=1),
        )
        db_session.add(past_agm)
        await db_session.commit()

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": "effauth@voter.test",
                "building_id": str(b.id),
                "general_meeting_id": str(past_agm.id),
            },
        )
        assert response.status_code == 200
        assert response.json()["agm_status"] == "closed"

    async def test_verify_auth_future_meeting_at_returns_pending_status(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """A GeneralMeeting with meeting_at in the future returns agm_status=pending."""
        b = Building(name="FutStatus Auth Bldg", manager_email="futauth@test.com")
        db_session.add(b)
        await db_session.flush()

        lo = LotOwner(building_id=b.id, lot_number="FA1", unit_entitlement=100)
        db_session.add(lo)
        await db_session.flush()
        db_session.add(LotOwnerEmail(lot_owner_id=lo.id, email="futauth@voter.test"))

        future_agm = GeneralMeeting(
            building_id=b.id,
            title="Future GeneralMeeting Auth",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) + timedelta(days=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=2),
        )
        db_session.add(future_agm)
        await db_session.commit()

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": "futauth@voter.test",
                "building_id": str(b.id),
                "general_meeting_id": str(future_agm.id),
            },
        )
        assert response.status_code == 200
        assert response.json()["agm_status"] == "pending"

    async def test_verify_auth_past_meeting_at_future_closes_at_returns_open_status(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """A GeneralMeeting whose start has passed but voting is open returns agm_status=open."""
        b = Building(name="OpenStatus Auth Bldg", manager_email="openauth@test.com")
        db_session.add(b)
        await db_session.flush()

        lo = LotOwner(building_id=b.id, lot_number="OA1", unit_entitlement=100)
        db_session.add(lo)
        await db_session.flush()
        db_session.add(LotOwnerEmail(lot_owner_id=lo.id, email="openauth@voter.test"))

        open_agm = GeneralMeeting(
            building_id=b.id,
            title="Open GeneralMeeting Auth",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) - timedelta(hours=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=2),
        )
        db_session.add(open_agm)
        await db_session.commit()

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": "openauth@voter.test",
                "building_id": str(b.id),
                "general_meeting_id": str(open_agm.id),
            },
        )
        assert response.status_code == 200
        assert response.json()["agm_status"] == "open"


# ---------------------------------------------------------------------------
# Public list_agms effective status (US-CD03)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestPublicListAGMsEffectiveStatus:
    """Public GET /api/buildings/{id}/agms returns effective status for expired AGMs."""

    async def test_public_list_agms_past_closes_at_returns_closed(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="PubEff Building", manager_email="pubeff@test.com")
        db_session.add(b)
        await db_session.flush()

        past_agm = GeneralMeeting(
            building_id=b.id,
            title="Public Expired GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) - timedelta(days=3),
            voting_closes_at=datetime.now(UTC) - timedelta(days=1),
        )
        db_session.add(past_agm)
        await db_session.commit()

        response = await client.get(f"/api/buildings/{b.id}/general-meetings")
        assert response.status_code == 200
        items = response.json()
        assert len(items) == 1
        assert items[0]["status"] == "closed"

    async def test_public_list_agms_future_meeting_at_returns_pending(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """A meeting with meeting_at in the future is effectively pending in the public list."""
        b = Building(name="PubFut Building", manager_email="pubfut@test.com")
        db_session.add(b)
        await db_session.flush()

        future_agm = GeneralMeeting(
            building_id=b.id,
            title="Public Future GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) + timedelta(days=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=2),
        )
        db_session.add(future_agm)
        await db_session.commit()

        response = await client.get(f"/api/buildings/{b.id}/general-meetings")
        assert response.status_code == 200
        items = response.json()
        assert len(items) == 1
        assert items[0]["status"] == "pending"

    async def test_public_list_agms_past_meeting_at_future_closes_at_returns_open(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """A meeting whose start has passed but voting is still open shows open in the public list."""
        b = Building(name="PubOpen Building", manager_email="pubopen@test.com")
        db_session.add(b)
        await db_session.flush()

        open_agm = GeneralMeeting(
            building_id=b.id,
            title="Public Open GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) - timedelta(hours=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=2),
        )
        db_session.add(open_agm)
        await db_session.commit()

        response = await client.get(f"/api/buildings/{b.id}/general-meetings")
        assert response.status_code == 200
        items = response.json()
        assert len(items) == 1
        assert items[0]["status"] == "open"
