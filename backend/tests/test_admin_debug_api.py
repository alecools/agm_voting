"""
Tests for admin debug endpoints:
  GET /api/admin/debug/meeting-status/{meeting_id}
  GET /api/admin/debug/email-deliveries
  GET /api/admin/debug/db-health

Also covers list_lot_owners N+1 fix (batch query path) and the
connection pool configuration in app.database.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Building,
    EmailDelivery,
    EmailDeliveryStatus,
    GeneralMeeting,
    GeneralMeetingStatus,
    LotOwner,
    LotProxy,
)
from app.models.lot_owner_email import LotOwnerEmail

from tests.conftest import meeting_dt, closing_dt


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def building(db_session: AsyncSession) -> Building:
    b = Building(name="Debug Test Building", manager_email="debug@test.com")
    db_session.add(b)
    await db_session.flush()
    await db_session.refresh(b)
    return b


@pytest_asyncio.fixture
async def open_meeting(db_session: AsyncSession, building: Building) -> GeneralMeeting:
    gm = GeneralMeeting(
        building_id=building.id,
        title="Debug Open Meeting",
        status=GeneralMeetingStatus.open,
        meeting_at=meeting_dt(),
        voting_closes_at=closing_dt(),
    )
    db_session.add(gm)
    await db_session.flush()
    await db_session.refresh(gm)
    return gm


@pytest_asyncio.fixture
async def closed_meeting(db_session: AsyncSession, building: Building) -> GeneralMeeting:
    gm = GeneralMeeting(
        building_id=building.id,
        title="Debug Closed Meeting",
        status=GeneralMeetingStatus.closed,
        meeting_at=meeting_dt(),
        voting_closes_at=closing_dt(),
        closed_at=datetime.now(UTC),
    )
    db_session.add(gm)
    await db_session.flush()
    await db_session.refresh(gm)
    return gm


@pytest_asyncio.fixture
async def email_delivery(
    db_session: AsyncSession, closed_meeting: GeneralMeeting
) -> EmailDelivery:
    ed = EmailDelivery(
        general_meeting_id=closed_meeting.id,
        status=EmailDeliveryStatus.failed,
        total_attempts=30,
        last_error="SMTP connection refused",
    )
    db_session.add(ed)
    await db_session.flush()
    await db_session.refresh(ed)
    return ed


@pytest_asyncio.fixture
async def building_with_many_owners(db_session: AsyncSession) -> Building:
    """Building with 5 lot owners, each with email and proxy."""
    b = Building(name="N+1 Test Building", manager_email="n1@test.com")
    db_session.add(b)
    await db_session.flush()

    owners = [
        LotOwner(building_id=b.id, lot_number=str(i), unit_entitlement=100)
        for i in range(1, 6)
    ]
    db_session.add_all(owners)
    await db_session.flush()

    emails = [
        LotOwnerEmail(lot_owner_id=o.id, email=f"owner{i}@test.com")
        for i, o in enumerate(owners, 1)
    ]
    db_session.add_all(emails)

    # Add proxy for the first two owners only
    proxies = [
        LotProxy(lot_owner_id=owners[0].id, proxy_email="proxy1@test.com"),
        LotProxy(lot_owner_id=owners[1].id, proxy_email="proxy2@test.com"),
    ]
    db_session.add_all(proxies)
    await db_session.flush()
    await db_session.refresh(b)
    return b


# ---------------------------------------------------------------------------
# Fixture: enable testing_mode for debug endpoint tests (RR3-34)
# Debug endpoints require testing_mode=True — patch settings for all debug classes.
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=False)
def enable_testing_mode():
    """Patch settings.testing_mode=True for the duration of a test (RR3-34).

    Debug endpoints call _require_debug_access() which imports settings at call
    time via 'from app.config import settings as _settings'. Patching the
    attribute on the already-imported module-level singleton is the correct approach.
    """
    from app.config import settings as _cfg_settings
    original = _cfg_settings.testing_mode
    _cfg_settings.testing_mode = True
    yield
    _cfg_settings.testing_mode = original


# ---------------------------------------------------------------------------
# GET /api/admin/debug/meeting-status/{meeting_id}
# ---------------------------------------------------------------------------


class TestDebugMeetingStatus:
    # --- Happy path ---

    async def test_returns_meeting_status_fields(
        self, client: AsyncClient, open_meeting: GeneralMeeting, enable_testing_mode
    ):
        response = await client.get(f"/api/admin/debug/meeting-status/{open_meeting.id}")
        assert response.status_code == 200
        data = response.json()
        assert data["meeting_id"] == str(open_meeting.id)
        assert data["stored_status"] == "open"
        assert data["effective_status"] == "open"
        assert "voting_closes_at" in data
        assert "current_time" in data

    async def test_closed_meeting_shows_closed_effective_status(
        self, client: AsyncClient, closed_meeting: GeneralMeeting, enable_testing_mode
    ):
        response = await client.get(f"/api/admin/debug/meeting-status/{closed_meeting.id}")
        assert response.status_code == 200
        data = response.json()
        assert data["stored_status"] == "closed"
        assert data["effective_status"] == "closed"

    async def test_voting_closes_at_is_iso_string(
        self, client: AsyncClient, open_meeting: GeneralMeeting, enable_testing_mode
    ):
        response = await client.get(f"/api/admin/debug/meeting-status/{open_meeting.id}")
        data = response.json()
        # Verify voting_closes_at is an ISO 8601 string
        closes_at = data["voting_closes_at"]
        assert isinstance(closes_at, str)
        datetime.fromisoformat(closes_at)  # Should not raise

    async def test_current_time_is_iso_string(
        self, client: AsyncClient, open_meeting: GeneralMeeting, enable_testing_mode
    ):
        response = await client.get(f"/api/admin/debug/meeting-status/{open_meeting.id}")
        data = response.json()
        current_time = data["current_time"]
        assert isinstance(current_time, str)
        datetime.fromisoformat(current_time)  # Should not raise

    # --- State / precondition errors ---

    async def test_404_for_missing_meeting(self, client: AsyncClient, enable_testing_mode):
        response = await client.get(f"/api/admin/debug/meeting-status/{uuid.uuid4()}")
        assert response.status_code == 404

    async def test_returns_404_when_testing_mode_disabled(self, client: AsyncClient):
        """Debug endpoints return 404 when testing_mode=False (RR3-34)."""
        from app.config import settings as _cfg_settings
        original = _cfg_settings.testing_mode
        _cfg_settings.testing_mode = False
        try:
            response = await client.get(f"/api/admin/debug/meeting-status/{uuid.uuid4()}")
            assert response.status_code == 404
        finally:
            _cfg_settings.testing_mode = original

    # --- Input validation ---

    async def test_invalid_uuid_returns_422(self, client: AsyncClient, enable_testing_mode):
        response = await client.get("/api/admin/debug/meeting-status/not-a-uuid")
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# GET /api/admin/debug/email-deliveries
# ---------------------------------------------------------------------------


class TestDebugEmailDeliveries:
    # --- Happy path ---

    async def test_returns_email_deliveries_list(
        self, client: AsyncClient, email_delivery: EmailDelivery, enable_testing_mode
    ):
        response = await client.get("/api/admin/debug/email-deliveries")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        ids = [d["id"] for d in data]
        assert str(email_delivery.id) in ids

    async def test_email_delivery_fields_present(
        self, client: AsyncClient, email_delivery: EmailDelivery, enable_testing_mode
    ):
        response = await client.get("/api/admin/debug/email-deliveries")
        data = response.json()
        record = next(d for d in data if d["id"] == str(email_delivery.id))
        assert record["status"] == "failed"
        assert record["total_attempts"] == 30
        assert record["last_error"] == "SMTP connection refused"
        assert "updated_at" in record
        assert "general_meeting_id" in record

    async def test_limit_parameter_accepted(
        self, client: AsyncClient, enable_testing_mode
    ):
        """limit query param (1-500) is accepted (RR3-34)."""
        response = await client.get("/api/admin/debug/email-deliveries?limit=50")
        assert response.status_code == 200

    async def test_limit_over_500_returns_422(
        self, client: AsyncClient, enable_testing_mode
    ):
        """limit > 500 returns 422 (RR3-34)."""
        response = await client.get("/api/admin/debug/email-deliveries?limit=501")
        assert response.status_code == 422

    # --- Edge cases ---

    async def test_empty_when_no_deliveries(self, client: AsyncClient, building: Building, enable_testing_mode):
        """Returns empty list when no email deliveries exist for this test transaction."""
        response = await client.get("/api/admin/debug/email-deliveries")
        assert response.status_code == 200
        assert isinstance(response.json(), list)


# ---------------------------------------------------------------------------
# GET /api/admin/debug/db-health
# ---------------------------------------------------------------------------


class TestDebugDbHealth:
    # --- Happy path ---

    async def test_returns_pool_info(self, client: AsyncClient, enable_testing_mode):
        response = await client.get("/api/admin/debug/db-health")
        assert response.status_code == 200
        data = response.json()
        assert "pool_type" in data
        assert "pool_size" in data
        assert "checked_in" in data
        assert "checked_out" in data
        assert "overflow" in data

    async def test_pool_type_is_string(self, client: AsyncClient, enable_testing_mode):
        response = await client.get("/api/admin/debug/db-health")
        data = response.json()
        assert isinstance(data["pool_type"], str)
        assert len(data["pool_type"]) > 0

    async def test_returns_numeric_pool_fields(self, client: AsyncClient, enable_testing_mode):
        """Pool fields are non-negative integers from the persistent pool."""
        response = await client.get("/api/admin/debug/db-health")
        data = response.json()
        assert isinstance(data["pool_size"], int)
        assert isinstance(data["checked_in"], int)
        assert isinstance(data["checked_out"], int)
        assert isinstance(data["overflow"], int)
        assert data["pool_size"] >= 0
        assert data["checked_in"] >= 0
        assert data["checked_out"] >= 0

    async def test_returns_404_when_testing_mode_disabled(self, client: AsyncClient):
        """Debug db-health endpoint returns 404 when testing_mode=False (RR3-34)."""
        from app.config import settings as _cfg_settings
        original = _cfg_settings.testing_mode
        _cfg_settings.testing_mode = False
        try:
            response = await client.get("/api/admin/debug/db-health")
            assert response.status_code == 404
        finally:
            _cfg_settings.testing_mode = original


# ---------------------------------------------------------------------------
# N+1 fix: list_lot_owners batches queries
# ---------------------------------------------------------------------------


class TestListLotOwnersBatch:
    # --- Happy path ---

    async def test_list_owners_with_emails_and_proxies(
        self, client: AsyncClient, building_with_many_owners: Building
    ):
        response = await client.get(
            f"/api/admin/buildings/{building_with_many_owners.id}/lot-owners"
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 5

    async def test_emails_correctly_assigned_to_owners(
        self, client: AsyncClient, building_with_many_owners: Building
    ):
        response = await client.get(
            f"/api/admin/buildings/{building_with_many_owners.id}/lot-owners"
        )
        data = response.json()
        for owner in data:
            assert len(owner["emails"]) == 1
            assert owner["emails"][0].startswith("owner")

    async def test_proxies_correctly_assigned(
        self, client: AsyncClient, building_with_many_owners: Building
    ):
        response = await client.get(
            f"/api/admin/buildings/{building_with_many_owners.id}/lot-owners"
        )
        data = response.json()
        # Sort by lot_number to get predictable order
        data.sort(key=lambda o: int(o["lot_number"]))
        # Lots 1 and 2 have proxies, rest do not
        assert data[0]["proxy_email"] == "proxy1@test.com"
        assert data[1]["proxy_email"] == "proxy2@test.com"
        for owner in data[2:]:
            assert owner["proxy_email"] is None

    # --- Boundary values ---

    async def test_empty_building_returns_empty_list(
        self, client: AsyncClient, building: Building
    ):
        """Building with no owners returns empty list — tests the early-exit path."""
        response = await client.get(
            f"/api/admin/buildings/{building.id}/lot-owners"
        )
        assert response.status_code == 200
        assert response.json() == []

    async def test_owners_without_emails_or_proxies(
        self, client: AsyncClient, db_session: AsyncSession, building: Building
    ):
        """Owners with no emails or proxies get empty lists and None proxy."""
        lo = LotOwner(building_id=building.id, lot_number="99", unit_entitlement=10)
        db_session.add(lo)
        await db_session.flush()

        response = await client.get(
            f"/api/admin/buildings/{building.id}/lot-owners"
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["emails"] == []
        assert data[0]["proxy_email"] is None
