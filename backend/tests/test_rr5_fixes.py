"""
Tests for RR5 backend fixes.

Covers:
- RR5-04: N+1 query in import_proxies() — batch-load existing proxies
- RR5-09: count_general_meetings() with status filter uses SQL CASE expression
- RR5-12: absent lot with no contact email produces structured log warning
- RR5-13: max_length validation on BuildingCreate, MotionAddRequest, and other user-supplied schemas
"""
from __future__ import annotations

import time
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Building,
    GeneralMeeting,
    GeneralMeetingLotWeight,
    GeneralMeetingStatus,
    LotOwner,
    LotProxy,
    Motion,
)
from app.models.lot_owner_email import LotOwnerEmail
from app.schemas.admin import (
    AddEmailRequest,
    BuildingCreate,
    BuildingUpdate,
    LotOwnerCreate,
    MotionAddRequest,
    SetProxyRequest,
)
from app.services.admin_service import count_general_meetings, import_proxies


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def meeting_dt() -> datetime:
    return datetime.now(UTC) - timedelta(hours=1)


def closing_dt() -> datetime:
    return datetime.now(UTC) + timedelta(days=7)


async def _create_building(db: AsyncSession, name: str) -> Building:
    b = Building(name=name, manager_email=f"rr5_{name.lower().replace(' ', '_')}@test.com")
    db.add(b)
    await db.flush()
    await db.refresh(b)
    return b


async def _create_lot(
    db: AsyncSession,
    building_id: uuid.UUID,
    lot_number: str,
    unit_entitlement: int = 10,
) -> LotOwner:
    lo = LotOwner(building_id=building_id, lot_number=lot_number, unit_entitlement=unit_entitlement)
    db.add(lo)
    await db.flush()
    await db.refresh(lo)
    return lo


# ---------------------------------------------------------------------------
# RR5-04: import_proxies batch-loads existing proxies — no N+1
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestImportProxiesBatchLoad:
    # --- Happy path ---

    async def test_50_proxies_import_completes_quickly(self, db_session: AsyncSession):
        """RR5-04: Importing 50 proxy rows completes in < 500 ms (no N+1 per row)."""
        building = await _create_building(db_session, "RR504 Batch Building")
        lots = []
        for i in range(50):
            lo = await _create_lot(db_session, building.id, f"L{i:03d}")
            lots.append(lo)
        await db_session.commit()

        rows = [{"lot_number": lo.lot_number, "proxy_email": f"proxy{i}@test.com"} for i, lo in enumerate(lots)]

        start = time.monotonic()
        result = await import_proxies(building.id, rows, db_session)
        elapsed_ms = (time.monotonic() - start) * 1000

        assert result["upserted"] == 50
        assert result["skipped"] == 0
        assert elapsed_ms < 500, f"import_proxies took {elapsed_ms:.0f} ms — should be < 500 ms"

    async def test_proxies_are_upserted_correctly_in_batch(self, db_session: AsyncSession):
        """RR5-04: Batch-loading produces same results as per-row approach."""
        building = await _create_building(db_session, "RR504 Upsert Building")
        lo1 = await _create_lot(db_session, building.id, "A01")
        lo2 = await _create_lot(db_session, building.id, "A02")
        # Pre-seed a proxy for lo1 to exercise the update branch
        db_session.add(LotProxy(lot_owner_id=lo1.id, proxy_email="old@test.com"))
        await db_session.commit()

        rows = [
            {"lot_number": "A01", "proxy_email": "new@test.com"},
            {"lot_number": "A02", "proxy_email": "brand-new@test.com"},
        ]
        result = await import_proxies(building.id, rows, db_session)
        assert result["upserted"] == 2
        assert result["skipped"] == 0

    async def test_empty_proxy_email_removes_nomination(self, db_session: AsyncSession):
        """RR5-04: Blank proxy_email in row removes the nomination via batch lookup."""
        building = await _create_building(db_session, "RR504 Remove Building")
        lo = await _create_lot(db_session, building.id, "R01")
        db_session.add(LotProxy(lot_owner_id=lo.id, proxy_email="to-remove@test.com"))
        await db_session.commit()

        rows = [{"lot_number": "R01", "proxy_email": ""}]
        result = await import_proxies(building.id, rows, db_session)
        assert result["removed"] == 1


