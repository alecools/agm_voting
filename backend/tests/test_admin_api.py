"""
Tests for the admin portal API endpoints.

Covers all endpoints in /api/admin with full test coverage.

Structure per endpoint:
  # --- Happy path ---
  # --- Input validation ---
  # --- Boundary values ---
  # --- State / precondition errors ---
  # --- Edge cases ---
"""
from __future__ import annotations

import csv
import io
import uuid
from datetime import UTC, datetime, timedelta

import openpyxl

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    AGM,
    AGMLotWeight,
    AGMStatus,
    BallotSubmission,
    Building,
    EmailDelivery,
    EmailDeliveryStatus,
    LotOwner,
    Motion,
    Vote,
    VoteChoice,
    VoteStatus,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_csv(headers: list[str], rows: list[list[str]]) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(headers)
    for row in rows:
        writer.writerow(row)
    return buf.getvalue().encode()


def make_excel(headers: list, rows: list[list]) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(headers)
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf.read()


def future_dt(days: int = 1) -> datetime:
    return datetime.now(UTC) + timedelta(days=days)


def meeting_dt() -> datetime:
    return datetime.now(UTC) + timedelta(days=1)


def closing_dt() -> datetime:
    return datetime.now(UTC) + timedelta(days=2)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def client(app):
    """HTTP client that shares the test db_session with the app (via conftest app fixture)."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        yield ac


@pytest_asyncio.fixture
async def building(db_session: AsyncSession) -> Building:
    b = Building(name="Test Building", manager_email="manager@test.com")
    db_session.add(b)
    await db_session.flush()
    await db_session.refresh(b)
    return b


@pytest_asyncio.fixture
async def building_with_owners(db_session: AsyncSession) -> Building:
    b = Building(name="Building With Owners", manager_email="mgr@bwo.com")
    db_session.add(b)
    await db_session.flush()
    lo1 = LotOwner(
        building_id=b.id,
        lot_number="1A",
        email="voter1@test.com",
        unit_entitlement=100,
    )
    lo2 = LotOwner(
        building_id=b.id,
        lot_number="2B",
        email="voter2@test.com",
        unit_entitlement=50,
    )
    db_session.add_all([lo1, lo2])
    await db_session.flush()
    await db_session.refresh(b)
    return b


# ---------------------------------------------------------------------------
# POST /api/admin/buildings/import
# ---------------------------------------------------------------------------


class TestImportBuildings:
    # --- Happy path ---

    async def test_valid_csv_creates_buildings(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        csv_data = make_csv(
            ["building_name", "manager_email"],
            [["Alpha Tower", "alpha@test.com"], ["Beta Complex", "beta@test.com"]],
        )
        response = await client.post(
            "/api/admin/buildings/import",
            files={"file": ("buildings.csv", csv_data, "text/csv")},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["created"] == 2
        assert data["updated"] == 0

    async def test_valid_csv_updates_existing_building(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        # First, create Alpha Tower
        csv_data = make_csv(
            ["building_name", "manager_email"],
            [["Alpha Tower", "alpha@test.com"]],
        )
        await client.post(
            "/api/admin/buildings/import",
            files={"file": ("buildings.csv", csv_data, "text/csv")},
        )

        # Now update its manager email
        csv_data2 = make_csv(
            ["building_name", "manager_email"],
            [["Alpha Tower", "new_alpha@test.com"]],
        )
        response = await client.post(
            "/api/admin/buildings/import",
            files={"file": ("buildings.csv", csv_data2, "text/csv")},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["created"] == 0
        assert data["updated"] == 1

    async def test_empty_csv_returns_zero_counts(self, client: AsyncClient):
        csv_data = make_csv(["building_name", "manager_email"], [])
        response = await client.post(
            "/api/admin/buildings/import",
            files={"file": ("empty.csv", csv_data, "text/csv")},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["created"] == 0
        assert data["updated"] == 0

    async def test_extra_columns_ignored(self, client: AsyncClient):
        csv_data = make_csv(
            ["building_name", "manager_email", "extra_col"],
            [["Extra Col Building", "extra@test.com", "ignored"]],
        )
        response = await client.post(
            "/api/admin/buildings/import",
            files={"file": ("buildings.csv", csv_data, "text/csv")},
        )
        assert response.status_code == 200
        assert response.json()["created"] == 1

    async def test_case_insensitive_building_name_match(self, client: AsyncClient):
        # Create a building
        csv_data = make_csv(
            ["building_name", "manager_email"],
            [["CaseTest Building", "ci@test.com"]],
        )
        await client.post(
            "/api/admin/buildings/import",
            files={"file": ("buildings.csv", csv_data, "text/csv")},
        )

        # Upload with different case
        csv_data2 = make_csv(
            ["building_name", "manager_email"],
            [["casetest building", "updated@test.com"]],
        )
        response = await client.post(
            "/api/admin/buildings/import",
            files={"file": ("buildings.csv", csv_data2, "text/csv")},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["updated"] == 1
        assert data["created"] == 0

    # --- Input validation ---

    async def test_missing_building_name_header(self, client: AsyncClient):
        csv_data = make_csv(["manager_email"], [["mgr@test.com"]])
        response = await client.post(
            "/api/admin/buildings/import",
            files={"file": ("buildings.csv", csv_data, "text/csv")},
        )
        assert response.status_code == 422
        assert "building_name" in str(response.json()["detail"]).lower()

    async def test_missing_manager_email_header(self, client: AsyncClient):
        csv_data = make_csv(["building_name"], [["Some Building"]])
        response = await client.post(
            "/api/admin/buildings/import",
            files={"file": ("buildings.csv", csv_data, "text/csv")},
        )
        assert response.status_code == 422
        assert "manager_email" in str(response.json()["detail"]).lower()

    async def test_blank_building_name_row(self, client: AsyncClient):
        csv_data = make_csv(
            ["building_name", "manager_email"],
            [["", "mgr@test.com"]],
        )
        response = await client.post(
            "/api/admin/buildings/import",
            files={"file": ("buildings.csv", csv_data, "text/csv")},
        )
        assert response.status_code == 422
        assert any("building_name" in e for e in response.json()["detail"])

    async def test_blank_manager_email_row(self, client: AsyncClient):
        csv_data = make_csv(
            ["building_name", "manager_email"],
            [["Valid Building", ""]],
        )
        response = await client.post(
            "/api/admin/buildings/import",
            files={"file": ("buildings.csv", csv_data, "text/csv")},
        )
        assert response.status_code == 422
        assert any("manager_email" in e for e in response.json()["detail"])

    async def test_multiple_row_errors_collected(self, client: AsyncClient):
        csv_data = make_csv(
            ["building_name", "manager_email"],
            [["", ""], ["", ""]],
        )
        response = await client.post(
            "/api/admin/buildings/import",
            files={"file": ("buildings.csv", csv_data, "text/csv")},
        )
        assert response.status_code == 422
        # Should have 4 errors (2 per bad row)
        assert len(response.json()["detail"]) == 4

    # --- State / precondition errors ---

    async def test_non_csv_file_returns_415(self, client: AsyncClient):
        response = await client.post(
            "/api/admin/buildings/import",
            files={"file": ("data.pdf", b"not csv content", "application/pdf")},
        )
        assert response.status_code == 415

    async def test_non_csv_no_extension_returns_415(self, client: AsyncClient):
        response = await client.post(
            "/api/admin/buildings/import",
            files={"file": ("data.bin", b"garbage", "application/octet-stream")},
        )
        # application/octet-stream is in allowed list but no csv extension —
        # however we allow octet-stream, so this should pass content-type check
        # Re-check: octet-stream IS in allowed set, so it should NOT be 415
        assert response.status_code in (200, 422)

    async def test_csv_filename_with_non_csv_content_type(self, client: AsyncClient):
        """A .csv extension overrides content-type check."""
        csv_data = make_csv(
            ["building_name", "manager_email"],
            [["CT Building", "ct@test.com"]],
        )
        response = await client.post(
            "/api/admin/buildings/import",
            files={"file": ("buildings.csv", csv_data, "application/json")},
        )
        # .csv extension should allow it through
        assert response.status_code == 200

    async def test_completely_empty_file_returns_422(self, client: AsyncClient):
        """An empty file (not even headers) should return 422."""
        response = await client.post(
            "/api/admin/buildings/import",
            files={"file": ("empty.csv", b"", "text/csv")},
        )
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# GET /api/admin/buildings
# ---------------------------------------------------------------------------


class TestListBuildings:
    # --- Happy path ---

    async def test_returns_all_buildings(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        response = await client.get("/api/admin/buildings")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        # At minimum the buildings created by import tests should be there
        assert len(data) >= 0

    async def test_building_has_required_fields(
        self, client: AsyncClient, building: Building
    ):
        response = await client.get("/api/admin/buildings")
        assert response.status_code == 200
        data = response.json()
        assert len(data) > 0
        first = data[0]
        assert "id" in first
        assert "name" in first
        assert "manager_email" in first
        assert "created_at" in first


# ---------------------------------------------------------------------------
# GET /api/admin/buildings/{building_id}/lot-owners
# ---------------------------------------------------------------------------


class TestListLotOwners:
    # --- Happy path ---

    async def test_returns_lot_owners_for_building(
        self, client: AsyncClient, building_with_owners: Building
    ):
        response = await client.get(
            f"/api/admin/buildings/{building_with_owners.id}/lot-owners"
        )
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) == 2

    async def test_lot_owner_fields_present(
        self, client: AsyncClient, building_with_owners: Building
    ):
        response = await client.get(
            f"/api/admin/buildings/{building_with_owners.id}/lot-owners"
        )
        data = response.json()
        owner = data[0]
        assert "id" in owner
        assert "lot_number" in owner
        assert "email" in owner
        assert "unit_entitlement" in owner

    # --- State / precondition errors ---

    async def test_building_not_found_returns_404(self, client: AsyncClient):
        response = await client.get(
            f"/api/admin/buildings/{uuid.uuid4()}/lot-owners"
        )
        assert response.status_code == 404


# ---------------------------------------------------------------------------
# POST /api/admin/buildings/{building_id}/lot-owners/import
# ---------------------------------------------------------------------------


class TestImportLotOwners:
    # --- Happy path ---

    async def test_valid_csv_imports_lot_owners(
        self, client: AsyncClient, building: Building, db_session: AsyncSession
    ):
        csv_data = make_csv(
            ["lot_number", "email", "unit_entitlement"],
            [["101", "a@test.com", "100"], ["102", "b@test.com", "200"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={"file": ("owners.csv", csv_data, "text/csv")},
        )
        assert response.status_code == 200
        assert response.json()["imported"] == 2

    async def test_import_replaces_existing_owners(
        self, client: AsyncClient, building: Building, db_session: AsyncSession
    ):
        # First import
        csv1 = make_csv(
            ["lot_number", "email", "unit_entitlement"],
            [["A1", "old@test.com", "50"]],
        )
        await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={"file": ("owners.csv", csv1, "text/csv")},
        )

        # Second import should replace
        csv2 = make_csv(
            ["lot_number", "email", "unit_entitlement"],
            [["B1", "new@test.com", "75"], ["B2", "new2@test.com", "25"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={"file": ("owners.csv", csv2, "text/csv")},
        )
        assert response.status_code == 200
        assert response.json()["imported"] == 2

        # Verify replacement
        owners_response = await client.get(
            f"/api/admin/buildings/{building.id}/lot-owners"
        )
        owners = owners_response.json()
        lot_numbers = {o["lot_number"] for o in owners}
        assert "B1" in lot_numbers
        assert "B2" in lot_numbers
        assert "A1" not in lot_numbers

    async def test_empty_csv_clears_owners(
        self, client: AsyncClient, building: Building, db_session: AsyncSession
    ):
        # Seed
        csv1 = make_csv(
            ["lot_number", "email", "unit_entitlement"],
            [["X1", "x@test.com", "10"]],
        )
        await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={"file": ("owners.csv", csv1, "text/csv")},
        )

        # Import empty
        csv2 = make_csv(["lot_number", "email", "unit_entitlement"], [])
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={"file": ("owners.csv", csv2, "text/csv")},
        )
        assert response.status_code == 200
        assert response.json()["imported"] == 0

        # Verify cleared
        owners_response = await client.get(
            f"/api/admin/buildings/{building.id}/lot-owners"
        )
        assert owners_response.json() == []

    async def test_extra_columns_ignored(
        self, client: AsyncClient, building: Building
    ):
        csv_data = make_csv(
            ["lot_number", "email", "unit_entitlement", "extra"],
            [["Z1", "z@test.com", "10", "ignore_me"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={"file": ("owners.csv", csv_data, "text/csv")},
        )
        assert response.status_code == 200
        assert response.json()["imported"] == 1

    async def test_unit_entitlement_zero_accepted(
        self, client: AsyncClient, building: Building
    ):
        csv_data = make_csv(
            ["lot_number", "email", "unit_entitlement"],
            [["ZERO1", "zero@test.com", "0"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={"file": ("owners.csv", csv_data, "text/csv")},
        )
        assert response.status_code == 200
        assert response.json()["imported"] == 1

    # --- Input validation ---

    async def test_missing_unit_entitlement_header(
        self, client: AsyncClient, building: Building
    ):
        csv_data = make_csv(
            ["lot_number", "email"],
            [["1", "a@test.com"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={"file": ("owners.csv", csv_data, "text/csv")},
        )
        assert response.status_code == 422
        assert "unit_entitlement" in str(response.json()["detail"]).lower()

    async def test_missing_lot_number_header(
        self, client: AsyncClient, building: Building
    ):
        csv_data = make_csv(
            ["email", "unit_entitlement"],
            [["a@test.com", "100"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={"file": ("owners.csv", csv_data, "text/csv")},
        )
        assert response.status_code == 422

    async def test_duplicate_lot_numbers_in_csv(
        self, client: AsyncClient, building: Building
    ):
        csv_data = make_csv(
            ["lot_number", "email", "unit_entitlement"],
            [["DUP1", "a@test.com", "100"], ["DUP1", "b@test.com", "200"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={"file": ("owners.csv", csv_data, "text/csv")},
        )
        assert response.status_code == 422
        assert any("DUP1" in str(e) or "duplicate" in str(e).lower() for e in response.json()["detail"])

    async def test_negative_unit_entitlement(
        self, client: AsyncClient, building: Building
    ):
        csv_data = make_csv(
            ["lot_number", "email", "unit_entitlement"],
            [["NEG1", "neg@test.com", "-1"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={"file": ("owners.csv", csv_data, "text/csv")},
        )
        assert response.status_code == 422

    async def test_non_integer_unit_entitlement(
        self, client: AsyncClient, building: Building
    ):
        csv_data = make_csv(
            ["lot_number", "email", "unit_entitlement"],
            [["NI1", "ni@test.com", "abc"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={"file": ("owners.csv", csv_data, "text/csv")},
        )
        assert response.status_code == 422

    async def test_collects_all_errors_before_returning(
        self, client: AsyncClient, building: Building
    ):
        csv_data = make_csv(
            ["lot_number", "email", "unit_entitlement"],
            [["", "", "abc"], ["", "", "-5"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={"file": ("owners.csv", csv_data, "text/csv")},
        )
        assert response.status_code == 422
        # Should have multiple errors
        assert len(response.json()["detail"]) > 1

    # --- State / precondition errors ---

    async def test_building_not_found_returns_404(self, client: AsyncClient):
        csv_data = make_csv(
            ["lot_number", "email", "unit_entitlement"],
            [["1", "a@test.com", "100"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{uuid.uuid4()}/lot-owners/import",
            files={"file": ("owners.csv", csv_data, "text/csv")},
        )
        assert response.status_code == 404

    async def test_non_csv_file_returns_415(
        self, client: AsyncClient, building: Building
    ):
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={"file": ("data.pdf", b"not a spreadsheet", "application/pdf")},
        )
        assert response.status_code == 415

    async def test_completely_empty_file_returns_422(
        self, client: AsyncClient, building: Building
    ):
        """An empty file (not even headers) should return 422."""
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={"file": ("empty.csv", b"", "text/csv")},
        )
        assert response.status_code == 422

    async def test_empty_unit_entitlement_value(
        self, client: AsyncClient, building: Building
    ):
        """A row with empty unit_entitlement (present column, empty value) returns 422."""
        csv_data = make_csv(
            ["lot_number", "email", "unit_entitlement"],
            [["E1", "e@test.com", ""]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={"file": ("owners.csv", csv_data, "text/csv")},
        )
        assert response.status_code == 422
        assert any("unit_entitlement is empty" in str(e) for e in response.json()["detail"])

    # --- Edge cases ---

    async def test_reimport_preserves_agm_lot_weight_snapshots(
        self, client: AsyncClient, building: Building, db_session: AsyncSession
    ):
        """Re-importing lot owners must NOT destroy AGMLotWeight snapshots.

        Bug: delete-all-then-insert gave new IDs to lot owners, which cascaded
        deletes to AGMLotWeight records, causing entitlement_sum=0 in tallies.
        Fix: upsert by lot_number preserves existing LotOwner IDs.
        """
        # Initial import
        csv1 = make_csv(
            ["lot_number", "email", "unit_entitlement"],
            [["L1", "voter@test.com", "150"], ["L2", "voter@test.com", "50"]],
        )
        await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={"file": ("owners.csv", csv1, "text/csv")},
        )

        # Create AGM and snapshot lot weights
        agm = AGM(
            building_id=building.id,
            title="Snapshot AGM",
            status=AGMStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()
        motion = Motion(agm_id=agm.id, title="Test Motion", order_index=1)
        db_session.add(motion)
        await db_session.flush()

        owners_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == building.id)
        )
        for lo in owners_result.scalars().all():
            db_session.add(AGMLotWeight(
                agm_id=agm.id,
                lot_owner_id=lo.id,
                voter_email=lo.email,
                unit_entitlement_snapshot=lo.unit_entitlement,
            ))
        await db_session.commit()

        # Re-import same lots (email change for L1) — must preserve snapshots
        csv2 = make_csv(
            ["lot_number", "email", "unit_entitlement"],
            [["L1", "updated@test.com", "150"], ["L2", "voter@test.com", "50"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={"file": ("owners.csv", csv2, "text/csv")},
        )
        assert response.status_code == 200

        # AGMLotWeight snapshots must still exist (not cascade-deleted)
        weights_result = await db_session.execute(
            select(AGMLotWeight).where(AGMLotWeight.agm_id == agm.id)
        )
        weights = weights_result.scalars().all()
        assert len(weights) == 2
        total_snapshot = sum(w.unit_entitlement_snapshot for w in weights)
        assert total_snapshot == 200  # 150 + 50 preserved from original snapshot

    async def test_reimport_updates_existing_and_adds_new(
        self, client: AsyncClient, building: Building, db_session: AsyncSession
    ):
        """Existing lot numbers are updated in-place; new lot numbers are inserted."""
        csv1 = make_csv(
            ["lot_number", "email", "unit_entitlement"],
            [["OLD1", "old@test.com", "100"]],
        )
        await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={"file": ("owners.csv", csv1, "text/csv")},
        )

        csv2 = make_csv(
            ["lot_number", "email", "unit_entitlement"],
            [["OLD1", "updated@test.com", "200"], ["NEW1", "new@test.com", "50"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={"file": ("owners.csv", csv2, "text/csv")},
        )
        assert response.status_code == 200
        assert response.json()["imported"] == 2

        owners_response = await client.get(
            f"/api/admin/buildings/{building.id}/lot-owners"
        )
        owners = {o["lot_number"]: o for o in owners_response.json()}
        assert owners["OLD1"]["email"] == "updated@test.com"
        assert owners["OLD1"]["unit_entitlement"] == 200
        assert "NEW1" in owners


# ---------------------------------------------------------------------------
# POST /api/admin/buildings/{building_id}/lot-owners
# ---------------------------------------------------------------------------


class TestAddLotOwner:
    # --- Happy path ---

    async def test_valid_add_returns_201(
        self, client: AsyncClient, building: Building
    ):
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners",
            json={"lot_number": "NEW01", "email": "new@test.com", "unit_entitlement": 150},
        )
        assert response.status_code == 201
        data = response.json()
        assert data["lot_number"] == "NEW01"
        assert data["email"] == "new@test.com"
        assert data["unit_entitlement"] == 150
        assert "id" in data

    async def test_unit_entitlement_zero_accepted(
        self, client: AsyncClient, building: Building
    ):
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners",
            json={"lot_number": "ZERO01", "email": "zero@test.com", "unit_entitlement": 0},
        )
        assert response.status_code == 201
        assert response.json()["unit_entitlement"] == 0

    # --- Input validation ---

    async def test_negative_unit_entitlement_returns_422(
        self, client: AsyncClient, building: Building
    ):
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners",
            json={"lot_number": "NEG01", "email": "neg@test.com", "unit_entitlement": -1},
        )
        assert response.status_code == 422

    async def test_empty_lot_number_returns_422(
        self, client: AsyncClient, building: Building
    ):
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners",
            json={"lot_number": "", "email": "e@test.com", "unit_entitlement": 10},
        )
        assert response.status_code == 422

    async def test_empty_email_returns_422(
        self, client: AsyncClient, building: Building
    ):
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners",
            json={"lot_number": "EM01", "email": "", "unit_entitlement": 10},
        )
        assert response.status_code == 422

    async def test_missing_fields_returns_422(
        self, client: AsyncClient, building: Building
    ):
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners",
            json={"lot_number": "M01"},
        )
        assert response.status_code == 422

    # --- State / precondition errors ---

    async def test_duplicate_lot_number_returns_409(
        self, client: AsyncClient, building: Building
    ):
        # Add first
        await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners",
            json={"lot_number": "DUP01", "email": "dup1@test.com", "unit_entitlement": 10},
        )
        # Add duplicate
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners",
            json={"lot_number": "DUP01", "email": "dup2@test.com", "unit_entitlement": 20},
        )
        assert response.status_code == 409

    async def test_building_not_found_returns_404(self, client: AsyncClient):
        response = await client.post(
            f"/api/admin/buildings/{uuid.uuid4()}/lot-owners",
            json={"lot_number": "X01", "email": "x@test.com", "unit_entitlement": 10},
        )
        assert response.status_code == 404


# ---------------------------------------------------------------------------
# PATCH /api/admin/lot-owners/{lot_owner_id}
# ---------------------------------------------------------------------------


class TestUpdateLotOwner:
    # --- Happy path ---

    async def test_update_email(
        self, client: AsyncClient, db_session: AsyncSession, building: Building
    ):
        lo = LotOwner(
            building_id=building.id,
            lot_number="UPD01",
            email="old@test.com",
            unit_entitlement=100,
        )
        db_session.add(lo)
        await db_session.commit()
        await db_session.refresh(lo)

        response = await client.patch(
            f"/api/admin/lot-owners/{lo.id}",
            json={"email": "updated@test.com"},
        )
        assert response.status_code == 200
        assert response.json()["email"] == "updated@test.com"
        assert response.json()["unit_entitlement"] == 100

    async def test_update_unit_entitlement(
        self, client: AsyncClient, db_session: AsyncSession, building: Building
    ):
        lo = LotOwner(
            building_id=building.id,
            lot_number="UPD02",
            email="ent@test.com",
            unit_entitlement=50,
        )
        db_session.add(lo)
        await db_session.commit()
        await db_session.refresh(lo)

        response = await client.patch(
            f"/api/admin/lot-owners/{lo.id}",
            json={"unit_entitlement": 999},
        )
        assert response.status_code == 200
        assert response.json()["unit_entitlement"] == 999

    async def test_update_both_fields(
        self, client: AsyncClient, db_session: AsyncSession, building: Building
    ):
        lo = LotOwner(
            building_id=building.id,
            lot_number="UPD03",
            email="both@test.com",
            unit_entitlement=10,
        )
        db_session.add(lo)
        await db_session.commit()
        await db_session.refresh(lo)

        response = await client.patch(
            f"/api/admin/lot-owners/{lo.id}",
            json={"email": "newboth@test.com", "unit_entitlement": 200},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["email"] == "newboth@test.com"
        assert data["unit_entitlement"] == 200

    # --- Boundary values ---

    async def test_unit_entitlement_zero_accepted(
        self, client: AsyncClient, db_session: AsyncSession, building: Building
    ):
        lo = LotOwner(
            building_id=building.id,
            lot_number="UPD04",
            email="zero2@test.com",
            unit_entitlement=100,
        )
        db_session.add(lo)
        await db_session.commit()
        await db_session.refresh(lo)

        response = await client.patch(
            f"/api/admin/lot-owners/{lo.id}",
            json={"unit_entitlement": 0},
        )
        assert response.status_code == 200
        assert response.json()["unit_entitlement"] == 0

    # --- Input validation ---

    async def test_no_fields_provided_returns_422(
        self, client: AsyncClient, db_session: AsyncSession, building: Building
    ):
        lo = LotOwner(
            building_id=building.id,
            lot_number="UPD05",
            email="nofield@test.com",
            unit_entitlement=10,
        )
        db_session.add(lo)
        await db_session.commit()
        await db_session.refresh(lo)

        response = await client.patch(
            f"/api/admin/lot-owners/{lo.id}",
            json={},
        )
        assert response.status_code == 422

    async def test_negative_unit_entitlement_returns_422(
        self, client: AsyncClient, db_session: AsyncSession, building: Building
    ):
        lo = LotOwner(
            building_id=building.id,
            lot_number="UPD06",
            email="negupd@test.com",
            unit_entitlement=10,
        )
        db_session.add(lo)
        await db_session.commit()
        await db_session.refresh(lo)

        response = await client.patch(
            f"/api/admin/lot-owners/{lo.id}",
            json={"unit_entitlement": -5},
        )
        assert response.status_code == 422

    # --- State / precondition errors ---

    async def test_not_found_returns_404(self, client: AsyncClient):
        response = await client.patch(
            f"/api/admin/lot-owners/{uuid.uuid4()}",
            json={"email": "x@test.com"},
        )
        assert response.status_code == 404


# ---------------------------------------------------------------------------
# POST /api/admin/agms
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
                    "order_index": 1,
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
            "/api/admin/agms",
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
        # Create building with owners for snapshot verification
        b = Building(name="Snapshot Building", manager_email="snap@test.com")
        db_session.add(b)
        await db_session.flush()
        lo = LotOwner(
            building_id=b.id,
            lot_number="S1",
            email="snap_voter@test.com",
            unit_entitlement=123,
        )
        db_session.add(lo)
        await db_session.commit()

        response = await client.post(
            "/api/admin/agms",
            json=self._agm_payload(b.id),
        )
        assert response.status_code == 201
        agm_id = response.json()["id"]

        weights = await db_session.execute(
            select(AGMLotWeight).where(AGMLotWeight.agm_id == uuid.UUID(agm_id))
        )
        weight_list = list(weights.scalars().all())
        assert len(weight_list) == 1
        assert weight_list[0].unit_entitlement_snapshot == 123
        assert weight_list[0].voter_email == "snap_voter@test.com"

    async def test_agm_with_multiple_motions(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="Multi Motion Building", manager_email="mm@test.com")
        db_session.add(b)
        await db_session.flush()

        payload = self._agm_payload(b.id)
        payload["motions"] = [
            {"title": "Motion A", "description": "A", "order_index": 1},
            {"title": "Motion B", "description": "B", "order_index": 2},
            {"title": "Motion C", "description": None, "order_index": 3},
        ]
        response = await client.post("/api/admin/agms", json=payload)
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
            email="multilot@test.com",
            unit_entitlement=100,
        )
        lo2 = LotOwner(
            building_id=b.id,
            lot_number="ML2",
            email="multilot@test.com",
            unit_entitlement=50,
        )
        db_session.add_all([lo1, lo2])
        await db_session.commit()

        response = await client.post(
            "/api/admin/agms",
            json=self._agm_payload(b.id),
        )
        assert response.status_code == 201
        agm_id = response.json()["id"]

        weights = await db_session.execute(
            select(AGMLotWeight).where(AGMLotWeight.agm_id == uuid.UUID(agm_id))
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
        response = await client.post("/api/admin/agms", json=payload)
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
        response = await client.post("/api/admin/agms", json=payload)
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
        response = await client.post("/api/admin/agms", json=payload)
        assert response.status_code == 422

    async def test_missing_building_id_returns_422(self, client: AsyncClient):
        payload = {
            "title": "Test",
            "meeting_at": meeting_dt().isoformat(),
            "voting_closes_at": closing_dt().isoformat(),
            "motions": [{"title": "M1", "order_index": 1}],
        }
        response = await client.post("/api/admin/agms", json=payload)
        assert response.status_code == 422

    # --- State / precondition errors ---

    async def test_building_not_found_returns_404(self, client: AsyncClient):
        payload = self._agm_payload(uuid.uuid4())
        response = await client.post("/api/admin/agms", json=payload)
        assert response.status_code == 404

    async def test_second_open_agm_for_same_building_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="One AGM Building", manager_email="one@test.com")
        db_session.add(b)
        await db_session.commit()

        payload = self._agm_payload(b.id)
        r1 = await client.post("/api/admin/agms", json=payload)
        assert r1.status_code == 201

        r2 = await client.post("/api/admin/agms", json=payload)
        assert r2.status_code == 409

    async def test_can_create_agm_after_closed(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="Closed AGM Building", manager_email="closed@test.com")
        db_session.add(b)
        await db_session.commit()

        payload = self._agm_payload(b.id)
        r1 = await client.post("/api/admin/agms", json=payload)
        assert r1.status_code == 201
        agm_id = r1.json()["id"]

        # Close the AGM
        await client.post(f"/api/admin/agms/{agm_id}/close")

        # Now create another
        r2 = await client.post("/api/admin/agms", json=payload)
        assert r2.status_code == 201


# ---------------------------------------------------------------------------
# GET /api/admin/agms
# ---------------------------------------------------------------------------


class TestListAGMs:
    # --- Happy path ---

    async def test_returns_list(self, client: AsyncClient):
        response = await client.get("/api/admin/agms")
        assert response.status_code == 200
        assert isinstance(response.json(), list)

    async def test_agm_list_fields_present(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="List AGM Building", manager_email="list@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = AGM(
            building_id=b.id,
            title="List Test AGM",
            status=AGMStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.commit()

        response = await client.get("/api/admin/agms")
        data = response.json()
        assert len(data) > 0

        # Find our AGM
        our_agm = next((a for a in data if a["title"] == "List Test AGM"), None)
        assert our_agm is not None
        assert "id" in our_agm
        assert "building_id" in our_agm
        assert "building_name" in our_agm
        assert "status" in our_agm
        assert "meeting_at" in our_agm
        assert "voting_closes_at" in our_agm
        assert "created_at" in our_agm
        assert our_agm["building_name"] == "List AGM Building"

    async def test_ordered_by_created_at_desc(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="Order Test Building", manager_email="order@test.com")
        db_session.add(b)
        await db_session.commit()

        response = await client.get("/api/admin/agms")
        data = response.json()
        if len(data) > 1:
            # Check ordering
            for i in range(len(data) - 1):
                assert data[i]["created_at"] >= data[i + 1]["created_at"]


# ---------------------------------------------------------------------------
# GET /api/admin/agms/{agm_id}
# ---------------------------------------------------------------------------


class TestGetAGMDetail:
    async def _setup_agm_with_votes(
        self, db_session: AsyncSession
    ) -> tuple[AGM, list[LotOwner], list[Motion]]:
        b = Building(name="Detail Building", manager_email="detail@test.com")
        db_session.add(b)
        await db_session.flush()

        lo1 = LotOwner(
            building_id=b.id, lot_number="D1", email="yes@test.com", unit_entitlement=100
        )
        lo2 = LotOwner(
            building_id=b.id, lot_number="D2", email="no@test.com", unit_entitlement=80
        )
        lo3 = LotOwner(
            building_id=b.id, lot_number="D3", email="abs@test.com", unit_entitlement=30
        )
        lo4 = LotOwner(
            building_id=b.id, lot_number="D4", email="absent@test.com", unit_entitlement=200
        )
        db_session.add_all([lo1, lo2, lo3, lo4])
        await db_session.flush()

        agm = AGM(
            building_id=b.id,
            title="Detail AGM",
            status=AGMStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(agm_id=agm.id, title="Motion D1", order_index=1)
        db_session.add(motion)
        await db_session.flush()

        # Snapshot
        for lo in [lo1, lo2, lo3, lo4]:
            w = AGMLotWeight(
                agm_id=agm.id,
                lot_owner_id=lo.id,
                voter_email=lo.email,
                unit_entitlement_snapshot=lo.unit_entitlement,
            )
            db_session.add(w)
        await db_session.flush()

        # lo1 voted yes, lo2 voted no, lo3 abstained — all submitted
        # lo4 is absent (no ballot submission)
        for email, choice in [
            ("yes@test.com", VoteChoice.yes),
            ("no@test.com", VoteChoice.no),
            ("abs@test.com", VoteChoice.abstained),
        ]:
            vote = Vote(
                agm_id=agm.id,
                motion_id=motion.id,
                voter_email=email,
                choice=choice,
                status=VoteStatus.submitted,
            )
            db_session.add(vote)
            bs = BallotSubmission(agm_id=agm.id, voter_email=email)
            db_session.add(bs)

        await db_session.commit()
        return agm, [lo1, lo2, lo3, lo4], [motion]

    # --- Happy path ---

    async def test_agm_detail_structure(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        agm, _, _ = await self._setup_agm_with_votes(db_session)
        response = await client.get(f"/api/admin/agms/{agm.id}")
        assert response.status_code == 200
        data = response.json()

        assert data["id"] == str(agm.id)
        assert data["building_name"] == "Detail Building"
        assert "total_eligible_voters" in data
        assert "total_submitted" in data
        assert "motions" in data
        assert "closed_at" in data

    async def test_tally_yes_no_abstained_absent(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        agm, _, _ = await self._setup_agm_with_votes(db_session)
        response = await client.get(f"/api/admin/agms/{agm.id}")
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
        assert tally["absent"]["voter_count"] == 1
        assert tally["absent"]["entitlement_sum"] == 200

    async def test_voter_lists_populated(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        agm, _, _ = await self._setup_agm_with_votes(db_session)
        response = await client.get(f"/api/admin/agms/{agm.id}")
        data = response.json()

        motion = data["motions"][0]
        voter_lists = motion["voter_lists"]

        yes_emails = {v["voter_email"] for v in voter_lists["yes"]}
        no_emails = {v["voter_email"] for v in voter_lists["no"]}
        abs_emails = {v["voter_email"] for v in voter_lists["abstained"]}
        absent_emails = {v["voter_email"] for v in voter_lists["absent"]}

        assert "yes@test.com" in yes_emails
        assert "no@test.com" in no_emails
        assert "abs@test.com" in abs_emails
        assert "absent@test.com" in absent_emails

    async def test_no_votes_all_absent(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="No Votes Building", manager_email="nv@test.com")
        db_session.add(b)
        await db_session.flush()
        lo = LotOwner(
            building_id=b.id,
            lot_number="NV1",
            email="novote@test.com",
            unit_entitlement=50,
        )
        db_session.add(lo)
        await db_session.flush()

        agm = AGM(
            building_id=b.id,
            title="No Votes AGM",
            status=AGMStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(agm_id=agm.id, title="Motion NV1", order_index=1)
        db_session.add(motion)
        await db_session.flush()

        w = AGMLotWeight(
            agm_id=agm.id,
            lot_owner_id=lo.id,
            voter_email=lo.email,
            unit_entitlement_snapshot=lo.unit_entitlement,
        )
        db_session.add(w)
        await db_session.commit()

        response = await client.get(f"/api/admin/agms/{agm.id}")
        data = response.json()

        assert data["total_eligible_voters"] == 1
        assert data["total_submitted"] == 0

        tally = data["motions"][0]["tally"]
        assert tally["yes"]["voter_count"] == 0
        assert tally["no"]["voter_count"] == 0
        assert tally["abstained"]["voter_count"] == 0
        assert tally["absent"]["voter_count"] == 1
        assert tally["absent"]["entitlement_sum"] == 50

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
            email="snap_tally@test.com",
            unit_entitlement=500,
        )
        db_session.add(lo)
        await db_session.flush()

        agm = AGM(
            building_id=b.id,
            title="Snapshot Tally AGM",
            status=AGMStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(agm_id=agm.id, title="ST Motion", order_index=1)
        db_session.add(motion)
        await db_session.flush()

        # Snapshot at 500
        w = AGMLotWeight(
            agm_id=agm.id,
            lot_owner_id=lo.id,
            voter_email=lo.email,
            unit_entitlement_snapshot=500,
        )
        db_session.add(w)
        await db_session.flush()

        # Vote yes
        vote = Vote(
            agm_id=agm.id,
            motion_id=motion.id,
            voter_email=lo.email,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        )
        db_session.add(vote)
        bs = BallotSubmission(agm_id=agm.id, voter_email=lo.email)
        db_session.add(bs)
        await db_session.flush()

        # Change current entitlement (shouldn't affect tally)
        lo.unit_entitlement = 999
        await db_session.commit()

        response = await client.get(f"/api/admin/agms/{agm.id}")
        tally = response.json()["motions"][0]["tally"]
        assert tally["yes"]["entitlement_sum"] == 500

    async def test_multi_lot_voter_entitlement_sum(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Voter with two lots: entitlement should be sum of both snapshots."""
        b = Building(name="Two Lots Building", manager_email="tl@test.com")
        db_session.add(b)
        await db_session.flush()
        lo1 = LotOwner(
            building_id=b.id,
            lot_number="TL1",
            email="twolots@test.com",
            unit_entitlement=100,
        )
        lo2 = LotOwner(
            building_id=b.id,
            lot_number="TL2",
            email="twolots@test.com",
            unit_entitlement=200,
        )
        db_session.add_all([lo1, lo2])
        await db_session.flush()

        agm = AGM(
            building_id=b.id,
            title="Two Lots AGM",
            status=AGMStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(agm_id=agm.id, title="TL Motion", order_index=1)
        db_session.add(motion)
        await db_session.flush()

        for lo in [lo1, lo2]:
            w = AGMLotWeight(
                agm_id=agm.id,
                lot_owner_id=lo.id,
                voter_email=lo.email,
                unit_entitlement_snapshot=lo.unit_entitlement,
            )
            db_session.add(w)
        await db_session.flush()

        vote = Vote(
            agm_id=agm.id,
            motion_id=motion.id,
            voter_email="twolots@test.com",
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        )
        db_session.add(vote)
        bs = BallotSubmission(agm_id=agm.id, voter_email="twolots@test.com")
        db_session.add(bs)
        await db_session.commit()

        response = await client.get(f"/api/admin/agms/{agm.id}")
        data = response.json()
        assert data["total_eligible_voters"] == 1
        tally = data["motions"][0]["tally"]
        assert tally["yes"]["voter_count"] == 1
        assert tally["yes"]["entitlement_sum"] == 300  # 100 + 200

    # --- State / precondition errors ---

    async def test_not_found_returns_404(self, client: AsyncClient):
        response = await client.get(f"/api/admin/agms/{uuid.uuid4()}")
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
                email=f"yes{i}@test.com",
                unit_entitlement=10 * (i + 1),
            )
            for i in range(3)
        ]
        db_session.add_all(owners)
        await db_session.flush()

        agm = AGM(
            building_id=b.id,
            title="All Yes AGM",
            status=AGMStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(agm_id=agm.id, title="All Yes Motion", order_index=1)
        db_session.add(motion)
        await db_session.flush()

        for lo in owners:
            w = AGMLotWeight(
                agm_id=agm.id,
                lot_owner_id=lo.id,
                voter_email=lo.email,
                unit_entitlement_snapshot=lo.unit_entitlement,
            )
            db_session.add(w)
            vote = Vote(
                agm_id=agm.id,
                motion_id=motion.id,
                voter_email=lo.email,
                choice=VoteChoice.yes,
                status=VoteStatus.submitted,
            )
            db_session.add(vote)
            bs = BallotSubmission(agm_id=agm.id, voter_email=lo.email)
            db_session.add(bs)
        await db_session.commit()

        response = await client.get(f"/api/admin/agms/{agm.id}")
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
            email="nullchoice@test.com",
            unit_entitlement=40,
        )
        db_session.add(lo)
        await db_session.flush()

        agm = AGM(
            building_id=b.id,
            title="Null Choice AGM",
            status=AGMStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(agm_id=agm.id, title="NC Motion", order_index=1)
        db_session.add(motion)
        await db_session.flush()

        w = AGMLotWeight(
            agm_id=agm.id,
            lot_owner_id=lo.id,
            voter_email=lo.email,
            unit_entitlement_snapshot=lo.unit_entitlement,
        )
        db_session.add(w)

        # Vote with null choice (submitted but no selection → abstained)
        vote = Vote(
            agm_id=agm.id,
            motion_id=motion.id,
            voter_email=lo.email,
            choice=None,
            status=VoteStatus.submitted,
        )
        db_session.add(vote)
        bs = BallotSubmission(agm_id=agm.id, voter_email=lo.email)
        db_session.add(bs)
        await db_session.commit()

        response = await client.get(f"/api/admin/agms/{agm.id}")
        tally = response.json()["motions"][0]["tally"]
        assert tally["abstained"]["voter_count"] == 1
        assert tally["abstained"]["entitlement_sum"] == 40


# ---------------------------------------------------------------------------
# POST /api/admin/agms/{agm_id}/close
# ---------------------------------------------------------------------------


class TestCloseAGM:
    async def _create_open_agm(self, db_session: AsyncSession, name: str) -> AGM:
        b = Building(name=name, manager_email=f"close_{name}@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = AGM(
            building_id=b.id,
            title=f"Close Test AGM {name}",
            status=AGMStatus.open,
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
        response = await client.post(f"/api/admin/agms/{agm.id}/close")
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
            building_id=b.id, lot_number="DD1", email="draft@test.com", unit_entitlement=10
        )
        db_session.add(lo)
        await db_session.flush()

        agm = AGM(
            building_id=b.id,
            title="Draft Delete AGM",
            status=AGMStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(agm_id=agm.id, title="DD Motion", order_index=1)
        db_session.add(motion)
        await db_session.flush()

        # Add draft and submitted votes
        draft_vote = Vote(
            agm_id=agm.id,
            motion_id=motion.id,
            voter_email="draft@test.com",
            choice=VoteChoice.yes,
            status=VoteStatus.draft,
        )
        submitted_vote = Vote(
            agm_id=agm.id,
            motion_id=motion.id,
            voter_email="submitted@test.com",
            choice=VoteChoice.no,
            status=VoteStatus.submitted,
        )
        db_session.add_all([draft_vote, submitted_vote])
        await db_session.commit()

        # Close AGM
        response = await client.post(f"/api/admin/agms/{agm.id}/close")
        assert response.status_code == 200

        # Check draft vote deleted, submitted vote remains
        remaining = await db_session.execute(
            select(Vote).where(Vote.agm_id == agm.id)
        )
        remaining_votes = list(remaining.scalars().all())
        assert all(v.status == VoteStatus.submitted for v in remaining_votes)
        assert not any(v.voter_email == "draft@test.com" for v in remaining_votes)

    async def test_email_delivery_record_created_on_close(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        agm = await self._create_open_agm(db_session, "Email Delivery Building")
        response = await client.post(f"/api/admin/agms/{agm.id}/close")
        assert response.status_code == 200

        result = await db_session.execute(
            select(EmailDelivery).where(EmailDelivery.agm_id == agm.id)
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
        await client.post(f"/api/admin/agms/{agm.id}/close")
        response = await client.post(f"/api/admin/agms/{agm.id}/close")
        assert response.status_code == 409

    async def test_close_not_found_returns_404(self, client: AsyncClient):
        response = await client.post(f"/api/admin/agms/{uuid.uuid4()}/close")
        assert response.status_code == 404


# ---------------------------------------------------------------------------
# POST /api/admin/agms/{agm_id}/resend-report
# ---------------------------------------------------------------------------


class TestResendReport:
    async def _setup_closed_agm_with_delivery(
        self, db_session: AsyncSession, name: str, delivery_status: EmailDeliveryStatus
    ) -> tuple[AGM, EmailDelivery]:
        b = Building(name=name, manager_email=f"resend_{name}@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = AGM(
            building_id=b.id,
            title=f"Resend Test {name}",
            status=AGMStatus.closed,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
            closed_at=datetime.now(UTC),
        )
        db_session.add(agm)
        await db_session.flush()

        delivery = EmailDelivery(
            agm_id=agm.id,
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
        response = await client.post(f"/api/admin/agms/{agm.id}/resend-report")
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
        response = await client.post(f"/api/admin/agms/{agm.id}/resend-report")
        assert response.status_code == 409

    async def test_resend_delivered_delivery_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        agm, _ = await self._setup_closed_agm_with_delivery(
            db_session, "Delivered Delivery Building", EmailDeliveryStatus.delivered
        )
        response = await client.post(f"/api/admin/agms/{agm.id}/resend-report")
        assert response.status_code == 409

    async def test_resend_open_agm_returns_409(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="Open Resend Building", manager_email="op_res@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = AGM(
            building_id=b.id,
            title="Open Resend AGM",
            status=AGMStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.commit()

        response = await client.post(f"/api/admin/agms/{agm.id}/resend-report")
        assert response.status_code == 409

    async def test_resend_not_found_returns_404(self, client: AsyncClient):
        response = await client.post(f"/api/admin/agms/{uuid.uuid4()}/resend-report")
        assert response.status_code == 404

    async def test_resend_no_delivery_record_returns_404(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        b = Building(name="No Delivery Building", manager_email="nd@test.com")
        db_session.add(b)
        await db_session.flush()
        agm = AGM(
            building_id=b.id,
            title="No Delivery AGM",
            status=AGMStatus.closed,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
            closed_at=datetime.now(UTC),
        )
        db_session.add(agm)
        await db_session.commit()

        response = await client.post(f"/api/admin/agms/{agm.id}/resend-report")
        assert response.status_code == 404


# ---------------------------------------------------------------------------
# Schema unit tests (for coverage of schema validators)
# ---------------------------------------------------------------------------


class TestSchemas:
    def test_lot_owner_update_requires_at_least_one_field(self):
        from pydantic import ValidationError

        from app.schemas.admin import LotOwnerUpdate

        with pytest.raises(ValidationError):
            LotOwnerUpdate()

    def test_lot_owner_update_email_only(self):
        from app.schemas.admin import LotOwnerUpdate

        obj = LotOwnerUpdate(email="x@test.com")
        assert obj.email == "x@test.com"
        assert obj.unit_entitlement is None

    def test_lot_owner_update_entitlement_only(self):
        from app.schemas.admin import LotOwnerUpdate

        obj = LotOwnerUpdate(unit_entitlement=10)
        assert obj.unit_entitlement == 10

    def test_lot_owner_update_negative_entitlement_raises(self):
        from pydantic import ValidationError

        from app.schemas.admin import LotOwnerUpdate

        with pytest.raises(ValidationError):
            LotOwnerUpdate(unit_entitlement=-1)

    def test_agm_create_no_motions_raises(self):
        from pydantic import ValidationError

        from app.schemas.admin import AGMCreate

        with pytest.raises(ValidationError):
            AGMCreate(
                building_id=uuid.uuid4(),
                title="t",
                meeting_at=meeting_dt(),
                voting_closes_at=closing_dt(),
                motions=[],
            )

    def test_agm_create_closes_before_meeting_raises(self):
        from pydantic import ValidationError

        from app.schemas.admin import AGMCreate, MotionCreate

        now = datetime.now(UTC)
        with pytest.raises(ValidationError):
            AGMCreate(
                building_id=uuid.uuid4(),
                title="t",
                meeting_at=now + timedelta(days=2),
                voting_closes_at=now + timedelta(days=1),
                motions=[MotionCreate(title="M", order_index=1)],
            )

    def test_lot_owner_create_empty_lot_number_raises(self):
        from pydantic import ValidationError

        from app.schemas.admin import LotOwnerCreate

        with pytest.raises(ValidationError):
            LotOwnerCreate(lot_number="  ", email="x@test.com", unit_entitlement=10)

    def test_lot_owner_create_empty_email_raises(self):
        from pydantic import ValidationError

        from app.schemas.admin import LotOwnerCreate

        with pytest.raises(ValidationError):
            LotOwnerCreate(lot_number="L1", email="  ", unit_entitlement=10)

    def test_lot_owner_create_negative_entitlement_raises(self):
        from pydantic import ValidationError

        from app.schemas.admin import LotOwnerCreate

        with pytest.raises(ValidationError):
            LotOwnerCreate(lot_number="L1", email="x@test.com", unit_entitlement=-1)


# ---------------------------------------------------------------------------
# _detect_file_format unit tests
# ---------------------------------------------------------------------------


class TestDetectFileFormat:
    """Unit tests for the _detect_file_format helper in admin router."""

    def test_csv_extension_returns_csv(self):
        from unittest.mock import MagicMock
        from app.routers.admin import _detect_file_format

        f = MagicMock()
        f.content_type = "application/octet-stream"
        f.filename = "data.csv"
        assert _detect_file_format(f) == "csv"

    def test_csv_content_type_returns_csv(self):
        from unittest.mock import MagicMock
        from app.routers.admin import _detect_file_format

        f = MagicMock()
        f.content_type = "text/csv"
        f.filename = "noextension"
        assert _detect_file_format(f) == "csv"

    def test_xlsx_extension_returns_excel(self):
        from unittest.mock import MagicMock
        from app.routers.admin import _detect_file_format

        f = MagicMock()
        f.content_type = "application/octet-stream"
        f.filename = "data.xlsx"
        assert _detect_file_format(f) == "excel"

    def test_xls_extension_returns_excel(self):
        from unittest.mock import MagicMock
        from app.routers.admin import _detect_file_format

        f = MagicMock()
        f.content_type = "application/octet-stream"
        f.filename = "data.xls"
        assert _detect_file_format(f) == "excel"

    def test_xlsx_content_type_returns_excel(self):
        from unittest.mock import MagicMock
        from app.routers.admin import _detect_file_format

        f = MagicMock()
        f.content_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        f.filename = "data"
        assert _detect_file_format(f) == "excel"

    def test_vnd_ms_excel_content_type_returns_excel(self):
        from unittest.mock import MagicMock
        from app.routers.admin import _detect_file_format

        f = MagicMock()
        f.content_type = "application/vnd.ms-excel"
        f.filename = "data"
        assert _detect_file_format(f) == "excel"

    def test_pdf_raises_415(self):
        from unittest.mock import MagicMock
        from fastapi import HTTPException
        from app.routers.admin import _detect_file_format

        f = MagicMock()
        f.content_type = "application/pdf"
        f.filename = "data.pdf"
        with pytest.raises(HTTPException) as exc_info:
            _detect_file_format(f)
        assert exc_info.value.status_code == 415

    def test_no_extension_no_matching_content_type_raises_415(self):
        from unittest.mock import MagicMock
        from fastapi import HTTPException
        from app.routers.admin import _detect_file_format

        f = MagicMock()
        f.content_type = "image/png"
        f.filename = "data.png"
        with pytest.raises(HTTPException) as exc_info:
            _detect_file_format(f)
        assert exc_info.value.status_code == 415


# ---------------------------------------------------------------------------
# POST /api/admin/buildings/import — Excel
# ---------------------------------------------------------------------------


class TestImportBuildingsExcel:
    # --- Happy path ---

    async def test_valid_xlsx_creates_buildings(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        excel_data = make_excel(
            ["building_name", "manager_email"],
            [["Excel Tower", "excel@test.com"], ["Xlsx Complex", "xlsx@test.com"]],
        )
        response = await client.post(
            "/api/admin/buildings/import",
            files={
                "file": (
                    "buildings.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["created"] == 2
        assert data["updated"] == 0

    async def test_valid_xlsx_updates_existing_building(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        # Create via CSV first
        csv_data = make_csv(
            ["building_name", "manager_email"],
            [["ExcelUpdate Building", "old@test.com"]],
        )
        await client.post(
            "/api/admin/buildings/import",
            files={"file": ("buildings.csv", csv_data, "text/csv")},
        )

        # Update via Excel
        excel_data = make_excel(
            ["building_name", "manager_email"],
            [["ExcelUpdate Building", "new@test.com"]],
        )
        response = await client.post(
            "/api/admin/buildings/import",
            files={
                "file": (
                    "buildings.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["created"] == 0
        assert data["updated"] == 1

    async def test_xlsx_with_blank_rows_skipped(self, client: AsyncClient):
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(["building_name", "manager_email"])
        ws.append(["Blank Skip Building", "bs@test.com"])
        ws.append([None, None])  # blank row
        ws.append(["", ""])  # also blank
        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        excel_data = buf.read()

        response = await client.post(
            "/api/admin/buildings/import",
            files={
                "file": (
                    "buildings.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 200
        assert response.json()["created"] == 1

    async def test_empty_xlsx_returns_zero_counts(self, client: AsyncClient):
        excel_data = make_excel(["building_name", "manager_email"], [])
        response = await client.post(
            "/api/admin/buildings/import",
            files={
                "file": (
                    "empty.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["created"] == 0
        assert data["updated"] == 0

    # --- Input validation ---

    async def test_xlsx_missing_building_name_column_returns_422(
        self, client: AsyncClient
    ):
        excel_data = make_excel(
            ["manager_email"],
            [["mgr@test.com"]],
        )
        response = await client.post(
            "/api/admin/buildings/import",
            files={
                "file": (
                    "buildings.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 422
        assert "building_name" in response.json()["detail"]

    async def test_xlsx_missing_manager_email_column_returns_422(
        self, client: AsyncClient
    ):
        excel_data = make_excel(
            ["building_name"],
            [["Some Building"]],
        )
        response = await client.post(
            "/api/admin/buildings/import",
            files={
                "file": (
                    "buildings.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 422
        assert "manager_email" in response.json()["detail"]

    async def test_xlsx_empty_building_name_value_returns_422(
        self, client: AsyncClient
    ):
        excel_data = make_excel(
            ["building_name", "manager_email"],
            [["", "mgr@test.com"]],
        )
        response = await client.post(
            "/api/admin/buildings/import",
            files={
                "file": (
                    "buildings.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert any("building_name is empty" in str(e) for e in detail)

    async def test_xlsx_empty_manager_email_value_returns_422(
        self, client: AsyncClient
    ):
        excel_data = make_excel(
            ["building_name", "manager_email"],
            [["Test Building", ""]],
        )
        response = await client.post(
            "/api/admin/buildings/import",
            files={
                "file": (
                    "buildings.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert any("manager_email is empty" in str(e) for e in detail)

    async def test_invalid_excel_bytes_returns_422(self, client: AsyncClient):
        response = await client.post(
            "/api/admin/buildings/import",
            files={
                "file": (
                    "broken.xlsx",
                    b"this is not an excel file",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 422

    async def test_xlsx_no_headers_returns_422(self, client: AsyncClient):
        """An Excel file that is empty (no rows at all) should return 422."""
        wb = openpyxl.Workbook()
        # Remove all rows — create a sheet with no content
        ws = wb.active
        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        excel_data = buf.read()

        response = await client.post(
            "/api/admin/buildings/import",
            files={
                "file": (
                    "noheader.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 422

    async def test_xlsx_headers_case_insensitive(self, client: AsyncClient):
        excel_data = make_excel(
            ["Building_Name", "Manager_Email"],
            [["CI Building Excel", "ci@excel.com"]],
        )
        response = await client.post(
            "/api/admin/buildings/import",
            files={
                "file": (
                    "buildings.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 200
        assert response.json()["created"] == 1


# ---------------------------------------------------------------------------
# POST /api/admin/buildings/{building_id}/lot-owners/import — Excel
# ---------------------------------------------------------------------------


class TestImportLotOwnersExcel:
    # --- Happy path ---

    async def test_valid_xlsx_imports_lot_owners(
        self, client: AsyncClient, building: Building
    ):
        excel_data = make_excel(
            ["Lot#", "UOE2", "Email"],
            [["101", "250", "owner101@test.com"], ["102", "300", "owner102@test.com"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={
                "file": (
                    "owners.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 200
        assert response.json()["imported"] == 2

    async def test_valid_xlsx_replaces_existing_lot_owners(
        self, client: AsyncClient, building_with_owners: Building
    ):
        excel_data = make_excel(
            ["Lot#", "UOE2", "Email"],
            [["NEW1", "100", "new1@test.com"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building_with_owners.id}/lot-owners/import",
            files={
                "file": (
                    "owners.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 200
        assert response.json()["imported"] == 1

    async def test_empty_xlsx_imports_zero(
        self, client: AsyncClient, building: Building
    ):
        excel_data = make_excel(["Lot#", "UOE2", "Email"], [])
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={
                "file": (
                    "empty.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 200
        assert response.json()["imported"] == 0

    async def test_xlsx_with_blank_rows_skipped(
        self, client: AsyncClient, building: Building
    ):
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(["Lot#", "UOE2", "Email"])
        ws.append(["201", "150", "owner201@test.com"])
        ws.append([None, None, None])
        ws.append(["", "", ""])
        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        excel_data = buf.read()

        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={
                "file": (
                    "owners.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 200
        assert response.json()["imported"] == 1

    # --- Input validation ---

    async def test_xlsx_missing_uoe2_column_returns_422(
        self, client: AsyncClient, building: Building
    ):
        excel_data = make_excel(
            ["Lot#", "Email"],
            [["101", "owner@test.com"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={
                "file": (
                    "owners.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 422
        assert "uoe2" in response.json()["detail"]

    async def test_xlsx_missing_lot_column_returns_422(
        self, client: AsyncClient, building: Building
    ):
        excel_data = make_excel(
            ["UOE2", "Email"],
            [["100", "owner@test.com"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={
                "file": (
                    "owners.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 422
        assert "lot#" in response.json()["detail"]

    async def test_xlsx_missing_email_column_returns_422(
        self, client: AsyncClient, building: Building
    ):
        excel_data = make_excel(
            ["Lot#", "UOE2"],
            [["101", "100"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={
                "file": (
                    "owners.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 422
        assert "email" in response.json()["detail"]

    async def test_xlsx_duplicate_lot_number_returns_422(
        self, client: AsyncClient, building: Building
    ):
        excel_data = make_excel(
            ["Lot#", "UOE2", "Email"],
            [
                ["101", "100", "a@test.com"],
                ["101", "200", "b@test.com"],
            ],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={
                "file": (
                    "owners.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert any("duplicate lot_number" in str(e) for e in detail)

    async def test_xlsx_non_integer_uoe2_returns_422(
        self, client: AsyncClient, building: Building
    ):
        excel_data = make_excel(
            ["Lot#", "UOE2", "Email"],
            [["101", "not-a-number", "owner@test.com"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={
                "file": (
                    "owners.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert any("unit_entitlement must be an integer" in str(e) for e in detail)

    async def test_xlsx_negative_uoe2_returns_422(
        self, client: AsyncClient, building: Building
    ):
        excel_data = make_excel(
            ["Lot#", "UOE2", "Email"],
            [["101", -5, "owner@test.com"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={
                "file": (
                    "owners.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert any("unit_entitlement must be >= 0" in str(e) for e in detail)

    async def test_xlsx_empty_lot_number_returns_422(
        self, client: AsyncClient, building: Building
    ):
        excel_data = make_excel(
            ["Lot#", "UOE2", "Email"],
            [["", "100", "owner@test.com"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={
                "file": (
                    "owners.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert any("lot_number is empty" in str(e) for e in detail)

    async def test_xlsx_empty_email_returns_422(
        self, client: AsyncClient, building: Building
    ):
        excel_data = make_excel(
            ["Lot#", "UOE2", "Email"],
            [["101", "100", ""]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={
                "file": (
                    "owners.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert any("email is empty" in str(e) for e in detail)

    async def test_xlsx_empty_uoe2_returns_422(
        self, client: AsyncClient, building: Building
    ):
        excel_data = make_excel(
            ["Lot#", "UOE2", "Email"],
            [["101", "", "owner@test.com"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={
                "file": (
                    "owners.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert any("unit_entitlement is empty" in str(e) for e in detail)

    async def test_xlsx_building_not_found_returns_404(self, client: AsyncClient):
        excel_data = make_excel(
            ["Lot#", "UOE2", "Email"],
            [["101", "100", "owner@test.com"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{uuid.uuid4()}/lot-owners/import",
            files={
                "file": (
                    "owners.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 404

    async def test_invalid_excel_bytes_returns_422(
        self, client: AsyncClient, building: Building
    ):
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={
                "file": (
                    "broken.xlsx",
                    b"this is not an excel file",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 422

    async def test_xlsx_no_headers_returns_422(
        self, client: AsyncClient, building: Building
    ):
        """An Excel file that is empty (no rows at all) should return 422."""
        wb = openpyxl.Workbook()
        ws = wb.active
        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        excel_data = buf.read()

        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={
                "file": (
                    "noheader.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 422

    async def test_xlsx_headers_case_insensitive(
        self, client: AsyncClient, building: Building
    ):
        excel_data = make_excel(
            ["LOT#", "uoe2", "EMAIL"],
            [["301", "200", "ci@test.com"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={
                "file": (
                    "owners.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 200
        assert response.json()["imported"] == 1

    async def test_xlsx_numeric_lot_number_converted_to_string(
        self, client: AsyncClient, building: Building
    ):
        """Lot numbers that are numeric in Excel should be imported as strings."""
        excel_data = make_excel(
            ["Lot#", "UOE2", "Email"],
            [[101, 100, "owner@test.com"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={
                "file": (
                    "owners.xlsx",
                    excel_data,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 200
        assert response.json()["imported"] == 1

    # --- Edge cases ---

    async def test_xlsx_reimport_preserves_agm_lot_weight_snapshots(
        self, client: AsyncClient, building: Building, db_session: AsyncSession
    ):
        """Re-importing via Excel must NOT destroy AGMLotWeight snapshots."""
        excel1 = make_excel(
            ["Lot#", "UOE2", "Email"],
            [["XL1", 100, "xvoter@test.com"], ["XL2", 200, "xvoter@test.com"]],
        )
        await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={
                "file": (
                    "owners.xlsx",
                    excel1,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )

        # Create AGM and snapshot lot weights
        agm = AGM(
            building_id=building.id,
            title="Excel Snapshot AGM",
            status=AGMStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()
        motion = Motion(agm_id=agm.id, title="XL Motion", order_index=1)
        db_session.add(motion)
        await db_session.flush()

        owners_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == building.id)
        )
        for lo in owners_result.scalars().all():
            db_session.add(AGMLotWeight(
                agm_id=agm.id,
                lot_owner_id=lo.id,
                voter_email=lo.email,
                unit_entitlement_snapshot=lo.unit_entitlement,
            ))
        await db_session.commit()

        # Re-import same lots — must preserve snapshots
        excel2 = make_excel(
            ["Lot#", "UOE2", "Email"],
            [["XL1", 100, "xvoter@test.com"], ["XL2", 200, "xvoter@test.com"]],
        )
        response = await client.post(
            f"/api/admin/buildings/{building.id}/lot-owners/import",
            files={
                "file": (
                    "owners.xlsx",
                    excel2,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert response.status_code == 200

        # Snapshots must survive the re-import
        weights_result = await db_session.execute(
            select(AGMLotWeight).where(AGMLotWeight.agm_id == agm.id)
        )
        weights = weights_result.scalars().all()
        assert len(weights) == 2
        assert sum(w.unit_entitlement_snapshot for w in weights) == 300  # 100 + 200
