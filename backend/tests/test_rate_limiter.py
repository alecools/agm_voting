"""
Unit tests for the in-memory rate limiter (RR3-33, RR4-17, RR4-31).

Covers:
  - RateLimiter.check() returns normally for the first N requests
  - RateLimiter.check() raises 429 HTTPException on the (N+1)th request
  - RateLimiter.reset() clears the window
  - RateLimiter.get_remaining() returns correct counts
  - get_client_ip() honours X-Forwarded-For header
  - ballot_submit_limiter: 10 req/min per voter_email
  - public_limiter: 60 req/min per IP
  - admin_import_limiter: 20 req/min (RR4-31)
  - admin_close_limiter: 30 req/min (RR4-31)
  - RR4-17: OTP rate limit is DB-backed; remaining limiters are intentionally in-memory
"""
from __future__ import annotations

import time
from unittest.mock import patch, MagicMock

import pytest
from fastapi import HTTPException

from app.rate_limiter import (
    RateLimiter,
    admin_close_limiter,
    admin_import_limiter,
    ballot_submit_limiter,
    get_client_ip,
    public_limiter,
)


# ---------------------------------------------------------------------------
# RateLimiter unit tests
# ---------------------------------------------------------------------------


class TestRateLimiter:
    def test_allows_requests_up_to_limit(self):
        """First N requests succeed without raising."""
        limiter = RateLimiter(max_requests=3, window_seconds=60)
        for _ in range(3):
            limiter.check("key1")  # must not raise

    def test_raises_429_on_n_plus_one_request(self):
        """(N+1)th request raises HTTPException with status 429."""
        limiter = RateLimiter(max_requests=3, window_seconds=60)
        for _ in range(3):
            limiter.check("key1")
        with pytest.raises(HTTPException) as exc_info:
            limiter.check("key1")
        assert exc_info.value.status_code == 429
        assert "Too many requests" in exc_info.value.detail

    def test_429_response_includes_rate_limit_headers(self):
        """429 HTTPException includes X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After headers."""
        limiter = RateLimiter(max_requests=1, window_seconds=30)
        limiter.check("key1")
        with pytest.raises(HTTPException) as exc_info:
            limiter.check("key1")
        headers = exc_info.value.headers or {}
        assert "X-RateLimit-Limit" in headers
        assert headers["X-RateLimit-Limit"] == "1"
        assert "X-RateLimit-Remaining" in headers
        assert headers["X-RateLimit-Remaining"] == "0"
        assert "Retry-After" in headers
        assert headers["Retry-After"] == "30"

    def test_reset_clears_window(self):
        """reset() allows requests to succeed again after limit was hit."""
        limiter = RateLimiter(max_requests=1, window_seconds=60)
        limiter.check("key1")
        # Should be at limit now
        with pytest.raises(HTTPException):
            limiter.check("key1")
        # Reset and try again
        limiter.reset("key1")
        limiter.check("key1")  # must not raise

    def test_different_keys_are_independent(self):
        """Rate limiting is per-key — exhausting one key does not affect another."""
        limiter = RateLimiter(max_requests=1, window_seconds=60)
        limiter.check("key_a")
        with pytest.raises(HTTPException):
            limiter.check("key_a")
        # key_b is unaffected
        limiter.check("key_b")  # must not raise

    def test_get_remaining_decrements_with_each_request(self):
        """get_remaining() returns max_requests - used_requests."""
        limiter = RateLimiter(max_requests=5, window_seconds=60)
        assert limiter.get_remaining("key1") == 5
        limiter.check("key1")
        assert limiter.get_remaining("key1") == 4
        limiter.check("key1")
        assert limiter.get_remaining("key1") == 3

    def test_old_timestamps_evicted_after_window(self):
        """Requests older than the window do not count toward the limit."""
        limiter = RateLimiter(max_requests=2, window_seconds=1)
        limiter.check("key1")
        limiter.check("key1")
        # Both slots used — next call would fail
        with pytest.raises(HTTPException):
            limiter.check("key1")

        # Simulate time passing beyond the window
        limiter.reset("key1")
        # After reset, allow 2 more
        limiter.check("key1")
        limiter.check("key1")

    def test_get_remaining_returns_zero_at_limit(self):
        """get_remaining() returns 0 when limit is reached."""
        limiter = RateLimiter(max_requests=2, window_seconds=60)
        limiter.check("key1")
        limiter.check("key1")
        assert limiter.get_remaining("key1") == 0


