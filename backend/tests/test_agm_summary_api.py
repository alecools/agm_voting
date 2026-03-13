"""
Tests for GET /api/general-meeting/{agm_id}/summary

Covers all code paths added to app/routers/public.py and app/schemas/agm.py
for the GeneralMeeting summary endpoint.

Structure:
  # --- Happy path ---
  # --- Input validation ---
  # --- Edge cases ---
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import GeneralMeeting, GeneralMeetingStatus, Building, Motion


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def meeting_dt() -> datetime:
    return datetime.now(UTC) + timedelta(days=1)


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
async def open_agm_with_motions(db_session: AsyncSession):
    """Building + open GeneralMeeting with two motions (one has description, one does not)."""
    b = Building(name="Summary Building Open", manager_email="summary@test.com")
    db_session.add(b)
    await db_session.flush()

    agm = GeneralMeeting(
        building_id=b.id,
        title="Open Summary GeneralMeeting",
        status=GeneralMeetingStatus.open,
        # meeting_at in the past so effective status is "open" (meeting has started)
        meeting_at=datetime.now(UTC) - timedelta(hours=1),
        voting_closes_at=closing_dt(),
    )
    db_session.add(agm)
    await db_session.flush()

    m1 = Motion(general_meeting_id=agm.id, title="Motion One", order_index=1, description="Desc one")
    m2 = Motion(general_meeting_id=agm.id, title="Motion Two", order_index=2, description=None)
    db_session.add_all([m1, m2])
    await db_session.flush()

    return {"building": b, "agm": agm, "motions": [m1, m2]}


@pytest_asyncio.fixture
async def closed_agm(db_session: AsyncSession):
    """Building + closed GeneralMeeting with one motion."""
    b = Building(name="Summary Building Closed", manager_email="closed@test.com")
    db_session.add(b)
    await db_session.flush()

    agm = GeneralMeeting(
        building_id=b.id,
        title="Closed Summary GeneralMeeting",
        status=GeneralMeetingStatus.closed,
        meeting_at=meeting_dt(),
        voting_closes_at=closing_dt(),
        closed_at=datetime.now(UTC),
    )
    db_session.add(agm)
    await db_session.flush()

    m = Motion(general_meeting_id=agm.id, title="Closed Motion", order_index=1, description="Details")
    db_session.add(m)
    await db_session.flush()

    return {"building": b, "agm": agm, "motions": [m]}


@pytest_asyncio.fixture
async def agm_no_motions(db_session: AsyncSession):
    """Building + open GeneralMeeting with zero motions."""
    b = Building(name="Summary Building NoMotions", manager_email="nomotions@test.com")
    db_session.add(b)
    await db_session.flush()

    agm = GeneralMeeting(
        building_id=b.id,
        title="No Motions GeneralMeeting",
        status=GeneralMeetingStatus.open,
        meeting_at=meeting_dt(),
        voting_closes_at=closing_dt(),
    )
    db_session.add(agm)
    await db_session.flush()

    return {"building": b, "agm": agm}


@pytest_asyncio.fixture
async def agm_multiple_motions(db_session: AsyncSession):
    """Building + open GeneralMeeting with motions inserted in reverse order to verify ordering."""
    b = Building(name="Summary Building Multi", manager_email="multi@test.com")
    db_session.add(b)
    await db_session.flush()

    agm = GeneralMeeting(
        building_id=b.id,
        title="Multi Motion GeneralMeeting",
        status=GeneralMeetingStatus.open,
        meeting_at=meeting_dt(),
        voting_closes_at=closing_dt(),
    )
    db_session.add(agm)
    await db_session.flush()

    # Insert in reverse order to test ORDER BY order_index
    m3 = Motion(general_meeting_id=agm.id, title="Motion C", order_index=3)
    m1 = Motion(general_meeting_id=agm.id, title="Motion A", order_index=1)
    m2 = Motion(general_meeting_id=agm.id, title="Motion B", order_index=2)
    db_session.add_all([m3, m1, m2])
    await db_session.flush()

    return {"building": b, "agm": agm, "motions": [m1, m2, m3]}


# ---------------------------------------------------------------------------
# GET /api/general-meeting/{agm_id}/summary
# ---------------------------------------------------------------------------


class TestAGMSummary:
    # --- Happy path ---

    async def test_open_agm_returns_200(
        self, client: AsyncClient, open_agm_with_motions: dict
    ):
        agm = open_agm_with_motions["agm"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        assert response.status_code == 200

    async def test_open_agm_returns_correct_agm_id(
        self, client: AsyncClient, open_agm_with_motions: dict
    ):
        agm = open_agm_with_motions["agm"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        data = response.json()
        assert data["general_meeting_id"] == str(agm.id)

    async def test_open_agm_returns_building_id(
        self, client: AsyncClient, open_agm_with_motions: dict
    ):
        agm = open_agm_with_motions["agm"]
        building = open_agm_with_motions["building"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        data = response.json()
        assert data["building_id"] == str(building.id)

    async def test_open_agm_returns_correct_title(
        self, client: AsyncClient, open_agm_with_motions: dict
    ):
        agm = open_agm_with_motions["agm"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        data = response.json()
        assert data["title"] == "Open Summary GeneralMeeting"

    async def test_open_agm_returns_status_open(
        self, client: AsyncClient, open_agm_with_motions: dict
    ):
        agm = open_agm_with_motions["agm"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        data = response.json()
        assert data["status"] == "open"

    async def test_open_agm_returns_meeting_at(
        self, client: AsyncClient, open_agm_with_motions: dict
    ):
        agm = open_agm_with_motions["agm"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        data = response.json()
        assert "meeting_at" in data
        assert data["meeting_at"] is not None

    async def test_open_agm_returns_voting_closes_at(
        self, client: AsyncClient, open_agm_with_motions: dict
    ):
        agm = open_agm_with_motions["agm"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        data = response.json()
        assert "voting_closes_at" in data
        assert data["voting_closes_at"] is not None

    async def test_open_agm_returns_building_name(
        self, client: AsyncClient, open_agm_with_motions: dict
    ):
        agm = open_agm_with_motions["agm"]
        building = open_agm_with_motions["building"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        data = response.json()
        assert data["building_name"] == building.name

    async def test_open_agm_returns_two_motions(
        self, client: AsyncClient, open_agm_with_motions: dict
    ):
        agm = open_agm_with_motions["agm"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        data = response.json()
        assert len(data["motions"]) == 2

    async def test_motion_fields_present(
        self, client: AsyncClient, open_agm_with_motions: dict
    ):
        agm = open_agm_with_motions["agm"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        motion = response.json()["motions"][0]
        assert "order_index" in motion
        assert "title" in motion
        assert "description" in motion

    async def test_motion_with_description_is_returned(
        self, client: AsyncClient, open_agm_with_motions: dict
    ):
        agm = open_agm_with_motions["agm"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        motions = response.json()["motions"]
        # First motion (order_index=1) has description
        assert motions[0]["description"] == "Desc one"

    async def test_motion_with_null_description_is_null(
        self, client: AsyncClient, open_agm_with_motions: dict
    ):
        agm = open_agm_with_motions["agm"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        motions = response.json()["motions"]
        # Second motion (order_index=2) has no description
        assert motions[1]["description"] is None

    async def test_closed_agm_returns_200(
        self, client: AsyncClient, closed_agm: dict
    ):
        agm = closed_agm["agm"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        assert response.status_code == 200

    async def test_closed_agm_returns_status_closed(
        self, client: AsyncClient, closed_agm: dict
    ):
        agm = closed_agm["agm"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        data = response.json()
        assert data["status"] == "closed"

    async def test_closed_agm_returns_correct_building_name(
        self, client: AsyncClient, closed_agm: dict
    ):
        agm = closed_agm["agm"]
        building = closed_agm["building"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        assert response.json()["building_name"] == building.name

    async def test_motions_returned_in_ascending_order_index(
        self, client: AsyncClient, agm_multiple_motions: dict
    ):
        agm = agm_multiple_motions["agm"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        motions = response.json()["motions"]
        order_indices = [m["order_index"] for m in motions]
        assert order_indices == sorted(order_indices)

    async def test_motions_titles_in_correct_order(
        self, client: AsyncClient, agm_multiple_motions: dict
    ):
        agm = agm_multiple_motions["agm"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        titles = [m["title"] for m in response.json()["motions"]]
        assert titles == ["Motion A", "Motion B", "Motion C"]

    async def test_zero_motions_returns_empty_list(
        self, client: AsyncClient, agm_no_motions: dict
    ):
        agm = agm_no_motions["agm"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        assert response.status_code == 200
        assert response.json()["motions"] == []

    # --- Input validation ---

    async def test_nonexistent_agm_returns_404(self, client: AsyncClient):
        response = await client.get(f"/api/general-meeting/{uuid.uuid4()}/summary")
        assert response.status_code == 404

    async def test_malformed_uuid_returns_422(self, client: AsyncClient):
        response = await client.get("/api/general-meeting/not-a-uuid/summary")
        assert response.status_code == 422

    # --- Edge cases ---

    async def test_no_auth_header_still_returns_200(
        self, client: AsyncClient, open_agm_with_motions: dict
    ):
        """Endpoint requires no authentication — unauthenticated requests succeed."""
        agm = open_agm_with_motions["agm"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        assert response.status_code == 200

    async def test_request_with_irrelevant_auth_header_still_returns_200(
        self, client: AsyncClient, open_agm_with_motions: dict
    ):
        """Supplying a token header does not break the public endpoint."""
        agm = open_agm_with_motions["agm"]
        response = await client.get(
            f"/api/general-meeting/{agm.id}/summary",
            headers={"Authorization": "Bearer sometoken"},
        )
        assert response.status_code == 200

    async def test_motion_type_returned_in_summary(
        self, client: AsyncClient, open_agm_with_motions: dict
    ):
        """motion_type field is present in each motion of the summary response."""
        agm = open_agm_with_motions["agm"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        assert response.status_code == 200
        for motion in response.json()["motions"]:
            assert "motion_type" in motion
            assert motion["motion_type"] in ("general", "special")

    async def test_motion_type_defaults_to_general_in_summary(
        self, client: AsyncClient, open_agm_with_motions: dict
    ):
        """Motions created without explicit motion_type have motion_type='general'."""
        agm = open_agm_with_motions["agm"]
        response = await client.get(f"/api/general-meeting/{agm.id}/summary")
        for motion in response.json()["motions"]:
            assert motion["motion_type"] == "general"