# ---------------------------------------------------------------------------
# RR5-09: count_general_meetings with status filter uses SQL CASE
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestCountGeneralMeetings:
    async def _create_meeting(
        self,
        db: AsyncSession,
        name: str,
        status: GeneralMeetingStatus,
        building: Building,
        meeting_offset_hours: int = -1,
        closing_offset_days: int = 7,
    ) -> GeneralMeeting:
        agm = GeneralMeeting(
            building_id=building.id,
            title=f"RR509 {name}",
            status=status,
            meeting_at=datetime.now(UTC) + timedelta(hours=meeting_offset_hours),
            voting_closes_at=datetime.now(UTC) + timedelta(days=closing_offset_days),
        )
        db.add(agm)
        await db.flush()
        await db.refresh(agm)
        return agm

    # --- Happy path ---

    async def test_count_without_filter_returns_total(self, db_session: AsyncSession):
        """count_general_meetings with no status filter returns total count."""
        b = await _create_building(db_session, "RR509 Count Building")
        # Just verify the call works and returns a number
        count = await count_general_meetings(db_session)
        assert isinstance(count, int)
        assert count >= 0

    async def test_count_with_open_filter_returns_open_meetings(self, db_session: AsyncSession):
        """count_general_meetings(status='open') counts only open meetings."""
        b = await _create_building(db_session, "RR509 Open Filter")
        before_count = await count_general_meetings(db_session, status="open", building_id=b.id)
        await self._create_meeting(db_session, "Open1", GeneralMeetingStatus.open, b)
        await self._create_meeting(db_session, "Closed1", GeneralMeetingStatus.closed, b)
        await db_session.commit()

        after_count = await count_general_meetings(db_session, status="open", building_id=b.id)
        assert after_count == before_count + 1

    async def test_count_with_closed_filter_returns_closed_meetings(self, db_session: AsyncSession):
        """count_general_meetings(status='closed') counts closed meetings."""
        b = await _create_building(db_session, "RR509 Closed Filter")
        before_count = await count_general_meetings(db_session, status="closed", building_id=b.id)
        await self._create_meeting(db_session, "C1", GeneralMeetingStatus.closed, b)
        await db_session.commit()

        after_count = await count_general_meetings(db_session, status="closed", building_id=b.id)
        assert after_count == before_count + 1

    async def test_count_with_pending_filter_returns_pending_meetings(self, db_session: AsyncSession):
        """count_general_meetings(status='pending') counts pending meetings (meeting_at in future)."""
        b = await _create_building(db_session, "RR509 Pending Filter")
        before_count = await count_general_meetings(db_session, status="pending", building_id=b.id)
        # Pending: meeting_at in the future, voting_closes_at further in the future
        agm = GeneralMeeting(
            building_id=b.id,
            title="RR509 Pending1",
            status=GeneralMeetingStatus.pending,
            meeting_at=datetime.now(UTC) + timedelta(days=30),
            voting_closes_at=datetime.now(UTC) + timedelta(days=60),
        )
        db_session.add(agm)
        await db_session.commit()

        after_count = await count_general_meetings(db_session, status="pending", building_id=b.id)
        assert after_count == before_count + 1

    async def test_count_with_name_and_status_filter(self, db_session: AsyncSession):
        """count_general_meetings with both name and status filters works correctly."""
        b = await _create_building(db_session, "RR509 Name Status")
        before_count = await count_general_meetings(
            db_session, name="rr509unique", status="open", building_id=b.id
        )
        agm = GeneralMeeting(
            building_id=b.id,
            title="RR509UniqueTitle Open Meeting",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) - timedelta(hours=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=7),
        )
        db_session.add(agm)
        await db_session.commit()

        after_count = await count_general_meetings(
            db_session, name="rr509uniquetitle", status="open", building_id=b.id
        )
        assert after_count == before_count + 1

    async def test_count_status_filter_does_not_load_all_rows_in_python(self, db_session: AsyncSession):
        """RR5-09: count_general_meetings with status filter completes < 200 ms for 200 meetings.

        The SQL CASE approach avoids loading all rows into Python memory — the count
        is computed entirely in the database.
        """
        b = await _create_building(db_session, "RR509 Performance Building")
        for i in range(200):
            db_session.add(GeneralMeeting(
                building_id=b.id,
                title=f"RR509 Perf Meeting {i}",
                status=GeneralMeetingStatus.open,
                meeting_at=datetime.now(UTC) - timedelta(hours=1),
                voting_closes_at=datetime.now(UTC) + timedelta(days=7),
            ))
        await db_session.commit()

        start = time.monotonic()
        count = await count_general_meetings(db_session, status="open", building_id=b.id)
        elapsed_ms = (time.monotonic() - start) * 1000

        assert count >= 200
        assert elapsed_ms < 200, f"count_general_meetings took {elapsed_ms:.0f} ms — should be < 200 ms"


