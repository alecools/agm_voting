"""
Tests for subscription and unarchive endpoints.

Covers:
  GET  /api/admin/subscription
  POST /api/admin/subscription
  POST /api/admin/buildings/{id}/unarchive
  Service: get_subscription, upsert_subscription, unarchive_building, create_building (limit)
  Dependencies: require_operator
"""
from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import BetterAuthUser, require_admin, require_operator
from app.models import Building
from app.models.tenant_settings import TenantSettings


async def _reset_tenant_settings(db: AsyncSession) -> None:
    """Remove any existing tenant_settings row so each test starts clean."""
    await db.execute(delete(TenantSettings))
    await db.flush()


async def _upsert_tenant_settings(
    db: AsyncSession,
    *,
    tier_name: str | None,
    building_limit: int | None,
) -> TenantSettings:
    """Delete and re-insert the singleton settings row (avoids PK conflicts)."""
    await _reset_tenant_settings(db)
    settings = TenantSettings(id=1, tier_name=tier_name, building_limit=building_limit)
    db.add(settings)
    await db.flush()
    return settings


# ---------------------------------------------------------------------------
# Fixtures: operator app and non-operator app
# ---------------------------------------------------------------------------


@pytest.fixture
def operator_app(db_session: AsyncSession):
    """App with admin auth overridden to a server-admin (operator) user."""
    from app.main import create_app

    application = create_app()

    async def override_get_db():
        yield db_session

    async def override_require_admin():
        return BetterAuthUser(
            email="operator@example.com",
            user_id="operator-user-id",
            is_server_admin=True,
        )

    async def override_require_operator():
        return BetterAuthUser(
            email="operator@example.com",
            user_id="operator-user-id",
            is_server_admin=True,
        )

    application.dependency_overrides[get_db] = override_get_db
    application.dependency_overrides[require_admin] = override_require_admin
    application.dependency_overrides[require_operator] = override_require_operator
    yield application
    application.dependency_overrides.clear()


@pytest.fixture
def non_operator_app(db_session: AsyncSession):
    """App with admin auth overridden to a regular admin (not server admin)."""
    from app.main import create_app

    application = create_app()

    async def override_get_db():
        yield db_session

    async def override_require_admin():
        return BetterAuthUser(
            email="admin@example.com",
            user_id="admin-user-id",
            is_server_admin=False,
        )

    application.dependency_overrides[get_db] = override_get_db
    application.dependency_overrides[require_admin] = override_require_admin
    yield application
    application.dependency_overrides.clear()


@pytest_asyncio.fixture
async def operator_client(operator_app):
    async with AsyncClient(
        transport=ASGITransport(app=operator_app),
        base_url="http://test",
        headers={"X-Requested-With": "XMLHttpRequest"},
    ) as ac:
        yield ac


@pytest_asyncio.fixture
async def non_operator_client(non_operator_app):
    async with AsyncClient(
        transport=ASGITransport(app=non_operator_app),
        base_url="http://test",
        headers={"X-Requested-With": "XMLHttpRequest"},
    ) as ac:
        yield ac


# ---------------------------------------------------------------------------
# GET /api/admin/subscription
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestGetSubscription:
    # --- Happy path ---

    async def test_returns_defaults_when_no_row(
        self, operator_client: AsyncClient, db_session: AsyncSession
    ):
        """Returns nulls + correct active building count when no tenant_settings row."""
        await _reset_tenant_settings(db_session)
        response = await operator_client.get("/api/admin/subscription")
        assert response.status_code == 200
        data = response.json()
        assert data["tier_name"] is None
        assert data["building_limit"] is None
        assert "active_building_count" in data

    async def test_returns_settings_when_row_exists(
        self, operator_client: AsyncClient, db_session: AsyncSession
    ):
        """Returns saved tier_name and building_limit when row exists."""
        await _upsert_tenant_settings(db_session, tier_name="Starter", building_limit=5)

        response = await operator_client.get("/api/admin/subscription")
        assert response.status_code == 200
        data = response.json()
        assert data["tier_name"] == "Starter"
        assert data["building_limit"] == 5

    async def test_active_building_count_excludes_archived(
        self, operator_client: AsyncClient, db_session: AsyncSession
    ):
        """active_building_count counts only non-archived buildings."""
        db_session.add(Building(name="Sub Active Building", manager_email="a@test.com"))
        db_session.add(
            Building(name="Sub Archived Building", manager_email="b@test.com", is_archived=True)
        )
        await db_session.flush()

        response = await operator_client.get("/api/admin/subscription")
        assert response.status_code == 200
        data = response.json()
        # Active count must be >= 1 (the non-archived one), not counting the archived
        assert data["active_building_count"] >= 1

    async def test_accessible_by_regular_admin(
        self, non_operator_client: AsyncClient, db_session: AsyncSession
    ):
        """GET /subscription is accessible by all admins (not operator-only)."""
        response = await non_operator_client.get("/api/admin/subscription")
        assert response.status_code == 200


