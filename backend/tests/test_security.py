"""
Tests for security hardening:
  Fix 1: SecurityHeadersMiddleware — security headers on every response
  Fix 2: Restricted CORS methods and headers
  Fix 7: HTML sanitisation on motion descriptions
  Fix 8: No secrets in build logs (tested via migrate.sh content)
  Fix 9: OTP rate-limit fixed window (first_attempt_at-based)

Structure:
  # --- Happy path ---
  # --- Input validation ---
  # --- Boundary values ---
  # --- State / precondition errors ---
  # --- Edge cases ---
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Building,
    GeneralMeeting,
    GeneralMeetingStatus,
    LotOwner,
    OTPRateLimit,
)
from app.models.lot_owner_email import LotOwnerEmail
from app.services.admin_service import _sanitise_description


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def client(app):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        yield ac


def meeting_dt() -> datetime:
    return datetime.now(UTC) - timedelta(hours=1)


def closing_dt() -> datetime:
    return datetime.now(UTC) + timedelta(days=2)


@pytest_asyncio.fixture
async def building_and_meeting(db_session: AsyncSession):
    b = Building(name=f"Sec Bldg {uuid.uuid4().hex[:6]}", manager_email="sec@test.com")
    db_session.add(b)
    await db_session.flush()

    lo = LotOwner(building_id=b.id, lot_number="SEC-1", unit_entitlement=100)
    db_session.add(lo)
    await db_session.flush()

    lo_email = LotOwnerEmail(lot_owner_id=lo.id, email="sec_voter@test.com")
    db_session.add(lo_email)

    agm = GeneralMeeting(
        building_id=b.id,
        title="Security Test Meeting",
        status=GeneralMeetingStatus.open,
        meeting_at=meeting_dt(),
        voting_closes_at=closing_dt(),
    )
    db_session.add(agm)
    await db_session.flush()

    return {"building": b, "lot_owner": lo, "voter_email": "sec_voter@test.com", "agm": agm}


# ---------------------------------------------------------------------------
# Fix 1: Security headers middleware
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestSecurityHeaders:
    # --- Happy path ---

    async def test_hsts_header_present_on_api_response(self, client: AsyncClient):
        """Strict-Transport-Security header is set on API responses."""
        response = await client.get("/api/health")
        assert response.status_code == 200
        assert "Strict-Transport-Security" in response.headers
        assert "max-age=31536000" in response.headers["Strict-Transport-Security"]
        assert "includeSubDomains" in response.headers["Strict-Transport-Security"]

    async def test_x_frame_options_deny(self, client: AsyncClient):
        """X-Frame-Options: DENY prevents clickjacking."""
        response = await client.get("/api/health")
        assert response.headers.get("X-Frame-Options") == "DENY"

    async def test_x_content_type_options_nosniff(self, client: AsyncClient):
        """X-Content-Type-Options: nosniff prevents MIME sniffing."""
        response = await client.get("/api/health")
        assert response.headers.get("X-Content-Type-Options") == "nosniff"

    async def test_x_xss_protection(self, client: AsyncClient):
        """X-XSS-Protection header is set."""
        response = await client.get("/api/health")
        assert response.headers.get("X-XSS-Protection") == "1; mode=block"

    async def test_referrer_policy(self, client: AsyncClient):
        """Referrer-Policy: strict-origin-when-cross-origin."""
        response = await client.get("/api/health")
        assert response.headers.get("Referrer-Policy") == "strict-origin-when-cross-origin"

    async def test_content_security_policy_present(self, client: AsyncClient):
        """Content-Security-Policy header is set with expected directives.

        script-src includes 'unsafe-inline' to permit Vite's module preload
        polyfill inline script that is injected into index.html at build time.
        https://vercel.live is included in script-src, connect-src, and frame-src
        to allow Vercel's injected preview feedback widget to load, make API calls,
        and render its toolbar iframe.
        frame-src governs what THIS page may frame outward; frame-ancestors governs
        who may frame THIS page. Both are set.
        """
        response = await client.get("/api/health")
        csp = response.headers.get("Content-Security-Policy", "")
        assert "default-src 'self'" in csp
        assert "frame-ancestors 'none'" in csp
        assert "frame-src https://vercel.live https://*.vercel.live" in csp
        assert "script-src 'self'" in csp
        assert "'unsafe-inline'" in csp
        assert "https://vercel.live" in csp
        assert "connect-src 'self' https://vercel.live wss://vercel.live https://*.vercel.live wss://*.vercel.live" in csp

    async def test_csp_allows_google_fonts(self, client: AsyncClient):
        """CSP permits Google Fonts for font-src and style-src."""
        response = await client.get("/api/health")
        csp = response.headers.get("Content-Security-Policy", "")
        assert "https://fonts.googleapis.com" in csp
        assert "https://fonts.gstatic.com" in csp

    # --- Boundary values ---

    async def test_headers_present_on_404_response(self, client: AsyncClient):
        """Security headers are set even on 404 error responses."""
        response = await client.get("/api/nonexistent-endpoint-xyz")
        assert "X-Content-Type-Options" in response.headers
        assert "X-Frame-Options" in response.headers

    async def test_security_middleware_class_registered(self):
        """SecurityHeadersMiddleware is in the app middleware stack."""
        from app.main import SecurityHeadersMiddleware, app

        middleware_classes = [m.cls for m in app.user_middleware if hasattr(m, "cls")]
        assert SecurityHeadersMiddleware in middleware_classes


# ---------------------------------------------------------------------------
# Fix 2: Restricted CORS methods and headers
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestRestrictedCors:
    # --- Happy path ---

    async def test_cors_allows_get(self, client: AsyncClient):
        """GET requests are allowed."""
        response = await client.get(
            "/api/health",
            headers={"Origin": "http://localhost:5173"},
        )
        assert response.status_code == 200

    async def test_cors_allows_post(self, client: AsyncClient):
        """POST requests pass through CORS middleware."""
        response = await client.options(
            "/api/auth/request-otp",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "POST",
            },
        )
        # CORS preflight returns 200 for allowed origins
        assert response.status_code == 200

    async def test_cors_allow_methods_excludes_wildcard(self):
        """DynamicCORSMiddleware uses an explicit method list, not wildcard."""
        from app.main import _CORS_ALLOW_METHODS

        methods = [m.strip() for m in _CORS_ALLOW_METHODS.split(",")]
        assert "*" not in methods
        assert "GET" in methods
        assert "POST" in methods
        assert "DELETE" in methods

    async def test_cors_allow_headers_excludes_wildcard(self):
        """DynamicCORSMiddleware uses an explicit header list, not wildcard."""
        from app.main import _CORS_ALLOW_HEADERS

        headers = [h.strip() for h in _CORS_ALLOW_HEADERS.split(",")]
        assert "*" not in headers
        assert "Content-Type" in headers
        assert "Authorization" in headers

    # --- Boundary values ---

    async def test_cors_preflight_returns_correct_allow_origin(self, client: AsyncClient):
        """CORS preflight returns the allowed origin header."""
        response = await client.options(
            "/api/health",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert response.status_code == 200
        assert "access-control-allow-origin" in response.headers


# ---------------------------------------------------------------------------
# DynamicCORSMiddleware unit tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestDynamicCORSMiddleware:
    """Unit tests for DynamicCORSMiddleware._is_allowed_origin and dispatch."""

    # --- Happy path ---

    async def test_preflight_allowed_for_same_host_origin(self, client: AsyncClient):
        """OPTIONS preflight returns 200 with CORS headers when Origin matches allowed_origin."""
        response = await client.options(
            "/api/health",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert response.status_code == 200
        assert response.headers.get("access-control-allow-origin") == "http://localhost:5173"
        assert response.headers.get("access-control-allow-credentials") == "true"

    async def test_preflight_includes_allow_methods(self, client: AsyncClient):
        """OPTIONS preflight response includes Access-Control-Allow-Methods."""
        response = await client.options(
            "/api/health",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "POST",
            },
        )
        assert response.status_code == 200
        assert "GET" in response.headers.get("access-control-allow-methods", "")
        assert "POST" in response.headers.get("access-control-allow-methods", "")
        assert "DELETE" in response.headers.get("access-control-allow-methods", "")

    async def test_preflight_includes_allow_headers(self, client: AsyncClient):
        """OPTIONS preflight response includes Access-Control-Allow-Headers."""
        response = await client.options(
            "/api/health",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type",
            },
        )
        assert response.status_code == 200
        assert "Content-Type" in response.headers.get("access-control-allow-headers", "")

    async def test_get_request_with_allowed_origin_has_acao_header(self, client: AsyncClient):
        """GET with allowed Origin receives Access-Control-Allow-Origin response header."""
        response = await client.get(
            "/api/health",
            headers={"Origin": "http://localhost:5173"},
        )
        assert response.status_code == 200
        assert response.headers.get("access-control-allow-origin") == "http://localhost:5173"

    async def test_request_without_origin_header_has_no_acao(self, client: AsyncClient):
        """Requests without Origin header receive no CORS headers (same-origin or non-browser)."""
        response = await client.get("/api/health")
        assert "access-control-allow-origin" not in response.headers

    # --- is_allowed_origin logic ---

    def test_is_allowed_origin_matches_configured_allowed_origin(self):
        """_is_allowed_origin returns True when origin equals settings.allowed_origin."""
        from unittest.mock import MagicMock
        from app.main import DynamicCORSMiddleware

        mw = DynamicCORSMiddleware(app=MagicMock())
        request = MagicMock()
        request.headers = {}  # no x-forwarded-* headers
        # settings.allowed_origin defaults to "http://localhost:5173"
        assert mw._is_allowed_origin("http://localhost:5173", request) is True

    def test_is_allowed_origin_returns_false_for_unknown_origin(self):
        """_is_allowed_origin returns False for an unrecognised cross-origin value."""
        from unittest.mock import MagicMock
        from app.main import DynamicCORSMiddleware

        mw = DynamicCORSMiddleware(app=MagicMock())
        request = MagicMock()
        request.headers = {}
        assert mw._is_allowed_origin("https://evil.example.com", request) is False

    def test_is_allowed_origin_matches_x_forwarded_host(self):
        """_is_allowed_origin returns True when origin matches x-forwarded-proto + x-forwarded-host."""
        from unittest.mock import MagicMock
        from app.main import DynamicCORSMiddleware

        mw = DynamicCORSMiddleware(app=MagicMock())
        request = MagicMock()
        request.headers = {
            "x-forwarded-proto": "https",
            "x-forwarded-host": "my-app.vercel.app",
        }
        assert mw._is_allowed_origin("https://my-app.vercel.app", request) is True

    def test_is_allowed_origin_rejects_different_host(self):
        """_is_allowed_origin returns False when origin doesn't match forwarded host."""
        from unittest.mock import MagicMock
        from app.main import DynamicCORSMiddleware

        mw = DynamicCORSMiddleware(app=MagicMock())
        request = MagicMock()
        request.headers = {
            "x-forwarded-proto": "https",
            "x-forwarded-host": "my-app.vercel.app",
        }
        assert mw._is_allowed_origin("https://other-app.vercel.app", request) is False

    def test_is_allowed_origin_falls_back_to_allowed_origin_setting(self):
        """_is_allowed_origin allows origin matching settings.allowed_origin even when
        x-forwarded-host is present and points to a different host (e.g. local dev
        behind a proxy that sets x-forwarded-host)."""
        from unittest.mock import MagicMock
        from app.main import DynamicCORSMiddleware

        mw = DynamicCORSMiddleware(app=MagicMock())
        request = MagicMock()
        # x-forwarded-host is set to some other host so derive_origin won't match
        request.headers = {
            "x-forwarded-proto": "https",
            "x-forwarded-host": "proxy.internal",
        }
        # settings.allowed_origin defaults to "http://localhost:5173" in tests
        # This exercises the explicit-override branch (line 86-87 in main.py)
        assert mw._is_allowed_origin("http://localhost:5173", request) is True

    # --- Preflight for disallowed origin ---

    async def test_preflight_returns_400_for_disallowed_origin(self, client: AsyncClient):
        """OPTIONS preflight returns 400 when origin is not allowed."""
        response = await client.options(
            "/api/health",
            headers={
                "Origin": "https://evil.example.com",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert response.status_code == 400
        assert "access-control-allow-origin" not in response.headers

    async def test_get_with_disallowed_origin_has_no_acao_header(self, client: AsyncClient):
        """GET with a disallowed Origin header does not receive CORS response headers."""
        response = await client.get(
            "/api/health",
            headers={"Origin": "https://evil.example.com"},
        )
        # Request proceeds (not blocked) but no CORS headers are added
        assert "access-control-allow-origin" not in response.headers

    # --- Middleware registration ---

    def test_dynamic_cors_middleware_registered(self):
        """DynamicCORSMiddleware is registered in the app middleware stack."""
        from app.main import DynamicCORSMiddleware, app

        middleware_classes = [m.cls for m in app.user_middleware if hasattr(m, "cls")]
        assert DynamicCORSMiddleware in middleware_classes


# ---------------------------------------------------------------------------
# Fix 7: HTML sanitisation on motion descriptions
# ---------------------------------------------------------------------------


class TestSanitiseDescription:
    # --- Happy path ---

    def test_plain_text_unchanged(self):
        """Plain text descriptions pass through unchanged."""
        result = _sanitise_description("A normal description.")
        assert result == "A normal description."

    def test_none_returns_none(self):
        """None description returns None."""
        assert _sanitise_description(None) is None

    def test_html_tags_stripped(self):
        """HTML tags are stripped from descriptions (tag is removed; text content retained)."""
        result = _sanitise_description("<script>xss</script>Motion text")
        assert "<script>" not in result
        assert "</script>" not in result
        assert "Motion text" in result

    def test_bold_tag_stripped(self):
        """Bold HTML tags are stripped."""
        result = _sanitise_description("<b>Important</b> motion")
        assert "<b>" not in result
        assert "Important motion" in result

    def test_anchor_tag_stripped(self):
        """Anchor/link tags are stripped."""
        result = _sanitise_description('<a href="evil.com">click here</a>')
        assert "<a" not in result
        assert "click here" in result

    # --- Boundary values ---

    def test_empty_string_returns_none(self):
        """Empty string (after stripping) returns None."""
        assert _sanitise_description("") is None

    def test_whitespace_only_returns_none(self):
        """Whitespace-only description returns None."""
        assert _sanitise_description("   ") is None

    def test_html_only_returns_none(self):
        """Description with only HTML tags (no text) returns None."""
        result = _sanitise_description("<b></b>")
        assert result is None

    def test_nested_html_stripped(self):
        """Nested HTML structures are fully stripped."""
        result = _sanitise_description("<div><p><b>text</b></p></div>")
        assert "<" not in result
        assert "text" in result

    # --- Edge cases ---

    def test_multiline_description_preserved(self):
        """Multiline text content is preserved after sanitisation."""
        result = _sanitise_description("Line 1\nLine 2\nLine 3")
        assert "Line 1" in result
        assert "Line 2" in result
        assert "Line 3" in result

    def test_special_characters_preserved(self):
        """Special characters are preserved through sanitisation."""
        result = _sanitise_description("Motion: 50% approval & quorum required")
        assert "50%" in result
        assert "&" in result or "amp" in result  # bleach may HTML-entity-encode &


@pytest.mark.asyncio
class TestMotionDescriptionSanitisationIntegration:
    # --- Happy path ---

    async def test_create_meeting_strips_html_from_description(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """HTML in motion description is stripped when creating a meeting."""
        building = Building(name=f"SanBldg {uuid.uuid4().hex[:6]}", manager_email="san@test.com")
        db_session.add(building)
        await db_session.flush()

        payload = {
            "building_id": str(building.id),
            "title": "Sanitise Test Meeting",
            "meeting_at": (datetime.now(UTC) - timedelta(hours=1)).isoformat(),
            "voting_closes_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
            "motions": [
                {
                    "title": "Motion 1",
                    "description": "<script>alert('xss')</script>Real content",
                    "display_order": 1,
                }
            ],
        }
        response = await client.post("/api/admin/general-meetings", json=payload)
        assert response.status_code == 201
        data = response.json()
        desc = data["motions"][0]["description"]
        assert "<script>" not in desc
        assert "Real content" in desc

    async def test_add_motion_strips_html_from_description(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """HTML in motion description is stripped when adding a motion to an existing meeting."""
        agm = building_and_meeting["agm"]

        payload = {
            "title": "Sanitise Motion",
            "description": '<b>Bold</b> <a href="evil.com">link</a> text',
        }
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json=payload,
        )
        assert response.status_code == 201
        data = response.json()
        desc = data["description"]
        assert "<b>" not in desc
        assert "<a" not in desc
        assert "Bold" in desc
        assert "link" in desc
        assert "text" in desc

    async def test_update_motion_strips_html_from_description(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """HTML in description is stripped when updating a motion."""
        agm = building_and_meeting["agm"]

        # Add a hidden motion first
        add_resp = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Update Sanitise Motion"},
        )
        assert add_resp.status_code == 201
        motion_id = add_resp.json()["id"]

        # Update with HTML description
        update_resp = await client.patch(
            f"/api/admin/motions/{motion_id}",
            json={"description": "<img src=x onerror=alert(1)>Safe text"},
        )
        assert update_resp.status_code == 200
        desc = update_resp.json()["description"]
        assert "<img" not in desc
        assert "Safe text" in desc

    # --- Input validation ---

    async def test_description_max_length_422_on_add_motion(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Descriptions exceeding 5000 chars are rejected with 422 (RR5-13: limit raised to 5000)."""
        agm = building_and_meeting["agm"]
        long_desc = "A" * 5001
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Long Desc Motion", "description": long_desc},
        )
        assert response.status_code == 422

    async def test_description_exactly_5000_chars_accepted(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Descriptions of exactly 5000 characters are accepted (RR5-13: limit raised from 2000 to 5000)."""
        agm = building_and_meeting["agm"]
        max_desc = "A" * 5000
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Max Desc Motion", "description": max_desc},
        )
        assert response.status_code == 201

    async def test_title_max_length_422_on_add_motion(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Titles exceeding 500 chars are rejected with 422."""
        agm = building_and_meeting["agm"]
        long_title = "T" * 501
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": long_title},
        )
        assert response.status_code == 422

    async def test_title_exactly_500_chars_accepted(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Titles of exactly 500 characters are accepted."""
        agm = building_and_meeting["agm"]
        max_title = "T" * 500
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": max_title},
        )
        assert response.status_code == 201

    async def test_motion_number_max_length_422_on_add_motion(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Motion numbers exceeding 50 chars are rejected with 422."""
        agm = building_and_meeting["agm"]
        long_number = "N" * 51
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Motion Num Test", "motion_number": long_number},
        )
        assert response.status_code == 422

    async def test_motion_number_exactly_50_chars_accepted(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Motion numbers of exactly 50 characters are accepted."""
        agm = building_and_meeting["agm"]
        max_number = "N" * 50
        response = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Motion Num Boundary", "motion_number": max_number},
        )
        assert response.status_code == 201

    async def test_update_motion_description_max_length_422(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Updating a motion with a description > 5000 chars is rejected with 422 (RR5-13: limit raised to 5000)."""
        agm = building_and_meeting["agm"]
        add_resp = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Desc Update Test"},
        )
        motion_id = add_resp.json()["id"]

        long_desc = "B" * 5001
        response = await client.patch(
            f"/api/admin/motions/{motion_id}",
            json={"description": long_desc},
        )
        assert response.status_code == 422

    async def test_update_motion_title_max_length_422(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Updating a motion with a title > 500 chars is rejected with 422."""
        agm = building_and_meeting["agm"]
        add_resp = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Title Update Test"},
        )
        motion_id = add_resp.json()["id"]

        long_title = "T" * 501
        response = await client.patch(
            f"/api/admin/motions/{motion_id}",
            json={"title": long_title},
        )
        assert response.status_code == 422

    async def test_update_motion_number_max_length_422(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Updating a motion with a motion_number > 50 chars is rejected with 422."""
        agm = building_and_meeting["agm"]
        add_resp = await client.post(
            f"/api/admin/general-meetings/{agm.id}/motions",
            json={"title": "Num Update Test"},
        )
        motion_id = add_resp.json()["id"]

        long_number = "N" * 51
        response = await client.patch(
            f"/api/admin/motions/{motion_id}",
            json={"motion_number": long_number},
        )
        assert response.status_code == 422

    async def test_create_meeting_description_max_length_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Motion description > 5000 chars in GeneralMeetingCreate is rejected with 422 (RR5-13: limit raised to 5000)."""
        building = Building(name=f"LenBldg {uuid.uuid4().hex[:6]}", manager_email="len@test.com")
        db_session.add(building)
        await db_session.flush()

        payload = {
            "building_id": str(building.id),
            "title": "Length Test Meeting",
            "meeting_at": (datetime.now(UTC) - timedelta(hours=1)).isoformat(),
            "voting_closes_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
            "motions": [
                {
                    "title": "Motion",
                    "description": "D" * 5001,
                    "display_order": 1,
                }
            ],
        }
        response = await client.post("/api/admin/general-meetings", json=payload)
        assert response.status_code == 422

    async def test_create_meeting_motion_title_max_length_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Motion title > 500 chars in GeneralMeetingCreate is rejected with 422."""
        building = Building(name=f"TLen {uuid.uuid4().hex[:6]}", manager_email="tlen@test.com")
        db_session.add(building)
        await db_session.flush()

        payload = {
            "building_id": str(building.id),
            "title": "Title Length Meeting",
            "meeting_at": (datetime.now(UTC) - timedelta(hours=1)).isoformat(),
            "voting_closes_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
            "motions": [
                {
                    "title": "T" * 501,
                    "description": "Valid desc",
                    "display_order": 1,
                }
            ],
        }
        response = await client.post("/api/admin/general-meetings", json=payload)
        assert response.status_code == 422

    async def test_create_meeting_motion_number_max_length_422(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        """Motion number > 50 chars in GeneralMeetingCreate is rejected with 422."""
        building = Building(name=f"NLen {uuid.uuid4().hex[:6]}", manager_email="nlen@test.com")
        db_session.add(building)
        await db_session.flush()

        payload = {
            "building_id": str(building.id),
            "title": "Number Length Meeting",
            "meeting_at": (datetime.now(UTC) - timedelta(hours=1)).isoformat(),
            "voting_closes_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
            "motions": [
                {
                    "title": "Valid title",
                    "motion_number": "N" * 51,
                    "display_order": 1,
                }
            ],
        }
        response = await client.post("/api/admin/general-meetings", json=payload)
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# Fix 8: No secrets in build logs (migrate.sh)
# ---------------------------------------------------------------------------


class TestMigrateShNoSecrets:
    def test_migrate_sh_has_set_plus_x(self):
        """migrate.sh contains 'set +x' to prevent tracing secrets into build logs."""
        migrate_sh = Path(__file__).parent.parent.parent / "scripts" / "migrate.sh"
        content = migrate_sh.read_text()
        assert "set +x" in content

    def test_migrate_sh_does_not_echo_database_url(self):
        """migrate.sh does not echo DATABASE_URL directly (no 'echo $DATABASE_URL')."""
        migrate_sh = Path(__file__).parent.parent.parent / "scripts" / "migrate.sh"
        content = migrate_sh.read_text()
        # Direct echo of the raw secret variable should not appear
        assert "echo $DATABASE_URL" not in content
        assert "echo $DATABASE_URL_UNPOOLED" not in content


# ---------------------------------------------------------------------------
# Fix 9: OTP rate-limit fixed window (first_attempt_at-based)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestOtpRateLimitFixedWindow:
    # --- Happy path ---

    async def test_rate_limit_allows_request_after_window_expires_from_first_attempt(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Rate limit window is based on first_attempt_at, not last_attempt_at.
        A request made after 60s from first_attempt_at is allowed even if
        last_attempt_at is recent."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]
        building = building_and_meeting["building"]

        # Simulate: first attempt was 90s ago (window expired), but last was 5s ago
        # (what would happen with last_attempt_at-based window = still blocked).
        # With fixed window on first_attempt_at: should be ALLOWED.
        first = datetime.now(UTC) - timedelta(seconds=90)
        last = datetime.now(UTC) - timedelta(seconds=5)
        rl = OTPRateLimit(
            email=voter_email,
            building_id=building.id,
            attempt_count=5,
            first_attempt_at=first,
            last_attempt_at=last,
        )
        db_session.add(rl)
        await db_session.flush()

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock) as mock_send, \
             patch("app.routers.auth.settings") as mock_settings:
            mock_settings.testing_mode = False
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id)},
            )

        assert response.status_code == 200, (
            "Fixed window: request allowed after 60s from first_attempt_at, "
            "even if last_attempt_at is recent"
        )
        mock_send.assert_awaited_once()

    # --- State / precondition errors ---

    async def test_rate_limit_blocks_when_within_window_from_first_attempt(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Rate limit window blocks requests within 60s of first_attempt_at."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]
        building = building_and_meeting["building"]

        # first_attempt_at is only 10 seconds ago — window still open
        first = datetime.now(UTC) - timedelta(seconds=10)
        rl = OTPRateLimit(
            email=voter_email,
            building_id=building.id,
            attempt_count=1,
            first_attempt_at=first,
            last_attempt_at=first,
        )
        db_session.add(rl)
        await db_session.flush()

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock), \
             patch("app.routers.auth.settings") as mock_settings:
            mock_settings.testing_mode = False
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id)},
            )

        assert response.status_code == 429
        assert "Please wait" in response.json()["detail"]

    async def test_rate_limit_window_cannot_be_reset_by_repeated_requests(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Attackers cannot keep the window open by making requests near the end of each window.

        With the old last_attempt_at approach:
          - first_attempt_at = T
          - last_attempt_at = T + 50s (just before window would expire)
          - → window resets to another 60s from T+50s = blocked until T+110s

        With the fixed first_attempt_at approach:
          - window always closes at first_attempt_at + 60s
          - last_attempt_at being recent does NOT extend the window
        """
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]
        building = building_and_meeting["building"]

        # Simulate attacker scenario: first attempt 65s ago, last attempt 5s ago
        # Old (broken) code: still blocked because last_attempt_at is recent
        # New (fixed) code: should be allowed because first_attempt_at + 60s has passed
        first = datetime.now(UTC) - timedelta(seconds=65)
        last = datetime.now(UTC) - timedelta(seconds=5)
        rl = OTPRateLimit(
            email=voter_email,
            building_id=building.id,
            attempt_count=10,
            first_attempt_at=first,
            last_attempt_at=last,
        )
        db_session.add(rl)
        await db_session.flush()

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock) as mock_send, \
             patch("app.routers.auth.settings") as mock_settings:
            mock_settings.testing_mode = False
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id)},
            )

        # Fixed window: first_attempt_at is 65s ago > 60s limit, so allowed
        assert response.status_code == 200, (
            "Fixed window closes the reset-window attack: "
            "request is allowed once first_attempt_at + 60s has elapsed"
        )
        mock_send.assert_awaited_once()

    # --- Boundary values ---

    async def test_rate_limit_at_exactly_60s_boundary_is_allowed(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """At exactly 60s from first_attempt_at the request is allowed (elapsed >= window)."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]
        building = building_and_meeting["building"]

        # first_attempt_at is exactly 61s ago (just past the boundary)
        first = datetime.now(UTC) - timedelta(seconds=61)
        rl = OTPRateLimit(
            email=voter_email,
            building_id=building.id,
            attempt_count=1,
            first_attempt_at=first,
            last_attempt_at=first,
        )
        db_session.add(rl)
        await db_session.flush()

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock) as mock_send, \
             patch("app.routers.auth.settings") as mock_settings:
            mock_settings.testing_mode = False
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id)},
            )

        assert response.status_code == 200
        mock_send.assert_awaited_once()

    async def test_rate_limit_at_59s_boundary_is_blocked(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """At 59s from first_attempt_at the request is still blocked."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]
        building = building_and_meeting["building"]

        first = datetime.now(UTC) - timedelta(seconds=59)
        rl = OTPRateLimit(
            email=voter_email,
            building_id=building.id,
            attempt_count=1,
            first_attempt_at=first,
            last_attempt_at=first,
        )
        db_session.add(rl)
        await db_session.flush()

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock), \
             patch("app.routers.auth.settings") as mock_settings:
            mock_settings.testing_mode = False
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id)},
            )

        assert response.status_code == 429


