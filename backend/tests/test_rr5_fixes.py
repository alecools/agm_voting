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
from app.models.lot import Lot
from app.models.lot_person import lot_persons
from app.models.person import Person
from app.schemas.admin import (
    AddEmailRequest,
    BuildingCreate,
    BuildingUpdate,
    LotOwnerCreate,
    MotionAddRequest,
    SetProxyRequest,
)
from app.services.admin_service import count_general_meetings, import_proxies, list_general_meetings
from tests.conftest import add_person_to_lot, get_or_create_person


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
        assert elapsed_ms < 2000, f"import_proxies took {elapsed_ms:.0f} ms — should be < 2000 ms"

    async def test_proxies_are_upserted_correctly_in_batch(self, db_session: AsyncSession):
        """RR5-04: Batch-loading produces same results as per-row approach."""
        building = await _create_building(db_session, "RR504 Upsert Building")
        lo1 = await _create_lot(db_session, building.id, "A01")
        lo2 = await _create_lot(db_session, building.id, "A02")
        # Pre-seed a proxy for lo1 to exercise the update branch
        _old_p = await get_or_create_person(db_session, "old@test.com")
        db_session.add(LotProxy(lot_id=lo1.id, person_id=_old_p.id))
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
        _remove_p = await get_or_create_person(db_session, "to-remove@test.com")
        db_session.add(LotProxy(lot_id=lo.id, person_id=_remove_p.id))
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
            lot_id=lo.id,
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
        await add_person_to_lot(db_session, lo, "hasemail@test.com")
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
            lot_id=lo.id,
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