# ---------------------------------------------------------------------------
# RR5-12: absent lot with no contact email logs structured warning
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestAbsentLotNoContactEmailWarning:
    # --- Happy path ---

    async def test_warning_emitted_when_lot_has_no_emails(self, db_session: AsyncSession):
        """RR5-12: close_general_meeting logs lot_no_contact_email when a lot has zero emails."""
        from app.services.admin_service import close_general_meeting

        building = await _create_building(db_session, "RR512 No Email Building")
        lo = await _create_lot(db_session, building.id, "NE01")
        # Deliberately no LotOwnerEmail — lot has zero contact emails
        agm = GeneralMeeting(
            building_id=building.id,
            title="RR512 No Email Meeting",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) - timedelta(hours=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=7),
        )
        db_session.add(agm)
        await db_session.flush()
        # Add lot weight so lo is eligible (absent voter)
        db_session.add(GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=10,
        ))
        await db_session.commit()

        log_calls = []
        import app.services.admin_service as svc_module
        original_logger = svc_module.logger

        class _CapturingLogger:
            def __getattr__(self, name):
                def capture(*args, **kwargs):
                    if name == "warning":
                        log_calls.append((args, kwargs))
                    # Also forward to original to avoid breaking other logging
                    return getattr(original_logger, name)(*args, **kwargs)
                return capture

        with patch.object(svc_module, "logger", _CapturingLogger()):
            await close_general_meeting(agm.id, db_session)

        warning_events = [kw for _args, kw in log_calls if kw.get("lot_id") == str(lo.id)]
        assert len(warning_events) == 1, (
            f"Expected exactly one lot_no_contact_email warning for lot {lo.id}, "
            f"got: {log_calls}"
        )
        assert warning_events[0]["lot_number"] == "NE01"

    async def test_no_warning_emitted_when_lot_has_email(self, db_session: AsyncSession):
        """RR5-12: no lot_no_contact_email warning when the absent lot has an email."""
        from app.services.admin_service import close_general_meeting

        building = await _create_building(db_session, "RR512 Has Email Building")
        lo = await _create_lot(db_session, building.id, "HE01")
        db_session.add(LotOwnerEmail(lot_owner_id=lo.id, email="hasemail@test.com"))
        agm = GeneralMeeting(
            building_id=building.id,
            title="RR512 Has Email Meeting",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) - timedelta(hours=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=7),
        )
        db_session.add(agm)
        await db_session.flush()
        db_session.add(GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=10,
        ))
        await db_session.commit()

        log_calls = []
        import app.services.admin_service as svc_module
        original_logger = svc_module.logger

        class _CapturingLogger:
            def __getattr__(self, name):
                def capture(*args, **kwargs):
                    if name == "warning":
                        log_calls.append((args, kwargs))
                    return getattr(original_logger, name)(*args, **kwargs)
                return capture

        with patch.object(svc_module, "logger", _CapturingLogger()):
            await close_general_meeting(agm.id, db_session)

        no_email_warnings = [kw for _args, kw in log_calls if kw.get("lot_id") == str(lo.id)]
        assert len(no_email_warnings) == 0


# ---------------------------------------------------------------------------
# RR5-13: max_length validation on user-supplied schemas
# ---------------------------------------------------------------------------


class TestBuildingCreateMaxLength:
    # --- Boundary values ---

    def test_name_at_max_length_passes(self):
        data = BuildingCreate(name="A" * 255, manager_email="a@b.com")
        assert len(data.name) == 255

    def test_name_over_max_length_raises_422(self):
        with pytest.raises(ValidationError):
            BuildingCreate(name="A" * 256, manager_email="a@b.com")

    def test_email_at_max_length_passes(self):
        local = "a" * (254 - len("@b.com"))
        data = BuildingCreate(name="MyBuilding", manager_email=f"{local}@b.com")
        assert len(data.manager_email) == 254

    def test_email_over_max_length_raises_422(self):
        long_email = "a" * 250 + "@b.com"  # 256 chars
        with pytest.raises(ValidationError):
            BuildingCreate(name="MyBuilding", manager_email=long_email)


class TestBuildingUpdateMaxLength:
    def test_name_over_max_length_raises_422(self):
        with pytest.raises(ValidationError):
            BuildingUpdate(name="B" * 256)

    def test_name_at_max_length_passes(self):
        data = BuildingUpdate(name="B" * 255)
        assert len(data.name) == 255

    def test_email_over_max_length_raises_422(self):
        long_email = "b" * 250 + "@b.com"
        with pytest.raises(ValidationError):
            BuildingUpdate(manager_email=long_email)