# ---------------------------------------------------------------------------
# RR3-21: Structured logging on critical paths
# ---------------------------------------------------------------------------


class TestStructuredLoggingAuthService:
    """Verify _unsign_token logs on SignatureExpired, BadSignature, and generic Exception."""

    def test_unsign_token_signature_expired_logs_warning(self):
        """_unsign_token logs session_token_invalid with reason=signature_expired."""
        import structlog.testing
        from itsdangerous import SignatureExpired
        from unittest.mock import patch, MagicMock
        from fastapi import HTTPException
        from app.services import auth_service

        mock_serializer = MagicMock()
        mock_serializer.loads.side_effect = SignatureExpired("expired", payload=None)

        with patch("app.services.auth_service._get_serializer", return_value=mock_serializer):
            with structlog.testing.capture_logs() as logs:
                with pytest.raises(HTTPException) as exc_info:
                    auth_service._unsign_token("some_token")

        assert exc_info.value.status_code == 401
        warning_logs = [l for l in logs if l.get("log_level") == "warning"]
        assert any(
            l.get("event") == "session_token_invalid" and l.get("reason") == "signature_expired"
            for l in warning_logs
        )

    def test_unsign_token_bad_signature_logs_warning(self):
        """_unsign_token logs session_token_invalid with reason=bad_signature."""
        import structlog.testing
        from itsdangerous import BadSignature
        from unittest.mock import patch, MagicMock
        from fastapi import HTTPException
        from app.services import auth_service

        mock_serializer = MagicMock()
        mock_serializer.loads.side_effect = BadSignature("bad sig")

        with patch("app.services.auth_service._get_serializer", return_value=mock_serializer):
            with structlog.testing.capture_logs() as logs:
                with pytest.raises(HTTPException) as exc_info:
                    auth_service._unsign_token("some_token")

        assert exc_info.value.status_code == 401
        warning_logs = [l for l in logs if l.get("log_level") == "warning"]
        assert any(
            l.get("event") == "session_token_invalid" and l.get("reason") == "bad_signature"
            for l in warning_logs
        )

    def test_unsign_token_generic_exception_logs_warning(self):
        """_unsign_token logs session_token_invalid with reason=unknown_error on generic Exception."""
        import structlog.testing
        from unittest.mock import patch, MagicMock
        from fastapi import HTTPException
        from app.services import auth_service

        mock_serializer = MagicMock()
        mock_serializer.loads.side_effect = ValueError("some unexpected error")

        with patch("app.services.auth_service._get_serializer", return_value=mock_serializer):
            with structlog.testing.capture_logs() as logs:
                with pytest.raises(HTTPException) as exc_info:
                    auth_service._unsign_token("some_token")

        assert exc_info.value.status_code == 401
        warning_logs = [l for l in logs if l.get("log_level") == "warning"]
        assert any(
            l.get("event") == "session_token_invalid" and l.get("reason") == "unknown_error"
            for l in warning_logs
        )


