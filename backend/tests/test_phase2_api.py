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
    AuthOtp,
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

    m1 = Motion(general_meeting_id=agm.id, title="P2 Motion 1", display_order=1, description="First")
    m2 = Motion(general_meeting_id=agm.id, title="P2 Motion 2", display_order=2, description=None)
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
    """Helper to create a session token directly in DB.

    Returns a signed token (same format as create_session service) so that
    restore_session and get_session can verify the signature.
    """
    import secrets
    from app.services.auth_service import _sign_token
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
    return _sign_token(token)


async def make_otp(
    db_session: AsyncSession,
    email: str,
    meeting_id: uuid.UUID,
) -> str:
    """Helper to insert a valid AuthOtp row and return the code."""
    code = "TESTCODE"
    otp = AuthOtp(
        email=email,
        meeting_id=meeting_id,
        code=code,
        expires_at=datetime.now(UTC) + timedelta(minutes=5),
    )
    db_session.add(otp)
    await db_session.flush()
    return code


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

    async def test_building_without_agm_is_excluded(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Buildings without any AGMs are excluded — only buildings with open meetings appear."""
        b = Building(name="No GeneralMeeting Building P2", manager_email="noagm@test.com")
        db_session.add(b)
        await db_session.flush()

        response = await client.get("/api/buildings")
        data = response.json()
        names = [item["name"] for item in data]
        assert "No GeneralMeeting Building P2" not in names

    # --- State / precondition errors ---

    async def test_building_with_only_closed_meeting_is_excluded(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """A building whose only meeting is closed does not appear in the list."""
        b = Building(name="Closed Only P2 Building", manager_email="closed@test.com")
        db_session.add(b)
        await db_session.flush()

        now = datetime.now(UTC)
        agm = GeneralMeeting(
            building_id=b.id,
            title="Closed Meeting",
            status=GeneralMeetingStatus.closed,
            meeting_at=now - timedelta(days=5),
            voting_closes_at=now + timedelta(days=1),
        )
        db_session.add(agm)
        await db_session.flush()

        response = await client.get("/api/buildings")
        names = [item["name"] for item in response.json()]
        assert "Closed Only P2 Building" not in names

    async def test_building_with_expired_voting_is_excluded(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """A building with a meeting whose voting_closes_at has passed is excluded."""
        b = Building(name="Expired Voting P2 Building", manager_email="expired@test.com")
        db_session.add(b)
        await db_session.flush()

        now = datetime.now(UTC)
        agm = GeneralMeeting(
            building_id=b.id,
            title="Expired Voting Meeting",
            status=GeneralMeetingStatus.open,
            meeting_at=now - timedelta(days=3),
            voting_closes_at=now - timedelta(hours=1),
        )
        db_session.add(agm)
        await db_session.flush()

        response = await client.get("/api/buildings")
        names = [item["name"] for item in response.json()]
        assert "Expired Voting P2 Building" not in names

    # --- Edge cases ---

    async def test_building_with_open_and_closed_meetings_is_included(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """A building with at least one open meeting appears even if it also has closed ones."""
        b = Building(name="Mixed P2 Building", manager_email="mixed@test.com")
        db_session.add(b)
        await db_session.flush()

        now = datetime.now(UTC)
        closed_agm = GeneralMeeting(
            building_id=b.id,
            title="Old Closed Meeting",
            status=GeneralMeetingStatus.closed,
            meeting_at=now - timedelta(days=30),
            voting_closes_at=now - timedelta(days=28),
        )
        open_agm = GeneralMeeting(
            building_id=b.id,
            title="Current Open Meeting",
            status=GeneralMeetingStatus.open,
            meeting_at=now - timedelta(hours=1),
            voting_closes_at=now + timedelta(days=2),
        )
        db_session.add_all([closed_agm, open_agm])
        await db_session.flush()

        response = await client.get("/api/buildings")
        names = [item["name"] for item in response.json()]
        assert "Mixed P2 Building" in names


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
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        building = building_with_agm["building"]
        code = await make_otp(db_session, voter_email, agm.id)

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "general_meeting_id": str(agm.id),
                "code": code,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["voter_email"] == voter_email
        assert "lots" in data
        assert len(data["lots"]) == 1
        assert data["lots"][0]["already_submitted"] is False
        assert data["building_name"] == building.name
        assert data["meeting_title"] == agm.title

    async def test_valid_auth_already_submitted(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """already_submitted=True when lot has submitted votes for every visible motion."""
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        motions = building_with_agm["motions"]  # [m1, m2] — both visible by default

        # Create a ballot submission and submitted votes for all visible motions
        bs = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            voter_email=voter_email,
        )
        db_session.add(bs)
        for motion in motions:
            v = Vote(
                general_meeting_id=agm.id,
                motion_id=motion.id,
                voter_email=voter_email,
                lot_owner_id=lo.id,
                choice=VoteChoice.yes,
                status=VoteStatus.submitted,
            )
            db_session.add(v)
        await db_session.flush()
        code = await make_otp(db_session, voter_email, agm.id)

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "general_meeting_id": str(agm.id),
                "code": code,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["lots"][0]["already_submitted"] is True

    async def test_sets_session_cookie(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        code = await make_otp(db_session, voter_email, agm.id)

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "general_meeting_id": str(agm.id),
                "code": code,
            },
        )
        assert response.status_code == 200
        assert "agm_session" in response.cookies

    async def test_sets_agm_session_cookie_attributes(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """agm_session cookie must be HttpOnly and SameSite=strict."""
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        code = await make_otp(db_session, voter_email, agm.id)

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "general_meeting_id": str(agm.id),
                "code": code,
            },
        )
        assert response.status_code == 200
        cookie_header = response.headers.get("set-cookie", "")
        assert "agm_session=" in cookie_header
        assert "HttpOnly" in cookie_header
        assert "SameSite=strict" in cookie_header or "samesite=strict" in cookie_header.lower()

    async def test_lots_contain_lot_info(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        code = await make_otp(db_session, voter_email, agm.id)

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "general_meeting_id": str(agm.id),
                "code": code,
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

    async def test_verify_lot_info_voted_motion_ids_empty_for_unvoted_lot(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """voted_motion_ids is empty for a lot that has no submitted votes."""
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        code = await make_otp(db_session, voter_email, agm.id)

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "general_meeting_id": str(agm.id),
                "code": code,
            },
        )
        assert response.status_code == 200
        data = response.json()
        lot = data["lots"][0]
        assert "voted_motion_ids" in lot
        assert lot["voted_motion_ids"] == []

    async def test_verify_lot_info_voted_motion_ids_populated_after_submission(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """voted_motion_ids contains the IDs of submitted votes for this lot."""
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        motions = building_with_agm["motions"]

        # Submit votes on both motions
        for motion in motions:
            v = Vote(
                general_meeting_id=agm.id,
                motion_id=motion.id,
                voter_email=voter_email,
                lot_owner_id=lo.id,
                choice=VoteChoice.yes,
                status=VoteStatus.submitted,
            )
            db_session.add(v)
        await db_session.flush()

        code = await make_otp(db_session, voter_email, agm.id)
        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "general_meeting_id": str(agm.id),
                "code": code,
            },
        )
        assert response.status_code == 200
        data = response.json()
        lot = data["lots"][0]
        voted_ids = lot["voted_motion_ids"]
        assert len(voted_ids) == 2
        assert str(motions[0].id) in voted_ids
        assert str(motions[1].id) in voted_ids

    async def test_verify_voted_motion_ids_excludes_draft_votes(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """voted_motion_ids only includes submitted votes, not drafts."""
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        motions = building_with_agm["motions"]

        # Add a draft vote (status=draft) — should NOT appear in voted_motion_ids
        from app.models.vote import VoteStatus as VS
        draft_v = Vote(
            general_meeting_id=agm.id,
            motion_id=motions[0].id,
            voter_email=voter_email,
            lot_owner_id=lo.id,
            choice=VoteChoice.yes,
            status=VS.draft,
        )
        db_session.add(draft_v)
        await db_session.flush()

        code = await make_otp(db_session, voter_email, agm.id)
        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "general_meeting_id": str(agm.id),
                "code": code,
            },
        )
        assert response.status_code == 200
        data = response.json()
        lot = data["lots"][0]
        # Draft vote must not be included
        assert lot["voted_motion_ids"] == []

    # --- Input validation ---

    async def test_empty_email_returns_422(
        self, client: AsyncClient, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": "",
                "general_meeting_id": str(agm.id),
                "code": "TESTCODE",
            },
        )
        assert response.status_code == 422

    async def test_empty_code_returns_422(
        self, client: AsyncClient, building_with_agm: dict
    ):
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "general_meeting_id": str(agm.id),
                "code": "",
            },
        )
        assert response.status_code == 422

    # --- State / precondition errors ---

    async def test_wrong_email_returns_401(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        agm = building_with_agm["agm"]
        # Insert OTP for wrong email (no lots found, so verify returns 401 at lot lookup)
        code = await make_otp(db_session, "wrong@email.com", agm.id)

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": "wrong@email.com",
                "general_meeting_id": str(agm.id),
                "code": code,
            },
        )
        assert response.status_code == 401

    async def test_agm_not_found_returns_404(
        self, client: AsyncClient, building_with_agm: dict
    ):
        voter_email = building_with_agm["voter_email"]

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "general_meeting_id": str(uuid.uuid4()),
                "code": "TESTCODE",
            },
        )
        assert response.status_code == 404

    async def test_invalid_otp_code_returns_401(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Wrong OTP code returns 401 before lot lookup."""
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        await make_otp(db_session, voter_email, agm.id)

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "general_meeting_id": str(agm.id),
                "code": "WRONGCOD",
            },
        )
        assert response.status_code == 401
        assert response.json()["detail"] == "Invalid or expired verification code"

    async def test_expired_otp_returns_401(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Expired OTP returns 401."""
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        expired_otp = AuthOtp(
            email=voter_email,
            meeting_id=agm.id,
            code="EXPCODE1",
            expires_at=datetime.now(UTC) - timedelta(minutes=1),
        )
        db_session.add(expired_otp)
        await db_session.flush()

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "general_meeting_id": str(agm.id),
                "code": "EXPCODE1",
            },
        )
        assert response.status_code == 401
        assert response.json()["detail"] == "Invalid or expired verification code"

    async def test_used_otp_returns_401(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Already-used OTP returns 401."""
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        used_otp = AuthOtp(
            email=voter_email,
            meeting_id=agm.id,
            code="USEDCODE",
            expires_at=datetime.now(UTC) + timedelta(minutes=5),
            used=True,
        )
        db_session.add(used_otp)
        await db_session.flush()

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "general_meeting_id": str(agm.id),
                "code": "USEDCODE",
            },
        )
        assert response.status_code == 401
        assert response.json()["detail"] == "Invalid or expired verification code"

    async def test_no_otp_row_returns_401(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """No OTP row at all → 401."""
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "general_meeting_id": str(agm.id),
                "code": "NOCODE12",
            },
        )
        assert response.status_code == 401
        assert response.json()["detail"] == "Invalid or expired verification code"

    async def test_otp_marked_used_after_successful_verify(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """OTP.used is set to True after a successful verify call."""
        from sqlalchemy import select as sa_select
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        code = await make_otp(db_session, voter_email, agm.id)

        await client.post(
            "/api/auth/verify",
            json={"email": voter_email, "general_meeting_id": str(agm.id), "code": code},
        )
        result = await db_session.execute(
            sa_select(AuthOtp).where(
                AuthOtp.email == voter_email,
                AuthOtp.meeting_id == agm.id,
                AuthOtp.code == code,
            )
        )
        otp = result.scalar_one_or_none()
        assert otp is not None
        assert otp.used is True

    async def test_used_otp_cannot_be_replayed(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """After a successful verify, the same code returns 401 on second attempt."""
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        code = await make_otp(db_session, voter_email, agm.id)

        # First call succeeds
        r1 = await client.post(
            "/api/auth/verify",
            json={"email": voter_email, "general_meeting_id": str(agm.id), "code": code},
        )
        assert r1.status_code == 200

        # Second call with same code → 401
        r2 = await client.post(
            "/api/auth/verify",
            json={"email": voter_email, "general_meeting_id": str(agm.id), "code": code},
        )
        assert r2.status_code == 401

    async def test_building_id_derived_from_meeting(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Backend derives building_id from GeneralMeeting; response includes building_name and meeting_title."""
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        building = building_with_agm["building"]
        code = await make_otp(db_session, voter_email, agm.id)

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "general_meeting_id": str(agm.id),
                "code": code,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["building_name"] == building.name
        assert data["meeting_title"] == agm.title

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
        code = await make_otp(db_session, voter_email, closed_agm.id)

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "general_meeting_id": str(closed_agm.id),
                "code": code,
            },
        )
        assert response.status_code == 200
        assert response.json()["agm_status"] == "closed"

    async def test_email_in_different_building_returns_401(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """An email that belongs to a different building returns 401."""
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
        # Insert OTP for voter email in the other meeting
        code = await make_otp(db_session, "voter@p2test.com", agm2.id)

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": "voter@p2test.com",
                "general_meeting_id": str(agm2.id),
                "code": code,
            },
        )
        assert response.status_code == 401

    async def test_verify_returns_session_token_in_body(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """POST /api/auth/verify must return session_token in the response body for localStorage persistence."""
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        code = await make_otp(db_session, voter_email, agm.id)

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "general_meeting_id": str(agm.id),
                "code": code,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert "session_token" in data
        assert isinstance(data["session_token"], str)
        assert len(data["session_token"]) > 0


# ---------------------------------------------------------------------------
# POST /api/auth/session  (session restore)
# ---------------------------------------------------------------------------


class TestSessionRestore:
    # --- Happy path ---

    async def test_valid_token_returns_200_with_lot_list(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """A valid token returns 200 with AuthVerifyResponse shape."""
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        building = building_with_agm["building"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.post(
            "/api/auth/session",
            json={"session_token": token, "general_meeting_id": str(agm.id)},
        )
        assert response.status_code == 200
        data = response.json()
        assert "lots" in data
        assert data["voter_email"] == voter_email
        assert data["agm_status"] == "open"
        assert data["building_name"] == building.name
        assert data["meeting_title"] == agm.title
        assert isinstance(data["session_token"], str)
        assert len(data["session_token"]) > 0

    async def test_valid_token_sets_agm_session_cookie(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Successful session restore sets the agm_session HttpOnly cookie."""
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        building = building_with_agm["building"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.post(
            "/api/auth/session",
            json={"session_token": token, "general_meeting_id": str(agm.id)},
        )
        assert response.status_code == 200
        assert "agm_session" in response.cookies

    async def test_restore_session_via_cookie(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Session restore works when token is passed via agm_session cookie (no body token)."""
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        building = building_with_agm["building"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.post(
            "/api/auth/session",
            json={"general_meeting_id": str(agm.id)},
            cookies={"agm_session": token},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["voter_email"] == voter_email

    async def test_restore_session_cookie_takes_priority_over_body_token(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Cookie token takes priority over session_token in request body."""
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        building = building_with_agm["building"]

        cookie_token = await create_session(db_session, voter_email, building.id, agm.id)

        # Pass a non-existent token in the body; the cookie should win
        response = await client.post(
            "/api/auth/session",
            json={"general_meeting_id": str(agm.id), "session_token": "invalid-body-token"},
            cookies={"agm_session": cookie_token},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["voter_email"] == voter_email

    async def test_restore_session_no_cookie_no_body_token_returns_401(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Returns 401 when neither cookie nor body token is provided."""
        agm = building_with_agm["agm"]

        response = await client.post(
            "/api/auth/session",
            json={"general_meeting_id": str(agm.id)},
        )
        assert response.status_code == 401

    async def test_valid_token_returns_fresh_already_submitted_flags(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """already_submitted flags reflect current vote state at restore time."""
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        motions = building_with_agm["motions"]
        building = building_with_agm["building"]

        # Submit votes for all motions
        bs = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            voter_email=voter_email,
        )
        db_session.add(bs)
        for motion in motions:
            v = Vote(
                general_meeting_id=agm.id,
                motion_id=motion.id,
                voter_email=voter_email,
                lot_owner_id=lo.id,
                choice=VoteChoice.yes,
                status=VoteStatus.submitted,
            )
            db_session.add(v)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.post(
            "/api/auth/session",
            json={"session_token": token, "general_meeting_id": str(agm.id)},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["lots"][0]["already_submitted"] is True

    async def test_restore_session_lot_info_includes_voted_motion_ids(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """restore_session returns voted_motion_ids populated with submitted vote IDs."""
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        motions = building_with_agm["motions"]
        building = building_with_agm["building"]

        # Submit one vote (on motions[0] only)
        v = Vote(
            general_meeting_id=agm.id,
            motion_id=motions[0].id,
            voter_email=voter_email,
            lot_owner_id=lo.id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        )
        db_session.add(v)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)
        response = await client.post(
            "/api/auth/session",
            json={"session_token": token, "general_meeting_id": str(agm.id)},
        )
        assert response.status_code == 200
        data = response.json()
        lot = data["lots"][0]
        voted_ids = lot["voted_motion_ids"]
        assert len(voted_ids) == 1
        assert str(motions[0].id) in voted_ids

    async def test_restore_session_voted_motion_ids_empty_for_unvoted_lot(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """restore_session returns voted_motion_ids=[] when no submitted votes exist."""
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        building = building_with_agm["building"]

        token = await create_session(db_session, voter_email, building.id, agm.id)
        response = await client.post(
            "/api/auth/session",
            json={"session_token": token, "general_meeting_id": str(agm.id)},
        )
        assert response.status_code == 200
        data = response.json()
        lot = data["lots"][0]
        assert lot["voted_motion_ids"] == []

    async def test_valid_token_with_proxy_lot_returns_is_proxy_true(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Session restore returns is_proxy=True for proxy lots."""
        lo = building_with_agm["lot_owner"]
        agm = building_with_agm["agm"]
        building = building_with_agm["building"]
        proxy_email = f"proxy_restore_{uuid.uuid4().hex[:6]}@test.com"

        lp = LotProxy(lot_owner_id=lo.id, proxy_email=proxy_email)
        db_session.add(lp)
        await db_session.flush()

        token = await create_session(db_session, proxy_email, building.id, agm.id)

        response = await client.post(
            "/api/auth/session",
            json={"session_token": token, "general_meeting_id": str(agm.id)},
        )
        assert response.status_code == 200
        data = response.json()
        proxy_lot = next((l for l in data["lots"] if l["lot_owner_id"] == str(lo.id)), None)
        assert proxy_lot is not None
        assert proxy_lot["is_proxy"] is True

    async def test_valid_token_returns_new_session_token(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """The restored session returns a new session_token (fresh session created)."""
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        building = building_with_agm["building"]

        original_token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.post(
            "/api/auth/session",
            json={"session_token": original_token, "general_meeting_id": str(agm.id)},
        )
        assert response.status_code == 200
        new_token = response.json()["session_token"]
        # A new token is issued each restore; it may differ from the original
        assert isinstance(new_token, str)
        assert len(new_token) > 0

    # --- Input validation ---

    async def test_empty_session_token_returns_422(
        self, client: AsyncClient, building_with_agm: dict
    ):
        """Empty session_token fails Pydantic validation."""
        agm = building_with_agm["agm"]
        response = await client.post(
            "/api/auth/session",
            json={"session_token": "", "general_meeting_id": str(agm.id)},
        )
        assert response.status_code == 422

    async def test_whitespace_session_token_returns_422(
        self, client: AsyncClient, building_with_agm: dict
    ):
        """Whitespace-only session_token fails Pydantic validation."""
        agm = building_with_agm["agm"]
        response = await client.post(
            "/api/auth/session",
            json={"session_token": "   ", "general_meeting_id": str(agm.id)},
        )
        assert response.status_code == 422

    async def test_missing_general_meeting_id_returns_422(
        self, client: AsyncClient
    ):
        """Missing general_meeting_id fails Pydantic validation."""
        response = await client.post(
            "/api/auth/session",
            json={"session_token": "some-token"},
        )
        assert response.status_code == 422

    # --- Boundary values ---

    async def test_token_for_different_meeting_returns_401(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """A token issued for one meeting cannot be used for a different meeting_id."""
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        building = building_with_agm["building"]

        token = await create_session(db_session, voter_email, building.id, agm.id)
        other_meeting_id = uuid.uuid4()

        response = await client.post(
            "/api/auth/session",
            json={"session_token": token, "general_meeting_id": str(other_meeting_id)},
        )
        # Returns 401 (session not found) or 404 if meeting doesn't exist — both are safe
        assert response.status_code in (401, 404)

    # --- State / precondition errors ---

    async def test_invalid_token_returns_401(
        self, client: AsyncClient, building_with_agm: dict
    ):
        """A tampered or unsigned token returns 401 at signature verification."""
        agm = building_with_agm["agm"]
        response = await client.post(
            "/api/auth/session",
            json={"session_token": "totally-invalid-garbage-token", "general_meeting_id": str(agm.id)},
        )
        assert response.status_code == 401
        # Unsigned/tampered tokens are rejected by _unsign_token before the DB lookup
        assert response.json()["detail"] == "Session expired. Please authenticate again."

    async def test_expired_token_returns_401(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """A signed token whose DB session expires_at is in the past returns 401."""
        import secrets
        from app.services.auth_service import _sign_token
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        building = building_with_agm["building"]

        raw_token = secrets.token_urlsafe(32)
        # Store an expired session in the DB with the raw token
        expired_session = SessionRecord(
            session_token=raw_token,
            voter_email=voter_email,
            building_id=building.id,
            general_meeting_id=agm.id,
            expires_at=datetime.now(UTC) - timedelta(hours=1),
        )
        db_session.add(expired_session)
        await db_session.flush()

        # Sign the raw token so it passes signature verification, but the DB record is expired
        signed_token = _sign_token(raw_token)

        response = await client.post(
            "/api/auth/session",
            json={"session_token": signed_token, "general_meeting_id": str(agm.id)},
        )
        assert response.status_code == 401
        assert response.json()["detail"] == "Session expired or invalid"

    async def test_closed_agm_token_returns_401(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """A valid token for a closed AGM returns 401 with the closed-meeting message."""
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        closed_agm = GeneralMeeting(
            building_id=building.id,
            title="Closed Session Test Meeting",
            status=GeneralMeetingStatus.closed,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
            closed_at=datetime.now(UTC),
        )
        db_session.add(closed_agm)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, closed_agm.id)

        response = await client.post(
            "/api/auth/session",
            json={"session_token": token, "general_meeting_id": str(closed_agm.id)},
        )
        assert response.status_code == 401
        assert response.json()["detail"] == "Session expired — meeting is closed"

    async def test_past_voting_closes_at_agm_returns_401(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """An AGM past its voting_closes_at (effective status 'closed') also returns 401."""
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        past_agm = GeneralMeeting(
            building_id=building.id,
            title="Past Closes Session Test Meeting",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) - timedelta(days=3),
            voting_closes_at=datetime.now(UTC) - timedelta(days=1),
        )
        db_session.add(past_agm)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, past_agm.id)

        response = await client.post(
            "/api/auth/session",
            json={"session_token": token, "general_meeting_id": str(past_agm.id)},
        )
        assert response.status_code == 401
        assert response.json()["detail"] == "Session expired — meeting is closed"

    async def test_nonexistent_meeting_id_returns_404(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """A valid-format meeting_id that doesn't exist in DB returns 404."""
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        building = building_with_agm["building"]

        # Create a session record pointing at an existing meeting
        token = await create_session(db_session, voter_email, building.id, agm.id)

        # But request with a different (nonexistent) meeting_id that won't match session_record
        # (and if it somehow finds a session, the meeting lookup returns 404)
        # We create a fake meeting_id that has no DB row
        fake_meeting_id = uuid.uuid4()
        response = await client.post(
            "/api/auth/session",
            json={"session_token": token, "general_meeting_id": str(fake_meeting_id)},
        )
        # Session not found for fake_meeting_id → 401
        assert response.status_code == 401

    # --- Edge cases ---

    async def test_pending_agm_session_restore_returns_200_with_pending_status(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Session restore for a pending AGM returns 200 with agm_status='pending'."""
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        pending_agm = GeneralMeeting(
            building_id=building.id,
            title="Pending Session Test Meeting",
            status=GeneralMeetingStatus.pending,
            meeting_at=datetime.now(UTC) + timedelta(days=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=2),
        )
        db_session.add(pending_agm)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, pending_agm.id)

        response = await client.post(
            "/api/auth/session",
            json={"session_token": token, "general_meeting_id": str(pending_agm.id)},
        )
        assert response.status_code == 200
        assert response.json()["agm_status"] == "pending"

    async def test_session_restore_unvoted_visible_count_reflects_current_state(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """unvoted_visible_count is computed fresh from current DB state."""
        voter_email = building_with_agm["voter_email"]
        agm = building_with_agm["agm"]
        building = building_with_agm["building"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.post(
            "/api/auth/session",
            json={"session_token": token, "general_meeting_id": str(agm.id)},
        )
        assert response.status_code == 200
        data = response.json()
        # Fixture has 2 motions, voter has not submitted any → unvoted_visible_count = 2
        assert data["unvoted_visible_count"] == 2


# ---------------------------------------------------------------------------
# POST /api/auth/logout
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestAuthLogout:
    # --- Happy path ---

    async def test_logout_returns_200_ok(self, client: AsyncClient):
        """POST /api/auth/logout returns 200 {"ok": true}."""
        response = await client.post("/api/auth/logout")
        assert response.status_code == 200
        assert response.json() == {"ok": True}

    async def test_logout_clears_agm_session_cookie(self, client: AsyncClient):
        """Logout response instructs the browser to delete the agm_session cookie."""
        response = await client.post("/api/auth/logout")
        assert response.status_code == 200
        # FastAPI's delete_cookie sets max-age=0 or expires in the past
        set_cookie = response.headers.get("set-cookie", "")
        # Cookie name must appear in the Set-Cookie header
        assert "agm_session" in set_cookie

    async def test_logout_idempotent_no_cookie(self, client: AsyncClient):
        """Calling logout without a cookie still returns 200 — idempotent."""
        response = await client.post("/api/auth/logout")
        assert response.status_code == 200
        assert response.json() == {"ok": True}


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

    async def test_get_session_with_agm_session_cookie(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Session can be validated via agm_session cookie."""
        agm = building_with_agm["agm"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.get(
            f"/api/general-meeting/{agm.id}/motions",
            cookies={"agm_session": token},
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
        """A signed token pointing to an expired DB session returns 401."""
        import secrets
        from app.services.auth_service import _sign_token
        agm = building_with_agm["agm"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        raw_token = secrets.token_urlsafe(32)
        expired_session = SessionRecord(
            session_token=raw_token,
            voter_email=voter_email,
            building_id=building.id,
            general_meeting_id=agm.id,
            expires_at=datetime.now(UTC) - timedelta(hours=1),
        )
        db_session.add(expired_session)
        await db_session.flush()

        # Use a signed token so it passes _unsign_token; the DB record is expired
        signed_token = _sign_token(raw_token)

        response = await client.get(
            f"/api/general-meeting/{agm.id}/motions",
            headers={"Authorization": f"Bearer {signed_token}"},
        )
        assert response.status_code == 401


# ---------------------------------------------------------------------------
# Token signing (Fix 6)
# ---------------------------------------------------------------------------


class TestTokenSigning:
    # --- Happy path ---

    def test_sign_and_unsign_roundtrip(self):
        """_sign_token and _unsign_token are inverses of each other."""
        from app.services.auth_service import _sign_token, _unsign_token

        raw = "raw_test_token_abc123"
        signed = _sign_token(raw)
        assert signed != raw
        assert _unsign_token(signed) == raw

    def test_signed_token_is_string(self):
        from app.services.auth_service import _sign_token

        signed = _sign_token("some_token")
        assert isinstance(signed, str)
        assert len(signed) > 0

    # --- State / precondition errors ---

    def test_unsign_unsigned_token_raises_401(self):
        """Passing a raw (unsigned) token to _unsign_token raises HTTPException 401."""
        from fastapi import HTTPException
        from app.services.auth_service import _unsign_token
        import pytest

        with pytest.raises(HTTPException) as exc_info:
            _unsign_token("totally-unsigned-raw-token")
        assert exc_info.value.status_code == 401
        assert "Session expired" in exc_info.value.detail

    def test_unsign_tampered_token_raises_401(self):
        """Tampering with a signed token makes _unsign_token raise HTTPException 401."""
        from fastapi import HTTPException
        from app.services.auth_service import _sign_token, _unsign_token
        import pytest

        signed = _sign_token("mytoken")
        tampered = signed[:-5] + "XXXXX"

        with pytest.raises(HTTPException) as exc_info:
            _unsign_token(tampered)
        assert exc_info.value.status_code == 401

    async def test_restore_session_with_unsigned_token_returns_401(
        self, client: AsyncClient, building_with_agm: dict
    ):
        """POST /api/auth/session with an unsigned token returns 401."""
        agm = building_with_agm["agm"]
        response = await client.post(
            "/api/auth/session",
            json={
                "session_token": "unsigned_raw_token_xyz",
                "general_meeting_id": str(agm.id),
            },
        )
        assert response.status_code == 401
        assert response.json()["detail"] == "Session expired. Please authenticate again."


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
        assert "display_order" in motion

    # --- submitted_choice field (BUG-RV-02) ---

    async def test_submitted_choice_null_when_not_voted(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """submitted_choice is null for motions the voter has not yet voted on."""
        agm = building_with_agm["agm"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.get(
            f"/api/general-meeting/{agm.id}/motions",
            headers={"Authorization": f"Bearer {token}"},
        )
        data = response.json()
        for motion in data:
            assert motion["submitted_choice"] is None

    async def test_submitted_choice_populated_for_voted_motion(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """submitted_choice returns the voter's choice for a motion they have already voted on."""
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        # Record a submitted vote for motion[0] = "yes"
        vote = Vote(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            voter_email=voter_email,
            motion_id=motions[0].id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        )
        db_session.add(vote)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.get(
            f"/api/general-meeting/{agm.id}/motions",
            headers={"Authorization": f"Bearer {token}"},
        )
        data = response.json()
        # Find motion[0] in the response
        m0 = next(m for m in data if str(m["id"]) == str(motions[0].id))
        m1 = next(m for m in data if str(m["id"]) == str(motions[1].id))
        assert m0["already_voted"] is True
        assert m0["submitted_choice"] == "yes"
        # Motion[1] not voted — null
        assert m1["already_voted"] is False
        assert m1["submitted_choice"] is None

    async def test_submitted_choice_prefers_non_not_eligible(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """For a multi-lot voter where one lot is in-arrear (not_eligible) and
        one normal lot voted yes, submitted_choice should return 'yes' not 'not_eligible'."""
        agm = building_with_agm["agm"]
        lo_normal = building_with_agm["lot_owner"]  # normal lot
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        # Create a second (in-arrear) lot owner with the same email
        lo_arrear = LotOwner(
            building_id=building.id, lot_number="P2-arrear", unit_entitlement=50
        )
        db_session.add(lo_arrear)
        await db_session.flush()
        lo_email_arrear = LotOwnerEmail(lot_owner_id=lo_arrear.id, email=voter_email)
        db_session.add(lo_email_arrear)
        await db_session.flush()

        # Record not_eligible for in-arrear lot (added first)
        vote_arrear = Vote(
            general_meeting_id=agm.id,
            lot_owner_id=lo_arrear.id,
            voter_email=voter_email,
            motion_id=motions[0].id,
            choice=VoteChoice.not_eligible,
            status=VoteStatus.submitted,
        )
        # Record yes for normal lot (added second)
        vote_normal = Vote(
            general_meeting_id=agm.id,
            lot_owner_id=lo_normal.id,
            voter_email=voter_email,
            motion_id=motions[0].id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        )
        db_session.add_all([vote_arrear, vote_normal])
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.get(
            f"/api/general-meeting/{agm.id}/motions",
            headers={"Authorization": f"Bearer {token}"},
        )
        data = response.json()
        m0 = next(m for m in data if str(m["id"]) == str(motions[0].id))
        # Should prefer "yes" over "not_eligible"
        assert m0["submitted_choice"] == "yes"

    async def test_submitted_choice_not_eligible_when_only_in_arrear(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """When only in-arrear lot exists and voted not_eligible, submitted_choice
        returns not_eligible (no non-not_eligible alternative exists)."""
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        vote = Vote(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            voter_email=voter_email,
            motion_id=motions[0].id,
            choice=VoteChoice.not_eligible,
            status=VoteStatus.submitted,
        )
        db_session.add(vote)
        await db_session.flush()

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.get(
            f"/api/general-meeting/{agm.id}/motions",
            headers={"Authorization": f"Bearer {token}"},
        )
        data = response.json()
        m0 = next(m for m in data if str(m["id"]) == str(motions[0].id))
        assert m0["submitted_choice"] == "not_eligible"

    async def test_submitted_choice_includes_submitted_choice_field_in_schema(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Every motion response item includes the submitted_choice field."""
        agm = building_with_agm["agm"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.get(
            f"/api/general-meeting/{agm.id}/motions",
            headers={"Authorization": f"Bearer {token}"},
        )
        data = response.json()
        for motion in data:
            assert "submitted_choice" in motion


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

    async def test_save_draft_with_lot_owner_id(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Draft is saved when lot_owner_id is provided."""
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

        motion = Motion(general_meeting_id=closed_agm.id, title="CM1", display_order=1)
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

        motion = Motion(general_meeting_id=pending_agm.id, title="PM1", display_order=1)
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

    async def test_save_draft_does_not_overwrite_submitted_vote(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """
        save_draft must not corrupt an already-submitted vote for a different lot.

        Scenario (multi-lot voter):
        1. Voter has two lots (lo = lot from fixture, lo2 = second lot).
        2. lot_owner lo has a submitted Vote for motion[0].
        3. Voter saves a draft for lo2 (same motion, same voter_email, different lot_owner_id).
        4. The save_draft filter (agm, motion, voter_email, status==draft, lot_owner_id==lo2.id)
           must NOT find or touch the submitted vote for lo.
        5. A new draft Vote for lo2 is created without affecting lo's submitted vote.
        """
        from sqlalchemy import select as sa_select
        from app.services.voting_service import save_draft as _save_draft
        from app.models.lot_owner import LotOwner as _LotOwner
        from app.models.lot_owner_email import LotOwnerEmail as _LOEmail

        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        # Create a second lot for the same voter
        lo2 = _LotOwner(building_id=building.id, lot_number="DRAFT-LO2", unit_entitlement=50)
        db_session.add(lo2)
        await db_session.flush()
        db_session.add(_LOEmail(lot_owner_id=lo2.id, email=voter_email))
        await db_session.flush()

        # Pre-create a submitted Vote for lot_owner lo (lot_owner_id is set)
        submitted_vote = Vote(
            general_meeting_id=agm.id,
            motion_id=motions[0].id,
            voter_email=voter_email,
            lot_owner_id=lo.id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        )
        db_session.add(submitted_vote)
        await db_session.flush()

        # Now save a draft for lo2 with the same motion and voter_email.
        # The status==draft filter ensures the submitted vote for lo is never touched.
        await _save_draft(
            db=db_session,
            general_meeting_id=agm.id,
            motion_id=motions[0].id,
            voter_email=voter_email,
            choice=VoteChoice.no,
            lot_owner_id=lo2.id,
        )
        await db_session.flush()

        # The submitted vote for `lo` must be untouched
        result_submitted = await db_session.execute(
            sa_select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.motion_id == motions[0].id,
                Vote.voter_email == voter_email,
                Vote.lot_owner_id == lo.id,
            )
        )
        submitted_votes = list(result_submitted.scalars().all())
        assert len(submitted_votes) == 1, "Submitted vote for lo must still exist"
        assert submitted_votes[0].status == VoteStatus.submitted, "Submitted vote must not be downgraded to draft"
        assert submitted_votes[0].choice == VoteChoice.yes, "Submitted vote choice must not be overwritten"

        # A new draft row for lo2 must exist
        result_draft = await db_session.execute(
            sa_select(Vote).where(
                Vote.general_meeting_id == agm.id,
                Vote.motion_id == motions[0].id,
                Vote.voter_email == voter_email,
                Vote.lot_owner_id == lo2.id,
                Vote.status == VoteStatus.draft,
            )
        )
        draft_votes = list(result_draft.scalars().all())
        assert len(draft_votes) == 1, "A new draft for lo2 must have been created"
        assert draft_votes[0].choice == VoteChoice.no

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

        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={
                "lot_owner_ids": [str(lo.id)],
                "votes": [
                    {"motion_id": str(motions[0].id), "choice": "yes"},
                    {"motion_id": str(motions[1].id), "choice": "no"},
                ],
            },
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

        token = await create_session(db_session, voter_email, building.id, agm.id)

        # Only supply a vote for the first motion — second is unanswered → abstained
        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={
                "lot_owner_ids": [str(lo.id)],
                "votes": [{"motion_id": str(motions[0].id), "choice": "yes"}],
            },
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

    async def test_submit_with_no_inline_choice_gets_abstained(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """A motion not included in the inline votes list should be recorded as abstained."""
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        # Submit with no votes for any motion — both should be abstained
        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={"lot_owner_ids": [str(lo.id)], "votes": []},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        votes = response.json()["lots"][0]["votes"]
        choices = {v["motion_id"]: v["choice"] for v in votes}
        assert choices[str(motions[0].id)] == "abstained"
        assert choices[str(motions[1].id)] == "abstained"

    async def test_submit_inline_votes_yes_no_not_abstained(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """
        Regression: after draft auto-save was removed, all submitted votes were
        recorded as abstained because choices were read from (non-existent) draft rows.
        Inline votes in the submit request must be persisted correctly — not abstained.
        """
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        token = await create_session(db_session, voter_email, building.id, agm.id)

        # Voter selects Yes for motion 1 and No for motion 2 — inline in the request
        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={
                "lot_owner_ids": [str(lo.id)],
                "votes": [
                    {"motion_id": str(motions[0].id), "choice": "yes"},
                    {"motion_id": str(motions[1].id), "choice": "no"},
                ],
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        data = response.json()
        votes = data["lots"][0]["votes"]
        choices = {v["motion_id"]: v["choice"] for v in votes}
        # Must NOT be abstained — choices must match what was sent
        assert choices[str(motions[0].id)] == "yes"
        assert choices[str(motions[1].id)] == "no"

    async def test_submit_multi_lot_with_inline_votes(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """
        Multi-lot voter: inline votes in the submit request are applied to every lot
        being submitted.  Both lots must receive the voter's actual choice, not abstained.
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

        token = await create_session(db_session, voter_email, building.id, agm.id)

        # Inline votes apply to all lots being submitted
        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={
                "lot_owner_ids": [str(lo.id), str(lo2.id)],
                "votes": [
                    {"motion_id": str(m.id), "choice": "yes"} for m in motions
                ],
            },
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

    async def test_submit_already_submitted_reentry_returns_200(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Re-entry: submitting when BallotSubmission exists is a no-op returning 200."""
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]
        motions = building_with_agm["motions"]

        # Submit ballot and all votes already
        bs = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            voter_email=voter_email,
        )
        db_session.add(bs)
        for m in motions:
            db_session.add(Vote(
                general_meeting_id=agm.id,
                motion_id=m.id,
                voter_email=voter_email,
                lot_owner_id=lo.id,
                choice=VoteChoice.yes,
                status=VoteStatus.submitted,
            ))
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
        # All motions were already voted on so no new votes added
        assert data["lots"][0]["votes"] == []

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

    # --- Input validation ---

    async def test_submit_unknown_motion_id_returns_400(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Inline votes referencing a motion ID from a different meeting → 400."""
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        building = building_with_agm["building"]

        foreign_motion_id = str(uuid.uuid4())
        token = await create_session(db_session, voter_email, building.id, agm.id)

        response = await client.post(
            f"/api/general-meeting/{agm.id}/submit",
            json={
                "lot_owner_ids": [str(lo.id)],
                "votes": [{"motion_id": foreign_motion_id, "choice": "yes"}],
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 400
        assert "Unknown motion IDs" in response.json()["detail"]

    # --- Edge cases ---

    async def test_concurrent_submission_integrity_error_raises_409(
        self, db_session: AsyncSession, building_with_agm: dict
    ):
        """IntegrityError on BallotSubmission flush is caught and re-raised as HTTP 409.

        This is a pure unit test using a fully-mocked AsyncSession. It exercises the
        IntegrityError handler in submit_ballot (voting_service.py lines 416-419) without
        touching the shared test session.
        """
        import pytest
        from unittest.mock import AsyncMock, MagicMock
        from sqlalchemy.exc import IntegrityError as SAIntegrityError
        from fastapi import HTTPException
        from app.services.voting_service import submit_ballot
        from app.models import GeneralMeetingStatus

        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        lot_owner_id = lo.id
        general_meeting_id = agm.id

        # Helper to make a mock result that returns a given scalar or list.
        def _scalar_result(value):
            r = MagicMock()
            r.scalar_one_or_none.return_value = value
            r.scalars.return_value.all.return_value = []
            r.all.return_value = []
            return r

        def _scalars_result(items):
            r = MagicMock()
            r.scalars.return_value.all.return_value = items
            r.scalar_one_or_none.return_value = None
            r.all.return_value = []
            return r

        def _all_result(rows):
            r = MagicMock()
            r.all.return_value = rows
            r.scalars.return_value.all.return_value = rows
            r.scalar_one_or_none.return_value = None
            return r

        # Build a mock open GeneralMeeting
        mock_meeting = MagicMock()
        mock_meeting.id = general_meeting_id
        mock_meeting.status = GeneralMeetingStatus.open
        mock_meeting.voting_closes_at = agm.voting_closes_at
        mock_meeting.meeting_at = agm.meeting_at

        # LotOwnerEmail row confirming direct ownership
        mock_email_row = MagicMock()
        mock_email_row.lot_owner_id = lot_owner_id

        # Mock LotOwner
        mock_lot_owner = MagicMock()
        mock_lot_owner.id = lot_owner_id
        mock_lot_owner.lot_number = lo.lot_number

        flush_count = 0

        async def _flush():
            nonlocal flush_count
            flush_count += 1
            # The service calls flush in this order:
            #   flush 1: after delete draft votes by lot
            #   flush 2: (inside per-lot loop) before BallotSubmission insert add — actually
            #            the first per-lot flush is at line 358 "await db.flush()"
            #   flush 3: the BallotSubmission insert flush at line 415 "await db.flush()"
            # Raise on flush 3 to simulate the concurrent duplicate.
            if flush_count >= 3:
                raise SAIntegrityError(None, None, Exception("duplicate key value"))

        execute_call_count = 0

        async def _execute(stmt):
            nonlocal execute_call_count
            execute_call_count += 1
            # Call sequence (for 1 lot, no inline votes):
            # 1: SELECT GeneralMeeting
            # 2: SELECT LotOwnerEmail (ownership check)
            # 3: SELECT BallotSubmission FOR UPDATE (existing_subs)
            # 4: SELECT Vote.motion_id (already voted)
            # 5: SELECT Motion (visible motions)
            # 6: SELECT GeneralMeetingLotWeight
            # 7: SELECT LotOwner
            # 8: DELETE draft votes by lot
            # 9: DELETE shared draft votes
            if execute_call_count == 1:
                return _scalar_result(mock_meeting)
            elif execute_call_count == 2:
                return _scalar_result(mock_email_row)
            elif execute_call_count == 3:
                return _scalars_result([])  # no existing submissions
            elif execute_call_count == 4:
                return _all_result([])  # no already-voted motions
            elif execute_call_count == 5:
                return _scalars_result([])  # no visible motions
            elif execute_call_count == 6:
                return _scalars_result([])  # no lot weights
            elif execute_call_count == 7:
                return _scalars_result([mock_lot_owner])
            else:
                return _all_result([])  # DELETE statements return nothing meaningful

        mock_session = MagicMock()
        mock_session.execute = _execute
        mock_session.add = MagicMock()
        mock_session.flush = _flush
        mock_session.rollback = AsyncMock()

        with pytest.raises(HTTPException) as exc_info:
            await submit_ballot(
                db=mock_session,  # type: ignore[arg-type]
                general_meeting_id=general_meeting_id,
                voter_email=voter_email,
                lot_owner_ids=[lot_owner_id],
                inline_votes={},
            )
        # The service converts IntegrityError to HTTP 409
        assert exc_info.value.status_code == 409


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
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]

        proxy_email = "proxy@test.com"
        lp = LotProxy(lot_owner_id=lo.id, proxy_email=proxy_email)
        db_session.add(lp)
        await db_session.flush()
        code = await make_otp(db_session, proxy_email, agm.id)

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": proxy_email,
                "general_meeting_id": str(agm.id),
                "code": code,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["lots"]) == 1
        assert data["lots"][0]["lot_owner_id"] == str(lo.id)
        assert data["lots"][0]["is_proxy"] is True

    async def test_direct_owner_has_is_proxy_false(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """A direct lot owner gets is_proxy=False."""
        agm = building_with_agm["agm"]
        voter_email = building_with_agm["voter_email"]
        code = await make_otp(db_session, voter_email, agm.id)

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "general_meeting_id": str(agm.id),
                "code": code,
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
        code = await make_otp(db_session, voter_email, agm.id)

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "general_meeting_id": str(agm.id),
                "code": code,
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
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]

        # Also set voter as proxy for their own lot
        lp = LotProxy(lot_owner_id=lo.id, proxy_email=voter_email)
        db_session.add(lp)
        await db_session.flush()
        code = await make_otp(db_session, voter_email, agm.id)

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": voter_email,
                "general_meeting_id": str(agm.id),
                "code": code,
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
        """already_submitted for proxy lot is True when lot has submitted votes for all visible motions."""
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        motions = building_with_agm["motions"]  # [m1, m2] — both visible by default

        proxy_email = "proxy2@test.com"
        lp = LotProxy(lot_owner_id=lo.id, proxy_email=proxy_email)
        db_session.add(lp)
        bs = BallotSubmission(general_meeting_id=agm.id, lot_owner_id=lo.id, voter_email=proxy_email)
        db_session.add(bs)
        # Submitted votes for all visible motions
        for motion in motions:
            v = Vote(
                general_meeting_id=agm.id,
                motion_id=motion.id,
                voter_email=proxy_email,
                lot_owner_id=lo.id,
                choice=VoteChoice.yes,
                status=VoteStatus.submitted,
            )
            db_session.add(v)
        await db_session.flush()
        code = await make_otp(db_session, proxy_email, agm.id)

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": proxy_email,
                "general_meeting_id": str(agm.id),
                "code": code,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["lots"][0]["already_submitted"] is True
        assert data["lots"][0]["is_proxy"] is True

    # --- State / precondition errors ---

    async def test_proxy_voter_no_proxy_records_returns_401(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """Email not in any owner or proxy list → 401 after OTP check passes."""
        agm = building_with_agm["agm"]
        code = await make_otp(db_session, "notaproxy@test.com", agm.id)

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": "notaproxy@test.com",
                "general_meeting_id": str(agm.id),
                "code": code,
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
        code = await make_otp(db_session, proxy_email, agm.id)

        building = building_with_agm["building"]
        response = await client.post(
            "/api/auth/verify",
            json={
                "email": proxy_email,
                "general_meeting_id": str(agm.id),
                "code": code,
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
# Hidden motions must not appear on the ballot confirmation page
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestMyBallotHiddenMotions:
    """Hidden motions (is_visible=False) must be excluded from get_my_ballot."""

    # --- Happy path ---

    async def test_hidden_motion_excluded_from_ballot_response(
        self, client: AsyncClient, db_session: AsyncSession, building_with_agm: dict
    ):
        """A hidden motion does not appear in any submitted lot's votes list."""
        building = building_with_agm["building"]
        agm = building_with_agm["agm"]
        lo = building_with_agm["lot_owner"]
        voter_email = building_with_agm["voter_email"]
        motions = building_with_agm["motions"]  # two visible motions from fixture

        # Add a hidden motion to the same AGM
        hidden_motion = Motion(
            general_meeting_id=agm.id,
            title="Hidden Motion",
            display_order=99,
            description="Should not appear",
            is_visible=False,
        )
        db_session.add(hidden_motion)
        await db_session.flush()

        # Submit votes for the two visible motions only
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

        assert len(data["submitted_lots"]) == 1
        votes = data["submitted_lots"][0]["votes"]

        # Only the two visible motions should appear
        returned_motion_ids = [v["motion_id"] for v in votes]
        assert len(returned_motion_ids) == 2
        assert str(hidden_motion.id) not in returned_motion_ids


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
        code = await make_otp(db_session, "effauth@voter.test", past_agm.id)
        await db_session.commit()

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": "effauth@voter.test",
                "general_meeting_id": str(past_agm.id),
                "code": code,
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
        code = await make_otp(db_session, "futauth@voter.test", future_agm.id)
        await db_session.commit()

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": "futauth@voter.test",
                "general_meeting_id": str(future_agm.id),
                "code": code,
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
        code = await make_otp(db_session, "openauth@voter.test", open_agm.id)
        await db_session.commit()

        response = await client.post(
            "/api/auth/verify",
            json={
                "email": "openauth@voter.test",
                "general_meeting_id": str(open_agm.id),
                "code": code,
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