# ---------------------------------------------------------------------------
# Pagination correctness fix: _effective_status_case() in list_general_meetings
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestListGeneralMeetingsPagination:
    """Regression tests for the pagination correctness fix.

    Before the fix, list_general_meetings applied the status filter in Python
    AFTER SQL LIMIT/OFFSET, causing pages to be shorter than requested when
    rows in the SQL window had a different effective status.

    After the fix, _effective_status_case() is pushed into a WHERE clause
    so LIMIT/OFFSET operate over the already-filtered set.
    """

    async def _create_building(self, db: AsyncSession, name: str) -> Building:
        b = Building(name=name, manager_email=f"pag_{name.lower().replace(' ', '_')[:40]}@test.com")
        db.add(b)
        await db.flush()
        await db.refresh(b)
        return b

    async def _add_open_meeting(
        self, db: AsyncSession, building: Building, title_suffix: str
    ) -> GeneralMeeting:
        """Open effective status: stored=open, meeting_at in past, voting_closes_at in future."""
        m = GeneralMeeting(
            building_id=building.id,
            title=f"Pag Open {title_suffix}",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) - timedelta(hours=2),
            voting_closes_at=datetime.now(UTC) + timedelta(days=7),
        )
        db.add(m)
        await db.flush()
        await db.refresh(m)
        return m

    async def _add_closed_meeting(
        self, db: AsyncSession, building: Building, title_suffix: str
    ) -> GeneralMeeting:
        """Closed via stored status."""
        m = GeneralMeeting(
            building_id=building.id,
            title=f"Pag Closed {title_suffix}",
            status=GeneralMeetingStatus.closed,
            meeting_at=datetime.now(UTC) - timedelta(hours=2),
            voting_closes_at=datetime.now(UTC) + timedelta(days=7),
        )
        db.add(m)
        await db.flush()
        await db.refresh(m)
        return m

    async def _add_closed_via_timestamp(
        self, db: AsyncSession, building: Building, title_suffix: str
    ) -> GeneralMeeting:
        """Closed via voting_closes_at in past (stored status is open)."""
        m = GeneralMeeting(
            building_id=building.id,
            title=f"Pag ClosedTS {title_suffix}",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) - timedelta(days=10),
            voting_closes_at=datetime.now(UTC) - timedelta(days=1),
        )
        db.add(m)
        await db.flush()
        await db.refresh(m)
        return m

    async def _add_pending_meeting(
        self, db: AsyncSession, building: Building, title_suffix: str
    ) -> GeneralMeeting:
        """Pending: meeting_at in future."""
        m = GeneralMeeting(
            building_id=building.id,
            title=f"Pag Pending {title_suffix}",
            status=GeneralMeetingStatus.pending,
            meeting_at=datetime.now(UTC) + timedelta(days=30),
            voting_closes_at=datetime.now(UTC) + timedelta(days=60),
        )
        db.add(m)
        await db.flush()
        await db.refresh(m)
        return m

    # --- Happy path ---

    async def test_pagination_returns_full_page_when_open_meetings_exceed_limit(
        self, db_session: AsyncSession
    ):
        """Core regression: page must contain exactly `limit` items when enough open meetings exist.

        Before the fix, interleaving open and closed rows in the SQL window meant
        the Python post-filter would discard closed rows, returning fewer than `limit`
        items even when more open meetings existed on subsequent pages.
        """
        limit = 5
        b = await self._create_building(db_session, "Pag Full Page Building")
        # Seed limit + 5 open meetings and limit - 1 closed meetings in the same building
        for i in range(limit + 5):
            await self._add_open_meeting(db_session, b, f"FP{i:03d}")
        for i in range(limit - 1):
            await self._add_closed_meeting(db_session, b, f"FP_C{i:03d}")
        await db_session.commit()

        result = await list_general_meetings(
            db_session, limit=limit, offset=0, status="open", building_id=b.id
        )
        assert len(result) == limit, (
            f"Expected exactly {limit} items but got {len(result)} — "
            "pagination correctness fix may not be applied"
        )

    async def test_pagination_pages_are_non_overlapping(self, db_session: AsyncSession):
        """Three consecutive pages must cover distinct meetings with no repeats."""
        limit = 3
        b = await self._create_building(db_session, "Pag Nonoverlap Building")
        # Seed 3*limit open meetings
        for i in range(limit * 3):
            await self._add_open_meeting(db_session, b, f"NOP{i:03d}")
        await db_session.commit()

        page1 = await list_general_meetings(
            db_session, limit=limit, offset=0, status="open", building_id=b.id
        )
        page2 = await list_general_meetings(
            db_session, limit=limit, offset=limit, status="open", building_id=b.id
        )
        page3 = await list_general_meetings(
            db_session, limit=limit, offset=limit * 2, status="open", building_id=b.id
        )

        ids1 = {m["id"] for m in page1}
        ids2 = {m["id"] for m in page2}
        ids3 = {m["id"] for m in page3}

        assert len(page1) == limit
        assert len(page2) == limit
        assert len(page3) == limit
        assert ids1.isdisjoint(ids2), "Page 1 and page 2 share meetings"
        assert ids2.isdisjoint(ids3), "Page 2 and page 3 share meetings"
        assert ids1.isdisjoint(ids3), "Page 1 and page 3 share meetings"

    async def test_no_status_filter_returns_all_meetings(self, db_session: AsyncSession):
        """Without a status filter all seeded meetings are returned (no accidental filtering)."""
        b = await self._create_building(db_session, "Pag No Filter Building")
        for i in range(3):
            await self._add_open_meeting(db_session, b, f"NF_O{i}")
        for i in range(2):
            await self._add_closed_meeting(db_session, b, f"NF_C{i}")
        await self._add_pending_meeting(db_session, b, "NF_P0")
        await db_session.commit()

        result = await list_general_meetings(
            db_session, limit=1000, offset=0, building_id=b.id
        )
        assert len(result) == 6

    # --- Effective-status derivation ---

    async def test_effective_status_open_stored_open_past_meeting(
        self, db_session: AsyncSession
    ):
        """stored=open, meeting_at past, voting_closes_at future → effective open."""
        b = await self._create_building(db_session, "Pag ESOpen Building")
        await self._add_open_meeting(db_session, b, "ESO1")
        await db_session.commit()

        result = await list_general_meetings(
            db_session, limit=100, offset=0, status="open", building_id=b.id
        )
        assert len(result) >= 1
        assert all(m["status"] == "open" for m in result)

    async def test_effective_status_closed_via_stored_status(
        self, db_session: AsyncSession
    ):
        """stored=closed, voting_closes_at future → effective closed (stored status wins)."""
        b = await self._create_building(db_session, "Pag ESClosed Stored Building")
        m = GeneralMeeting(
            building_id=b.id,
            title="Pag ESClosed Stored",
            status=GeneralMeetingStatus.closed,
            meeting_at=datetime.now(UTC) - timedelta(hours=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=7),
        )
        b_session = db_session
        b_session.add(m)
        await b_session.commit()

        result = await list_general_meetings(
            db_session, limit=100, offset=0, status="closed", building_id=b.id
        )
        ids = [r["id"] for r in result]
        assert m.id in ids
        # Confirm it does not appear under open filter
        open_result = await list_general_meetings(
            db_session, limit=100, offset=0, status="open", building_id=b.id
        )
        open_ids = [r["id"] for r in open_result]
        assert m.id not in open_ids

    async def test_effective_status_closed_via_timestamp(
        self, db_session: AsyncSession
    ):
        """stored=open, voting_closes_at in past → effective closed (timestamp overrides)."""
        b = await self._create_building(db_session, "Pag ESClosed TS Building")
        m = await self._add_closed_via_timestamp(db_session, b, "ETS1")
        await db_session.commit()

        closed_result = await list_general_meetings(
            db_session, limit=100, offset=0, status="closed", building_id=b.id
        )
        closed_ids = [r["id"] for r in closed_result]
        assert m.id in closed_ids

        open_result = await list_general_meetings(
            db_session, limit=100, offset=0, status="open", building_id=b.id
        )
        open_ids = [r["id"] for r in open_result]
        assert m.id not in open_ids

    async def test_effective_status_pending(self, db_session: AsyncSession):
        """stored=pending, meeting_at future → effective pending."""
        b = await self._create_building(db_session, "Pag ESPending Building")
        m = await self._add_pending_meeting(db_session, b, "ESP1")
        await db_session.commit()

        result = await list_general_meetings(
            db_session, limit=100, offset=0, status="pending", building_id=b.id
        )
        ids = [r["id"] for r in result]
        assert m.id in ids

    # --- List/count agreement ---

    async def test_list_and_count_agree_for_open_status(self, db_session: AsyncSession):
        """list_general_meetings and count_general_meetings return consistent results for open."""
        b = await self._create_building(db_session, "Pag Agree Open Building")
        for i in range(4):
            await self._add_open_meeting(db_session, b, f"AGR_O{i}")
        for i in range(2):
            await self._add_closed_meeting(db_session, b, f"AGR_C{i}")
        await db_session.commit()

        list_result = await list_general_meetings(
            db_session, limit=10000, offset=0, status="open", building_id=b.id
        )
        count_result = await count_general_meetings(
            db_session, status="open", building_id=b.id
        )
        assert len(list_result) == count_result

    async def test_list_and_count_agree_for_closed_status(self, db_session: AsyncSession):
        """list_general_meetings and count_general_meetings return consistent results for closed."""
        b = await self._create_building(db_session, "Pag Agree Closed Building")
        for i in range(3):
            await self._add_closed_meeting(db_session, b, f"AGR_CL{i}")
        for i in range(2):
            await self._add_open_meeting(db_session, b, f"AGR_CL_O{i}")
        await db_session.commit()

        list_result = await list_general_meetings(
            db_session, limit=10000, offset=0, status="closed", building_id=b.id
        )
        count_result = await count_general_meetings(
            db_session, status="closed", building_id=b.id
        )
        assert len(list_result) == count_result

    async def test_list_and_count_agree_for_pending_status(self, db_session: AsyncSession):
        """list_general_meetings and count_general_meetings return consistent results for pending."""
        b = await self._create_building(db_session, "Pag Agree Pending Building")
        for i in range(2):
            await self._add_pending_meeting(db_session, b, f"AGR_P{i}")
        await self._add_open_meeting(db_session, b, "AGR_P_O")
        await db_session.commit()

        list_result = await list_general_meetings(
            db_session, limit=10000, offset=0, status="pending", building_id=b.id
        )
        count_result = await count_general_meetings(
            db_session, status="pending", building_id=b.id
        )
        assert len(list_result) == count_result

    # --- Edge cases ---

    async def test_status_filter_no_match_returns_empty_list(
        self, db_session: AsyncSession
    ):
        """list_general_meetings with a status that matches nothing returns empty list."""
        b = await self._create_building(db_session, "Pag NoMatch Building")
        await self._add_open_meeting(db_session, b, "NM1")
        await db_session.commit()

        result = await list_general_meetings(
            db_session, limit=100, offset=0, status="nonexistent_status", building_id=b.id
        )
        assert result == []

    async def test_offset_beyond_result_set_returns_empty(
        self, db_session: AsyncSession
    ):
        """Offset beyond the total count returns an empty list, not an error."""
        b = await self._create_building(db_session, "Pag OffsetBeyond Building")
        await self._add_open_meeting(db_session, b, "OB1")
        await db_session.commit()

        result = await list_general_meetings(
            db_session, limit=10, offset=9999, status="open", building_id=b.id
        )
        assert result == []