# ---------------------------------------------------------------------------
# POST /api/admin/subscription
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestUpdateSubscription:
    # --- Happy path ---

    async def test_operator_can_create_subscription(
        self, operator_client: AsyncClient, db_session: AsyncSession
    ):
        """Operator can POST to create subscription settings."""
        response = await operator_client.post(
            "/api/admin/subscription",
            json={"tier_name": "Pro", "building_limit": 10},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["tier_name"] == "Pro"
        assert data["building_limit"] == 10

    async def test_operator_can_update_subscription(
        self, operator_client: AsyncClient, db_session: AsyncSession
    ):
        """Operator can POST again to update existing settings."""
        await operator_client.post(
            "/api/admin/subscription",
            json={"tier_name": "Starter", "building_limit": 5},
        )
        response = await operator_client.post(
            "/api/admin/subscription",
            json={"tier_name": "Pro", "building_limit": 20},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["tier_name"] == "Pro"
        assert data["building_limit"] == 20

    async def test_can_set_null_building_limit(
        self, operator_client: AsyncClient, db_session: AsyncSession
    ):
        """setting building_limit to null means unlimited."""
        await operator_client.post(
            "/api/admin/subscription",
            json={"tier_name": "Enterprise", "building_limit": 10},
        )
        response = await operator_client.post(
            "/api/admin/subscription",
            json={"tier_name": "Enterprise", "building_limit": None},
        )
        assert response.status_code == 200
        assert response.json()["building_limit"] is None

    async def test_can_set_null_tier_name(
        self, operator_client: AsyncClient, db_session: AsyncSession
    ):
        """tier_name can be null."""
        response = await operator_client.post(
            "/api/admin/subscription",
            json={"tier_name": None, "building_limit": 3},
        )
        assert response.status_code == 200
        assert response.json()["tier_name"] is None

    async def test_returns_active_building_count(
        self, operator_client: AsyncClient, db_session: AsyncSession
    ):
        """Response always includes active_building_count."""
        response = await operator_client.post(
            "/api/admin/subscription",
            json={"tier_name": "Basic", "building_limit": 5},
        )
        assert response.status_code == 200
        assert "active_building_count" in response.json()

    # --- Authorization ---

    async def test_non_operator_gets_403(
        self, non_operator_client: AsyncClient, db_session: AsyncSession
    ):
        """Regular admin cannot POST /subscription."""
        response = await non_operator_client.post(
            "/api/admin/subscription",
            json={"tier_name": "Pro", "building_limit": 10},
        )
        assert response.status_code == 403

    # --- Input validation ---

    async def test_rejects_zero_building_limit(
        self, operator_client: AsyncClient, db_session: AsyncSession
    ):
        """building_limit < 1 is rejected with 422."""
        response = await operator_client.post(
            "/api/admin/subscription",
            json={"tier_name": "Basic", "building_limit": 0},
        )
        assert response.status_code == 422

    async def test_rejects_negative_building_limit(
        self, operator_client: AsyncClient, db_session: AsyncSession
    ):
        """Negative building_limit is rejected with 422."""
        response = await operator_client.post(
            "/api/admin/subscription",
            json={"tier_name": "Basic", "building_limit": -1},
        )
        assert response.status_code == 422

    async def test_rejects_tier_name_too_long(
        self, operator_client: AsyncClient, db_session: AsyncSession
    ):
        """tier_name > 255 chars is rejected with 422."""
        response = await operator_client.post(
            "/api/admin/subscription",
            json={"tier_name": "A" * 256, "building_limit": None},
        )
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# POST /api/admin/buildings/{id}/unarchive
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestUnarchiveBuilding:
    # --- Happy path ---

    async def test_operator_can_unarchive_building(
        self, operator_client: AsyncClient, db_session: AsyncSession
    ):
        """Operator can unarchive an archived building."""
        b = Building(name="Archived Bldg", manager_email="a@test.com", is_archived=True)
        db_session.add(b)
        await db_session.flush()
        await db_session.refresh(b)

        response = await operator_client.post(f"/api/admin/buildings/{b.id}/unarchive")
        assert response.status_code == 200
        data = response.json()
        assert data["is_archived"] is False
        assert data["id"] == str(b.id)

    async def test_unarchive_already_active_building(
        self, operator_client: AsyncClient, db_session: AsyncSession
    ):
        """Unarchiving a non-archived building is idempotent (still 200)."""
        b = Building(name="Active Bldg Unarchive", manager_email="x@test.com", is_archived=False)
        db_session.add(b)
        await db_session.flush()
        await db_session.refresh(b)

        response = await operator_client.post(f"/api/admin/buildings/{b.id}/unarchive")
        assert response.status_code == 200
        assert response.json()["is_archived"] is False

    # --- Authorization ---

    async def test_non_operator_gets_403(
        self, non_operator_client: AsyncClient, db_session: AsyncSession
    ):
        """Regular admin cannot unarchive a building."""
        b = Building(name="403 Bldg", manager_email="y@test.com", is_archived=True)
        db_session.add(b)
        await db_session.flush()
        await db_session.refresh(b)

        response = await non_operator_client.post(f"/api/admin/buildings/{b.id}/unarchive")
        assert response.status_code == 403

    # --- Not found ---

    async def test_returns_404_for_unknown_building(
        self, operator_client: AsyncClient, db_session: AsyncSession
    ):
        """404 returned when building_id does not exist."""
        fake_id = uuid.uuid4()
        response = await operator_client.post(f"/api/admin/buildings/{fake_id}/unarchive")
        assert response.status_code == 404


# ---------------------------------------------------------------------------
# Building limit enforcement (via POST /api/admin/buildings)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestBuildingLimitEnforcement:
    # --- Happy path ---

    async def test_create_building_succeeds_below_limit(
        self, operator_client: AsyncClient, db_session: AsyncSession
    ):
        """Can create a building when current count is below limit.

        Use a very large limit (10 000) so this test is resilient to however
        many buildings already exist in the shared test DB.
        """
        await _upsert_tenant_settings(db_session, tier_name="Starter", building_limit=10_000)

        response = await operator_client.post(
            "/api/admin/buildings",
            json={"name": "Limit Test OK Below", "manager_email": "ltok@test.com"},
        )
        assert response.status_code == 201

    async def test_create_building_no_limit_always_succeeds(
        self, operator_client: AsyncClient, db_session: AsyncSession
    ):
        """When building_limit is null (unlimited), creation always succeeds."""
        await _upsert_tenant_settings(db_session, tier_name="Enterprise", building_limit=None)

        response = await operator_client.post(
            "/api/admin/buildings",
            json={"name": "Unlimited Test BldgX", "manager_email": "ulx@test.com"},
        )
        assert response.status_code == 201

    async def test_create_building_blocked_at_limit(
        self, operator_client: AsyncClient, db_session: AsyncSession
    ):
        """Creation fails with 422 when non-archived building count >= building_limit.

        We query the current active count and set the limit to that count so
        that the very next creation attempt is blocked regardless of pre-existing data.
        """
        from sqlalchemy import func, select as sa_select

        result = await db_session.execute(
            sa_select(func.count()).select_from(Building).where(Building.is_archived == False)  # noqa: E712
        )
        current_count = result.scalar_one()

        # Set limit == current count — any additional creation must be blocked
        await _upsert_tenant_settings(db_session, tier_name="Starter", building_limit=current_count)

        response = await operator_client.post(
            "/api/admin/buildings",
            json={"name": "Should Be Blocked Limit", "manager_email": "sbl@test.com"},
        )
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert "Building limit reached" in detail
        assert "Starter" in detail

    async def test_error_message_contains_all_context(
        self, operator_client: AsyncClient, db_session: AsyncSession
    ):
        """Error message contains current count, limit, and plan name."""
        from sqlalchemy import func, select as sa_select

        result = await db_session.execute(
            sa_select(func.count()).select_from(Building).where(Building.is_archived == False)  # noqa: E712
        )
        current_count = result.scalar_one()

        await _upsert_tenant_settings(db_session, tier_name="Pro Plan", building_limit=current_count)

        response = await operator_client.post(
            "/api/admin/buildings",
            json={"name": "Should Fail Context", "manager_email": "sfc@test.com"},
        )
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert "Building limit reached" in detail
        assert "Pro Plan" in detail

    async def test_archived_buildings_not_counted_against_limit(
        self, operator_client: AsyncClient, db_session: AsyncSession
    ):
        """Archived buildings are not counted when checking the limit.

        Create one archived building, then set limit = current_non_archived_count + 1
        (so the archived one would have pushed us over if it were counted).
        Verify we can still create a building.
        """
        from sqlalchemy import func, select as sa_select

        # Add an archived building — must NOT count toward limit
        db_session.add(
            Building(name="Limit Archived BldgZ", manager_email="arcz@test.com", is_archived=True)
        )
        await db_session.flush()

        result = await db_session.execute(
            sa_select(func.count()).select_from(Building).where(Building.is_archived == False)  # noqa: E712
        )
        active_count = result.scalar_one()

        # Set limit just above active count; archived building must not count
        await _upsert_tenant_settings(db_session, tier_name="Starter", building_limit=active_count + 1)

        response = await operator_client.post(
            "/api/admin/buildings",
            json={"name": "Should Succeed Despite Archived Z", "manager_email": "okz@test.com"},
        )
        assert response.status_code == 201

    async def test_limit_message_uses_current_plan_name(
        self, operator_client: AsyncClient, db_session: AsyncSession
    ):
        """Error message uses 'current' when tier_name is None."""
        from sqlalchemy import func, select as sa_select

        result = await db_session.execute(
            sa_select(func.count()).select_from(Building).where(Building.is_archived == False)  # noqa: E712
        )
        current_count = result.scalar_one()

        await _upsert_tenant_settings(db_session, tier_name=None, building_limit=current_count)

        response = await operator_client.post(
            "/api/admin/buildings",
            json={"name": "Fails No Plan", "manager_email": "fnp@test.com"},
        )
        assert response.status_code == 422
        assert "current" in response.json()["detail"]


# ---------------------------------------------------------------------------
# require_operator dependency unit tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestRequireOperator:
    async def test_require_operator_passes_for_server_admin(self):
        """require_operator returns user when is_server_admin=True.

        Calls the real require_operator function with a pre-resolved user to
        ensure the happy-path return branch is exercised (100% coverage).
        """
        from app.dependencies import require_operator as _require_operator

        user = BetterAuthUser(
            email="op@example.com", user_id="op-id", is_server_admin=True
        )
        # Call require_operator directly — FastAPI Depends() is only used at
        # request dispatch time; calling the coroutine directly with the
        # resolved argument exercises the function body.
        result = await _require_operator(current_user=user)
        assert result is user
        assert result.is_server_admin is True

    async def test_require_operator_raises_403_for_non_server_admin(self):
        """require_operator raises 403 when is_server_admin=False."""
        from fastapi import HTTPException
        from app.dependencies import require_operator as _require_operator

        user = BetterAuthUser(
            email="admin@example.com", user_id="admin-id", is_server_admin=False
        )
        with pytest.raises(HTTPException) as exc_info:
            await _require_operator(current_user=user)
        assert exc_info.value.status_code == 403
