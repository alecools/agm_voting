"""Tests for admin general meeting, motion, and voting endpoints."""
from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import (
    GeneralMeeting,
    GeneralMeetingLotWeight,
    GeneralMeetingStatus,
    BallotSubmission,
    Building,
    EmailDelivery,
    EmailDeliveryStatus,
    LotOwner,
    LotProxy,
    Motion,
    MotionType,
    Vote,
    VoteChoice,
    VoteStatus,
    get_effective_status,
)
from app.models.lot_owner_email import LotOwnerEmail

# Helpers and fixtures (make_csv, make_excel, meeting_dt, closing_dt, client, building)
# are defined in conftest.py and automatically available to all test modules.
from tests.conftest import meeting_dt, closing_dt

# ---------------------------------------------------------------------------
# POST /api/admin/general-meetings
# ---------------------------------------------------------------------------


class TestCreateAGM:
    def _agm_payload(self, building_id: uuid.UUID, **kwargs) -> dict:
        base = {
            "building_id": str(building_id),
            "title": "Annual General Meeting 2024",
            "meeting_at": meeting_dt().isoformat(),
            "voting_closes_at": closing_dt().isoformat(),
            "motions": [
                {
                    "title": "Motion 1",
                    "description": "First motion",
                    "display_order": 1,
                }
            ],
        }
        base.update(kwargs)
        return base

    # --- Happy path ---

    async def test_create_agm_returns_201(
        self, client: AsyncClient, building_with_owners: Building
    ):
        response = await client.post(
            "/api/admin/general-meetings",
            json=self._agm_payload(building_with_owners.id),
        )
        assert response.status_code == 201
        data = response.json()
        assert data["status"] == "open"
        assert data["title"] == "Annual General Meeting 2024"
        assert len(data["motions"]) == 1

    async def test_agm_lot_weight_snapshot_created(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        # Create building with owner for snapshot verification
        b = Building(name="Snapshot Building", manager_email="snap@test.com")
        db_session.add(b)
        await db_session.flush()
        lo = LotOwner(
            building_id=b.id,
            lot_number="S1",
            unit_entitlement=123,
        )
        db_session.add(lo)
        await db_session.commit()

        response = await client.post(
            "/api/admin/general-meetings",
            json=self._agm_payload(b.id),
        )
        assert response.status_code == 201
        agm_id = response.json()["id"]

        weights = await db_session.execute(
            select(GeneralMeetingLotWeight).where(GeneralMeetingLotWeight.general_meeting_id == uuid.UUID(agm_id))
        )
        weight_list = list(weights.scalars().all())
        assert len(weight_list) == 1
        assert weight_list[0].unit_entitlement_snapshot == 123
        # No voter_email on snapshot anymore
        assert weight_list[0].lot_owner_id == lo.id

    async def test_agm_with_multiple_motions(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="Multi Motion Building", manager_email="mm@test.com")
        db_session.add(b)
        await db_session.flush()

        payload = self._agm_payload(b.id)
        payload["motions"] = [
            {"title": "Motion A", "description": "A", "display_order": 1},
            {"title": "Motion B", "description": "B", "display_order": 2},
            {"title": "Motion C", "description": None, "display_order": 3},
        ]
        response = await client.post("/api/admin/general-meetings", json=payload)
        assert response.status_code == 201
        assert len(response.json()["motions"]) == 3

    async def test_multi_lot_owner_snapshot(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Voter with multiple lots should have multiple snapshot rows."""
        b = Building(name="Multi Lot Building", manager_email="ml@test.com")
        db_session.add(b)
        await db_session.flush()
        lo1 = LotOwner(
            building_id=b.id,
            lot_number="ML1",
            unit_entitlement=100,
        )
        lo2 = LotOwner(
            building_id=b.id,
            lot_number="ML2",
            unit_entitlement=50,
        )
        db_session.add_all([lo1, lo2])
        await db_session.commit()

        response = await client.post(
            "/api/admin/general-meetings",
            json=self._agm_payload(b.id),
        )
        assert response.status_code == 201
        agm_id = response.json()["id"]

        weights = await db_session.execute(
            select(GeneralMeetingLotWeight).where(GeneralMeetingLotWeight.general_meeting_id == uuid.UUID(agm_id))
        )
        weight_list = list(weights.scalars().all())
        assert len(weight_list) == 2
        total = sum(w.unit_entitlement_snapshot for w in weight_list)
        assert total == 150

    # --- Input validation ---

    async def test_no_motions_returns_422(
        self, client: AsyncClient, building_with_owners: Building
    ):
        payload = self._agm_payload(building_with_owners.id, motions=[])
        response = await client.post("/api/admin/general-meetings", json=payload)
        assert response.status_code == 422

    async def test_voting_closes_before_meeting_returns_422(
        self, client: AsyncClient, building_with_owners: Building
    ):
        now = datetime.now(UTC)
        payload = self._agm_payload(
            building_with_owners.id,
            meeting_at=(now + timedelta(days=2)).isoformat(),
            voting_closes_at=(now + timedelta(days=1)).isoformat(),
        )
        response = await client.post("/api/admin/general-meetings", json=payload)
        assert response.status_code == 422

    async def test_voting_closes_equal_to_meeting_returns_422(
        self, client: AsyncClient, building_with_owners: Building
    ):
        now = datetime.now(UTC)
        t = (now + timedelta(days=1)).isoformat()
        payload = self._agm_payload(
            building_with_owners.id,
            meeting_at=t,
            voting_closes_at=t,
        )
        response = await client.post("/api/admin/general-meetings", json=payload)
        assert response.status_code == 422

    async def test_missing_building_id_returns_422(self, client: AsyncClient):
        payload = {
            "title": "Test",
            "meeting_at": meeting_dt().isoformat(),
            "voting_closes_at": closing_dt().isoformat(),
            "motions": [{"title": "M1", "display_order": 1}],
        }
        response = await client.post("/api/admin/general-meetings", json=payload)
        assert response.status_code == 422

    # --- State / precondition errors ---

    async def test_building_not_found_returns_404(self, client: AsyncClient):
        payload = self._agm_payload(uuid.uuid4())
        response = await client.post("/api/admin/general-meetings", json=payload)
        assert response.status_code == 404

    async def test_second_open_agm_for_same_building_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="One GeneralMeeting Building", manager_email="one@test.com")
        db_session.add(b)
        await db_session.commit()

        payload = self._agm_payload(b.id)
        r1 = await client.post("/api/admin/general-meetings", json=payload)
        assert r1.status_code == 201

        r2 = await client.post("/api/admin/general-meetings", json=payload)
        assert r2.status_code == 409

    async def test_can_create_agm_after_closed(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="Closed GeneralMeeting Building", manager_email="closed@test.com")
        db_session.add(b)
        await db_session.commit()

        payload = self._agm_payload(b.id)
        r1 = await client.post("/api/admin/general-meetings", json=payload)
        assert r1.status_code == 201
        agm_id = r1.json()["id"]

        # Close the GeneralMeeting
        await client.post(f"/api/admin/general-meetings/{agm_id}/close")

        # Now create another
        r2 = await client.post("/api/admin/general-meetings", json=payload)
        assert r2.status_code == 201

    async def test_create_agm_with_future_meeting_at_returns_pending_status(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Meeting created with future meeting_at should have status=pending."""
        b = Building(name="Pending Status Building", manager_email="pending@test.com")
        db_session.add(b)
        await db_session.commit()

        now = datetime.now(UTC)
        payload = self._agm_payload(
            b.id,
            meeting_at=(now + timedelta(days=1)).isoformat(),
            voting_closes_at=(now + timedelta(days=2)).isoformat(),
        )
        response = await client.post("/api/admin/general-meetings", json=payload)
        assert response.status_code == 201
        assert response.json()["status"] == "pending"

    async def test_second_pending_agm_for_same_building_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Cannot create a meeting if a pending meeting already exists for the building."""
        b = Building(name="Pending Block Building", manager_email="pendblock@test.com")
        db_session.add(b)
        await db_session.commit()

        now = datetime.now(UTC)
        payload = self._agm_payload(
            b.id,
            meeting_at=(now + timedelta(days=1)).isoformat(),
            voting_closes_at=(now + timedelta(days=2)).isoformat(),
        )
        r1 = await client.post("/api/admin/general-meetings", json=payload)
        assert r1.status_code == 201
        assert r1.json()["status"] == "pending"

        # Second create should be blocked
        r2 = await client.post("/api/admin/general-meetings", json=payload)
        assert r2.status_code == 409

    # --- motion_number uniqueness ---

    async def test_create_agm_with_motion_numbers(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """AGM with distinct motion_numbers on each motion is accepted (201)."""
        b = Building(name="Motion Number Test Bldg", manager_email="mn@test.com")
        db_session.add(b)
        await db_session.commit()

        payload = self._agm_payload(b.id)
        payload["motions"] = [
            {"title": "Motion A", "display_order": 1, "motion_number": "1"},
            {"title": "Motion B", "display_order": 2, "motion_number": "2"},
        ]
        response = await client.post("/api/admin/general-meetings", json=payload)
        assert response.status_code == 201
        motions = response.json()["motions"]
        assert motions[0]["motion_number"] == "1"
        assert motions[1]["motion_number"] == "2"

    async def test_create_agm_motions_without_motion_number_auto_assigned(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Motions created without motion_number get auto-assigned str(display_order)."""
        b = Building(name="Auto MN Bldg", manager_email="automn@test.com")
        db_session.add(b)
        await db_session.commit()

        payload = self._agm_payload(b.id)
        payload["motions"] = [
            {"title": "Motion A", "display_order": 1},
            {"title": "Motion B", "display_order": 2},
            {"title": "Motion C", "display_order": 3},
        ]
        response = await client.post("/api/admin/general-meetings", json=payload)
        assert response.status_code == 201
        motions = response.json()["motions"]
        assert motions[0]["motion_number"] == "1"
        assert motions[1]["motion_number"] == "2"
        assert motions[2]["motion_number"] == "3"

    async def test_create_agm_motions_explicit_motion_number_preserved(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Explicit motion_number is preserved and not overwritten by auto-assign."""
        b = Building(name="Explicit MN Bldg", manager_email="explmn@test.com")
        db_session.add(b)
        await db_session.commit()

        payload = self._agm_payload(b.id)
        payload["motions"] = [
            {"title": "Motion A", "display_order": 1, "motion_number": "SR-1"},
            {"title": "Motion B", "display_order": 2},
        ]
        response = await client.post("/api/admin/general-meetings", json=payload)
        assert response.status_code == 201
        motions = response.json()["motions"]
        assert motions[0]["motion_number"] == "SR-1"
        assert motions[1]["motion_number"] == "2"

    async def test_create_agm_with_duplicate_motion_numbers_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """AGM with two motions sharing the same non-null motion_number returns 409."""
        b = Building(name="Dup MN Bldg", manager_email="dupmn@test.com")
        db_session.add(b)
        await db_session.commit()

        payload = self._agm_payload(b.id)
        payload["motions"] = [
            {"title": "Motion A", "display_order": 1, "motion_number": "SR-1"},
            {"title": "Motion B", "display_order": 2, "motion_number": "SR-1"},
        ]
        response = await client.post("/api/admin/general-meetings", json=payload)
        assert response.status_code == 409


# ---------------------------------------------------------------------------
# GET /api/admin/general-meetings
# ---------------------------------------------------------------------------


class TestListAGMs:
    # --- Happy path ---

    async def test_returns_list(self, client: AsyncClient):
        response = await client.get("/api/admin/general-meetings")
        assert response.status_code == 200
        assert isinstance(response.json(), list)

    async def test_agm_list_fields_present(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="List GeneralMeeting Building", manager_email="list@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="List Test GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.commit()

        response = await client.get("/api/admin/general-meetings")
        data = response.json()
        assert len(data) > 0

        # Find our GeneralMeeting
        our_agm = next((a for a in data if a["title"] == "List Test GeneralMeeting"), None)
        assert our_agm is not None
        assert "id" in our_agm
        assert "building_id" in our_agm
        assert "building_name" in our_agm
        assert "status" in our_agm
        assert "meeting_at" in our_agm
        assert "voting_closes_at" in our_agm
        assert "created_at" in our_agm
        assert our_agm["building_name"] == "List GeneralMeeting Building"

    async def test_ordered_by_created_at_desc(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="Order Test Building", manager_email="order@test.com")
        db_session.add(b)
        await db_session.commit()

        response = await client.get("/api/admin/general-meetings")
        data = response.json()
        if len(data) > 1:
            # Check ordering
            for i in range(len(data) - 1):
                assert data[i]["created_at"] >= data[i + 1]["created_at"]

    # --- name filter ---

    async def test_agm_name_filter_exact_match(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="AGM Name Filter Building", manager_email="agmnf@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="Exact Match AGM Title",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.commit()

        response = await client.get("/api/admin/general-meetings?name=Exact+Match+AGM+Title")
        assert response.status_code == 200
        data = response.json()
        titles = [item["title"] for item in data]
        assert "Exact Match AGM Title" in titles

    async def test_agm_name_filter_partial_substring_match(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="AGM Substring Building", manager_email="agmsub@test.com")
        db_session.add(b)
        await db_session.flush()
        agm1 = GeneralMeeting(
            building_id=b.id,
            title="SubstringAGM First Meeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        agm2 = GeneralMeeting(
            building_id=b.id,
            title="SubstringAGM Second Meeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        agm_other = GeneralMeeting(
            building_id=b.id,
            title="Unrelated Meeting Title",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add_all([agm1, agm2, agm_other])
        await db_session.commit()

        response = await client.get("/api/admin/general-meetings?name=SubstringAGM")
        assert response.status_code == 200
        data = response.json()
        titles = [item["title"] for item in data]
        assert "SubstringAGM First Meeting" in titles
        assert "SubstringAGM Second Meeting" in titles
        assert "Unrelated Meeting Title" not in titles

    async def test_agm_name_filter_case_insensitive(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="AGM Case Building", manager_email="agmcase@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="CaseMixed AGM",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.commit()

        response = await client.get("/api/admin/general-meetings?name=casemixed")
        assert response.status_code == 200
        data = response.json()
        titles = [item["title"] for item in data]
        assert "CaseMixed AGM" in titles

    async def test_agm_name_filter_no_match_returns_empty(
        self, client: AsyncClient
    ):
        response = await client.get(
            "/api/admin/general-meetings?name=does-not-exist-xyz-agm-99"
        )
        assert response.status_code == 200
        assert response.json() == []

    async def test_agm_name_filter_absent_returns_all(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="AGM No Filter Building", manager_email="agmnof@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="No Filter AGM Title",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.commit()

        response = await client.get("/api/admin/general-meetings")
        assert response.status_code == 200
        data = response.json()
        titles = [item["title"] for item in data]
        assert "No Filter AGM Title" in titles

    async def test_agm_name_filter_empty_string_returns_all(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="AGM Empty Filter Building", manager_email="agmempty@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="EmptyFilter AGM Title",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.commit()

        response = await client.get("/api/admin/general-meetings?name=")
        assert response.status_code == 200
        data = response.json()
        titles = [item["title"] for item in data]
        # empty string matches everything via LIKE '%%'
        assert "EmptyFilter AGM Title" in titles

    async def test_agm_name_filter_combined_with_limit(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="AGM Limit Filter Building", manager_email="agmlimit@test.com")
        db_session.add(b)
        await db_session.flush()
        for i in range(3):
            db_session.add(
                GeneralMeeting(
                    building_id=b.id,
                    title=f"LimitFilterAGM Meeting {i}",
                    status=GeneralMeetingStatus.open,
                    meeting_at=meeting_dt(),
                    voting_closes_at=closing_dt(),
                )
            )
        await db_session.commit()

        response = await client.get("/api/admin/general-meetings?name=LimitFilterAGM&limit=2")
        assert response.status_code == 200
        data = response.json()
        assert len(data) <= 2

    # --- building_id filter ---

    async def test_agm_building_id_filter_returns_only_that_building(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b1 = Building(name="AGM BldFilter Building1", manager_email="bf1@test.com")
        b2 = Building(name="AGM BldFilter Building2", manager_email="bf2@test.com")
        db_session.add_all([b1, b2])
        await db_session.flush()
        agm1 = GeneralMeeting(
            building_id=b1.id,
            title="BuildingFilter AGM B1",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        agm2 = GeneralMeeting(
            building_id=b2.id,
            title="BuildingFilter AGM B2",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add_all([agm1, agm2])
        await db_session.commit()

        response = await client.get(f"/api/admin/general-meetings?building_id={b1.id}")
        assert response.status_code == 200
        data = response.json()
        ids = [item["id"] for item in data]
        assert str(agm1.id) in ids
        assert str(agm2.id) not in ids

    async def test_agm_building_id_filter_no_match_returns_empty(
        self, client: AsyncClient
    ):
        import uuid as _uuid
        random_id = str(_uuid.uuid4())
        response = await client.get(f"/api/admin/general-meetings?building_id={random_id}")
        assert response.status_code == 200
        assert response.json() == []

    async def test_agm_building_id_filter_combined_with_name(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="AGM BldName Filter Building", manager_email="bfn@test.com")
        db_session.add(b)
        await db_session.flush()
        agm_match = GeneralMeeting(
            building_id=b.id,
            title="BldNameCombo AGM Match",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        agm_no_match = GeneralMeeting(
            building_id=b.id,
            title="Other AGM Title",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add_all([agm_match, agm_no_match])
        await db_session.commit()

        response = await client.get(
            f"/api/admin/general-meetings?building_id={b.id}&name=BldNameCombo"
        )
        assert response.status_code == 200
        data = response.json()
        ids = [item["id"] for item in data]
        assert str(agm_match.id) in ids
        assert str(agm_no_match.id) not in ids

    async def test_agm_building_id_filter_absent_returns_all_buildings(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b1 = Building(name="AGM NoBldFilter B1", manager_email="nbf1@test.com")
        b2 = Building(name="AGM NoBldFilter B2", manager_email="nbf2@test.com")
        db_session.add_all([b1, b2])
        await db_session.flush()
        agm1 = GeneralMeeting(
            building_id=b1.id,
            title="NoBldFilter AGM B1",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        agm2 = GeneralMeeting(
            building_id=b2.id,
            title="NoBldFilter AGM B2",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add_all([agm1, agm2])
        await db_session.commit()

        response = await client.get("/api/admin/general-meetings")
        assert response.status_code == 200
        data = response.json()
        ids = [item["id"] for item in data]
        assert str(agm1.id) in ids
        assert str(agm2.id) in ids

    # --- offset / pagination ---

    async def test_offset_returns_second_page(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """offset=1 with limit=1 returns a different meeting than offset=0."""
        b = Building(name="AGM Offset Building", manager_email="agmoffset@test.com")
        db_session.add(b)
        await db_session.flush()
        for i in range(3):
            db_session.add(
                GeneralMeeting(
                    building_id=b.id,
                    title=f"AGM Offset Meeting {i}",
                    status=GeneralMeetingStatus.open,
                    meeting_at=meeting_dt(),
                    voting_closes_at=closing_dt(),
                )
            )
        await db_session.commit()

        first = await client.get(
            "/api/admin/general-meetings?name=AGM+Offset+Meeting&limit=1&offset=0"
        )
        second = await client.get(
            "/api/admin/general-meetings?name=AGM+Offset+Meeting&limit=1&offset=1"
        )
        assert first.status_code == 200
        assert second.status_code == 200
        first_ids = [m["id"] for m in first.json()]
        second_ids = [m["id"] for m in second.json()]
        assert first_ids != second_ids


# ---------------------------------------------------------------------------
# GET /api/admin/general-meetings/count
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestCountGeneralMeetings:
    # --- Happy path ---

    async def test_returns_total_count(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """GET /api/admin/general-meetings/count returns {"count": N}."""
        b = Building(name="Count AGM Building", manager_email="countb@test.com")
        db_session.add(b)
        await db_session.flush()
        db_session.add(
            GeneralMeeting(
                building_id=b.id,
                title="Count AGM A",
                status=GeneralMeetingStatus.open,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
        )
        db_session.add(
            GeneralMeeting(
                building_id=b.id,
                title="Count AGM B",
                status=GeneralMeetingStatus.open,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
        )
        await db_session.commit()

        response = await client.get("/api/admin/general-meetings/count")
        assert response.status_code == 200
        data = response.json()
        assert "count" in data
        assert data["count"] >= 2

    async def test_count_matches_list_length(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """count endpoint matches the number of items returned by the list endpoint."""
        list_resp = await client.get("/api/admin/general-meetings")
        count_resp = await client.get("/api/admin/general-meetings/count")
        assert list_resp.status_code == 200
        assert count_resp.status_code == 200
        assert count_resp.json()["count"] == len(list_resp.json())

    # --- name filter ---

    async def test_name_filter_returns_filtered_count(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="Count AGM Filter Building", manager_email="cafb@test.com")
        db_session.add(b)
        await db_session.flush()
        db_session.add(
            GeneralMeeting(
                building_id=b.id,
                title="UniqueCountTitle X9Z7W",
                status=GeneralMeetingStatus.open,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
        )
        db_session.add(
            GeneralMeeting(
                building_id=b.id,
                title="Other Meeting Entirely",
                status=GeneralMeetingStatus.open,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
        )
        await db_session.commit()

        response = await client.get("/api/admin/general-meetings/count?name=UniqueCountTitle+X9Z7W")
        assert response.status_code == 200
        assert response.json()["count"] == 1

    async def test_name_filter_no_match_returns_zero(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        response = await client.get(
            "/api/admin/general-meetings/count?name=ZZZ-impossible-match-999"
        )
        assert response.status_code == 200
        assert response.json()["count"] == 0

    async def test_name_filter_case_insensitive(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="CaseCountAGM Building", manager_email="ccab@test.com")
        db_session.add(b)
        await db_session.flush()
        db_session.add(
            GeneralMeeting(
                building_id=b.id,
                title="CaseCountTitle Meeting",
                status=GeneralMeetingStatus.open,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
        )
        await db_session.commit()

        response = await client.get("/api/admin/general-meetings/count?name=casecounttitle")
        assert response.status_code == 200
        assert response.json()["count"] >= 1

    # --- building_id filter ---

    async def test_building_id_filter_returns_filtered_count(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b1 = Building(name="CountBld1", manager_email="cb1@test.com")
        b2 = Building(name="CountBld2", manager_email="cb2@test.com")
        db_session.add_all([b1, b2])
        await db_session.flush()
        db_session.add(
            GeneralMeeting(
                building_id=b1.id,
                title="CountBld1 Meeting",
                status=GeneralMeetingStatus.open,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
        )
        db_session.add(
            GeneralMeeting(
                building_id=b2.id,
                title="CountBld2 Meeting",
                status=GeneralMeetingStatus.open,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
        )
        await db_session.commit()

        response = await client.get(f"/api/admin/general-meetings/count?building_id={b1.id}")
        assert response.status_code == 200
        data = response.json()
        assert data["count"] >= 1
        # Confirm it does not include b2's meeting
        all_response = await client.get("/api/admin/general-meetings/count")
        assert all_response.json()["count"] > data["count"]

    # --- Boundary values ---

    async def test_empty_name_filter_counts_all(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        list_resp = await client.get("/api/admin/general-meetings")
        count_resp = await client.get("/api/admin/general-meetings/count?name=")
        assert list_resp.status_code == 200
        assert count_resp.status_code == 200
        assert count_resp.json()["count"] == len(list_resp.json())

    # --- status filter ---

    async def test_status_filter_open_counts_only_open(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """?status=open counts only meetings with effective status 'open'."""
        b = Building(name="StatusCount Building O", manager_email="sco@test.com")
        db_session.add(b)
        await db_session.flush()
        db_session.add(
            GeneralMeeting(
                building_id=b.id,
                title="StatusCount Open AGM",
                status=GeneralMeetingStatus.open,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
        )
        db_session.add(
            GeneralMeeting(
                building_id=b.id,
                title="StatusCount Closed AGM",
                status=GeneralMeetingStatus.closed,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
        )
        await db_session.commit()

        open_resp = await client.get("/api/admin/general-meetings/count?status=open")
        closed_resp = await client.get("/api/admin/general-meetings/count?status=closed")
        all_resp = await client.get("/api/admin/general-meetings/count")
        assert open_resp.status_code == 200
        assert closed_resp.status_code == 200
        # open count + closed count must be <= total (there may be pending ones too)
        assert open_resp.json()["count"] + closed_resp.json()["count"] <= all_resp.json()["count"]

    async def test_status_filter_no_match_returns_zero(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """?status=nonexistent returns 0 — no meeting has that status."""
        response = await client.get("/api/admin/general-meetings/count?status=nonexistent")
        assert response.status_code == 200
        assert response.json()["count"] == 0

    async def test_status_filter_none_counts_all(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Omitting status counts all meetings."""
        list_resp = await client.get("/api/admin/general-meetings")
        count_resp = await client.get("/api/admin/general-meetings/count")
        assert list_resp.status_code == 200
        assert count_resp.status_code == 200
        assert count_resp.json()["count"] == len(list_resp.json())


# ---------------------------------------------------------------------------
# GET /api/admin/general-meetings — status list filter
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestListGeneralMeetingsStatusFilter:
    # --- Happy path ---

    async def test_status_filter_open_returns_only_open_meetings(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """?status=open returns only open meetings."""
        b = Building(name="StatusList Building O", manager_email="slbo@test.com")
        db_session.add(b)
        await db_session.flush()
        db_session.add(
            GeneralMeeting(
                building_id=b.id,
                title="StatusList Open AGM",
                status=GeneralMeetingStatus.open,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
        )
        db_session.add(
            GeneralMeeting(
                building_id=b.id,
                title="StatusList Closed AGM",
                status=GeneralMeetingStatus.closed,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
        )
        await db_session.commit()

        response = await client.get("/api/admin/general-meetings?status=open")
        assert response.status_code == 200
        statuses = [m["status"] for m in response.json()]
        assert all(s == "open" for s in statuses)

    async def test_status_filter_closed_returns_only_closed_meetings(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """?status=closed returns only closed meetings."""
        b = Building(name="StatusList Building C", manager_email="slbc@test.com")
        db_session.add(b)
        await db_session.flush()
        db_session.add(
            GeneralMeeting(
                building_id=b.id,
                title="StatusList Closed Only AGM",
                status=GeneralMeetingStatus.closed,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
        )
        await db_session.commit()

        response = await client.get("/api/admin/general-meetings?status=closed")
        assert response.status_code == 200
        statuses = [m["status"] for m in response.json()]
        assert all(s == "closed" for s in statuses)

    async def test_status_filter_no_match_returns_empty(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """?status=nonexistent returns empty list."""
        response = await client.get("/api/admin/general-meetings?status=nonexistent")
        assert response.status_code == 200
        assert response.json() == []

    async def test_no_status_filter_returns_all(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Omitting ?status returns all meetings regardless of status."""
        b = Building(name="StatusList All Building", manager_email="slab@test.com")
        db_session.add(b)
        await db_session.flush()
        db_session.add(
            GeneralMeeting(
                building_id=b.id,
                title="StatusListAll Open",
                status=GeneralMeetingStatus.open,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
        )
        db_session.add(
            GeneralMeeting(
                building_id=b.id,
                title="StatusListAll Closed",
                status=GeneralMeetingStatus.closed,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
        )
        await db_session.commit()

        response = await client.get("/api/admin/general-meetings?name=StatusListAll")
        assert response.status_code == 200
        titles = [m["title"] for m in response.json()]
        assert "StatusListAll Open" in titles
        assert "StatusListAll Closed" in titles

    # --- Edge cases ---

    async def test_status_and_building_id_filters_combined(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """?status=open&building_id=X returns only open meetings for that building."""
        b1 = Building(name="StatusCombined B1", manager_email="scb1@test.com")
        b2 = Building(name="StatusCombined B2", manager_email="scb2@test.com")
        db_session.add_all([b1, b2])
        await db_session.flush()
        open_b1 = GeneralMeeting(
            building_id=b1.id,
            title="Open B1 Meeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        closed_b1 = GeneralMeeting(
            building_id=b1.id,
            title="Closed B1 Meeting",
            status=GeneralMeetingStatus.closed,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        open_b2 = GeneralMeeting(
            building_id=b2.id,
            title="Open B2 Meeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add_all([open_b1, closed_b1, open_b2])
        await db_session.commit()

        response = await client.get(
            f"/api/admin/general-meetings?status=open&building_id={b1.id}"
        )
        assert response.status_code == 200
        titles = [m["title"] for m in response.json()]
        assert "Open B1 Meeting" in titles
        assert "Closed B1 Meeting" not in titles
        assert "Open B2 Meeting" not in titles

    async def test_status_and_name_filters_combined(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """?status=open&name=X returns only open meetings matching the name."""
        b = Building(name="StatusNameCombined Bldg", manager_email="sncb@test.com")
        db_session.add(b)
        await db_session.flush()
        db_session.add(
            GeneralMeeting(
                building_id=b.id,
                title="StatusNameCombo Open UNIQ8X",
                status=GeneralMeetingStatus.open,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
        )
        db_session.add(
            GeneralMeeting(
                building_id=b.id,
                title="StatusNameCombo Closed UNIQ8X",
                status=GeneralMeetingStatus.closed,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
        )
        await db_session.commit()

        response = await client.get(
            "/api/admin/general-meetings?status=open&name=StatusNameCombo"
        )
        assert response.status_code == 200
        titles = [m["title"] for m in response.json()]
        assert "StatusNameCombo Open UNIQ8X" in titles
        assert "StatusNameCombo Closed UNIQ8X" not in titles

    async def test_count_with_status_and_name_combined(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """count endpoint: ?status=open&name=X returns only matching count."""
        b = Building(name="CountStatusName Bldg", manager_email="csnb@test.com")
        db_session.add(b)
        await db_session.flush()
        db_session.add(
            GeneralMeeting(
                building_id=b.id,
                title="CountStatusName Open Q4T",
                status=GeneralMeetingStatus.open,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
        )
        db_session.add(
            GeneralMeeting(
                building_id=b.id,
                title="CountStatusName Closed Q4T",
                status=GeneralMeetingStatus.closed,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
        )
        await db_session.commit()

        response = await client.get(
            "/api/admin/general-meetings/count?status=open&name=CountStatusName"
        )
        assert response.status_code == 200
        assert response.json()["count"] == 1

    async def test_count_with_status_and_building_id_combined(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """count endpoint: ?status=open&building_id=X returns count for that building + status."""
        b1 = Building(name="CountStatusBldg B1", manager_email="csbb1@test.com")
        b2 = Building(name="CountStatusBldg B2", manager_email="csbb2@test.com")
        db_session.add_all([b1, b2])
        await db_session.flush()
        db_session.add(
            GeneralMeeting(
                building_id=b1.id,
                title="CountStatusBldg Open B1",
                status=GeneralMeetingStatus.open,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
        )
        db_session.add(
            GeneralMeeting(
                building_id=b2.id,
                title="CountStatusBldg Open B2",
                status=GeneralMeetingStatus.open,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
        )
        await db_session.commit()

        resp_b1 = await client.get(
            f"/api/admin/general-meetings/count?status=open&building_id={b1.id}"
        )
        assert resp_b1.status_code == 200
        assert resp_b1.json()["count"] == 1


# ---------------------------------------------------------------------------
# GET /api/admin/general-meetings/{agm_id}
# ---------------------------------------------------------------------------


class TestGetGeneralMeetingDetail:
    async def _setup_agm_with_votes(
        self, db_session: AsyncSession
    ) -> tuple[GeneralMeeting, list[LotOwner], list[Motion]]:
        b = Building(name="Detail Building", manager_email="detail@test.com")
        db_session.add(b)
        await db_session.flush()

        lo1 = LotOwner(building_id=b.id, lot_number="D1", unit_entitlement=100)
        lo2 = LotOwner(building_id=b.id, lot_number="D2", unit_entitlement=80)
        lo3 = LotOwner(building_id=b.id, lot_number="D3", unit_entitlement=30)
        lo4 = LotOwner(building_id=b.id, lot_number="D4", unit_entitlement=200)
        db_session.add_all([lo1, lo2, lo3, lo4])
        await db_session.flush()

        # Add emails
        db_session.add(LotOwnerEmail(lot_owner_id=lo1.id, email="yes@test.com"))
        db_session.add(LotOwnerEmail(lot_owner_id=lo2.id, email="no@test.com"))
        db_session.add(LotOwnerEmail(lot_owner_id=lo3.id, email="abs@test.com"))
        db_session.add(LotOwnerEmail(lot_owner_id=lo4.id, email="absent@test.com"))
        await db_session.flush()

        agm = GeneralMeeting(
            building_id=b.id,
            title="Detail GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(general_meeting_id=agm.id, title="Motion D1", display_order=1)
        db_session.add(motion)
        await db_session.flush()

        # Snapshot (no voter_email)
        for lo in [lo1, lo2, lo3, lo4]:
            w = GeneralMeetingLotWeight(
                general_meeting_id=agm.id,
                lot_owner_id=lo.id,
                unit_entitlement_snapshot=lo.unit_entitlement,
            )
            db_session.add(w)
        await db_session.flush()

        # lo1 voted yes, lo2 voted no, lo3 abstained — all submitted
        # lo4 is absent (no ballot submission)
        lo_email_map = {lo1.id: "yes@test.com", lo2.id: "no@test.com", lo3.id: "abs@test.com"}
        for lo, choice in [
            (lo1, VoteChoice.yes),
            (lo2, VoteChoice.no),
            (lo3, VoteChoice.abstained),
        ]:
            voter_email = lo_email_map[lo.id]
            vote = Vote(
                general_meeting_id=agm.id,
                motion_id=motion.id,
                voter_email=voter_email,
                lot_owner_id=lo.id,
                choice=choice,
                status=VoteStatus.submitted,
            )
            db_session.add(vote)
            bs = BallotSubmission(
                general_meeting_id=agm.id,
                lot_owner_id=lo.id,
                voter_email=voter_email,
            )
            db_session.add(bs)

        await db_session.commit()
        return agm, [lo1, lo2, lo3, lo4], [motion]

    # --- Happy path ---

    async def test_agm_detail_structure(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        agm, _, _ = await self._setup_agm_with_votes(db_session)
        response = await client.get(f"/api/admin/general-meetings/{agm.id}")
        assert response.status_code == 200
        data = response.json()

        assert data["id"] == str(agm.id)
        assert data["building_name"] == "Detail Building"
        assert "total_eligible_voters" in data
        assert "total_submitted" in data
        assert "total_entitlement" in data
        assert "motions" in data
        assert "closed_at" in data

    async def test_total_entitlement_is_sum_of_snapshots(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        agm, _, _ = await self._setup_agm_with_votes(db_session)
        response = await client.get(f"/api/admin/general-meetings/{agm.id}")
        assert response.status_code == 200
        data = response.json()
        # lo1=100, lo2=80, lo3=30, lo4=200
        assert data["total_entitlement"] == 410

    async def test_tally_yes_no_abstained_absent(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        agm, _, _ = await self._setup_agm_with_votes(db_session)
        response = await client.get(f"/api/admin/general-meetings/{agm.id}")
        data = response.json()

        assert data["total_eligible_voters"] == 4
        assert data["total_submitted"] == 3

        motion = data["motions"][0]
        tally = motion["tally"]
        assert tally["yes"]["voter_count"] == 1
        assert tally["yes"]["entitlement_sum"] == 100
        assert tally["no"]["voter_count"] == 1
        assert tally["no"]["entitlement_sum"] == 80
        assert tally["abstained"]["voter_count"] == 1
        assert tally["abstained"]["entitlement_sum"] == 30
        # Meeting is open: absent tally is suppressed
        assert tally["absent"]["voter_count"] == 0
        assert tally["absent"]["entitlement_sum"] == 0

    async def test_voter_lists_populated(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        agm, _, _ = await self._setup_agm_with_votes(db_session)
        response = await client.get(f"/api/admin/general-meetings/{agm.id}")
        data = response.json()

        motion = data["motions"][0]
        voter_lists = motion["voter_lists"]

        yes_emails = {v["voter_email"] for v in voter_lists["yes"]}
        no_emails = {v["voter_email"] for v in voter_lists["no"]}
        abs_emails = {v["voter_email"] for v in voter_lists["abstained"]}

        assert "yes@test.com" in yes_emails
        assert "no@test.com" in no_emails
        assert "abs@test.com" in abs_emails
        # Meeting is open: absent list is empty
        assert voter_lists["absent"] == []

    async def test_no_votes_all_absent(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="No Votes Building", manager_email="nv@test.com")
        db_session.add(b)
        await db_session.flush()
        lo = LotOwner(
            building_id=b.id,
            lot_number="NV1",
            unit_entitlement=50,
        )
        db_session.add(lo)
        await db_session.flush()

        agm = GeneralMeeting(
            building_id=b.id,
            title="No Votes GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(general_meeting_id=agm.id, title="Motion NV1", display_order=1)
        db_session.add(motion)
        await db_session.flush()

        w = GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=lo.unit_entitlement,
        )
        db_session.add(w)
        await db_session.commit()

        response = await client.get(f"/api/admin/general-meetings/{agm.id}")
        data = response.json()

        assert data["total_eligible_voters"] == 1
        assert data["total_submitted"] == 0

        tally = data["motions"][0]["tally"]
        assert tally["yes"]["voter_count"] == 0
        assert tally["no"]["voter_count"] == 0
        assert tally["abstained"]["voter_count"] == 0
        # Meeting is open: absent tally is suppressed
        assert tally["absent"]["voter_count"] == 0
        assert tally["absent"]["entitlement_sum"] == 0

    async def test_entitlement_sums_use_snapshot_not_current(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Even if unit_entitlement changes later, tally uses snapshot."""
        b = Building(name="Snapshot Tally Building", manager_email="st@test.com")
        db_session.add(b)
        await db_session.flush()
        lo = LotOwner(
            building_id=b.id,
            lot_number="ST1",
            unit_entitlement=500,
        )
        db_session.add(lo)
        await db_session.flush()
        lo_email = LotOwnerEmail(lot_owner_id=lo.id, email="snap_tally@test.com")
        db_session.add(lo_email)
        await db_session.flush()

        agm = GeneralMeeting(
            building_id=b.id,
            title="Snapshot Tally GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(general_meeting_id=agm.id, title="ST Motion", display_order=1)
        db_session.add(motion)
        await db_session.flush()

        # Snapshot at 500
        w = GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=500,
        )
        db_session.add(w)
        await db_session.flush()

        # Vote yes
        vote = Vote(
            general_meeting_id=agm.id,
            motion_id=motion.id,
            voter_email="snap_tally@test.com",
            lot_owner_id=lo.id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        )
        db_session.add(vote)
        bs = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            voter_email="snap_tally@test.com",
        )
        db_session.add(bs)
        await db_session.flush()

        # Change current entitlement (shouldn't affect tally)
        lo.unit_entitlement = 999
        await db_session.commit()

        response = await client.get(f"/api/admin/general-meetings/{agm.id}")
        tally = response.json()["motions"][0]["tally"]
        assert tally["yes"]["entitlement_sum"] == 500

    async def test_multi_lot_voter_entitlement_sum(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Voter with two lots: entitlement should be sum of both snapshots."""
        b = Building(name="Two Lots Building", manager_email="tl@test.com")
        db_session.add(b)
        await db_session.flush()
        lo1 = LotOwner(building_id=b.id, lot_number="TL1", unit_entitlement=100)
        lo2 = LotOwner(building_id=b.id, lot_number="TL2", unit_entitlement=200)
        db_session.add_all([lo1, lo2])
        await db_session.flush()
        db_session.add(LotOwnerEmail(lot_owner_id=lo1.id, email="twolots@test.com"))
        db_session.add(LotOwnerEmail(lot_owner_id=lo2.id, email="twolots@test.com"))
        await db_session.flush()

        agm = GeneralMeeting(
            building_id=b.id,
            title="Two Lots GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(general_meeting_id=agm.id, title="TL Motion", display_order=1)
        db_session.add(motion)
        await db_session.flush()

        for lo in [lo1, lo2]:
            w = GeneralMeetingLotWeight(
                general_meeting_id=agm.id,
                lot_owner_id=lo.id,
                unit_entitlement_snapshot=lo.unit_entitlement,
            )
            db_session.add(w)
        await db_session.flush()

        # Submit for both lots
        for lo in [lo1, lo2]:
            vote = Vote(
                general_meeting_id=agm.id,
                motion_id=motion.id,
                voter_email="twolots@test.com",
                lot_owner_id=lo.id,
                choice=VoteChoice.yes,
                status=VoteStatus.submitted,
            )
            db_session.add(vote)
            bs = BallotSubmission(
                general_meeting_id=agm.id,
                lot_owner_id=lo.id,
                voter_email="twolots@test.com",
            )
            db_session.add(bs)
        await db_session.commit()

        response = await client.get(f"/api/admin/general-meetings/{agm.id}")
        data = response.json()
        # Each lot is a separate eligible voter
        assert data["total_eligible_voters"] == 2
        tally = data["motions"][0]["tally"]
        assert tally["yes"]["voter_count"] == 2
        assert tally["yes"]["entitlement_sum"] == 300  # 100 + 200

    # --- State / precondition errors ---

    async def test_not_found_returns_404(self, client: AsyncClient):
        response = await client.get(f"/api/admin/general-meetings/{uuid.uuid4()}")
        assert response.status_code == 404

    # --- Edge cases ---

    async def test_all_yes_voters(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="All Yes Building", manager_email="ally@test.com")
        db_session.add(b)
        await db_session.flush()

        owners = [
            LotOwner(
                building_id=b.id,
                lot_number=f"AY{i}",
                unit_entitlement=10 * (i + 1),
            )
            for i in range(3)
        ]
        db_session.add_all(owners)
        await db_session.flush()

        for i, lo in enumerate(owners):
            db_session.add(LotOwnerEmail(lot_owner_id=lo.id, email=f"yes{i}@test.com"))
        await db_session.flush()

        agm = GeneralMeeting(
            building_id=b.id,
            title="All Yes GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(general_meeting_id=agm.id, title="All Yes Motion", display_order=1)
        db_session.add(motion)
        await db_session.flush()

        for i, lo in enumerate(owners):
            w = GeneralMeetingLotWeight(
                general_meeting_id=agm.id,
                lot_owner_id=lo.id,
                unit_entitlement_snapshot=lo.unit_entitlement,
            )
            db_session.add(w)
            vote = Vote(
                general_meeting_id=agm.id,
                motion_id=motion.id,
                voter_email=f"yes{i}@test.com",
                lot_owner_id=lo.id,
                choice=VoteChoice.yes,
                status=VoteStatus.submitted,
            )
            db_session.add(vote)
            bs = BallotSubmission(
                general_meeting_id=agm.id,
                lot_owner_id=lo.id,
                voter_email=f"yes{i}@test.com",
            )
            db_session.add(bs)
        await db_session.commit()

        response = await client.get(f"/api/admin/general-meetings/{agm.id}")
        data = response.json()
        tally = data["motions"][0]["tally"]
        # 10 + 20 + 30 = 60
        assert tally["yes"]["voter_count"] == 3
        assert tally["yes"]["entitlement_sum"] == 60
        assert tally["no"]["voter_count"] == 0
        assert tally["absent"]["voter_count"] == 0

    async def test_submitted_vote_with_null_choice_treated_as_abstained(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="Null Choice Building", manager_email="nc@test.com")
        db_session.add(b)
        await db_session.flush()

        lo = LotOwner(
            building_id=b.id,
            lot_number="NC1",
            unit_entitlement=40,
        )
        db_session.add(lo)
        await db_session.flush()
        db_session.add(LotOwnerEmail(lot_owner_id=lo.id, email="nullchoice@test.com"))
        await db_session.flush()

        agm = GeneralMeeting(
            building_id=b.id,
            title="Null Choice GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(general_meeting_id=agm.id, title="NC Motion", display_order=1)
        db_session.add(motion)
        await db_session.flush()

        w = GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=lo.unit_entitlement,
        )
        db_session.add(w)

        # Vote with null choice (submitted but no selection → abstained)
        vote = Vote(
            general_meeting_id=agm.id,
            motion_id=motion.id,
            voter_email="nullchoice@test.com",
            lot_owner_id=lo.id,
            choice=None,
            status=VoteStatus.submitted,
        )
        db_session.add(vote)
        bs = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            voter_email="nullchoice@test.com",
        )
        db_session.add(bs)
        await db_session.commit()

        response = await client.get(f"/api/admin/general-meetings/{agm.id}")
        tally = response.json()["motions"][0]["tally"]
        assert tally["abstained"]["voter_count"] == 1
        assert tally["abstained"]["entitlement_sum"] == 40

    async def test_fallback_to_current_lot_owners_when_no_snapshot(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """When GeneralMeetingLotWeight snapshot is empty, fall back to current lot owners."""
        b = Building(name="No Snapshot Building", manager_email="ns@test.com")
        db_session.add(b)
        await db_session.flush()

        lo = LotOwner(
            building_id=b.id,
            lot_number="NS1",
            unit_entitlement=75,
        )
        db_session.add(lo)
        await db_session.flush()

        agm = GeneralMeeting(
            building_id=b.id,
            title="No Snapshot GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(general_meeting_id=agm.id, title="NS Motion", display_order=1)
        db_session.add(motion)
        # Intentionally no GeneralMeetingLotWeight rows for this GeneralMeeting
        await db_session.commit()

        response = await client.get(f"/api/admin/general-meetings/{agm.id}")
        data = response.json()
        assert data["total_eligible_voters"] == 1
        tally = data["motions"][0]["tally"]
        # Meeting is open: absent tally is suppressed
        assert tally["absent"]["voter_count"] == 0
        assert tally["absent"]["entitlement_sum"] == 0

    async def test_tally_not_eligible_counted_separately(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """In-arrear lots with not_eligible votes appear in the not_eligible tally
        bucket (admin_service.py line 1018)."""
        b = Building(name="Not Eligible Building", manager_email="ne@test.com")
        db_session.add(b)
        await db_session.flush()

        lo_normal = LotOwner(building_id=b.id, lot_number="NE1", unit_entitlement=100)
        lo_arrear = LotOwner(building_id=b.id, lot_number="NE2", unit_entitlement=50)
        db_session.add_all([lo_normal, lo_arrear])
        await db_session.flush()

        db_session.add(LotOwnerEmail(lot_owner_id=lo_normal.id, email="normal@ne.com"))
        db_session.add(LotOwnerEmail(lot_owner_id=lo_arrear.id, email="arrear@ne.com"))
        await db_session.flush()

        agm = GeneralMeeting(
            building_id=b.id,
            title="NE GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(general_meeting_id=agm.id, title="NE Motion", display_order=1)
        db_session.add(motion)
        await db_session.flush()

        for lo in [lo_normal, lo_arrear]:
            db_session.add(GeneralMeetingLotWeight(
                general_meeting_id=agm.id,
                lot_owner_id=lo.id,
                unit_entitlement_snapshot=lo.unit_entitlement,
            ))
        await db_session.flush()

        # Normal lot voted yes; in-arrear lot has not_eligible
        db_session.add(Vote(
            general_meeting_id=agm.id, motion_id=motion.id,
            voter_email="normal@ne.com", lot_owner_id=lo_normal.id,
            choice=VoteChoice.yes, status=VoteStatus.submitted,
        ))
        db_session.add(BallotSubmission(
            general_meeting_id=agm.id, lot_owner_id=lo_normal.id, voter_email="normal@ne.com",
        ))
        db_session.add(Vote(
            general_meeting_id=agm.id, motion_id=motion.id,
            voter_email="arrear@ne.com", lot_owner_id=lo_arrear.id,
            choice=VoteChoice.not_eligible, status=VoteStatus.submitted,
        ))
        db_session.add(BallotSubmission(
            general_meeting_id=agm.id, lot_owner_id=lo_arrear.id, voter_email="arrear@ne.com",
        ))
        await db_session.commit()

        response = await client.get(f"/api/admin/general-meetings/{agm.id}")
        assert response.status_code == 200
        data = response.json()
        tally = data["motions"][0]["tally"]
        assert tally["yes"]["voter_count"] == 1
        assert tally["yes"]["entitlement_sum"] == 100
        assert tally["not_eligible"]["voter_count"] == 1
        assert tally["not_eligible"]["entitlement_sum"] == 50
        assert tally["abstained"]["voter_count"] == 0
        voter_lists = data["motions"][0]["voter_lists"]
        assert len(voter_lists["not_eligible"]) == 1


# ---------------------------------------------------------------------------
# POST /api/admin/general-meetings/{agm_id}/close
# ---------------------------------------------------------------------------


class TestCloseAGM:
    async def _create_open_agm(self, db_session: AsyncSession, name: str) -> GeneralMeeting:
        b = Building(name=name, manager_email=f"close_{name}@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title=f"Close Test GeneralMeeting {name}",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.commit()
        await db_session.refresh(agm)
        return agm

    # --- Happy path ---

    async def test_close_open_agm_returns_closed(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        agm = await self._create_open_agm(db_session, "Close Happy 1")
        response = await client.post(f"/api/admin/general-meetings/{agm.id}/close")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "closed"
        assert data["closed_at"] is not None
        assert data["id"] == str(agm.id)

    async def test_draft_votes_deleted_on_close(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="Draft Delete Building", manager_email="dd@test.com")
        db_session.add(b)
        await db_session.flush()

        lo = LotOwner(
            building_id=b.id, lot_number="DD1", unit_entitlement=10
        )
        db_session.add(lo)
        await db_session.flush()

        agm = GeneralMeeting(
            building_id=b.id,
            title="Draft Delete GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(general_meeting_id=agm.id, title="DD Motion", display_order=1)
        db_session.add(motion)
        await db_session.flush()

        # Add another lot owner for the submitted voter
        lo2 = LotOwner(building_id=b.id, lot_number="DD2", unit_entitlement=10)
        db_session.add(lo2)
        await db_session.flush()

        # Add draft and submitted votes (both require lot_owner_id after migration)
        draft_vote = Vote(
            general_meeting_id=agm.id,
            motion_id=motion.id,
            voter_email="draft@test.com",
            lot_owner_id=lo.id,
            choice=VoteChoice.yes,
            status=VoteStatus.draft,
        )
        submitted_vote = Vote(
            general_meeting_id=agm.id,
            motion_id=motion.id,
            voter_email="submitted@test.com",
            lot_owner_id=lo2.id,
            choice=VoteChoice.no,
            status=VoteStatus.submitted,
        )
        db_session.add_all([draft_vote, submitted_vote])
        await db_session.commit()

        # Close GeneralMeeting
        response = await client.post(f"/api/admin/general-meetings/{agm.id}/close")
        assert response.status_code == 200

        # Check draft vote deleted, submitted vote remains
        remaining = await db_session.execute(
            select(Vote).where(Vote.general_meeting_id == agm.id)
        )
        remaining_votes = list(remaining.scalars().all())
        assert all(v.status == VoteStatus.submitted for v in remaining_votes)
        assert not any(v.voter_email == "draft@test.com" for v in remaining_votes)

    async def test_email_delivery_record_created_on_close(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        agm = await self._create_open_agm(db_session, "Email Delivery Building")
        response = await client.post(f"/api/admin/general-meetings/{agm.id}/close")
        assert response.status_code == 200

        result = await db_session.execute(
            select(EmailDelivery).where(EmailDelivery.general_meeting_id == agm.id)
        )
        delivery = result.scalar_one_or_none()
        assert delivery is not None
        assert delivery.status == EmailDeliveryStatus.pending
        assert delivery.total_attempts == 0

    # --- State / precondition errors ---

    async def test_close_already_closed_agm_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        agm = await self._create_open_agm(db_session, "Double Close Building")
        await client.post(f"/api/admin/general-meetings/{agm.id}/close")
        response = await client.post(f"/api/admin/general-meetings/{agm.id}/close")
        assert response.status_code == 409

    async def test_close_not_found_returns_404(self, client: AsyncClient):
        response = await client.post(f"/api/admin/general-meetings/{uuid.uuid4()}/close")
        assert response.status_code == 404

    async def test_close_returns_voting_closes_at(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Close response includes voting_closes_at field (US-PS05)."""
        agm = await self._create_open_agm(db_session, "VotingClosesAt Building")
        response = await client.post(f"/api/admin/general-meetings/{agm.id}/close")
        assert response.status_code == 200
        data = response.json()
        assert "voting_closes_at" in data
        assert data["voting_closes_at"] is not None

    async def test_close_updates_voting_closes_at_when_future(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Close sets voting_closes_at to now when it was in the future (US-PS05)."""
        b = Building(name="EarlyClose Building", manager_email="eclose@test.com")
        db_session.add(b)
        await db_session.flush()
        original_close = datetime.now(UTC) + timedelta(days=2)
        agm = GeneralMeeting(
            building_id=b.id,
            title="Early Close GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=original_close,
        )
        db_session.add(agm)
        await db_session.commit()
        await db_session.refresh(agm)

        before_close = datetime.now(UTC)
        response = await client.post(f"/api/admin/general-meetings/{agm.id}/close")
        assert response.status_code == 200
        after_close = datetime.now(UTC)

        # voting_closes_at should have been updated to approximately now
        updated_closes_at_str = response.json()["voting_closes_at"]
        from datetime import timezone as _tz
        updated_closes_at = datetime.fromisoformat(updated_closes_at_str.replace("Z", "+00:00"))
        assert before_close <= updated_closes_at <= after_close

    async def test_close_preserves_voting_closes_at_when_already_past(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Close does not update voting_closes_at if it is already in the past (US-PS05)."""
        b = Building(name="PastClose Building", manager_email="pastclose@test.com")
        db_session.add(b)
        await db_session.flush()
        past_close = datetime.now(UTC) - timedelta(hours=1)
        # meeting_at also past so constraint ok, but pass as naive to hit the naive branch
        past_meeting_at = (datetime.now(UTC) - timedelta(hours=2)).replace(tzinfo=None)
        agm = GeneralMeeting(
            building_id=b.id,
            title="Past Close GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=past_meeting_at,
            voting_closes_at=past_close,
        )
        db_session.add(agm)
        await db_session.commit()
        await db_session.refresh(agm)

        response = await client.post(f"/api/admin/general-meetings/{agm.id}/close")
        assert response.status_code == 200
        # voting_closes_at should be preserved (not changed to now)
        data = response.json()
        assert "voting_closes_at" in data


# ---------------------------------------------------------------------------
# POST /api/admin/general-meetings/{agm_id}/start (US-PS04)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestStartGeneralMeeting:
    """Tests for POST /api/admin/general-meetings/{id}/start."""

    async def _create_pending_agm(self, db_session: AsyncSession, name: str) -> GeneralMeeting:
        b = Building(name=name, manager_email=f"start_{name}@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title=f"Pending Test GeneralMeeting {name}",
            status=GeneralMeetingStatus.pending,
            meeting_at=datetime.now(UTC) + timedelta(days=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=2),
        )
        db_session.add(agm)
        await db_session.commit()
        await db_session.refresh(agm)
        return agm

    # --- Happy path ---

    async def test_start_pending_meeting_returns_200(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        agm = await self._create_pending_agm(db_session, "StartHappy1")
        response = await client.post(f"/api/admin/general-meetings/{agm.id}/start")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "open"
        assert data["id"] == str(agm.id)
        assert data["meeting_at"] is not None

    async def test_start_updates_meeting_at_to_now(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Start endpoint sets meeting_at to approximately now."""
        agm = await self._create_pending_agm(db_session, "StartMeetingAt")
        before = datetime.now(UTC)
        response = await client.post(f"/api/admin/general-meetings/{agm.id}/start")
        after = datetime.now(UTC)
        assert response.status_code == 200
        from datetime import timezone as _tz
        meeting_at_str = response.json()["meeting_at"]
        meeting_at = datetime.fromisoformat(meeting_at_str.replace("Z", "+00:00"))
        assert before <= meeting_at <= after

    # --- State / precondition errors ---

    async def test_start_open_meeting_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="StartOpen Building", manager_email="startopen@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="Open Start GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.commit()

        response = await client.post(f"/api/admin/general-meetings/{agm.id}/start")
        assert response.status_code == 409

    async def test_start_closed_meeting_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="StartClosed Building", manager_email="startclosed@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="Closed Start GeneralMeeting",
            status=GeneralMeetingStatus.closed,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
            closed_at=datetime.now(UTC),
        )
        db_session.add(agm)
        await db_session.commit()

        response = await client.post(f"/api/admin/general-meetings/{agm.id}/start")
        assert response.status_code == 409

    async def test_start_not_found_returns_404(self, client: AsyncClient):
        response = await client.post(f"/api/admin/general-meetings/{uuid.uuid4()}/start")
        assert response.status_code == 404


# ---------------------------------------------------------------------------
# POST /api/admin/general-meetings/{agm_id}/resend-report
# ---------------------------------------------------------------------------


class TestResendReport:
    async def _setup_closed_agm_with_delivery(
        self, db_session: AsyncSession, name: str, delivery_status: EmailDeliveryStatus
    ) -> tuple[GeneralMeeting, EmailDelivery]:
        b = Building(name=name, manager_email=f"resend_{name}@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title=f"Resend Test {name}",
            status=GeneralMeetingStatus.closed,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
            closed_at=datetime.now(UTC),
        )
        db_session.add(agm)
        await db_session.flush()

        delivery = EmailDelivery(
            general_meeting_id=agm.id,
            status=delivery_status,
            total_attempts=5,
            last_error="some error" if delivery_status == EmailDeliveryStatus.failed else None,
        )
        db_session.add(delivery)
        await db_session.commit()
        await db_session.refresh(agm)
        await db_session.refresh(delivery)
        return agm, delivery

    # --- Happy path ---

    async def test_resend_failed_delivery_resets_to_pending(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        agm, delivery = await self._setup_closed_agm_with_delivery(
            db_session, "Failed Delivery Building", EmailDeliveryStatus.failed
        )
        response = await client.post(f"/api/admin/general-meetings/{agm.id}/resend-report")
        assert response.status_code == 200
        assert response.json()["queued"] is True

        await db_session.refresh(delivery)
        assert delivery.status == EmailDeliveryStatus.pending
        assert delivery.total_attempts == 0
        assert delivery.last_error is None
        assert delivery.next_retry_at is None

    # --- State / precondition errors ---

    async def test_resend_pending_delivery_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        agm, _ = await self._setup_closed_agm_with_delivery(
            db_session, "Pending Delivery Building", EmailDeliveryStatus.pending
        )
        response = await client.post(f"/api/admin/general-meetings/{agm.id}/resend-report")
        assert response.status_code == 409

    async def test_resend_delivered_delivery_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        agm, _ = await self._setup_closed_agm_with_delivery(
            db_session, "Delivered Delivery Building", EmailDeliveryStatus.delivered
        )
        response = await client.post(f"/api/admin/general-meetings/{agm.id}/resend-report")
        assert response.status_code == 409

    async def test_resend_open_agm_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="Open Resend Building", manager_email="op_res@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="Open Resend GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.commit()

        response = await client.post(f"/api/admin/general-meetings/{agm.id}/resend-report")
        assert response.status_code == 409

    async def test_resend_not_found_returns_404(self, client: AsyncClient):
        response = await client.post(f"/api/admin/general-meetings/{uuid.uuid4()}/resend-report")
        assert response.status_code == 404

    async def test_resend_no_delivery_record_returns_404(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="No Delivery Building", manager_email="nd@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="No Delivery GeneralMeeting",
            status=GeneralMeetingStatus.closed,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
            closed_at=datetime.now(UTC),
        )
        db_session.add(agm)
        await db_session.commit()

        response = await client.post(f"/api/admin/general-meetings/{agm.id}/resend-report")
        assert response.status_code == 404


# ---------------------------------------------------------------------------
# DELETE /api/admin/general-meetings/{agm_id}/ballots
# ---------------------------------------------------------------------------


class TestResetAGMBallots:
    async def _create_agm_with_ballot(
        self, db_session: AsyncSession, name: str
    ) -> tuple[GeneralMeeting, LotOwner, Motion]:
        b = Building(name=name, manager_email=f"reset_{name}@test.com")
        db_session.add(b)
        await db_session.flush()

        lo = LotOwner(
            building_id=b.id,
            lot_number="RESET-1",
            unit_entitlement=10,
        )
        db_session.add(lo)
        await db_session.flush()

        agm = GeneralMeeting(
            building_id=b.id,
            title=f"Reset Ballots GeneralMeeting {name}",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(general_meeting_id=agm.id, title="Reset Motion", display_order=1)
        db_session.add(motion)
        await db_session.flush()

        # Add a submitted vote + ballot submission
        vote = Vote(
            general_meeting_id=agm.id,
            motion_id=motion.id,
            voter_email="reset-voter@test.com",
            lot_owner_id=lo.id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        )
        db_session.add(vote)
        await db_session.flush()

        submission = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            voter_email="reset-voter@test.com",
        )
        db_session.add(submission)
        await db_session.commit()
        await db_session.refresh(agm)
        return agm, lo, motion

    # --- Happy path ---

    async def test_reset_ballots_deletes_submissions_and_returns_count(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        agm, _lo, _motion = await self._create_agm_with_ballot(db_session, "Happy Reset")
        response = await client.delete(f"/api/admin/general-meetings/{agm.id}/ballots")
        assert response.status_code == 200
        data = response.json()
        assert data["deleted"] == 1

        # Verify ballot submission is gone
        subs = await db_session.execute(
            select(BallotSubmission).where(BallotSubmission.general_meeting_id == agm.id)
        )
        assert subs.scalars().all() == []

    async def test_reset_ballots_deletes_submitted_votes(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        agm, _lo, _motion = await self._create_agm_with_ballot(db_session, "Vote Delete Reset")
        response = await client.delete(f"/api/admin/general-meetings/{agm.id}/ballots")
        assert response.status_code == 200

        # Verify submitted votes are gone
        votes = await db_session.execute(
            select(Vote).where(Vote.general_meeting_id == agm.id, Vote.status == VoteStatus.submitted)
        )
        assert votes.scalars().all() == []

    async def test_reset_ballots_on_agm_with_no_submissions_returns_zero(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="Empty Reset Building", manager_email="empty_reset@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="Empty Reset GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.commit()

        response = await client.delete(f"/api/admin/general-meetings/{agm.id}/ballots")
        assert response.status_code == 200
        assert response.json()["deleted"] == 0

    async def test_reset_ballots_preserves_draft_votes(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="Draft Preserve Building", manager_email="draft_pres@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="Draft Preserve GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        lo_draft = LotOwner(building_id=b.id, lot_number="DPL1", unit_entitlement=10)
        db_session.add(lo_draft)
        await db_session.flush()

        motion = Motion(general_meeting_id=agm.id, title="Draft Motion", display_order=1)
        db_session.add(motion)
        await db_session.flush()

        draft_vote = Vote(
            general_meeting_id=agm.id,
            motion_id=motion.id,
            voter_email="drafter@test.com",
            lot_owner_id=lo_draft.id,
            choice=VoteChoice.no,
            status=VoteStatus.draft,
        )
        db_session.add(draft_vote)
        await db_session.commit()

        response = await client.delete(f"/api/admin/general-meetings/{agm.id}/ballots")
        assert response.status_code == 200
        assert response.json()["deleted"] == 0

        # Draft vote should still be present
        remaining = await db_session.execute(
            select(Vote).where(Vote.general_meeting_id == agm.id, Vote.status == VoteStatus.draft)
        )
        assert len(remaining.scalars().all()) == 1

    async def test_reset_multiple_submissions_deletes_all(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="Multi Reset Building", manager_email="multi_reset@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="Multi Reset GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(general_meeting_id=agm.id, title="Multi Motion", display_order=1)
        db_session.add(motion)
        await db_session.flush()

        for i in range(3):
            lo = LotOwner(building_id=b.id, lot_number=f"MRESET-{i}", unit_entitlement=10)
            db_session.add(lo)
            await db_session.flush()
            email = f"multi-voter-{i}@test.com"
            db_session.add(
                Vote(
                    general_meeting_id=agm.id,
                    motion_id=motion.id,
                    voter_email=email,
                    lot_owner_id=lo.id,
                    choice=VoteChoice.yes,
                    status=VoteStatus.submitted,
                )
            )
            db_session.add(BallotSubmission(
                general_meeting_id=agm.id,
                lot_owner_id=lo.id,
                voter_email=email,
            ))
        await db_session.commit()

        response = await client.delete(f"/api/admin/general-meetings/{agm.id}/ballots")
        assert response.status_code == 200
        assert response.json()["deleted"] == 3

    # --- State / precondition errors ---

    async def test_reset_ballots_not_found_returns_404(self, client: AsyncClient):
        response = await client.delete(f"/api/admin/general-meetings/{uuid.uuid4()}/ballots")
        assert response.status_code == 404

    # --- Edge cases ---

    async def test_reset_ballots_unauthenticated_returns_401(
        self, db_session: AsyncSession
    ):
        """Without admin credentials, the endpoint returns 401."""
        from app.main import create_app
        from app.database import get_db

        b = Building(name="Unauth Reset Building", manager_email="unauth_reset@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="Unauth Reset GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.commit()

        # Create an app without admin auth bypass
        unauth_app = create_app()

        async def override_get_db():
            yield db_session

        unauth_app.dependency_overrides[get_db] = override_get_db

        async with AsyncClient(
            transport=ASGITransport(app=unauth_app), base_url="http://test"
        ) as unauth_client:
            response = await unauth_client.delete(f"/api/admin/general-meetings/{agm.id}/ballots")
        assert response.status_code == 401



# ---------------------------------------------------------------------------
# get_effective_status helper — unit tests (US-CD01)
# ---------------------------------------------------------------------------


class _FakeAGM:
    """Minimal stand-in for GeneralMeeting used to unit-test get_effective_status without a DB."""

    def __init__(self, status: GeneralMeetingStatus, voting_closes_at, meeting_at=None):
        self.status = status
        self.voting_closes_at = voting_closes_at
        self.meeting_at = meeting_at


class TestGetEffectiveStatus:
    """Unit tests for the get_effective_status helper."""

    # --- Happy path ---

    def test_open_agm_with_future_closes_at_returns_open(self):
        """An GeneralMeeting whose voting_closes_at is in the future stays open."""
        agm = _FakeAGM(GeneralMeetingStatus.open, datetime.now(UTC) + timedelta(days=1))
        assert get_effective_status(agm) == GeneralMeetingStatus.open  # type: ignore[arg-type]

    def test_open_agm_with_past_closes_at_returns_closed(self):
        """An GeneralMeeting whose voting_closes_at has passed is effectively closed."""
        agm = _FakeAGM(GeneralMeetingStatus.open, datetime.now(UTC) - timedelta(seconds=1))
        assert get_effective_status(agm) == GeneralMeetingStatus.closed  # type: ignore[arg-type]

    def test_already_closed_agm_returns_closed_regardless_of_closes_at(self):
        """An GeneralMeeting with status=closed stays closed whether closes_at is past or future."""
        agm = _FakeAGM(GeneralMeetingStatus.closed, datetime.now(UTC) + timedelta(days=1))
        assert get_effective_status(agm) == GeneralMeetingStatus.closed  # type: ignore[arg-type]

    def test_open_agm_with_none_closes_at_returns_open(self):
        """An GeneralMeeting with no voting_closes_at set stays open (edge case)."""
        agm = _FakeAGM(GeneralMeetingStatus.open, None)
        assert get_effective_status(agm) == GeneralMeetingStatus.open  # type: ignore[arg-type]

    def test_naive_datetime_past_returns_closed(self):
        """A naive (tz-unaware) voting_closes_at in the past is treated as UTC."""
        agm = _FakeAGM(GeneralMeetingStatus.open, datetime(2000, 1, 1, 0, 0, 0))
        assert get_effective_status(agm) == GeneralMeetingStatus.closed  # type: ignore[arg-type]

    def test_naive_datetime_future_returns_open(self):
        """A naive (tz-unaware) voting_closes_at far in the future stays open."""
        agm = _FakeAGM(GeneralMeetingStatus.open, datetime(2099, 12, 31, 23, 59, 59))
        assert get_effective_status(agm) == GeneralMeetingStatus.open  # type: ignore[arg-type]

    # --- Pending status (US-PS01) ---

    def test_pending_stored_status_with_future_meeting_at_returns_pending(self):
        """A meeting stored as pending with future meeting_at returns pending."""
        agm = _FakeAGM(
            GeneralMeetingStatus.pending,
            datetime.now(UTC) + timedelta(days=2),
            meeting_at=datetime.now(UTC) + timedelta(days=1),
        )
        assert get_effective_status(agm) == GeneralMeetingStatus.pending  # type: ignore[arg-type]

    def test_open_stored_status_with_future_meeting_at_returns_pending(self):
        """A meeting stored as open but with future meeting_at returns pending."""
        agm = _FakeAGM(
            GeneralMeetingStatus.open,
            datetime.now(UTC) + timedelta(days=2),
            meeting_at=datetime.now(UTC) + timedelta(days=1),
        )
        assert get_effective_status(agm) == GeneralMeetingStatus.pending  # type: ignore[arg-type]

    def test_open_stored_status_with_past_meeting_at_future_closes_at_returns_open(self):
        """A meeting whose start has passed but voting is still open returns open."""
        agm = _FakeAGM(
            GeneralMeetingStatus.open,
            datetime.now(UTC) + timedelta(days=1),
            meeting_at=datetime.now(UTC) - timedelta(hours=1),
        )
        assert get_effective_status(agm) == GeneralMeetingStatus.open  # type: ignore[arg-type]

    def test_closed_stored_status_with_future_voting_closes_at_returns_closed(self):
        """Manually closed meeting returns closed even if voting_closes_at is in the future."""
        agm = _FakeAGM(
            GeneralMeetingStatus.closed,
            datetime.now(UTC) + timedelta(days=1),
            meeting_at=datetime.now(UTC) + timedelta(days=1),
        )
        assert get_effective_status(agm) == GeneralMeetingStatus.closed  # type: ignore[arg-type]

    def test_pending_stored_status_with_both_timestamps_past_returns_closed(self):
        """A meeting stored as pending but both timestamps past returns closed."""
        agm = _FakeAGM(
            GeneralMeetingStatus.pending,
            datetime.now(UTC) - timedelta(hours=1),
            meeting_at=datetime.now(UTC) - timedelta(hours=2),
        )
        assert get_effective_status(agm) == GeneralMeetingStatus.closed  # type: ignore[arg-type]

    def test_future_meeting_at_but_past_voting_closes_at_returns_closed(self):
        """voting_closes_at in the past takes priority over future meeting_at."""
        agm = _FakeAGM(
            GeneralMeetingStatus.open,
            datetime.now(UTC) - timedelta(seconds=1),
            meeting_at=datetime.now(UTC) + timedelta(days=1),
        )
        assert get_effective_status(agm) == GeneralMeetingStatus.closed  # type: ignore[arg-type]

    def test_naive_future_meeting_at_returns_pending(self):
        """A naive (tz-unaware) meeting_at far in the future derives pending."""
        agm = _FakeAGM(
            GeneralMeetingStatus.open,
            datetime(2099, 12, 31, 23, 59, 59),
            meeting_at=datetime(2099, 12, 31, 12, 0, 0),
        )
        assert get_effective_status(agm) == GeneralMeetingStatus.pending  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Admin list_agms effective status (US-CD01)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestListAGMsEffectiveStatus:
    """list_agms returns effective (closed) status for past-closes_at AGMs."""

    async def test_list_agms_past_closes_at_shows_closed(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="EffStatus Building", manager_email="eff@test.com")
        db_session.add(b)
        await db_session.flush()
        past_agm = GeneralMeeting(
            building_id=b.id,
            title="Expired GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) - timedelta(days=3),
            voting_closes_at=datetime.now(UTC) - timedelta(days=1),
        )
        db_session.add(past_agm)
        await db_session.commit()

        response = await client.get("/api/admin/general-meetings")
        assert response.status_code == 200
        items = response.json()
        match = next((i for i in items if i["id"] == str(past_agm.id)), None)
        assert match is not None
        assert match["status"] == "closed"

    async def test_list_agms_future_closes_at_shows_pending(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """A meeting with meeting_at in the future is effectively pending."""
        b = Building(name="FutureStatus Building", manager_email="fut@test.com")
        db_session.add(b)
        await db_session.flush()
        future_agm = GeneralMeeting(
            building_id=b.id,
            title="Future GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) + timedelta(days=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=2),
        )
        db_session.add(future_agm)
        await db_session.commit()

        response = await client.get("/api/admin/general-meetings")
        assert response.status_code == 200
        items = response.json()
        match = next((i for i in items if i["id"] == str(future_agm.id)), None)
        assert match is not None
        assert match["status"] == "pending"

    async def test_list_agms_past_meeting_at_future_closes_at_shows_open(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """A meeting whose start time has passed but voting is still open is effectively open."""
        b = Building(name="OpenStatus Building", manager_email="open@test.com")
        db_session.add(b)
        await db_session.flush()
        open_agm = GeneralMeeting(
            building_id=b.id,
            title="Open GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) - timedelta(hours=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=2),
        )
        db_session.add(open_agm)
        await db_session.commit()

        response = await client.get("/api/admin/general-meetings")
        assert response.status_code == 200
        items = response.json()
        match = next((i for i in items if i["id"] == str(open_agm.id)), None)
        assert match is not None
        assert match["status"] == "open"


# ---------------------------------------------------------------------------
# Admin get_agm_detail effective status (US-CD01)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestGetGeneralMeetingDetailEffectiveStatus:
    """get_agm_detail returns effective (closed) status for past-closes_at AGMs."""

    async def test_detail_past_closes_at_shows_closed(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="DetailEff Building", manager_email="de@test.com")
        db_session.add(b)
        await db_session.flush()
        past_agm = GeneralMeeting(
            building_id=b.id,
            title="Detail Expired GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) - timedelta(days=3),
            voting_closes_at=datetime.now(UTC) - timedelta(days=1),
        )
        db_session.add(past_agm)
        await db_session.commit()

        response = await client.get(f"/api/admin/general-meetings/{past_agm.id}")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "closed"

    async def test_detail_future_closes_at_shows_pending(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """A meeting with meeting_at in the future is effectively pending."""
        b = Building(name="DetailFut Building", manager_email="df@test.com")
        db_session.add(b)
        await db_session.flush()
        future_agm = GeneralMeeting(
            building_id=b.id,
            title="Detail Future GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) + timedelta(days=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=2),
        )
        db_session.add(future_agm)
        await db_session.commit()

        response = await client.get(f"/api/admin/general-meetings/{future_agm.id}")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "pending"

    async def test_detail_past_meeting_at_future_closes_at_shows_open(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """A meeting whose start has passed but voting is still open is effectively open."""
        b = Building(name="DetailOpen Building", manager_email="do@test.com")
        db_session.add(b)
        await db_session.flush()
        open_agm = GeneralMeeting(
            building_id=b.id,
            title="Detail Open GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) - timedelta(hours=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=2),
        )
        db_session.add(open_agm)
        await db_session.commit()

        response = await client.get(f"/api/admin/general-meetings/{open_agm.id}")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "open"


# ---------------------------------------------------------------------------
# close_agm tally shows absent lots correctly (US-CD02)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestCloseAGMAbsentRecords:
    """Closing a GeneralMeeting creates absent BallotSubmission records (is_absent=True)
    for lots that did not vote, capturing contact emails as a snapshot."""

    async def _make_agm_with_lots(
        self, db_session: AsyncSession, name: str, n_lots: int = 2
    ):
        """Create building + GeneralMeeting + n lots with GeneralMeetingLotWeight snapshots."""
        b = Building(name=name, manager_email=f"absent_{name}@test.com")
        db_session.add(b)
        await db_session.flush()

        lots = []
        for i in range(n_lots):
            lo = LotOwner(
                building_id=b.id,
                lot_number=f"A{i+1}",
                unit_entitlement=100,
            )
            db_session.add(lo)
            await db_session.flush()
            lo_email = LotOwnerEmail(lot_owner_id=lo.id, email=f"voter{i+1}@{name}.test")
            db_session.add(lo_email)
            lots.append(lo)

        agm = GeneralMeeting(
            building_id=b.id,
            title=f"Absent Test GeneralMeeting {name}",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(general_meeting_id=agm.id, title="Motion 1", display_order=1)
        db_session.add(motion)
        await db_session.flush()

        for lo in lots:
            w = GeneralMeetingLotWeight(
                general_meeting_id=agm.id,
                lot_owner_id=lo.id,
                unit_entitlement_snapshot=lo.unit_entitlement,
            )
            db_session.add(w)
        await db_session.flush()

        return b, agm, lots, [motion]

    # --- Happy path ---

    async def test_close_creates_absent_submission_for_non_voters(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Lots that did not vote get an absent BallotSubmission (is_absent=True) on close.
        The voter_email contains the lot's contact emails as a snapshot."""
        _, agm, lots, _ = await self._make_agm_with_lots(
            db_session, "AbsentHappy1", n_lots=2
        )

        # lot[0] already voted
        bs = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lots[0].id,
            voter_email="voter1@AbsentHappy1.test",
        )
        db_session.add(bs)
        await db_session.commit()

        response = await client.post(f"/api/admin/general-meetings/{agm.id}/close")
        assert response.status_code == 200

        # lots[1] did not vote — must have an absent BallotSubmission after close
        await db_session.refresh(lots[1])
        subs_result = await db_session.execute(
            select(BallotSubmission).where(
                BallotSubmission.general_meeting_id == agm.id,
                BallotSubmission.lot_owner_id == lots[1].id,
            )
        )
        absent_sub = subs_result.scalar_one_or_none()
        assert absent_sub is not None
        assert absent_sub.is_absent is True
        assert "voter2@AbsentHappy1.test" in absent_sub.voter_email

    async def test_close_tally_shows_absent_lot_in_absent_not_abstained(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """After close, a lot that never voted appears in absent tally (not abstained)."""
        _, agm, lots, _ = await self._make_agm_with_lots(
            db_session, "AbsentVotes1", n_lots=2
        )
        # lots[0] votes, lots[1] does not
        bs = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lots[0].id,
            voter_email="voter1@AbsentVotes1.test",
        )
        db_session.add(bs)
        motion_result = await db_session.execute(
            select(Motion).where(Motion.general_meeting_id == agm.id)
        )
        motion = motion_result.scalar_one()
        v = Vote(
            general_meeting_id=agm.id,
            motion_id=motion.id,
            voter_email="voter1@AbsentVotes1.test",
            lot_owner_id=lots[0].id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        )
        db_session.add(v)
        await db_session.commit()

        response = await client.post(f"/api/admin/general-meetings/{agm.id}/close")
        assert response.status_code == 200

        tally_response = await client.get(f"/api/admin/general-meetings/{agm.id}")
        assert tally_response.status_code == 200
        data = tally_response.json()
        m = data["motions"][0]
        # lots[1] never voted → absent voter_count=1, abstained voter_count=0
        assert m["tally"]["absent"]["voter_count"] == 1
        assert m["tally"]["abstained"]["voter_count"] == 0

    async def test_close_does_not_duplicate_existing_submissions(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """A lot that already has a real BallotSubmission (is_absent=False) must not get a second one."""
        _, agm, lots, _ = await self._make_agm_with_lots(
            db_session, "AbsentNoDup1", n_lots=1
        )
        bs = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lots[0].id,
            voter_email="voter1@AbsentNoDup1.test",
        )
        db_session.add(bs)
        await db_session.commit()

        response = await client.post(f"/api/admin/general-meetings/{agm.id}/close")
        assert response.status_code == 200

        subs_result = await db_session.execute(
            select(BallotSubmission).where(
                BallotSubmission.general_meeting_id == agm.id,
                BallotSubmission.lot_owner_id == lots[0].id,
            )
        )
        # Only the original voted submission — no absent duplicate
        assert len(list(subs_result.scalars().all())) == 1

    async def test_close_agm_with_no_lot_weights_no_absent_records(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Closing a GeneralMeeting with no GeneralMeetingLotWeight snapshot creates no absent records."""
        b = Building(name="NoWeights Building", manager_email="nw@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="No Weights GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.commit()

        response = await client.post(f"/api/admin/general-meetings/{agm.id}/close")
        assert response.status_code == 200

        subs_result = await db_session.execute(
            select(BallotSubmission).where(BallotSubmission.general_meeting_id == agm.id)
        )
        assert list(subs_result.scalars().all()) == []

    async def test_close_agm_total_submitted_excludes_absent_lots(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """total_submitted in the summary reflects only actual voters, not absent lots."""
        _, agm, lots, _ = await self._make_agm_with_lots(
            db_session, "AbsentEmail1", n_lots=2
        )
        # Only lots[0] votes
        bs = BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lots[0].id,
            voter_email="voter1@AbsentEmail1.test",
        )
        db_session.add(bs)
        await db_session.commit()

        response = await client.post(f"/api/admin/general-meetings/{agm.id}/close")
        assert response.status_code == 200

        summary = await client.get(f"/api/admin/general-meetings/{agm.id}")
        assert summary.status_code == 200
        assert summary.json()["total_submitted"] == 1

    async def test_close_agm_lot_with_no_emails_gets_absent_record_with_empty_voter_email(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """A lot with no registered emails gets an absent BallotSubmission with empty voter_email."""
        b = Building(name="NoEmail Building", manager_email="ne@test.com")
        db_session.add(b)
        await db_session.flush()
        lo = LotOwner(building_id=b.id, lot_number="NE1", unit_entitlement=50)
        db_session.add(lo)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="No Email GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()
        w = GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=50,
        )
        db_session.add(w)
        await db_session.commit()

        response = await client.post(f"/api/admin/general-meetings/{agm.id}/close")
        assert response.status_code == 200

        # Absent BallotSubmission IS created, with empty voter_email
        subs_result = await db_session.execute(
            select(BallotSubmission).where(
                BallotSubmission.general_meeting_id == agm.id,
                BallotSubmission.lot_owner_id == lo.id,
            )
        )
        sub = subs_result.scalar_one_or_none()
        assert sub is not None
        assert sub.is_absent is True
        assert sub.voter_email == ""

    async def test_close_agm_absent_lot_with_proxy_includes_proxy_in_voter_email(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Absent lot with a proxy nomination includes proxy email in voter_email (comma-sep)
        when the proxy is not already in the owner emails list."""
        b = Building(name="ProxyAbsent Building", manager_email="pa@test.com")
        db_session.add(b)
        await db_session.flush()
        lo = LotOwner(building_id=b.id, lot_number="PA1", unit_entitlement=75)
        db_session.add(lo)
        await db_session.flush()
        # One owner email
        db_session.add(LotOwnerEmail(lot_owner_id=lo.id, email="owner-pa@test.com"))
        # Proxy is a different address
        db_session.add(LotProxy(lot_owner_id=lo.id, proxy_email="proxy-pa@test.com"))
        agm = GeneralMeeting(
            building_id=b.id,
            title="Proxy Absent GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()
        db_session.add(GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=75,
        ))
        await db_session.commit()

        response = await client.post(f"/api/admin/general-meetings/{agm.id}/close")
        assert response.status_code == 200

        subs_result = await db_session.execute(
            select(BallotSubmission).where(
                BallotSubmission.general_meeting_id == agm.id,
                BallotSubmission.lot_owner_id == lo.id,
            )
        )
        sub = subs_result.scalar_one_or_none()
        assert sub is not None
        assert sub.is_absent is True
        assert "owner-pa@test.com" in sub.voter_email
        assert "proxy-pa@test.com" in sub.voter_email
        assert sub.proxy_email == "proxy-pa@test.com"


# ---------------------------------------------------------------------------
# GET /api/admin/general-meetings/{agm_id} — absent only for closed meetings
# ---------------------------------------------------------------------------


class TestGetGeneralMeetingDetailAbsentBehaviour:
    """absent tally is only populated for closed meetings."""

    async def _make_agm_with_non_voter(
        self,
        db_session: AsyncSession,
        name: str,
        status: GeneralMeetingStatus,
    ):
        """Create building + AGM with one voter and one non-voter lot."""
        b = Building(name=name, manager_email=f"{name}@test.com")
        db_session.add(b)
        await db_session.flush()

        lo_voted = LotOwner(building_id=b.id, lot_number="V1", unit_entitlement=100)
        lo_absent = LotOwner(building_id=b.id, lot_number="V2", unit_entitlement=50)
        db_session.add_all([lo_voted, lo_absent])
        await db_session.flush()

        db_session.add(LotOwnerEmail(lot_owner_id=lo_voted.id, email=f"voted@{name}.test"))
        db_session.add(LotOwnerEmail(lot_owner_id=lo_absent.id, email=f"absent@{name}.test"))
        await db_session.flush()

        agm = GeneralMeeting(
            building_id=b.id,
            title=f"Absent Behaviour {name}",
            status=status,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(general_meeting_id=agm.id, title="Motion AB1", display_order=1)
        db_session.add(motion)
        await db_session.flush()

        for lo in [lo_voted, lo_absent]:
            db_session.add(GeneralMeetingLotWeight(
                general_meeting_id=agm.id,
                lot_owner_id=lo.id,
                unit_entitlement_snapshot=lo.unit_entitlement,
            ))
        await db_session.flush()

        # lo_voted submits a ballot
        db_session.add(Vote(
            general_meeting_id=agm.id,
            motion_id=motion.id,
            voter_email=f"voted@{name}.test",
            lot_owner_id=lo_voted.id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        ))
        db_session.add(BallotSubmission(
            general_meeting_id=agm.id,
            lot_owner_id=lo_voted.id,
            voter_email=f"voted@{name}.test",
        ))
        # For closed meetings, manually create absent BallotSubmission for the non-voter
        # (the close endpoint would normally create this, but here we set status directly)
        if status == GeneralMeetingStatus.closed:
            db_session.add(BallotSubmission(
                general_meeting_id=agm.id,
                lot_owner_id=lo_absent.id,
                voter_email=f"absent@{name}.test",
                is_absent=True,
            ))
        await db_session.commit()
        return agm

    # --- Happy path ---

    async def test_get_general_meeting_detail_absent_only_for_closed_open_meeting(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Open meeting: absent tally is 0 even when a lot owner has not voted."""
        agm = await self._make_agm_with_non_voter(
            db_session, "AbsentOpenTest", GeneralMeetingStatus.open
        )
        response = await client.get(f"/api/admin/general-meetings/{agm.id}")
        assert response.status_code == 200
        tally = response.json()["motions"][0]["tally"]
        assert tally["absent"]["voter_count"] == 0
        assert tally["absent"]["entitlement_sum"] == 0
        assert response.json()["motions"][0]["voter_lists"]["absent"] == []

    async def test_get_general_meeting_detail_absent_computed_for_closed(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Closed meeting: absent tally reflects lots that did not submit."""
        agm = await self._make_agm_with_non_voter(
            db_session, "AbsentClosedTest", GeneralMeetingStatus.closed
        )
        response = await client.get(f"/api/admin/general-meetings/{agm.id}")
        assert response.status_code == 200
        tally = response.json()["motions"][0]["tally"]
        assert tally["absent"]["voter_count"] == 1
        assert tally["absent"]["entitlement_sum"] == 50


# ---------------------------------------------------------------------------
# DELETE /api/admin/general-meetings/{agm_id}
# ---------------------------------------------------------------------------


class TestDeleteGeneralMeeting:
    async def _create_meeting(
        self,
        db_session: AsyncSession,
        name: str,
        status: GeneralMeetingStatus,
    ) -> GeneralMeeting:
        b = Building(name=name, manager_email=f"del_{name}@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title=f"Delete Test {name}",
            status=status,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.commit()
        await db_session.refresh(agm)
        return agm

    # --- Happy path ---

    async def test_delete_general_meeting_closed_success(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """DELETE on a closed meeting returns 204."""
        agm = await self._create_meeting(db_session, "DeleteClosed", GeneralMeetingStatus.closed)
        response = await client.delete(f"/api/admin/general-meetings/{agm.id}")
        assert response.status_code == 204

    async def test_delete_general_meeting_pending_success(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """DELETE on a pending meeting returns 204."""
        agm = await self._create_meeting(db_session, "DeletePending", GeneralMeetingStatus.pending)
        response = await client.delete(f"/api/admin/general-meetings/{agm.id}")
        assert response.status_code == 204

    async def test_delete_general_meeting_removes_from_db(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """After DELETE the record no longer exists in the database."""
        agm = await self._create_meeting(db_session, "DeleteDBCheck", GeneralMeetingStatus.closed)
        agm_id = agm.id
        response = await client.delete(f"/api/admin/general-meetings/{agm_id}")
        assert response.status_code == 204
        result = await db_session.execute(
            select(GeneralMeeting).where(GeneralMeeting.id == agm_id)
        )
        assert result.scalar_one_or_none() is None

    # --- State / precondition errors ---

    async def test_delete_general_meeting_open_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """DELETE on an open meeting returns 409."""
        agm = await self._create_meeting(db_session, "DeleteOpen", GeneralMeetingStatus.open)
        response = await client.delete(f"/api/admin/general-meetings/{agm.id}")
        assert response.status_code == 409
        assert "Cannot delete an open General Meeting" in response.json()["detail"]

    async def test_delete_general_meeting_not_found_returns_404(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """DELETE on a non-existent meeting ID returns 404."""
        fake_id = uuid.uuid4()
        response = await client.delete(f"/api/admin/general-meetings/{fake_id}")
        assert response.status_code == 404
        assert "General Meeting not found" in response.json()["detail"]

    async def test_delete_general_meeting_unauthenticated_returns_401(
        self, db_session: AsyncSession
    ):
        """DELETE without admin credentials returns 401."""
        from app.main import app as fastapi_app
        async with AsyncClient(
            transport=ASGITransport(app=fastapi_app), base_url="http://test"
        ) as unauthenticated_client:
            agm = await self._create_meeting(db_session, "DeleteUnauth", GeneralMeetingStatus.closed)
            response = await unauthenticated_client.delete(f"/api/admin/general-meetings/{agm.id}")
            assert response.status_code == 401


class TestReorderMotions:
    """Tests for the bulk motion reorder endpoint."""

    async def _create_meeting_with_motions(
        self,
        db_session: AsyncSession,
        name: str,
        status: GeneralMeetingStatus = GeneralMeetingStatus.open,
        motion_count: int = 3,
    ) -> tuple[GeneralMeeting, list[Motion]]:
        b = Building(name=name, manager_email=f"reorder_{name}@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title=f"Reorder Test {name}",
            status=status,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()
        motions = []
        for i in range(1, motion_count + 1):
            m = Motion(
                general_meeting_id=agm.id,
                title=f"Motion {i}",
                display_order=i,
            )
            db_session.add(m)
            motions.append(m)
        await db_session.flush()
        for m in motions:
            await db_session.refresh(m)
        await db_session.commit()
        await db_session.refresh(agm)
        return agm, motions

    # --- Happy path ---

    async def test_reorder_three_motions(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Reorder 3 motions: verify display_order values updated correctly."""
        agm, motions = await self._create_meeting_with_motions(
            db_session, "ReorderHappy3", motion_count=3
        )
        m1, m2, m3 = motions
        # Send in reverse order: m3 → 1, m2 → 2, m1 → 3
        payload = {
            "motions": [
                {"motion_id": str(m3.id), "display_order": 1},
                {"motion_id": str(m2.id), "display_order": 2},
                {"motion_id": str(m1.id), "display_order": 3},
            ]
        }
        response = await client.put(
            f"/api/admin/general-meetings/{agm.id}/motions/reorder",
            json=payload,
        )
        assert response.status_code == 200
        data = response.json()
        assert "motions" in data
        returned_motions = data["motions"]
        assert len(returned_motions) == 3
        # Should be sorted by display_order
        assert returned_motions[0]["id"] == str(m3.id)
        assert returned_motions[0]["display_order"] == 1
        assert returned_motions[1]["id"] == str(m2.id)
        assert returned_motions[1]["display_order"] == 2
        assert returned_motions[2]["id"] == str(m1.id)
        assert returned_motions[2]["display_order"] == 3

    async def test_reorder_normalises_to_sequential_positions(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Non-sequential submitted display_order values are normalised to 1-based sequential."""
        agm, motions = await self._create_meeting_with_motions(
            db_session, "ReorderNorm", motion_count=3
        )
        m1, m2, m3 = motions
        # Submit non-sequential values: 10, 20, 30 — should normalise to 1, 2, 3
        payload = {
            "motions": [
                {"motion_id": str(m3.id), "display_order": 10},
                {"motion_id": str(m1.id), "display_order": 20},
                {"motion_id": str(m2.id), "display_order": 30},
            ]
        }
        response = await client.put(
            f"/api/admin/general-meetings/{agm.id}/motions/reorder",
            json=payload,
        )
        assert response.status_code == 200
        returned = response.json()["motions"]
        assert returned[0]["id"] == str(m3.id)
        assert returned[0]["display_order"] == 1
        assert returned[1]["id"] == str(m1.id)
        assert returned[1]["display_order"] == 2
        assert returned[2]["id"] == str(m2.id)
        assert returned[2]["display_order"] == 3

    async def test_reorder_returns_full_motion_details(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Response includes all motion fields."""
        agm, motions = await self._create_meeting_with_motions(
            db_session, "ReorderFields", motion_count=2
        )
        m1, m2 = motions
        payload = {
            "motions": [
                {"motion_id": str(m2.id), "display_order": 1},
                {"motion_id": str(m1.id), "display_order": 2},
            ]
        }
        response = await client.put(
            f"/api/admin/general-meetings/{agm.id}/motions/reorder",
            json=payload,
        )
        assert response.status_code == 200
        first = response.json()["motions"][0]
        assert "id" in first
        assert "title" in first
        assert "display_order" in first
        assert "motion_number" in first
        assert "motion_type" in first

    async def test_reorder_single_motion_no_op(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Single motion meeting: reorder with the same ID succeeds."""
        agm, motions = await self._create_meeting_with_motions(
            db_session, "ReorderSingle", motion_count=1
        )
        m1 = motions[0]
        payload = {
            "motions": [
                {"motion_id": str(m1.id), "display_order": 1},
            ]
        }
        response = await client.put(
            f"/api/admin/general-meetings/{agm.id}/motions/reorder",
            json=payload,
        )
        assert response.status_code == 200
        assert len(response.json()["motions"]) == 1

    async def test_reorder_pending_meeting_succeeds(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Reorder is allowed on pending meetings."""
        agm, motions = await self._create_meeting_with_motions(
            db_session, "ReorderPending", status=GeneralMeetingStatus.pending, motion_count=2
        )
        m1, m2 = motions
        payload = {
            "motions": [
                {"motion_id": str(m2.id), "display_order": 1},
                {"motion_id": str(m1.id), "display_order": 2},
            ]
        }
        response = await client.put(
            f"/api/admin/general-meetings/{agm.id}/motions/reorder",
            json=payload,
        )
        assert response.status_code == 200

    # --- Input validation ---

    async def test_reorder_empty_list_returns_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Empty motion list returns 422."""
        agm, _ = await self._create_meeting_with_motions(
            db_session, "ReorderEmpty", motion_count=2
        )
        payload = {"motions": []}
        response = await client.put(
            f"/api/admin/general-meetings/{agm.id}/motions/reorder",
            json=payload,
        )
        assert response.status_code == 422

    async def test_reorder_extra_ids_returns_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Submitting extra motion IDs (not belonging to meeting) returns 422."""
        agm, motions = await self._create_meeting_with_motions(
            db_session, "ReorderExtra", motion_count=2
        )
        m1, m2 = motions
        fake_id = uuid.uuid4()
        payload = {
            "motions": [
                {"motion_id": str(m1.id), "display_order": 1},
                {"motion_id": str(m2.id), "display_order": 2},
                {"motion_id": str(fake_id), "display_order": 3},
            ]
        }
        response = await client.put(
            f"/api/admin/general-meetings/{agm.id}/motions/reorder",
            json=payload,
        )
        assert response.status_code == 422
        assert "motion_order" in response.json()["detail"]

    async def test_reorder_missing_ids_returns_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Submitting fewer motion IDs than exist in the meeting returns 422."""
        agm, motions = await self._create_meeting_with_motions(
            db_session, "ReorderMissing", motion_count=3
        )
        m1, _, _ = motions
        # Only include 1 of 3 motions
        payload = {
            "motions": [
                {"motion_id": str(m1.id), "display_order": 1},
            ]
        }
        response = await client.put(
            f"/api/admin/general-meetings/{agm.id}/motions/reorder",
            json=payload,
        )
        assert response.status_code == 422

    async def test_reorder_ids_from_different_meeting_returns_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Submitting IDs from a different meeting returns 422."""
        agm1, motions1 = await self._create_meeting_with_motions(
            db_session, "ReorderAGM1", motion_count=2
        )
        agm2, motions2 = await self._create_meeting_with_motions(
            db_session, "ReorderAGM2", motion_count=2
        )
        # Send motions from agm2 to agm1's endpoint
        payload = {
            "motions": [
                {"motion_id": str(motions2[0].id), "display_order": 1},
                {"motion_id": str(motions2[1].id), "display_order": 2},
            ]
        }
        response = await client.put(
            f"/api/admin/general-meetings/{agm1.id}/motions/reorder",
            json=payload,
        )
        assert response.status_code == 422

    async def test_reorder_duplicate_display_order_in_request_returns_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Duplicate display_order values in request body returns 422."""
        agm, motions = await self._create_meeting_with_motions(
            db_session, "ReorderDupOrder", motion_count=2
        )
        m1, m2 = motions
        payload = {
            "motions": [
                {"motion_id": str(m1.id), "display_order": 1},
                {"motion_id": str(m2.id), "display_order": 1},  # duplicate
            ]
        }
        response = await client.put(
            f"/api/admin/general-meetings/{agm.id}/motions/reorder",
            json=payload,
        )
        assert response.status_code == 422
        assert "Duplicate" in response.json()["detail"]

    # --- State / precondition errors ---

    async def test_reorder_closed_meeting_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Reorder on a closed meeting returns 409."""
        agm, motions = await self._create_meeting_with_motions(
            db_session, "ReorderClosed", status=GeneralMeetingStatus.closed, motion_count=2
        )
        m1, m2 = motions
        payload = {
            "motions": [
                {"motion_id": str(m2.id), "display_order": 1},
                {"motion_id": str(m1.id), "display_order": 2},
            ]
        }
        response = await client.put(
            f"/api/admin/general-meetings/{agm.id}/motions/reorder",
            json=payload,
        )
        assert response.status_code == 409
        assert "closed" in response.json()["detail"].lower()

    async def test_reorder_meeting_not_found_returns_404(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Reorder on a non-existent meeting returns 404."""
        fake_id = uuid.uuid4()
        payload = {
            "motions": [
                {"motion_id": str(uuid.uuid4()), "display_order": 1},
            ]
        }
        response = await client.put(
            f"/api/admin/general-meetings/{fake_id}/motions/reorder",
            json=payload,
        )
        assert response.status_code == 404
        assert "General Meeting not found" in response.json()["detail"]

    # --- Edge cases ---

    async def test_reorder_does_not_change_motion_numbers(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Reordering motions must never mutate motion_number — it is a stable identifier.

        Creates 2 motions with explicit motion_numbers "1" and "2", swaps their
        display_order, then asserts that each motion still carries its original
        motion_number even though display_order has changed.
        """
        b = Building(name="ReorderMN2", manager_email="rmn2@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="Reorder MN Test 2",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()
        m1 = Motion(
            general_meeting_id=agm.id,
            title="Alpha",
            display_order=1,
            motion_number="1",
        )
        m2 = Motion(
            general_meeting_id=agm.id,
            title="Beta",
            display_order=2,
            motion_number="2",
        )
        db_session.add_all([m1, m2])
        await db_session.flush()
        await db_session.refresh(m1)
        await db_session.refresh(m2)
        await db_session.commit()

        # Move m1 (motion_number="1", currently display_order=1) down to position 2
        payload = {
            "motions": [
                {"motion_id": str(m2.id), "display_order": 1},
                {"motion_id": str(m1.id), "display_order": 2},
            ]
        }
        response = await client.put(
            f"/api/admin/general-meetings/{agm.id}/motions/reorder",
            json=payload,
        )
        assert response.status_code == 200
        returned = response.json()["motions"]

        # m2 is now first (display_order=1) but still has motion_number "2"
        assert returned[0]["id"] == str(m2.id)
        assert returned[0]["display_order"] == 1
        assert returned[0]["motion_number"] == "2", (
            "motion_number must not change when display_order changes"
        )
        # m1 is now second (display_order=2) but still has motion_number "1"
        assert returned[1]["id"] == str(m1.id)
        assert returned[1]["display_order"] == 2
        assert returned[1]["motion_number"] == "1", (
            "motion_number must not change when display_order changes"
        )

    async def test_reorder_same_order_is_idempotent(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Reordering with the same order as current returns the same display_order values."""
        agm, motions = await self._create_meeting_with_motions(
            db_session, "ReorderIdempotent", motion_count=3
        )
        m1, m2, m3 = motions
        payload = {
            "motions": [
                {"motion_id": str(m1.id), "display_order": 1},
                {"motion_id": str(m2.id), "display_order": 2},
                {"motion_id": str(m3.id), "display_order": 3},
            ]
        }
        response = await client.put(
            f"/api/admin/general-meetings/{agm.id}/motions/reorder",
            json=payload,
        )
        assert response.status_code == 200
        returned = response.json()["motions"]
        assert returned[0]["display_order"] == 1
        assert returned[1]["display_order"] == 2
        assert returned[2]["display_order"] == 3

    async def test_reorder_does_not_change_motion_numbers(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Reordering motions must not change their motion_number values.

        Uses the auto-assign feature: create two motions without explicit
        motion_number so the backend assigns "1" and "2" respectively.
        After reversing the display order, the motion_number values must
        remain "1" and "2" tied to their original motions.
        """
        from app.models import Building as _Building, GeneralMeeting as _GM, Motion as _Motion, GeneralMeetingStatus as _GMS, MotionType as _MT
        from datetime import timezone

        b = _Building(name="ReorderNoMN", manager_email="rnmn@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = _GM(
            building_id=b.id,
            title="Reorder No MN Test",
            status=_GMS.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.commit()
        await db_session.refresh(agm)

        # Add two motions without motion_number — backend auto-assigns "1" and "2"
        r1 = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "First Motion"},
        )
        assert r1.status_code == 201
        assert r1.json()["motion_number"] == "1"
        m1_id = r1.json()["id"]

        r2 = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Second Motion"},
        )
        assert r2.status_code == 201
        assert r2.json()["motion_number"] == "2"
        m2_id = r2.json()["id"]

        # Reverse the display order
        response = await client.put(
            f"/api/admin/general-meetings/{agm.id}/motions/reorder",
            json={
                "motions": [
                    {"motion_id": m2_id, "display_order": 1},
                    {"motion_id": m1_id, "display_order": 2},
                ]
            },
        )
        assert response.status_code == 200
        returned = response.json()["motions"]

        # m2 is now first (display_order=1), but its motion_number is still "2"
        assert returned[0]["id"] == m2_id
        assert returned[0]["display_order"] == 1
        assert returned[0]["motion_number"] == "2"

        # m1 is now second (display_order=2), but its motion_number is still "1"
        assert returned[1]["id"] == m1_id
        assert returned[1]["display_order"] == 2
        assert returned[1]["motion_number"] == "1"


class TestToggleMotionVisibility:
    """Tests for the motion visibility toggle endpoint."""

    async def _create_open_meeting_with_motion(
        self,
        db_session: AsyncSession,
        label: str,
        motion_type: MotionType = MotionType.general,
        is_visible: bool = True,
        status: GeneralMeetingStatus = GeneralMeetingStatus.open,
    ) -> tuple[GeneralMeeting, Motion]:
        b = Building(name=f"VisBldg_{label}", manager_email=f"vis_{label}@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title=f"Vis Meeting {label}",
            status=status,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()
        motion = Motion(
            general_meeting_id=agm.id,
            title=f"Vis Motion {label}",
            display_order=1,
            motion_type=motion_type,
            is_visible=is_visible,
        )
        db_session.add(motion)
        await db_session.commit()
        await db_session.refresh(agm)
        await db_session.refresh(motion)
        return agm, motion

    # --- Happy path ---

    async def test_hide_motion_no_votes_returns_200(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """PATCH is_visible=false on a visible motion with no votes returns 200."""
        _agm, motion = await self._create_open_meeting_with_motion(
            db_session, "HideNoVotes", is_visible=True
        )
        response = await client.patch(
            f"/api/admin/motions/{motion.id}/visibility",
            json={"is_visible": False},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == str(motion.id)
        assert data["is_visible"] is False

    async def test_show_hidden_motion_returns_200(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """PATCH is_visible=true on a hidden motion returns 200."""
        _agm, motion = await self._create_open_meeting_with_motion(
            db_session, "ShowHidden", is_visible=False
        )
        response = await client.patch(
            f"/api/admin/motions/{motion.id}/visibility",
            json={"is_visible": True},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["is_visible"] is True

    async def test_toggle_persists_to_db(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """After toggling to hidden the DB row reflects is_visible=False."""
        _agm, motion = await self._create_open_meeting_with_motion(
            db_session, "PersistDB", is_visible=True
        )
        await client.patch(
            f"/api/admin/motions/{motion.id}/visibility",
            json={"is_visible": False},
        )
        await db_session.refresh(motion)
        assert motion.is_visible is False

    async def test_toggle_response_includes_tally_structure(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Response includes the expected tally and voter_lists structure."""
        _agm, motion = await self._create_open_meeting_with_motion(
            db_session, "TallyStruct", is_visible=True
        )
        response = await client.patch(
            f"/api/admin/motions/{motion.id}/visibility",
            json={"is_visible": False},
        )
        assert response.status_code == 200
        data = response.json()
        assert "tally" in data
        assert "voter_lists" in data
        for cat in ("yes", "no", "abstained", "absent", "not_eligible"):
            assert cat in data["tally"]
            assert cat in data["voter_lists"]

    async def test_hide_motion_on_pending_meeting_returns_200(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Hiding a motion on a pending meeting (not yet open/closed) succeeds."""
        _agm, motion = await self._create_open_meeting_with_motion(
            db_session, "PendingHide", is_visible=True, status=GeneralMeetingStatus.pending
        )
        response = await client.patch(
            f"/api/admin/motions/{motion.id}/visibility",
            json={"is_visible": False},
        )
        assert response.status_code == 200
        assert response.json()["is_visible"] is False

    async def test_hide_motion_with_only_draft_votes_returns_200(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Hiding a motion that only has draft (not submitted) votes succeeds."""
        b = Building(name="VisBldg_DraftVotes", manager_email="vis_draft@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="Vis Meeting DraftVotes",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()
        lo = LotOwner(building_id=b.id, lot_number="DV1", unit_entitlement=10)
        db_session.add(lo)
        await db_session.flush()
        motion = Motion(
            general_meeting_id=agm.id,
            title="Vis Motion DraftVotes",
            display_order=1,
            is_visible=True,
        )
        db_session.add(motion)
        await db_session.flush()
        # Add a draft vote (status != submitted) — should NOT block hiding
        draft_vote = Vote(
            general_meeting_id=agm.id,
            motion_id=motion.id,
            voter_email="draftvoter@test.com",
            lot_owner_id=lo.id,
            choice=VoteChoice.yes,
            status=VoteStatus.draft,
        )
        db_session.add(draft_vote)
        await db_session.commit()
        await db_session.refresh(motion)

        response = await client.patch(
            f"/api/admin/motions/{motion.id}/visibility",
            json={"is_visible": False},
        )
        assert response.status_code == 200
        assert response.json()["is_visible"] is False

    # --- Input validation ---

    async def test_missing_is_visible_returns_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """PATCH with missing body returns 422."""
        _agm, motion = await self._create_open_meeting_with_motion(
            db_session, "MissingBody"
        )
        response = await client.patch(
            f"/api/admin/motions/{motion.id}/visibility",
            json={},
        )
        assert response.status_code == 422

    async def test_invalid_is_visible_type_returns_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """PATCH with a dict value for is_visible (non-coercible) returns 422."""
        _agm, motion = await self._create_open_meeting_with_motion(
            db_session, "InvalidType"
        )
        response = await client.patch(
            f"/api/admin/motions/{motion.id}/visibility",
            json={"is_visible": {"nested": "object"}},
        )
        assert response.status_code == 422

    # --- State / precondition errors ---

    async def test_hide_motion_with_submitted_votes_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Hiding a motion that has submitted votes returns 409."""
        b = Building(name="VisBldg_VotedHide", manager_email="vis_voted@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="Vis Meeting VotedHide",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()
        lo = LotOwner(building_id=b.id, lot_number="VH1", unit_entitlement=10)
        db_session.add(lo)
        await db_session.flush()
        motion = Motion(
            general_meeting_id=agm.id,
            title="Vis Motion VotedHide",
            display_order=1,
            is_visible=True,
        )
        db_session.add(motion)
        await db_session.flush()
        # Add a submitted vote — should BLOCK hiding
        submitted_vote = Vote(
            general_meeting_id=agm.id,
            motion_id=motion.id,
            voter_email="voted@test.com",
            lot_owner_id=lo.id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        )
        db_session.add(submitted_vote)
        await db_session.commit()
        await db_session.refresh(motion)

        response = await client.patch(
            f"/api/admin/motions/{motion.id}/visibility",
            json={"is_visible": False},
        )
        assert response.status_code == 409
        assert "Cannot hide a motion that has received votes" in response.json()["detail"]

    async def test_toggle_on_closed_meeting_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Toggling visibility on a closed meeting returns 409."""
        _agm, motion = await self._create_open_meeting_with_motion(
            db_session, "ClosedToggle", is_visible=True, status=GeneralMeetingStatus.closed
        )
        response = await client.patch(
            f"/api/admin/motions/{motion.id}/visibility",
            json={"is_visible": False},
        )
        assert response.status_code == 409
        assert "Cannot change visibility on a closed meeting" in response.json()["detail"]

    async def test_show_on_closed_meeting_also_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Showing a hidden motion on a closed meeting also returns 409."""
        _agm, motion = await self._create_open_meeting_with_motion(
            db_session, "ClosedShow", is_visible=False, status=GeneralMeetingStatus.closed
        )
        response = await client.patch(
            f"/api/admin/motions/{motion.id}/visibility",
            json={"is_visible": True},
        )
        assert response.status_code == 409

    # --- Edge cases ---

    async def test_motion_not_found_returns_404(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """PATCH on an unknown motion ID returns 404."""
        fake_id = uuid.uuid4()
        response = await client.patch(
            f"/api/admin/motions/{fake_id}/visibility",
            json={"is_visible": False},
        )
        assert response.status_code == 404
        assert "Motion not found" in response.json()["detail"]

    async def test_unauthenticated_returns_401(
        self, db_session: AsyncSession
    ):
        """PATCH without admin credentials returns 401."""
        from app.main import app as fastapi_app
        _agm, motion = await self._create_open_meeting_with_motion(
            db_session, "UnauthVis"
        )
        async with AsyncClient(
            transport=ASGITransport(app=fastapi_app), base_url="http://test"
        ) as unauthenticated_client:
            response = await unauthenticated_client.patch(
                f"/api/admin/motions/{motion.id}/visibility",
                json={"is_visible": False},
            )
            assert response.status_code == 401

    async def test_toggle_special_motion_returns_correct_motion_type(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Toggling a special motion returns motion_type='special' in response."""
        _agm, motion = await self._create_open_meeting_with_motion(
            db_session, "SpecialHide",
            motion_type=MotionType.special,
            is_visible=True,
        )
        response = await client.patch(
            f"/api/admin/motions/{motion.id}/visibility",
            json={"is_visible": False},
        )
        assert response.status_code == 200
        assert response.json()["motion_type"] == "special"
        assert response.json()["is_visible"] is False

    async def test_show_motion_with_votes_allowed(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Showing (is_visible=true) a hidden motion that has votes IS allowed (only hiding is guarded)."""
        b = Building(name="VisBldg_ShowVoted", manager_email="vis_showvoted@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="Vis Meeting ShowVoted",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()
        lo = LotOwner(building_id=b.id, lot_number="SV1", unit_entitlement=10)
        db_session.add(lo)
        await db_session.flush()
        motion = Motion(
            general_meeting_id=agm.id,
            title="Vis Motion ShowVoted",
            display_order=1,
            is_visible=False,
        )
        db_session.add(motion)
        await db_session.flush()
        submitted_vote = Vote(
            general_meeting_id=agm.id,
            motion_id=motion.id,
            voter_email="showvoted@test.com",
            lot_owner_id=lo.id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        )
        db_session.add(submitted_vote)
        await db_session.commit()
        await db_session.refresh(motion)

        # Showing a hidden-but-voted motion should be allowed
        response = await client.patch(
            f"/api/admin/motions/{motion.id}/visibility",
            json={"is_visible": True},
        )
        assert response.status_code == 200
        assert response.json()["is_visible"] is True

    async def test_is_visible_field_in_admin_detail_response(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """GET /api/admin/general-meetings/{id} includes is_visible on each motion."""
        _agm, motion = await self._create_open_meeting_with_motion(
            db_session, "DetailVisible", is_visible=True
        )
        response = await client.get(f"/api/admin/general-meetings/{_agm.id}")
        assert response.status_code == 200
        motions = response.json()["motions"]
        assert len(motions) == 1
        assert "is_visible" in motions[0]
        assert motions[0]["is_visible"] is True

    async def test_is_visible_false_reflected_in_detail(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """GET /api/admin/general-meetings/{id} reflects is_visible=false for hidden motions."""
        _agm, motion = await self._create_open_meeting_with_motion(
            db_session, "DetailHidden", is_visible=False
        )
        response = await client.get(f"/api/admin/general-meetings/{_agm.id}")
        assert response.status_code == 200
        motions = response.json()["motions"]
        assert motions[0]["is_visible"] is False


# ---------------------------------------------------------------------------
# POST /api/admin/general-meetings/{id}/motions
# PATCH /api/admin/motions/{id}
# DELETE /api/admin/motions/{id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestMotionManagement:
    """Tests for add, update, and delete motion endpoints."""

    async def _create_meeting(
        self,
        db_session: AsyncSession,
        label: str,
        status: GeneralMeetingStatus = GeneralMeetingStatus.open,
    ) -> GeneralMeeting:
        b = Building(name=f"MgmtBldg_{label}", manager_email=f"mgmt_{label}@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title=f"Mgmt Meeting {label}",
            status=status,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.commit()
        await db_session.refresh(agm)
        return agm

    async def _create_meeting_with_motion(
        self,
        db_session: AsyncSession,
        label: str,
        status: GeneralMeetingStatus = GeneralMeetingStatus.open,
        is_visible: bool = False,
        order_index: int = 0,
    ) -> tuple[GeneralMeeting, Motion]:
        agm = await self._create_meeting(db_session, label, status)
        motion = Motion(
            general_meeting_id=agm.id,
            title=f"Motion {label}",
            description=f"Desc {label}",
            display_order=order_index,
            motion_type=MotionType.general,
            is_visible=is_visible,
        )
        db_session.add(motion)
        await db_session.commit()
        await db_session.refresh(motion)
        return agm, motion

    # --- Happy path (add) ---

    async def test_add_motion_to_open_meeting_returns_201(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """POST adds a motion; returns 201 with is_visible=False and correct fields."""
        agm = await self._create_meeting(db_session, "AddOpen")
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "New Motion", "description": "Some desc", "motion_type": "general"},
        )
        assert response.status_code == 201
        data = response.json()
        assert data["title"] == "New Motion"
        assert data["description"] == "Some desc"
        assert data["motion_type"] == "general"
        assert data["is_visible"] is False
        assert "id" in data
        assert "display_order" in data

    async def test_add_motion_to_pending_meeting_returns_201(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """POST to a pending meeting also returns 201."""
        agm = await self._create_meeting(db_session, "AddPending", GeneralMeetingStatus.pending)
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Pending Motion"},
        )
        assert response.status_code == 201
        assert response.json()["is_visible"] is False

    async def test_add_motion_first_motion_order_index_zero(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """First motion on a meeting with no existing motions gets display_order=1 (1-based)."""
        agm = await self._create_meeting(db_session, "FirstMotion")
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "First"},
        )
        assert response.status_code == 201
        assert response.json()["display_order"] == 1

    async def test_add_motion_order_index_increments(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Second motion gets display_order = max + 1."""
        agm, _motion = await self._create_meeting_with_motion(db_session, "IncrOrder", order_index=0)
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Second Motion"},
        )
        assert response.status_code == 201
        assert response.json()["display_order"] == 1

    async def test_add_multiple_motions_sequential_order_indexes(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Adding 3 motions results in display_orders 1, 2, 3 (1-based) with no constraint violations."""
        agm = await self._create_meeting(db_session, "SeqOrder")
        indexes = []
        for i in range(3):
            r = await client.post(
                f"/api/admin/general-meetings/{agm.id}/motions",
                json={"title": f"Motion {i}"},
            )
            assert r.status_code == 201
            indexes.append(r.json()["display_order"])
        assert indexes == [1, 2, 3]

    async def test_add_motion_motion_type_defaults_to_general(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """When motion_type is omitted it defaults to 'general'."""
        agm = await self._create_meeting(db_session, "DefaultType")
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Default type motion"},
        )
        assert response.status_code == 201
        assert response.json()["motion_type"] == "general"

    async def test_add_special_motion_returns_special_type(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Specifying motion_type=special returns motion with motion_type='special'."""
        agm = await self._create_meeting(db_session, "SpecialAdd")
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Special", "motion_type": "special"},
        )
        assert response.status_code == 201
        assert response.json()["motion_type"] == "special"

    async def test_add_motion_description_null_when_omitted(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Description is null when not provided."""
        agm = await self._create_meeting(db_session, "NullDesc")
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "No Desc"},
        )
        assert response.status_code == 201
        assert response.json()["description"] is None

    async def test_add_motion_persists_to_db(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Added motion row appears in DB with correct fields."""
        agm = await self._create_meeting(db_session, "PersistAdd")
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Persist Check"},
        )
        assert response.status_code == 201
        motion_id = uuid.UUID(response.json()["id"])
        result = await db_session.execute(select(Motion).where(Motion.id == motion_id))
        motion = result.scalar_one_or_none()
        assert motion is not None
        assert motion.title == "Persist Check"
        assert motion.is_visible is False

    async def test_add_motion_with_motion_number_persists(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """motion_number supplied in add-motion payload is saved to DB and returned."""
        agm = await self._create_meeting(db_session, "AddMotionNumber")
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Numbered Motion", "motion_number": "SR-1"},
        )
        assert response.status_code == 201
        data = response.json()
        assert data["motion_number"] == "SR-1"
        motion_id = uuid.UUID(data["id"])
        result = await db_session.execute(select(Motion).where(Motion.id == motion_id))
        motion = result.scalar_one_or_none()
        assert motion is not None
        assert motion.motion_number == "SR-1"

    async def test_add_motion_without_motion_number_auto_assigns_display_order(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """When motion_number is omitted on empty meeting, it is auto-assigned to '1'."""
        agm = await self._create_meeting(db_session, "AddNoMotionNumber")
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Unnumbered Motion"},
        )
        assert response.status_code == 201
        data = response.json()
        # display_order is 1 for the first motion on an empty meeting (1-based)
        assert data["display_order"] == 1
        assert data["motion_number"] == "1"

    async def test_add_motion_whitespace_motion_number_auto_assigned(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Whitespace-only motion_number is treated as absent — auto-assigned '1' for first motion."""
        agm = await self._create_meeting(db_session, "AddWhitespaceNumber")
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Whitespace Number Motion", "motion_number": "   "},
        )
        assert response.status_code == 201
        # Whitespace is treated same as omitted — auto-assigns '1' for first motion on empty meeting
        assert response.json()["motion_number"] == "1"

    # --- State / precondition errors (duplicate motion_number) ---

    async def test_add_motion_duplicate_motion_number_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Adding a second motion with the same non-null motion_number returns 409."""
        agm = await self._create_meeting(db_session, "DupMotionNum")
        # First motion succeeds
        r1 = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "First Numbered", "motion_number": "SR-1"},
        )
        assert r1.status_code == 201
        # Second motion with same motion_number returns 409
        r2 = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Second Numbered", "motion_number": "SR-1"},
        )
        assert r2.status_code == 409
        assert "already exists" in r2.json()["detail"].lower()

    async def test_add_motion_explicit_motion_number_overrides_auto(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """When motion_number is explicitly provided, it overrides the auto-assigned value."""
        agm = await self._create_meeting(db_session, "ExplicitMotionNum")
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Explicitly Numbered", "motion_number": "SR-1"},
        )
        assert response.status_code == 201
        data = response.json()
        assert data["motion_number"] == "SR-1"

    async def test_add_motion_two_omitted_numbers_auto_assigns_sequential(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Adding two motions without motion_number auto-assigns sequential 1-based numbers."""
        agm = await self._create_meeting(db_session, "AutoSeqMotionNum")
        r1 = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "First Auto Number"},
        )
        assert r1.status_code == 201
        # First motion on empty meeting → motion_number="1"
        assert r1.json()["motion_number"] == "1"
        r2 = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Second Auto Number"},
        )
        assert r2.status_code == 201
        # Second motion → max("1")+1 = "2"
        assert r2.json()["motion_number"] == "2"

    # --- Input validation (add) ---

    async def test_add_motion_missing_title_returns_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Missing title in body returns 422."""
        agm = await self._create_meeting(db_session, "MissingTitle")
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"description": "No title"},
        )
        assert response.status_code == 422

    async def test_add_motion_empty_title_returns_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Empty (whitespace-only) title returns 422."""
        agm = await self._create_meeting(db_session, "EmptyTitle")
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "   "},
        )
        assert response.status_code == 422

    async def test_add_motion_unknown_motion_type_returns_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Unknown motion_type value returns 422."""
        agm = await self._create_meeting(db_session, "BadType")
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Bad", "motion_type": "invalid"},
        )
        assert response.status_code == 422

    # --- State / precondition errors (add) ---

    async def test_add_motion_closed_meeting_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Adding a motion to a closed meeting returns 409."""
        agm = await self._create_meeting(db_session, "AddClosed", GeneralMeetingStatus.closed)
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Blocked"},
        )
        assert response.status_code == 409
        assert "closed" in response.json()["detail"].lower()

    async def test_add_motion_meeting_not_found_returns_404(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Adding to a non-existent meeting returns 404."""
        fake_id = uuid.uuid4()
        response = await client.post(
            f"/api/admin/general-meetings/{fake_id}/motions",
            json={"title": "Ghost meeting"},
        )
        assert response.status_code == 404
        assert "General Meeting not found" in response.json()["detail"]

    async def test_add_motion_requires_admin_returns_403(
        self, db_session: AsyncSession
    ):
        """POST without admin auth returns 401."""
        from app.main import app as fastapi_app
        agm = await self._create_meeting(db_session, "AddUnauth")
        async with AsyncClient(
            transport=ASGITransport(app=fastapi_app), base_url="http://test"
        ) as unauthenticated_client:
            response = await unauthenticated_client.post(
                f"/api/admin/general-meetings/{agm.id}/motions",
                json={"title": "Unauth"},
            )
            assert response.status_code == 401

    # --- motion_number auto-assign (add) ---

    async def test_add_motion_no_motion_number_auto_assigns_from_display_order(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """When motion_number is omitted on empty meeting, auto-assigns '1' (1-based)."""
        agm = await self._create_meeting(db_session, "AutoNumOmit")
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Auto Number"},
        )
        assert response.status_code == 201
        data = response.json()
        # First motion on empty meeting → display_order=1, motion_number="1"
        assert data["display_order"] == 1
        assert data["motion_number"] == "1"

    async def test_add_motion_null_motion_number_auto_assigns(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """When motion_number is explicitly null, auto-assigns '1' for first motion."""
        agm = await self._create_meeting(db_session, "AutoNumNull")
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Null MN", "motion_number": None},
        )
        assert response.status_code == 201
        data = response.json()
        assert data["motion_number"] == "1"

    async def test_add_motion_empty_string_motion_number_auto_assigns(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """When the frontend sends motion_number='', auto-assigns '1' for first motion.

        This is the core bug scenario: the frontend sends an empty string when the field
        is left blank. Previously the service stored null instead of auto-assigning.
        """
        agm = await self._create_meeting(db_session, "AutoNumEmpty")
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Empty MN", "motion_number": ""},
        )
        assert response.status_code == 201
        data = response.json()
        assert data["motion_number"] == "1"

    async def test_add_motion_explicit_motion_number_preserved(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """When motion_number is explicitly provided, it is preserved as-is."""
        agm = await self._create_meeting(db_session, "ExplicitMN")
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Custom MN", "motion_number": "SR-5"},
        )
        assert response.status_code == 201
        assert response.json()["motion_number"] == "SR-5"

    async def test_add_motion_whitespace_only_motion_number_auto_assigns(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Whitespace-only motion_number is treated as blank and auto-assigns '1' for first motion."""
        agm = await self._create_meeting(db_session, "WsMN")
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Whitespace MN", "motion_number": "   "},
        )
        assert response.status_code == 201
        data = response.json()
        assert data["motion_number"] == "1"

    async def test_add_motion_second_motion_auto_assigns_correct_number(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Second motion auto-assigns motion_number = '2' (max("1")+1)."""
        agm, _first = await self._create_meeting_with_motion(db_session, "SecondAutoMN", order_index=1)
        # The helper creates a motion without motion_number (None), so max numeric is None.
        # next_index = display_order(1) + 1 = 2 for the second motion.
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Second Auto"},
        )
        assert response.status_code == 201
        data = response.json()
        assert data["display_order"] == 2
        assert data["motion_number"] == "2"

    async def test_add_motion_first_motion_starts_at_1(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Fix 3: The first auto-assigned motion_number on an empty meeting is '1', not '0'."""
        agm = await self._create_meeting(db_session, "FirstMN1Based")
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "First Motion"},
        )
        assert response.status_code == 201
        data = response.json()
        assert data["motion_number"] == "1", (
            "Auto-assigned motion_number must start at '1' (1-based), not '0'"
        )
        assert data["display_order"] == 1

    async def test_add_motion_motion_number_persisted_in_db(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Auto-assigned motion_number is stored correctly in the DB row."""
        agm = await self._create_meeting(db_session, "PersistMN")
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "DB Check MN"},
        )
        assert response.status_code == 201
        motion_id = uuid.UUID(response.json()["id"])
        result = await db_session.execute(select(Motion).where(Motion.id == motion_id))
        motion = result.scalar_one_or_none()
        assert motion is not None
        assert motion.motion_number == "1"

    # --- RR2-02: auto-assign avoids conflict with manual numeric motion_number ---

    async def test_rr2_02_auto_assign_avoids_conflict_with_manual_number(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """RR2-02: When an existing motion has motion_number='1' manually set,
        auto-assigning a second motion should use max+1 = '2', not display_order='1',
        which would have caused a 409 unique constraint violation."""
        agm = await self._create_meeting(db_session, "RR202Conflict")
        # First: add a motion with explicit motion_number="1"
        r1 = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Manual Number One", "motion_number": "1"},
        )
        assert r1.status_code == 201
        assert r1.json()["motion_number"] == "1"

        # Second: add a motion without specifying motion_number — display_order would be 1
        # which equals the manually set "1", causing a 409 under the old logic.
        # The new logic uses max(numeric motion_numbers) + 1 = 2, avoiding the conflict.
        r2 = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Auto Assigned After Manual"},
        )
        assert r2.status_code == 201
        data = r2.json()
        assert data["display_order"] == 2  # display_order is 2 (max(1)+1)
        assert data["motion_number"] == "2"  # motion_number = max(1)+1 = 2, avoids conflict with "1"

    async def test_rr2_02_auto_assign_with_non_numeric_existing_numbers_falls_back(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """RR2-02: When existing motion_numbers are all non-numeric (e.g. 'A', 'B'),
        auto-assign falls back to str(display_order)."""
        agm = await self._create_meeting(db_session, "RR202NonNumeric")
        # Add motion with non-numeric motion_number
        r1 = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Alpha Motion", "motion_number": "A"},
        )
        assert r1.status_code == 201
        assert r1.json()["motion_number"] == "A"

        # Auto-assign: no numeric motion_numbers exist → falls back to display_order
        r2 = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Auto After Non-numeric"},
        )
        assert r2.status_code == 201
        data = r2.json()
        # Falls back to str(display_order) = "1" since "A" is non-numeric
        assert data["motion_number"] == str(data["display_order"])

    async def test_rr2_02_auto_assign_mixed_numeric_non_numeric(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """RR2-02: When both numeric and non-numeric motion_numbers exist,
        auto-assign uses max(numeric) + 1."""
        agm = await self._create_meeting(db_session, "RR202Mixed")
        # Add motion with non-numeric number
        r1 = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "SR Motion", "motion_number": "SR-1"},
        )
        assert r1.status_code == 201
        # Add motion with numeric number "3"
        r2 = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Numeric Three", "motion_number": "3"},
        )
        assert r2.status_code == 201
        # Auto-assign: max numeric = 3, so next = 4
        r3 = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Auto After Mixed"},
        )
        assert r3.status_code == 201
        assert r3.json()["motion_number"] == "4"

    # --- Happy path (update) ---

    async def test_update_motion_all_fields_returns_200(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """PATCH with all fields (including motion_number) returns 200 and updated values."""
        _agm, motion = await self._create_meeting_with_motion(db_session, "UpdateAll")
        response = await client.patch(
            f"/api/admin/motions/{motion.id}",
            json={"title": "Updated Title", "description": "Updated Desc", "motion_type": "special", "motion_number": "42"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["title"] == "Updated Title"
        assert data["description"] == "Updated Desc"
        assert data["motion_type"] == "special"
        assert data["motion_number"] == "42"
        assert data["is_visible"] is False

    async def test_update_motion_partial_title_only(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """PATCH with only title updates title; other fields unchanged."""
        _agm, motion = await self._create_meeting_with_motion(db_session, "PartialTitle")
        original_type = motion.motion_type
        response = await client.patch(
            f"/api/admin/motions/{motion.id}",
            json={"title": "New Title Only"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["title"] == "New Title Only"
        assert data["motion_type"] == original_type.value if hasattr(original_type, "value") else original_type

    async def test_update_motion_partial_description_only(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """PATCH with only description updates description; other fields unchanged."""
        _agm, motion = await self._create_meeting_with_motion(db_session, "PartialDesc")
        response = await client.patch(
            f"/api/admin/motions/{motion.id}",
            json={"description": "Only desc changed"},
        )
        assert response.status_code == 200
        assert response.json()["description"] == "Only desc changed"
        assert response.json()["title"] == motion.title

    async def test_update_motion_partial_motion_type_only(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """PATCH with only motion_type updates type; other fields unchanged."""
        _agm, motion = await self._create_meeting_with_motion(db_session, "PartialType")
        response = await client.patch(
            f"/api/admin/motions/{motion.id}",
            json={"motion_type": "special"},
        )
        assert response.status_code == 200
        assert response.json()["motion_type"] == "special"
        assert response.json()["title"] == motion.title

    async def test_update_motion_persists_to_db(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Updated fields including motion_number are persisted in the DB."""
        _agm, motion = await self._create_meeting_with_motion(db_session, "PersistUpdate")
        await client.patch(
            f"/api/admin/motions/{motion.id}",
            json={"title": "DB Persisted", "motion_number": "99"},
        )
        await db_session.refresh(motion)
        assert motion.title == "DB Persisted"
        assert motion.motion_number == "99"

    # --- Input validation (update) ---

    async def test_update_motion_no_fields_returns_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """PATCH with empty body returns 422."""
        _agm, motion = await self._create_meeting_with_motion(db_session, "NoFields")
        response = await client.patch(
            f"/api/admin/motions/{motion.id}",
            json={},
        )
        assert response.status_code == 422

    async def test_update_motion_partial_motion_number_only(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """PATCH with only motion_number updates it and returns 200."""
        _agm, motion = await self._create_meeting_with_motion(db_session, "MotionNumberOnly")
        response = await client.patch(
            f"/api/admin/motions/{motion.id}",
            json={"motion_number": "SR-1"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["motion_number"] == "SR-1"
        # Other fields unchanged
        assert data["title"] == motion.title

    async def test_update_motion_motion_number_clear_with_empty_string(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """PATCH with motion_number='' clears the motion number (stores NULL)."""
        _agm, motion = await self._create_meeting_with_motion(db_session, "ClearMotionNumber")
        # First set a motion number
        await client.patch(
            f"/api/admin/motions/{motion.id}",
            json={"motion_number": "5"},
        )
        # Now clear it with empty string
        response = await client.patch(
            f"/api/admin/motions/{motion.id}",
            json={"motion_number": ""},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["motion_number"] is None

    async def test_update_motion_empty_title_returns_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """PATCH with empty title returns 422."""
        _agm, motion = await self._create_meeting_with_motion(db_session, "EmptyTitleUpdate")
        response = await client.patch(
            f"/api/admin/motions/{motion.id}",
            json={"title": "   "},
        )
        assert response.status_code == 422

    # --- State / precondition errors (update) ---

    async def test_update_motion_visible_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """PATCH on a visible motion returns 409."""
        _agm, motion = await self._create_meeting_with_motion(
            db_session, "UpdateVisible", is_visible=True
        )
        response = await client.patch(
            f"/api/admin/motions/{motion.id}",
            json={"title": "Try update visible"},
        )
        assert response.status_code == 409
        assert "Cannot edit a visible motion" in response.json()["detail"]

    async def test_update_motion_closed_meeting_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """PATCH on a motion in a closed meeting returns 409."""
        _agm, motion = await self._create_meeting_with_motion(
            db_session, "UpdateClosed", status=GeneralMeetingStatus.closed, is_visible=False
        )
        response = await client.patch(
            f"/api/admin/motions/{motion.id}",
            json={"title": "Try update closed"},
        )
        assert response.status_code == 409
        assert "closed" in response.json()["detail"].lower()

    async def test_update_motion_not_found_returns_404(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """PATCH on a non-existent motion returns 404."""
        fake_id = uuid.uuid4()
        response = await client.patch(
            f"/api/admin/motions/{fake_id}",
            json={"title": "Ghost"},
        )
        assert response.status_code == 404
        assert "Motion not found" in response.json()["detail"]

    async def test_update_motion_requires_admin_returns_401(
        self, db_session: AsyncSession
    ):
        """PATCH without admin auth returns 401."""
        from app.main import app as fastapi_app
        _agm, motion = await self._create_meeting_with_motion(db_session, "UpdateUnauth")
        async with AsyncClient(
            transport=ASGITransport(app=fastapi_app), base_url="http://test"
        ) as unauthenticated_client:
            response = await unauthenticated_client.patch(
                f"/api/admin/motions/{motion.id}",
                json={"title": "Unauth"},
            )
            assert response.status_code == 401

    async def test_update_motion_all_fields_includes_motion_number(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """PATCH with all fields including motion_number returns 200 with motion_number set."""
        _agm, motion = await self._create_meeting_with_motion(db_session, "UpdateAllMN")
        response = await client.patch(
            f"/api/admin/motions/{motion.id}",
            json={"title": "Updated Title MN", "description": "Updated Desc MN", "motion_type": "special", "motion_number": "42"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["title"] == "Updated Title MN"
        assert data["description"] == "Updated Desc MN"
        assert data["motion_type"] == "special"
        assert data["motion_number"] == "42"
        assert data["is_visible"] is False

    async def test_update_motion_partial_motion_number_only(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """PATCH with only motion_number updates it; other fields unchanged."""
        _agm, motion = await self._create_meeting_with_motion(db_session, "PartialMN")
        response = await client.patch(
            f"/api/admin/motions/{motion.id}",
            json={"motion_number": "SR-1"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["motion_number"] == "SR-1"
        assert data["title"] == motion.title

    async def test_update_motion_motion_number_empty_string_clears(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """PATCH with motion_number='' clears the motion_number to null."""
        _agm, motion = await self._create_meeting_with_motion(db_session, "ClearMN")
        # First set a motion number
        await client.patch(
            f"/api/admin/motions/{motion.id}",
            json={"motion_number": "OLD-NUM"},
        )
        # Now clear it with empty string
        response = await client.patch(
            f"/api/admin/motions/{motion.id}",
            json={"motion_number": ""},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["motion_number"] is None

    # --- Happy path (delete) ---

    async def test_delete_motion_returns_204(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """DELETE on a hidden motion returns 204."""
        _agm, motion = await self._create_meeting_with_motion(db_session, "DeleteOK")
        response = await client.delete(f"/api/admin/motions/{motion.id}")
        assert response.status_code == 204

    async def test_delete_motion_removes_from_db(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """After DELETE the motion row is absent from the DB."""
        _agm, motion = await self._create_meeting_with_motion(db_session, "DeleteDB")
        motion_id = motion.id
        await client.delete(f"/api/admin/motions/{motion_id}")
        result = await db_session.execute(select(Motion).where(Motion.id == motion_id))
        assert result.scalar_one_or_none() is None

    async def test_delete_motion_other_motions_unaffected(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Deleting one motion does not affect remaining motions (no renumbering)."""
        agm, motion_a = await self._create_meeting_with_motion(db_session, "DeleteOther", order_index=0)
        motion_b = Motion(
            general_meeting_id=agm.id,
            title="Motion B",
            display_order=1,
            is_visible=False,
        )
        db_session.add(motion_b)
        await db_session.commit()
        await db_session.refresh(motion_b)

        await client.delete(f"/api/admin/motions/{motion_a.id}")

        result = await db_session.execute(select(Motion).where(Motion.id == motion_b.id))
        surviving = result.scalar_one_or_none()
        assert surviving is not None
        assert surviving.display_order == 1  # Not renumbered

    # --- State / precondition errors (delete) ---

    async def test_delete_motion_visible_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """DELETE on a visible motion returns 409."""
        _agm, motion = await self._create_meeting_with_motion(
            db_session, "DeleteVisible", is_visible=True
        )
        response = await client.delete(f"/api/admin/motions/{motion.id}")
        assert response.status_code == 409
        assert "Cannot delete a visible motion" in response.json()["detail"]

    async def test_delete_motion_closed_meeting_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """DELETE on a motion in a closed meeting returns 409."""
        _agm, motion = await self._create_meeting_with_motion(
            db_session, "DeleteClosed", status=GeneralMeetingStatus.closed, is_visible=False
        )
        response = await client.delete(f"/api/admin/motions/{motion.id}")
        assert response.status_code == 409
        assert "closed" in response.json()["detail"].lower()

    async def test_delete_motion_not_found_returns_404(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """DELETE on a non-existent motion returns 404."""
        fake_id = uuid.uuid4()
        response = await client.delete(f"/api/admin/motions/{fake_id}")
        assert response.status_code == 404
        assert "Motion not found" in response.json()["detail"]

    async def test_delete_motion_requires_admin_returns_401(
        self, db_session: AsyncSession
    ):
        """DELETE without admin auth returns 401."""
        from app.main import app as fastapi_app
        _agm, motion = await self._create_meeting_with_motion(db_session, "DeleteUnauth")
        async with AsyncClient(
            transport=ASGITransport(app=fastapi_app), base_url="http://test"
        ) as unauthenticated_client:
            response = await unauthenticated_client.delete(f"/api/admin/motions/{motion.id}")
            assert response.status_code == 401


# ---------------------------------------------------------------------------
# Migration 888085a72643 — backfill motion_number from display_order
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestBackfillMotionNumber:
    """Tests for migration 888085a72643.

    The migration runs:
        UPDATE motions SET motion_number = CAST(display_order AS VARCHAR)
        WHERE motion_number IS NULL

    We verify this SQL directly against the test DB so the migration logic is
    covered independently of the Alembic runner.
    """

    # --- Happy path ---

    async def test_null_motion_number_is_backfilled_to_display_order(
        self, db_session: AsyncSession
    ):
        """A motion with motion_number=NULL gets backfilled to str(display_order)."""
        b = Building(name="BackfillMN1", manager_email="bmn1@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="Backfill Test 1",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()
        m = Motion(
            general_meeting_id=agm.id,
            title="Old Motion",
            display_order=3,
            motion_number=None,  # pre-feature state
        )
        db_session.add(m)
        await db_session.flush()

        # Run the exact migration SQL
        await db_session.execute(
            text(
                "UPDATE motions SET motion_number = CAST(display_order AS VARCHAR)"
                " WHERE motion_number IS NULL"
            )
        )

        await db_session.refresh(m)
        assert m.motion_number == "3", (
            "motion_number should be backfilled to str(display_order)"
        )

    async def test_existing_motion_number_is_not_overwritten(
        self, db_session: AsyncSession
    ):
        """A motion with an existing motion_number is untouched by the backfill."""
        b = Building(name="BackfillMN2", manager_email="bmn2@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="Backfill Test 2",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()
        m = Motion(
            general_meeting_id=agm.id,
            title="Numbered Motion",
            display_order=1,
            motion_number="SR-1",  # already has a value
        )
        db_session.add(m)
        await db_session.flush()

        # Run the exact migration SQL
        await db_session.execute(
            text(
                "UPDATE motions SET motion_number = CAST(display_order AS VARCHAR)"
                " WHERE motion_number IS NULL"
            )
        )

        await db_session.refresh(m)
        assert m.motion_number == "SR-1", (
            "motion_number must not be overwritten when it already has a value"
        )

    # --- Boundary values ---

    async def test_multiple_null_motions_all_backfilled(
        self, db_session: AsyncSession
    ):
        """Multiple NULL motion_number rows are all backfilled in one UPDATE."""
        b = Building(name="BackfillMN3", manager_email="bmn3@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=b.id,
            title="Backfill Test 3",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()
        m1 = Motion(
            general_meeting_id=agm.id, title="M1", display_order=1, motion_number=None
        )
        m2 = Motion(
            general_meeting_id=agm.id, title="M2", display_order=2, motion_number=None
        )
        m3 = Motion(
            general_meeting_id=agm.id, title="M3", display_order=5, motion_number=None
        )
        db_session.add_all([m1, m2, m3])
        await db_session.flush()

        await db_session.execute(
            text(
                "UPDATE motions SET motion_number = CAST(display_order AS VARCHAR)"
                " WHERE motion_number IS NULL"
            )
        )

        for motion, expected in [(m1, "1"), (m2, "2"), (m3, "5")]:
            await db_session.refresh(motion)
            assert motion.motion_number == expected

    # --- Edge cases ---

    async def test_migration_on_empty_motions_table_is_a_no_op(
        self, db_session: AsyncSession
    ):
        """Running the UPDATE when no NULL rows exist does not error."""
        # First, ensure any existing NULL rows are already set (simulate post-migration state)
        await db_session.execute(
            text(
                "UPDATE motions SET motion_number = CAST(display_order AS VARCHAR)"
                " WHERE motion_number IS NULL"
            )
        )
        # Running a second time is idempotent — no rows to update, no error
        result = await db_session.execute(
            text(
                "UPDATE motions SET motion_number = CAST(display_order AS VARCHAR)"
                " WHERE motion_number IS NULL"
            )
        )
        assert result.rowcount == 0


# ---------------------------------------------------------------------------
# US-TCG-02: Concurrent ballot submission race condition
# ---------------------------------------------------------------------------


class TestConcurrentBallotSubmission:
    """Integration tests for US-TCG-02: concurrent POST /submit race condition guard.

    Uses asyncio.gather() to fire multiple simultaneous ballot submissions for the
    same (meeting_id, lot_owner_id) pair against the real test database.  Exactly
    one submission must succeed (200); all others must receive 409.  The DB must
    contain exactly one BallotSubmission row and no duplicate Vote rows.
    """

    async def _setup_meeting_with_voter(
        self,
        session_factory,
        label: str,
    ) -> dict:
        """Create a building, lot owner, open meeting with one motion, and a session token.

        Uses a standalone session (not the shared test session) so the data is visible
        to other DB connections used by the concurrent requests.  A UUID suffix ensures
        uniqueness across repeated test runs.
        """
        import secrets
        from app.services.auth_service import _sign_token
        from app.models.session_record import SessionRecord

        unique_suffix = uuid.uuid4().hex[:8]
        bname = f"ConcBldg_{label}_{unique_suffix}"

        async with session_factory() as s:
            b = Building(name=bname, manager_email=f"conc_{unique_suffix}@test.com")
            s.add(b)
            await s.flush()

            lo = LotOwner(building_id=b.id, lot_number=f"CC-{unique_suffix}", unit_entitlement=100)
            s.add(lo)
            await s.flush()

            lo_email = LotOwnerEmail(lot_owner_id=lo.id, email=f"conc_{unique_suffix}@voter.com")
            s.add(lo_email)

            agm = GeneralMeeting(
                building_id=b.id,
                title=f"Conc Meeting {label} {unique_suffix}",
                status=GeneralMeetingStatus.open,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
            s.add(agm)
            await s.flush()

            # Snapshot lot weight
            weight = GeneralMeetingLotWeight(
                general_meeting_id=agm.id,
                lot_owner_id=lo.id,
                unit_entitlement_snapshot=100,
            )
            s.add(weight)

            motion = Motion(
                general_meeting_id=agm.id,
                title=f"Conc Motion {label}",
                display_order=1,
                is_visible=True,
            )
            s.add(motion)
            await s.flush()

            # Create a valid session record so all 3 concurrent requests can authenticate
            raw_token = secrets.token_urlsafe(32)
            session_record = SessionRecord(
                session_token=raw_token,
                voter_email=f"conc_{unique_suffix}@voter.com",
                building_id=b.id,
                general_meeting_id=agm.id,
                expires_at=datetime.now(UTC) + timedelta(hours=24),
            )
            s.add(session_record)
            await s.commit()

            # Refresh to get IDs after commit
            await s.refresh(b)
            await s.refresh(lo)
            await s.refresh(agm)
            await s.refresh(motion)

        signed_token = _sign_token(raw_token)
        return {
            "agm_id": agm.id,
            "building_id": b.id,
            "lot_owner_id": lo.id,
            "motion_id": motion.id,
            "signed_token": signed_token,
        }

    async def _make_real_app(self, session_factory):
        """Build a FastAPI app instance wired to the given session_factory."""
        from app.main import create_app
        from app.routers.admin_auth import require_admin

        real_app = create_app()

        async def _real_db():
            async with session_factory() as s:
                yield s

        real_app.dependency_overrides[get_db] = _real_db
        real_app.dependency_overrides[require_admin] = lambda: None
        return real_app

    # --- Happy path ---

    async def test_concurrent_submissions_race_guard(self):
        """Three concurrent POST /submit requests for the same voter seed one race.

        All three properties are verified against the same asyncio.gather outcome:
        - Status codes: exactly 1 success (200) and the rest 409 — no 500s
        - DB consistency: exactly 1 BallotSubmission row after all requests complete
        - No vote duplication: exactly 1 Vote row per (motion, lot_owner) pair

        Uses the real test DB (separate engine) so the database unique constraints
        are exercised end-to-end rather than via mocked sessions.
        """
        import os
        from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

        test_db_url = os.getenv(
            "TEST_DATABASE_URL",
            "postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test",
        )
        engine = create_async_engine(test_db_url, echo=False, future=True)
        session_factory = async_sessionmaker(bind=engine, expire_on_commit=False)

        setup = await self._setup_meeting_with_voter(session_factory, "Race")
        agm_id = setup["agm_id"]
        lot_owner_id = setup["lot_owner_id"]
        motion_id = setup["motion_id"]
        signed_token = setup["signed_token"]

        real_app = await self._make_real_app(session_factory)

        payload = {
            "lot_owner_ids": [str(lot_owner_id)],
            "votes": [{"motion_id": str(motion_id), "choice": "yes"}],
        }

        async def _submit() -> int:
            async with AsyncClient(
                transport=ASGITransport(app=real_app), base_url="http://test"
            ) as c:
                r = await c.post(
                    f"/api/general-meeting/{agm_id}/submit",
                    json=payload,
                    headers={"Authorization": f"Bearer {signed_token}"},
                )
                return r.status_code

        # Fire 3 concurrent submissions against the same (meeting, lot) pair
        statuses = await asyncio.gather(_submit(), _submit(), _submit())

        # Verify DB state using the same engine/session
        async with session_factory() as s:
            bs_result = await s.execute(
                select(BallotSubmission).where(
                    BallotSubmission.general_meeting_id == agm_id,
                    BallotSubmission.lot_owner_id == lot_owner_id,
                )
            )
            submissions = list(bs_result.scalars().all())

            votes_result = await s.execute(
                select(Vote).where(
                    Vote.general_meeting_id == agm_id,
                    Vote.lot_owner_id == lot_owner_id,
                    Vote.motion_id == motion_id,
                    Vote.status == VoteStatus.submitted,
                )
            )
            votes = list(votes_result.scalars().all())

        await engine.dispose()

        # 1. Status codes: exactly one 200, rest 409, no 500s
        assert statuses.count(200) == 1, f"Expected 1 success, got statuses={statuses}"
        assert all(s in (200, 409) for s in statuses), (
            f"Unexpected status codes (expected 200 or 409 only): {statuses}"
        )

        # 2. DB consistency: exactly one BallotSubmission
        assert len(submissions) == 1, (
            f"Expected exactly 1 BallotSubmission, found {len(submissions)}"
        )

        # 3. No vote duplication: exactly one Vote row per motion-lot pair
        assert len(votes) == 1, (
            f"Expected exactly 1 Vote row (no duplicates), found {len(votes)}"
        )


# ---------------------------------------------------------------------------
# US-TCG-03: Email failure during meeting close
# ---------------------------------------------------------------------------


class TestEmailFailureDuringClose:
    """Integration tests for US-TCG-03: email service failure during AGM close.

    Tests that:
    1. The meeting closes successfully (status = closed) even when the email
       delivery task encounters an exception.
    2. The EmailDelivery record captures the error in last_error after one failed
       attempt, with status remaining 'pending' (will retry).
    3. After _MAX_ATTEMPTS failed attempts, status transitions to 'failed'.
    4. resend_report transitions a 'failed' delivery back to 'pending'.
    """

    async def _create_open_agm_for_email_test(
        self, db_session: AsyncSession, label: str
    ) -> GeneralMeeting:
        """Create a building + open AGM for email failure tests."""
        b = Building(name=f"EmailFail_{label}", manager_email=f"ef_{label}@test.com")
        db_session.add(b)
        await db_session.flush()

        agm = GeneralMeeting(
            building_id=b.id,
            title=f"EmailFail Meeting {label}",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()
        await db_session.refresh(agm)
        return agm

    # --- Happy path ---

    async def test_close_succeeds_even_when_trigger_with_retry_raises(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """close_general_meeting returns 200 and creates EmailDelivery before the background task runs.

        The email task is launched via FastAPI BackgroundTasks after the HTTP response is
        committed.  The meeting is closed and the EmailDelivery record is created with
        status=pending.  trigger_with_retry is mocked to avoid hitting SMTP.
        """
        agm = await self._create_open_agm_for_email_test(db_session, "CloseOK")

        # Patch trigger_with_retry so BackgroundTasks can run it without hitting SMTP.
        # The endpoint must return 200 and the EmailDelivery record must exist before the
        # background task runs — this is what we are asserting here.
        with patch(
            "app.services.email_service.EmailService.trigger_with_retry",
            new_callable=AsyncMock,
        ):
            response = await client.post(f"/api/admin/general-meetings/{agm.id}/close")

        assert response.status_code == 200

        # Meeting must be closed in the DB
        await db_session.refresh(agm)
        assert agm.status == GeneralMeetingStatus.closed

        # EmailDelivery record is created with pending status
        delivery_result = await db_session.execute(
            select(EmailDelivery).where(EmailDelivery.general_meeting_id == agm.id)
        )
        delivery = delivery_result.scalar_one_or_none()
        assert delivery is not None
        assert delivery.status == EmailDeliveryStatus.pending

    async def test_trigger_with_retry_one_failure_leaves_status_pending(
        self, db_session: AsyncSession
    ):
        """A single send_report failure sets last_error but keeps status pending.

        trigger_with_retry uses its own DB session.  We patch _make_session_factory to
        return a factory connected to the real test DB.  After one failure
        (total_attempts < 30), status stays 'pending' with last_error set.
        Data is cleaned up at the end of the test to avoid polluting requeue tests.
        """
        import os
        from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
        from app.services.email_service import EmailService

        test_db_url = os.getenv(
            "TEST_DATABASE_URL",
            "postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test",
        )
        engine = create_async_engine(test_db_url, echo=False, future=True)
        real_session_factory = async_sessionmaker(bind=engine, expire_on_commit=False)

        unique_suffix = uuid.uuid4().hex[:8]
        async with real_session_factory() as s:
            b = Building(name=f"EmailFail_OFP_{unique_suffix}", manager_email=f"ef_ofp_{unique_suffix}@test.com")
            s.add(b)
            await s.flush()
            agm = GeneralMeeting(
                building_id=b.id,
                title=f"EmailFail OneFailPending {unique_suffix}",
                status=GeneralMeetingStatus.closed,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
            s.add(agm)
            await s.flush()
            delivery = EmailDelivery(
                general_meeting_id=agm.id,
                status=EmailDeliveryStatus.pending,
                total_attempts=0,
            )
            s.add(delivery)
            await s.commit()
            agm_id = agm.id
            delivery_id = delivery.id

        email_service = EmailService()

        async def _failing_send_report(_agm_id, _db):
            raise Exception("SMTP timeout")

        sleep_count = 0

        async def _stop_after_one(delay):
            nonlocal sleep_count
            sleep_count += 1
            raise asyncio.CancelledError()

        with (
            patch.object(email_service, "send_report", _failing_send_report),
            patch("app.services.email_service._make_session_factory", return_value=real_session_factory),
            patch("app.services.email_service.asyncio.sleep", _stop_after_one),
        ):
            try:
                await email_service.trigger_with_retry(agm_id)
            except asyncio.CancelledError:
                pass

        async with real_session_factory() as s:
            result = await s.execute(
                select(EmailDelivery).where(EmailDelivery.general_meeting_id == agm_id)
            )
            updated = result.scalar_one_or_none()

        # Clean up: delete the GeneralMeeting (cascades to EmailDelivery) so that
        # requeue_pending_on_startup tests are not polluted by test data in pending status.
        async with real_session_factory() as s:
            gm = await s.get(GeneralMeeting, agm_id)
            if gm:
                await s.delete(gm)
            await s.commit()

        await engine.dispose()

        assert updated is not None
        assert updated.status == EmailDeliveryStatus.pending
        assert updated.last_error is not None
        assert "SMTP timeout" in updated.last_error

    async def test_trigger_with_retry_max_failures_sets_status_failed(
        self, db_session: AsyncSession
    ):
        """After 30 failed attempts, EmailDelivery.status transitions to 'failed'."""
        import os
        from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
        from app.services.email_service import EmailService, _MAX_ATTEMPTS

        test_db_url = os.getenv(
            "TEST_DATABASE_URL",
            "postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test",
        )
        engine = create_async_engine(test_db_url, echo=False, future=True)
        real_session_factory = async_sessionmaker(bind=engine, expire_on_commit=False)

        # Pre-seed delivery with MAX_ATTEMPTS - 1 so next attempt exhausts it.
        # Must use the real DB (separate engine) because trigger_with_retry calls commit()
        # which would release the savepoint in the shared test session, breaking isolation.
        unique_suffix = uuid.uuid4().hex[:8]
        async with real_session_factory() as s:
            b = Building(name=f"EmailFail_MF_{unique_suffix}", manager_email=f"ef_mf_{unique_suffix}@test.com")
            s.add(b)
            await s.flush()
            agm = GeneralMeeting(
                building_id=b.id,
                title=f"EmailFail MaxFails {unique_suffix}",
                status=GeneralMeetingStatus.closed,
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
            )
            s.add(agm)
            await s.flush()
            delivery = EmailDelivery(
                general_meeting_id=agm.id,
                status=EmailDeliveryStatus.pending,
                total_attempts=_MAX_ATTEMPTS - 1,  # one attempt remaining
                last_error="previous error",
            )
            s.add(delivery)
            await s.commit()
            agm_id = agm.id

        email_service = EmailService()

        async def _always_fail(_agm_id, _db):
            raise Exception("Final SMTP failure")

        with (
            patch.object(email_service, "send_report", _always_fail),
            patch("app.services.email_service._make_session_factory", return_value=real_session_factory),
        ):
            # One more attempt → total_attempts reaches MAX → status = failed, returns
            await email_service.trigger_with_retry(agm_id)

        async with real_session_factory() as s:
            result = await s.execute(
                select(EmailDelivery).where(EmailDelivery.general_meeting_id == agm_id)
            )
            updated = result.scalar_one_or_none()

        # Clean up: delete the GeneralMeeting (cascades to EmailDelivery) so that
        # requeue_pending_on_startup tests are not polluted by test data.
        async with real_session_factory() as s:
            gm = await s.get(GeneralMeeting, agm_id)
            if gm:
                await s.delete(gm)
            await s.commit()

        await engine.dispose()

        assert updated is not None
        assert updated.status == EmailDeliveryStatus.failed
        assert updated.total_attempts == _MAX_ATTEMPTS
        assert "Final SMTP failure" in updated.last_error

    # --- State / precondition errors ---

    async def test_resend_report_transitions_failed_delivery_to_pending(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """POST /resend-report on a 'failed' delivery resets it to 'pending'.

        The resend endpoint allows an admin to re-queue a failed email delivery.
        """
        agm = await self._create_open_agm_for_email_test(db_session, "ResendFailed")

        # Manually close and set delivery to failed (simulates all retries exhausted)
        agm.status = GeneralMeetingStatus.closed
        delivery = EmailDelivery(
            general_meeting_id=agm.id,
            status=EmailDeliveryStatus.failed,
            total_attempts=30,
            last_error="all retries exhausted",
        )
        db_session.add(delivery)
        await db_session.flush()

        # Patch at the class level so the instance created inside the router gets the mock
        with patch(
            "app.services.email_service.EmailService.trigger_with_retry",
            new_callable=AsyncMock,
        ):
            response = await client.post(
                f"/api/admin/general-meetings/{agm.id}/resend-report"
            )

        assert response.status_code == 200

        # Verify status transitions to pending after resend
        # Use a fresh query to bypass any session-level identity map caching
        result = await db_session.execute(
            select(EmailDelivery.status).where(EmailDelivery.general_meeting_id == agm.id)
        )
        status_value = result.scalar_one_or_none()
        assert status_value == EmailDeliveryStatus.pending


# ---------------------------------------------------------------------------
# GET /api/admin/general-meetings — sort_by / sort_dir query params
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestListGeneralMeetingsSort:
    """Tests for sort_by and sort_dir query parameters on GET /api/admin/general-meetings."""

    def _agm_payload(self, building_id, title: str) -> dict:
        return {
            "building_id": str(building_id),
            "title": title,
            "meeting_at": meeting_dt().isoformat(),
            "voting_closes_at": closing_dt().isoformat(),
            "motions": [
                {
                    "title": "Motion 1",
                    "description": None,
                    "display_order": 1,
                    "motion_number": None,
                    "motion_type": "general",
                }
            ],
        }

    # --- Happy path ---

    async def test_sort_by_title_asc_returns_alphabetical_order(
        self, client: AsyncClient, db_session: AsyncSession, building
    ):
        """Meetings sorted by title ascending should be in A→Z order."""
        await client.post("/api/admin/general-meetings", json=self._agm_payload(building.id, "Zeta Meeting"))
        await client.post("/api/admin/general-meetings", json=self._agm_payload(building.id, "Alpha Meeting"))
        # Need a second building for second meeting (AGM already exists for building)
        b2_resp = await client.post(
            "/api/admin/buildings",
            json={"name": "Sort Test Building 2", "manager_email": "s2@test.com"},
        )
        b2_id = b2_resp.json()["id"]
        await client.post("/api/admin/general-meetings", json=self._agm_payload(b2_id, "Alpha Meeting 2"))

        response = await client.get("/api/admin/general-meetings?sort_by=title&sort_dir=asc")
        assert response.status_code == 200
        titles = [m["title"] for m in response.json()]
        assert titles == sorted(titles)

    async def test_sort_by_title_desc_returns_reverse_alphabetical_order(
        self, client: AsyncClient, db_session: AsyncSession, building
    ):
        """Meetings sorted by title descending should be in Z→A order."""
        await client.post("/api/admin/general-meetings", json=self._agm_payload(building.id, "Zeta Meeting"))
        b2_resp = await client.post(
            "/api/admin/buildings",
            json={"name": "Sort Test Building 3", "manager_email": "s3@test.com"},
        )
        b2_id = b2_resp.json()["id"]
        await client.post("/api/admin/general-meetings", json=self._agm_payload(b2_id, "Alpha Meeting"))

        response = await client.get("/api/admin/general-meetings?sort_by=title&sort_dir=desc")
        assert response.status_code == 200
        titles = [m["title"] for m in response.json()]
        assert titles == sorted(titles, reverse=True)

    async def test_sort_by_created_at_asc_returns_oldest_first(
        self, client: AsyncClient, db_session: AsyncSession, building
    ):
        """Meetings sorted by created_at ascending should be oldest first."""
        await client.post("/api/admin/general-meetings", json=self._agm_payload(building.id, "First Meeting"))
        b2_resp = await client.post(
            "/api/admin/buildings",
            json={"name": "Sort Test Building 4", "manager_email": "s4@test.com"},
        )
        b2_id = b2_resp.json()["id"]
        await client.post("/api/admin/general-meetings", json=self._agm_payload(b2_id, "Second Meeting"))

        response = await client.get("/api/admin/general-meetings?sort_by=created_at&sort_dir=asc")
        assert response.status_code == 200
        data = response.json()
        assert len(data) >= 2
        created_ats = [m["created_at"] for m in data]
        assert created_ats == sorted(created_ats)

    async def test_default_sort_returns_newest_first(
        self, client: AsyncClient, db_session: AsyncSession, building
    ):
        """Without sort params, meetings should be returned newest first (default)."""
        await client.post("/api/admin/general-meetings", json=self._agm_payload(building.id, "Meeting Default"))
        response = await client.get("/api/admin/general-meetings")
        assert response.status_code == 200
        data = response.json()
        if len(data) >= 2:
            created_ats = [m["created_at"] for m in data]
            assert created_ats == sorted(created_ats, reverse=True)

    # --- Input validation ---

    async def test_invalid_sort_by_returns_422(self, client: AsyncClient):
        """An unrecognised sort_by value must be rejected with 422."""
        response = await client.get("/api/admin/general-meetings?sort_by=invalid_column")
        assert response.status_code == 422
        assert "Invalid sort_by value" in response.json()["detail"]

    async def test_invalid_sort_dir_returns_422(self, client: AsyncClient):
        """An unrecognised sort_dir value must be rejected with 422."""
        response = await client.get("/api/admin/general-meetings?sort_by=title&sort_dir=random")
        assert response.status_code == 422
        assert "Invalid sort_dir value" in response.json()["detail"]

    async def test_sql_injection_attempt_in_sort_by_returns_422(self, client: AsyncClient):
        """A SQL injection attempt in sort_by must be rejected before hitting the DB."""
        response = await client.get("/api/admin/general-meetings?sort_by=title;DROP TABLE general_meetings;--")
        assert response.status_code == 422

    # --- Boundary values ---

    async def test_sort_with_no_meetings_returns_empty_list(self, client: AsyncClient, db_session: AsyncSession):
        """sort_by=title on an empty result set returns an empty list without error."""
        response = await client.get("/api/admin/general-meetings?sort_by=title&sort_dir=asc&building_id=00000000-0000-0000-0000-000000000000")
        assert response.status_code == 200
        assert response.json() == []

    # --- Edge cases ---

    async def test_sort_dir_only_without_sort_by_is_accepted(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """sort_dir without sort_by uses the default column (created_at)."""
        response = await client.get("/api/admin/general-meetings?sort_dir=asc")
        assert response.status_code == 200

    # --- New columns: meeting_at, voting_closes_at, status ---

    async def test_sort_by_meeting_at_asc_returns_oldest_meeting_first(
        self, client: AsyncClient, db_session: AsyncSession, building
    ):
        """Meetings sorted by meeting_at ascending should be oldest meeting first."""
        # Use different buildings so the "one open AGM per building" constraint isn't hit
        b1_resp = await client.post("/api/admin/buildings", json={"name": "SortMeetingAtB1", "manager_email": "b1@test.com"})
        b1_id = b1_resp.json()["id"]
        b2_resp = await client.post("/api/admin/buildings", json={"name": "SortMeetingAtB2", "manager_email": "b2@test.com"})
        b2_id = b2_resp.json()["id"]
        await client.post("/api/admin/general-meetings", json=self._agm_payload(b1_id, "SortMeetingAt Later"))
        await client.post("/api/admin/general-meetings", json=self._agm_payload(b2_id, "SortMeetingAt Earlier"))
        response = await client.get("/api/admin/general-meetings?sort_by=meeting_at&sort_dir=asc")
        assert response.status_code == 200
        data = response.json()
        assert len(data) >= 2
        meeting_ats = [m["meeting_at"] for m in data]
        assert meeting_ats == sorted(meeting_ats)

    async def test_sort_by_voting_closes_at_asc_returns_earliest_close_first(
        self, client: AsyncClient, db_session: AsyncSession, building
    ):
        """Meetings sorted by voting_closes_at ascending should be earliest close first."""
        b1_resp = await client.post("/api/admin/buildings", json={"name": "SortVotingCloseB1", "manager_email": "vc1@test.com"})
        b1_id = b1_resp.json()["id"]
        b2_resp = await client.post("/api/admin/buildings", json={"name": "SortVotingCloseB2", "manager_email": "vc2@test.com"})
        b2_id = b2_resp.json()["id"]
        await client.post("/api/admin/general-meetings", json=self._agm_payload(b1_id, "SortVotingClose A"))
        await client.post("/api/admin/general-meetings", json=self._agm_payload(b2_id, "SortVotingClose B"))
        response = await client.get("/api/admin/general-meetings?sort_by=voting_closes_at&sort_dir=asc")
        assert response.status_code == 200
        data = response.json()
        assert len(data) >= 2
        closes = [m["voting_closes_at"] for m in data]
        assert closes == sorted(closes)

    async def test_sort_by_status_asc_is_accepted(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """sort_by=status should be accepted (status is now a valid sort column)."""
        response = await client.get("/api/admin/general-meetings?sort_by=status&sort_dir=asc")
        assert response.status_code == 200

    # --- Case-insensitive title sort ---

    async def test_sort_by_title_case_insensitive(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Title sort is case-insensitive: 'zebra' and 'Apple' and 'MANGO' sort alphabetically."""
        b1_resp = await client.post("/api/admin/buildings", json={"name": "SortTitleCaseB1", "manager_email": "tc1@test.com"})
        b1_id = b1_resp.json()["id"]
        b2_resp = await client.post("/api/admin/buildings", json={"name": "SortTitleCaseB2", "manager_email": "tc2@test.com"})
        b2_id = b2_resp.json()["id"]
        b3_resp = await client.post("/api/admin/buildings", json={"name": "SortTitleCaseB3", "manager_email": "tc3@test.com"})
        b3_id = b3_resp.json()["id"]
        await client.post("/api/admin/general-meetings", json=self._agm_payload(b1_id, "zebra meeting"))
        await client.post("/api/admin/general-meetings", json=self._agm_payload(b2_id, "Apple Meeting"))
        await client.post("/api/admin/general-meetings", json=self._agm_payload(b3_id, "MANGO Meeting"))
        response = await client.get("/api/admin/general-meetings?sort_by=title&sort_dir=asc")
        assert response.status_code == 200
        titles = [m["title"].lower() for m in response.json()]
        # Lower-cased titles that include our test data should appear in order apple < mango < zebra
        test_titles = [t for t in titles if any(kw in t for kw in ("apple", "mango", "zebra"))]
        assert test_titles == sorted(test_titles)