class TestLotOwnerCreateMaxLength:
    def test_lot_number_over_max_length_raises_422(self):
        with pytest.raises(ValidationError):
            LotOwnerCreate(lot_number="L" * 256, unit_entitlement=10)

    def test_lot_number_at_max_length_passes(self):
        data = LotOwnerCreate(lot_number="L" * 255, unit_entitlement=10)
        assert len(data.lot_number) == 255

    def test_given_name_over_max_length_raises_422(self):
        with pytest.raises(ValidationError):
            LotOwnerCreate(lot_number="L1", unit_entitlement=10, given_name="G" * 256)

    def test_surname_over_max_length_raises_422(self):
        with pytest.raises(ValidationError):
            LotOwnerCreate(lot_number="L1", unit_entitlement=10, surname="S" * 256)


class TestAddEmailRequestMaxLength:
    def test_email_over_max_length_raises_422(self):
        long_email = "e" * 250 + "@x.com"
        with pytest.raises(ValidationError):
            AddEmailRequest(email=long_email)

    def test_email_at_max_length_passes(self):
        local = "e" * (254 - len("@x.com"))
        data = AddEmailRequest(email=f"{local}@x.com")
        assert len(data.email) == 254


class TestSetProxyRequestMaxLength:
    def test_proxy_email_over_max_length_raises_422(self):
        long_email = "p" * 250 + "@x.com"
        with pytest.raises(ValidationError):
            SetProxyRequest(proxy_email=long_email)

    def test_given_name_over_max_length_raises_422(self):
        with pytest.raises(ValidationError):
            SetProxyRequest(proxy_email="p@x.com", given_name="G" * 256)

    def test_surname_over_max_length_raises_422(self):
        with pytest.raises(ValidationError):
            SetProxyRequest(proxy_email="p@x.com", surname="S" * 256)


class TestMotionAddRequestMaxLength:
    def test_title_over_max_length_raises_422(self):
        with pytest.raises(ValidationError):
            MotionAddRequest(title="T" * 501)

    def test_title_at_max_length_passes(self):
        data = MotionAddRequest(title="T" * 500)
        assert len(data.title) == 500

    def test_description_over_max_length_raises_422(self):
        with pytest.raises(ValidationError):
            MotionAddRequest(title="Motion", description="D" * 5001)

    def test_description_at_max_length_passes(self):
        data = MotionAddRequest(title="Motion", description="D" * 5000)
        assert len(data.description) == 5000

    def test_motion_number_over_max_length_raises_422(self):
        with pytest.raises(ValidationError):
            MotionAddRequest(title="Motion", motion_number="N" * 51)

    def test_motion_number_at_max_length_passes(self):
        data = MotionAddRequest(title="Motion", motion_number="N" * 50)
        assert len(data.motion_number) == 50


@pytest.mark.asyncio(loop_scope="session")
class TestMotionAddRequestApiMaxLength:
    """RR5-13: API-level 422 for over-length fields on POST /api/admin/agms/{id}/motions."""

    async def _create_open_meeting(self, db_session: AsyncSession) -> GeneralMeeting:
        b = await _create_building(db_session, "RR513 API MaxLen Building")
        agm = GeneralMeeting(
            building_id=b.id,
            title="RR513 Open Meeting",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) - timedelta(hours=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=7),
        )
        db_session.add(agm)
        await db_session.commit()
        await db_session.refresh(agm)
        return agm

    async def test_over_length_title_returns_422(self, app, db_session: AsyncSession):
        agm = await self._create_open_meeting(db_session)
        payload = {"title": "T" * 501, "display_order": 1}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(f"/api/admin/general-meetings/{agm.id}/motions", json=payload)
        assert resp.status_code == 422

    async def test_over_length_description_returns_422(self, app, db_session: AsyncSession):
        agm = await self._create_open_meeting(db_session)
        payload = {"title": "Valid Title", "description": "D" * 5001, "display_order": 1}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(f"/api/admin/general-meetings/{agm.id}/motions", json=payload)
        assert resp.status_code == 422


@pytest.mark.asyncio(loop_scope="session")
class TestBuildingCreateApiMaxLength:
    """RR5-13: API-level 422 for over-length fields on POST /api/admin/buildings."""

    async def test_over_length_name_returns_422(self, app, db_session: AsyncSession):
        payload = {"name": "B" * 256, "manager_email": "mgr@test.com"}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post("/api/admin/buildings", json=payload)
        assert resp.status_code == 422

    async def test_over_length_email_returns_422(self, app, db_session: AsyncSession):
        long_email = "b" * 250 + "@test.com"
        payload = {"name": "ValidName", "manager_email": long_email}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post("/api/admin/buildings", json=payload)
        assert resp.status_code == 422