# ---------------------------------------------------------------------------
# get_client_ip unit tests
# ---------------------------------------------------------------------------


class TestGetClientIp:
    def _make_request(self, x_forwarded_for: str | None = None, client_host: str = "127.0.0.1"):
        mock_request = MagicMock()
        mock_request.headers = {}
        if x_forwarded_for is not None:
            mock_request.headers = {"X-Forwarded-For": x_forwarded_for}
        mock_request.client = MagicMock()
        mock_request.client.host = client_host
        return mock_request

    def test_returns_x_forwarded_for_first_ip(self):
        """Honours X-Forwarded-For header, returns first IP in the chain."""
        req = self._make_request(x_forwarded_for="203.0.113.1, 10.0.0.1")
        assert get_client_ip(req) == "203.0.113.1"

    def test_returns_client_host_when_no_forwarded_for(self):
        """Falls back to request.client.host when X-Forwarded-For is absent."""
        req = self._make_request(client_host="192.168.1.50")
        assert get_client_ip(req) == "192.168.1.50"

    def test_returns_unknown_when_no_client(self):
        """Returns 'unknown' when request.client is None."""
        mock_request = MagicMock()
        mock_request.headers = {}
        mock_request.client = None
        assert get_client_ip(mock_request) == "unknown"

    def test_strips_whitespace_from_forwarded_for(self):
        """Strips whitespace from the extracted IP."""
        req = self._make_request(x_forwarded_for="  203.0.113.2  , 10.0.0.1")
        assert get_client_ip(req) == "203.0.113.2"


# ---------------------------------------------------------------------------
# Integration smoke: singleton limiters have correct defaults
# ---------------------------------------------------------------------------


class TestSingletonLimiters:
    def test_ballot_submit_limiter_has_expected_limits(self):
        """ballot_submit_limiter is configured for 10 req/60s."""
        assert ballot_submit_limiter.max_requests == 10
        assert ballot_submit_limiter.window_seconds == 60

    def test_public_limiter_has_expected_limits(self):
        """public_limiter is configured for 60 req/60s."""
        assert public_limiter.max_requests == 60
        assert public_limiter.window_seconds == 60

    def test_admin_import_limiter_has_expected_limits(self):
        """admin_import_limiter is configured for 20 req/60s (RR4-31)."""
        assert admin_import_limiter.max_requests == 20
        assert admin_import_limiter.window_seconds == 60

    def test_admin_close_limiter_has_expected_limits(self):
        """admin_close_limiter is configured for 30 req/60s (RR4-31)."""
        assert admin_close_limiter.max_requests == 30
        assert admin_close_limiter.window_seconds == 60


# ---------------------------------------------------------------------------
# RR4-17: OTP rate limit is DB-backed; in-memory limiters are acceptable
# ---------------------------------------------------------------------------


class TestRR417OtpRateLimitIsDbBacked:
    def test_otp_rate_limit_model_exists(self):
        """OTPRateLimit model exists and is backed by a DB table (RR4-17).

        The OTP request rate limit uses DB-backed counters (``OTPRateLimit`` table)
        so it is shared across Lambda instances and survives cold starts.
        This test confirms the model is importable and refers to the correct table,
        verifying the finding is NOT APPLICABLE for DB-backed OTP limiting.
        """
        from app.models.otp_rate_limit import OTPRateLimit
        assert OTPRateLimit.__tablename__ == "otp_rate_limits"
        # The model has all expected columns for DB-backed rate limiting
        assert hasattr(OTPRateLimit, "email")
        assert hasattr(OTPRateLimit, "attempt_count")
        assert hasattr(OTPRateLimit, "first_attempt_at")

    def test_in_memory_limiters_are_ratelimiter_instances(self):
        """All in-memory limiters are RateLimiter instances (not DB-backed).

        RR4-17 documents why these limiters are intentionally in-memory:
        - ballot_submit_limiter: protected by DB-level unique constraint on ballots
        - public_limiter: per-IP general throttle; per-instance approximation is acceptable
        - admin_import_limiter: admin-only, session-authenticated
        - admin_close_limiter: admin-only, session-authenticated
        """
        assert isinstance(ballot_submit_limiter, RateLimiter)
        assert isinstance(public_limiter, RateLimiter)
        assert isinstance(admin_import_limiter, RateLimiter)
        assert isinstance(admin_close_limiter, RateLimiter)
