"""
Simple in-memory rate limiter for FastAPI endpoints (RR3-33).

Uses a dictionary mapping (key) -> list[timestamp] to track requests within
a sliding window. Thread-safe for single-process deployments (Lambda/Uvicorn
with a single worker); not shared across multiple processes.

RR4-17 — in-memory vs. DB-backed rate limiters:
  The OTP request rate limit (POST /api/auth/request) is DB-backed via the
  ``OTPRateLimit`` table, so it is shared across Lambda instances and survives
  cold starts (see ``backend/app/models/otp_rate_limit.py``).

  The limiters in this module (``ballot_submit_limiter``, ``public_limiter``,
  and the admin import/close limiters in ``admin.py``) are intentionally
  in-memory because:
    • The endpoints they guard are idempotent or low-risk enough that
      per-instance limiting is an acceptable approximation.
    • Ballot submissions are additionally protected by a DB-level unique
      constraint on ``(general_meeting_id, lot_owner_id)``, so duplicates
      are rejected at the DB layer regardless of rate-limit state.
    • Admin operations are session-authenticated; a single compromised admin
      session hitting multiple Lambda instances simultaneously is an unlikely
      threat model relative to public OTP enumeration.

  No action required for these limiters (finding is NOT APPLICABLE — already
  acceptable for their respective threat models).

Usage:
    limiter = RateLimiter(max_requests=10, window_seconds=60)

    @router.post("/submit")
    async def submit(request: Request):
        await limiter.check(request.client.host)
        ...
"""
from __future__ import annotations

import time
from collections import defaultdict
from typing import Callable

from fastapi import HTTPException, Request


class RateLimiter:
    """Sliding-window in-memory rate limiter."""

    def __init__(self, max_requests: int, window_seconds: int) -> None:
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._timestamps: dict[str, list[float]] = defaultdict(list)

    def _evict_old(self, key: str, now: float) -> None:
        cutoff = now - self.window_seconds
        self._timestamps[key] = [t for t in self._timestamps[key] if t > cutoff]

    def check(self, key: str) -> None:
        """Raise 429 if key has exceeded the rate limit; otherwise record the request."""
        now = time.monotonic()
        self._evict_old(key, now)
        if len(self._timestamps[key]) >= self.max_requests:
            raise HTTPException(
                status_code=429,
                detail="Too many requests. Please try again later.",
                headers={
                    "X-RateLimit-Limit": str(self.max_requests),
                    "X-RateLimit-Remaining": "0",
                    "Retry-After": str(self.window_seconds),
                },
            )
        self._timestamps[key].append(now)

    def get_remaining(self, key: str) -> int:
        """Return the number of remaining requests for key in the current window."""
        now = time.monotonic()
        self._evict_old(key, now)
        return max(0, self.max_requests - len(self._timestamps[key]))

    def reset(self, key: str) -> None:
        """Clear all recorded timestamps for key (useful in tests)."""
        self._timestamps.pop(key, None)


def get_client_ip(request: Request) -> str:
    """Return the real client IP, honouring X-Forwarded-For from Vercel proxy."""
    forwarded_for = request.headers.get("X-Forwarded-For")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# Singleton rate limiters — created once at module import time.
# Ballot submission: 10 requests per minute per voter_email.
ballot_submit_limiter = RateLimiter(max_requests=10, window_seconds=60)

# Public endpoints: 60 requests per minute per IP.
public_limiter = RateLimiter(max_requests=60, window_seconds=60)

# Admin import endpoints: 20 requests per minute per admin session (RR4-31).
# Applies to buildings/import, lot-owners/import, import-proxies,
# and import-financial-positions endpoints.
admin_import_limiter = RateLimiter(max_requests=20, window_seconds=60)

# Admin meeting close: 30 requests per minute per admin session (RR4-31).
# Raised from 10 to 30 so parallel E2E jobs sharing the "admin" key do not
# saturate the bucket during concurrent beforeAll/afterAll close-meeting calls.
admin_close_limiter = RateLimiter(max_requests=30, window_seconds=60)
