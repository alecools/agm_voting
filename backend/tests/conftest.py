"""
Pytest configuration and fixtures for backend tests.

Uses the TEST_DATABASE_URL from environment (or a default) with isolated
transactions per test for complete isolation.

All async fixtures and tests run in a single session-scoped event loop so that
the asyncpg connection pool is not attached to a different loop than the tests.

When running with pytest-xdist (-n auto), each worker creates its own copy of
the test database (agm_test_gw0, agm_test_gw1, etc.) to avoid cross-worker
contention on the same schema.  When running without xdist (PYTEST_XDIST_WORKER
not set), the original agm_test DB is used as before.
"""
import csv
import io
import os
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

# US-IAS-05: Enable testing mode so the CSRF middleware is skipped in tests.
# This must be set BEFORE any app module is imported so the Settings singleton
# picks up the env var.  The CSRF middleware skips its check when testing_mode=True.
os.environ.setdefault("TESTING_MODE", "true")

import asyncpg
import openpyxl
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import (
    AsyncConnection,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.database import get_db
from app.models import Base, Building, LotOwner
from app.models.lot import Lot
from app.models.lot_person import lot_persons
from app.models.person import Person

# Use the test database URL from environment or fall back to default
_BASE_DATABASE_URL = os.getenv(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test",
)


def _worker_db_url() -> str:
    """Return a DB URL scoped to this xdist worker (or the base URL if no worker)."""
    worker_id = os.environ.get("PYTEST_XDIST_WORKER")
    if worker_id is None:
        # Not running under xdist — use the base test DB as before
        return _BASE_DATABASE_URL
    # Running under xdist — use a worker-specific DB name to avoid collisions
    db_name = f"agm_test_{worker_id}"
    base_without_db = _BASE_DATABASE_URL.rsplit("/", 1)[0]
    return f"{base_without_db}/{db_name}"


def _admin_url() -> str:
    """Return a URL to the postgres system DB (used for CREATE/DROP DATABASE)."""
    base_without_db = _BASE_DATABASE_URL.rsplit("/", 1)[0]
    return base_without_db + "/postgres"


def _plain_url(asyncpg_url: str) -> str:
    """Strip the +asyncpg driver suffix for plain asyncpg connections."""
    return asyncpg_url.replace("postgresql+asyncpg://", "postgresql://")


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def test_engine():
    """Create an async engine for the test session.

    When running under xdist, creates a per-worker copy of the test database
    (migrated via alembic) and drops it after the session.  When not under
    xdist, creates/drops tables using the base agm_test DB as before.
    """
    worker_id = os.environ.get("PYTEST_XDIST_WORKER")
    worker_url = _worker_db_url()

    if worker_id is not None:
        # --- xdist mode: create a fresh per-worker database ---
        db_name = f"agm_test_{worker_id}"
        admin_url = _plain_url(_admin_url())

        # Create the worker DB (connect to postgres to issue CREATE DATABASE)
        conn = await asyncpg.connect(admin_url)
        try:
            await conn.execute(f'DROP DATABASE IF EXISTS "{db_name}"')
            await conn.execute(f'CREATE DATABASE "{db_name}"')
        finally:
            await conn.close()

        # Run alembic migrations against the worker DB
        import subprocess, sys  # noqa: E401
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "alembic",
                "-x",
                f"dburl={worker_url}",
                "upgrade",
                "head",
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:  # pragma: no cover — only fails if migrations are broken
            raise RuntimeError(
                f"Alembic migration failed for {db_name}:\n{result.stderr}"
            )

        engine = create_async_engine(worker_url, echo=False, future=True)
        yield engine
        await engine.dispose()

        # Drop the per-worker DB after the session
        conn = await asyncpg.connect(admin_url)
        try:
            await conn.execute(f'DROP DATABASE IF EXISTS "{db_name}"')
        finally:
            await conn.close()
    else:
        # --- Non-xdist mode: use metadata create_all as before ---
        engine = create_async_engine(
            worker_url,
            echo=False,
            future=True,
        )
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        yield engine
        await engine.dispose()


@pytest_asyncio.fixture(loop_scope="session")
async def db_conn(test_engine) -> AsyncGenerator[AsyncConnection, None]:
    """
    Provide a connection with a savepoint so each test can roll back
    to a clean state without recreating tables.
    """
    async with test_engine.connect() as conn:
        await conn.begin()
        await conn.begin_nested()
        yield conn
        await conn.rollback()


@pytest_asyncio.fixture(loop_scope="session")
async def db_session(db_conn: AsyncConnection) -> AsyncGenerator[AsyncSession, None]:
    """
    Provide an AsyncSession bound to the per-test connection so that
    all DB operations in a test share the same transaction.
    """
    session_factory = async_sessionmaker(
        bind=db_conn,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    async with session_factory() as session:
        yield session


@pytest.fixture(autouse=True)
def reset_rate_limiters():
    """Reset all in-memory rate limiters before each test (RR3-33, RR4-31).

    The rate limiters are module-level singletons. Without a reset, tests that
    call the same endpoint multiple times could accidentally trigger 429 responses
    and fail, or interfere with each other when running in parallel.
    """
    from app.rate_limiter import (
        admin_close_limiter,
        admin_import_limiter,
        admin_invite_limiter,
        ballot_submit_limiter,
        provision_limiter,
        public_limiter,
        sms_test_rate_limiter,
        smtp_test_rate_limiter,
    )
    ballot_submit_limiter._timestamps.clear()
    public_limiter._timestamps.clear()
    admin_import_limiter._timestamps.clear()
    admin_close_limiter._timestamps.clear()
    admin_invite_limiter._timestamps.clear()
    smtp_test_rate_limiter.reset("smtp_test")
    sms_test_rate_limiter.reset("sms_test")
    provision_limiter._timestamps.clear()
    yield
    ballot_submit_limiter._timestamps.clear()
    public_limiter._timestamps.clear()
    admin_import_limiter._timestamps.clear()
    admin_close_limiter._timestamps.clear()
    admin_invite_limiter._timestamps.clear()
    smtp_test_rate_limiter.reset("smtp_test")
    sms_test_rate_limiter.reset("sms_test")
    provision_limiter._timestamps.clear()


@pytest.fixture(autouse=True)
def reset_config_cache():
    """Reset the module-level tenant config cache before and after each test.

    The cache is a module-level singleton.  Without a reset, a cached value from
    one test leaks into the next test and causes stale-data assertion failures.
    """
    from app.services import config_service
    config_service._config_cache.config = None
    config_service._config_cache.cached_at = None
    yield
    config_service._config_cache.config = None
    config_service._config_cache.cached_at = None


@pytest.fixture(autouse=True)
def patch_parallel_lot_lookup(db_session: AsyncSession):
    """Patch the parallel lot-lookup helpers in auth_service to use the test session.

    _load_direct_lot_owner_ids and _load_proxy_lot_owner_ids use AsyncSessionLocal()
    to open separate sessions for concurrent execution.  In tests the test data is
    only flushed (not committed) inside db_session's transaction, so a separate
    connection would see no data.  Patching both helpers to run their queries on
    db_session ensures they see the same test data as the rest of the test suite.
    """
    import uuid
    from unittest.mock import patch
    from sqlalchemy import select
    from app.models.lot import Lot
    from app.models.lot_person import lot_persons as _lot_persons
    from app.models.lot_proxy import LotProxy
    from app.models.person import Person

    async def _direct_ids_via_test_session(voter_email: str, building_id: uuid.UUID) -> set[uuid.UUID]:
        r = await db_session.execute(
            select(_lot_persons.c.lot_id)
            .join(Person, Person.id == _lot_persons.c.person_id)
            .join(Lot, Lot.id == _lot_persons.c.lot_id)
            .where(
                Person.email.isnot(None),
                Person.email == voter_email,
                Lot.building_id == building_id,
            )
        )
        return {row[0] for row in r.all()}

    async def _proxy_ids_via_test_session(voter_email: str, building_id: uuid.UUID) -> set[uuid.UUID]:
        r = await db_session.execute(
            select(LotProxy.lot_id)
            .join(Person, Person.id == LotProxy.person_id)
            .join(Lot, Lot.id == LotProxy.lot_id)
            .where(
                Person.email == voter_email,
                Lot.building_id == building_id,
            )
        )
        return {row[0] for row in r.all()}

    with patch(
        "app.routers.auth._load_direct_lot_owner_ids",
        side_effect=_direct_ids_via_test_session,
    ), patch(
        "app.routers.auth._load_proxy_lot_owner_ids",
        side_effect=_proxy_ids_via_test_session,
    ), patch(
        "app.routers.voting._load_direct_lot_owner_ids",
        side_effect=_direct_ids_via_test_session,
    ), patch(
        "app.routers.voting._load_proxy_lot_owner_ids",
        side_effect=_proxy_ids_via_test_session,
    ):
        yield


@pytest.fixture
def app(db_session: AsyncSession):
    """
    Create a FastAPI app instance with the get_db dependency overridden to use
    the test session so all HTTP requests share the same transaction.
    Also bypasses admin authentication so tests do not need to log in.
    """
    from app.main import create_app
    from app.dependencies import require_admin, BetterAuthUser

    application = create_app()

    async def override_get_db():
        yield db_session

    async def override_require_admin():
        return BetterAuthUser(email="test-admin@example.com", user_id="test-user-id")

    application.dependency_overrides[get_db] = override_get_db
    application.dependency_overrides[require_admin] = override_require_admin
    yield application
    application.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Shared test helpers — used by multiple admin test modules
# ---------------------------------------------------------------------------


def make_csv(headers: list[str], rows: list[list[str]]) -> bytes:
    """Build a CSV file as bytes from a header row and data rows."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(headers)
    for row in rows:
        writer.writerow(row)
    return buf.getvalue().encode()


def make_excel(headers: list, rows: list[list]) -> bytes:
    """Build an xlsx file as bytes from a header row and data rows."""
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
    """Return a past meeting_at so meetings are effectively open (not pending)."""
    return datetime.now(UTC) - timedelta(hours=1)


def closing_dt() -> datetime:
    return datetime.now(UTC) + timedelta(days=2)


# ---------------------------------------------------------------------------
# Shared DB fixtures — used by multiple admin test modules
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def client(app):
    """HTTP client that shares the test db_session with the app (via conftest app fixture).

    Includes X-Requested-With header by default so all tests pass the CSRF check
    (US-IAS-05 CSRFMiddleware requires this header on state-changing requests).
    """
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Requested-With": "XMLHttpRequest"},
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
    lo1 = Lot(
        building_id=b.id,
        lot_number="1A",
        unit_entitlement=100,
    )
    lo2 = Lot(
        building_id=b.id,
        lot_number="2B",
        unit_entitlement=50,
    )
    db_session.add_all([lo1, lo2])
    await db_session.flush()
    p1 = Person(email="voter1@test.com")
    p2 = Person(email="voter2@test.com")
    db_session.add_all([p1, p2])
    await db_session.flush()
    await db_session.execute(
        lot_persons.insert().values([
            {"lot_id": lo1.id, "person_id": p1.id},
            {"lot_id": lo2.id, "person_id": p2.id},
        ])
    )
    await db_session.flush()
    await db_session.refresh(b)
    return b


async def add_person_to_lot(
    db_session: AsyncSession,
    lot: "Lot",
    email: str,
    given_name: str | None = None,
    surname: str | None = None,
    phone_number: str | None = None,
) -> Person:
    """Create (or reuse) a Person and link them to a Lot via lot_persons.

    If a Person with the given email already exists in the session, it is reused.
    This helper is used throughout tests wherever old code used LotOwnerEmail.
    """
    from sqlalchemy import select as _select

    existing = (await db_session.execute(
        _select(Person).where(Person.email == email)
    )).scalar_one_or_none()

    if existing is None:
        person = Person(
            email=email,
            given_name=given_name,
            surname=surname,
            phone_number=phone_number,
        )
        db_session.add(person)
        await db_session.flush()
    else:
        person = existing

    # Insert lot_persons link (ignore if already exists)
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    await db_session.execute(
        pg_insert(lot_persons).values(lot_id=lot.id, person_id=person.id).on_conflict_do_nothing()
    )
    await db_session.flush()
    return person


async def get_or_create_person(
    db_session: AsyncSession,
    email: str,
    given_name: str | None = None,
    surname: str | None = None,
    phone_number: str | None = None,
) -> Person:
    """Create (or reuse) a Person row without adding any lot_persons link.

    Used when setting up LotProxy fixtures where the person is a proxy
    (not a direct lot owner).
    """
    from sqlalchemy import select as _select

    existing = (await db_session.execute(
        _select(Person).where(Person.email == email)
    )).scalar_one_or_none()

    if existing is not None:
        return existing

    person = Person(
        email=email,
        given_name=given_name,
        surname=surname,
        phone_number=phone_number,
    )
    db_session.add(person)
    await db_session.flush()
    return person