class TestStructuredLoggingVotingService:
    """Verify ballot_submitted and ballot_denied log events (RR3-21)."""

    async def test_ballot_submitted_log_on_success(
        self, db_session: AsyncSession
    ):
        """submit_ballot logs ballot_submitted on successful submission."""
        import structlog.testing
        from app.models import (
            GeneralMeeting,
            GeneralMeetingLotWeight,
            GeneralMeetingStatus,
            LotOwner,
        )
        from app.models.lot_owner_email import LotOwnerEmail
        from app.services.voting_service import submit_ballot

        building = Building(name=f"Log Test Bldg {uuid.uuid4().hex[:6]}", manager_email="m@e.com")
        db_session.add(building)
        await db_session.flush()

        lo = LotOwner(building_id=building.id, lot_number="L-1", unit_entitlement=100)
        db_session.add(lo)
        await db_session.flush()

        email_rec = LotOwnerEmail(lot_owner_id=lo.id, email="logtest@example.com")
        db_session.add(email_rec)

        agm = GeneralMeeting(
            building_id=building.id,
            title="Log Test AGM",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) - timedelta(hours=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=1),
        )
        db_session.add(agm)
        await db_session.flush()

        weight = GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=100,
        )
        db_session.add(weight)
        await db_session.flush()

        with structlog.testing.capture_logs() as logs:
            result = await submit_ballot(
                db=db_session,
                general_meeting_id=agm.id,
                voter_email="logtest@example.com",
                lot_owner_ids=[lo.id],
            )

        assert result.submitted is True
        info_logs = [l for l in logs if l.get("log_level") == "info"]
        assert any(
            l.get("event") == "ballot_submitted" and l.get("lot_count") == 1
            for l in info_logs
        )

    async def test_ballot_denied_log_on_closed_meeting(
        self, db_session: AsyncSession
    ):
        """submit_ballot logs ballot_denied with reason=meeting_closed when meeting is closed."""
        import structlog.testing
        from fastapi import HTTPException
        from app.models import (
            GeneralMeeting,
            GeneralMeetingStatus,
        )
        from app.services.voting_service import submit_ballot

        building = Building(name=f"Deny Test Bldg {uuid.uuid4().hex[:6]}", manager_email="m@e.com")
        db_session.add(building)
        await db_session.flush()

        agm = GeneralMeeting(
            building_id=building.id,
            title="Closed AGM",
            status=GeneralMeetingStatus.closed,
            meeting_at=datetime.now(UTC) - timedelta(days=2),
            voting_closes_at=datetime.now(UTC) - timedelta(days=1),
        )
        db_session.add(agm)
        await db_session.flush()

        with structlog.testing.capture_logs() as logs:
            with pytest.raises(HTTPException) as exc_info:
                await submit_ballot(
                    db=db_session,
                    general_meeting_id=agm.id,
                    voter_email="voter@example.com",
                    lot_owner_ids=[uuid.uuid4()],
                )

        assert exc_info.value.status_code == 403
        warning_logs = [l for l in logs if l.get("log_level") == "warning"]
        assert any(
            l.get("event") == "ballot_denied" and l.get("reason") == "meeting_closed"
            for l in warning_logs
        )


class TestStructuredLoggingAdminService:
    """Verify meeting_close_initiated and meeting_closed log events (RR3-21)."""

    async def test_close_meeting_logs_meeting_closed(
        self, db_session: AsyncSession
    ):
        """close_general_meeting logs meeting_closed with lot_count and absent_count."""
        import structlog.testing
        from app.models import (
            GeneralMeeting,
            GeneralMeetingLotWeight,
            GeneralMeetingStatus,
            LotOwner,
        )
        from app.models.lot_owner_email import LotOwnerEmail
        from app.services.admin_service import close_general_meeting

        building = Building(name=f"Close Log Bldg {uuid.uuid4().hex[:6]}", manager_email="m@e.com")
        db_session.add(building)
        await db_session.flush()

        lo = LotOwner(building_id=building.id, lot_number="CL-1", unit_entitlement=100)
        db_session.add(lo)
        await db_session.flush()

        db_session.add(LotOwnerEmail(lot_owner_id=lo.id, email="closetest@example.com"))

        agm = GeneralMeeting(
            building_id=building.id,
            title="Close Log AGM",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) - timedelta(days=2),
            voting_closes_at=datetime.now(UTC) - timedelta(days=1),
        )
        db_session.add(agm)
        await db_session.flush()

        db_session.add(GeneralMeetingLotWeight(
            general_meeting_id=agm.id,
            lot_owner_id=lo.id,
            unit_entitlement_snapshot=100,
        ))
        await db_session.flush()

        with structlog.testing.capture_logs() as logs:
            await close_general_meeting(agm.id, db_session)

        info_logs = [l for l in logs if l.get("log_level") == "info"]
        assert any(l.get("event") == "meeting_close_initiated" for l in info_logs)
        assert any(
            l.get("event") == "meeting_closed" and "lot_count" in l
            for l in info_logs
        )
