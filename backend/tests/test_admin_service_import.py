"""
Unit tests for admin_service import functions — IntegrityError handling.

Tests the concurrent-import-conflict guard (409) in:
  - import_buildings_from_csv
  - import_buildings_from_excel

Uses a mock AsyncSession so these tests run without a real DB.

Structure:
  # --- Happy path (covered by integration tests) ---
  # --- State / precondition errors ---
"""
from __future__ import annotations

import io
from unittest.mock import AsyncMock, MagicMock, patch

import openpyxl
import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from app.services.admin_service import (
    _parse_name,
    import_buildings_from_csv,
    import_buildings_from_excel,
)


def _make_csv(headers: list[str], rows: list[list[str]]) -> bytes:
    import csv

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(headers)
    for row in rows:
        writer.writerow(row)
    return buf.getvalue().encode()


def _make_excel(headers: list, rows: list[list]) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(headers)
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf.read()


def _make_mock_session(*, commit_side_effect=None) -> AsyncMock:
    """Return a mock AsyncSession with configurable commit behaviour."""
    session = AsyncMock()
    # execute returns an object with a scalars().all() chain
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    session.execute = AsyncMock(return_value=mock_result)
    session.add = MagicMock()
    if commit_side_effect is not None:
        session.commit = AsyncMock(side_effect=commit_side_effect)
        session.rollback = AsyncMock()
    else:
        session.commit = AsyncMock()
        session.rollback = AsyncMock()
    return session


# ---------------------------------------------------------------------------
# State / precondition errors — IntegrityError guard
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# _parse_name — unit tests
# ---------------------------------------------------------------------------


class TestParseName:
    # --- Happy path ---

    def test_two_part_name(self):
        """Standard first last → (first, last)."""
        assert _parse_name("John Smith") == ("John", "Smith")

    def test_three_part_name(self):
        """Three tokens → given_name gets first two, surname gets last."""
        assert _parse_name("Steven Xiwen Sun") == ("Steven Xiwen", "Sun")

    def test_four_part_name(self):
        """Four tokens → given_name gets first three."""
        assert _parse_name("Mary Jane Van Der Berg") == ("Mary Jane Van Der", "Berg")

    # --- Single-token (company name) ---

    def test_single_token_returns_none_given_name(self):
        """Single token stored as surname only (company name case)."""
        assert _parse_name("ACME") == (None, "ACME")

    def test_single_token_with_leading_trailing_spaces(self):
        """Surrounding whitespace is stripped before splitting."""
        assert _parse_name("  Corp  ") == (None, "Corp")

    # --- Boundary values / edge cases ---

    def test_blank_string_returns_none_none(self):
        """Empty string returns (None, None)."""
        assert _parse_name("") == (None, None)

    def test_whitespace_only_returns_none_none(self):
        """Whitespace-only string returns (None, None)."""
        assert _parse_name("   ") == (None, None)

    def test_name_with_internal_multiple_spaces(self):
        """Multiple internal spaces are collapsed by split()."""
        # "Alice  Bob" → two tokens → ("Alice", "Bob")
        assert _parse_name("Alice  Bob") == ("Alice", "Bob")


# ---------------------------------------------------------------------------
# State / precondition errors — IntegrityError guard
# ---------------------------------------------------------------------------


class TestImportBuildingsCsvIntegrityError:
    async def test_integrity_error_on_commit_raises_409(self):
        """IntegrityError during commit raises HTTPException 409."""
        csv_content = _make_csv(
            ["building_name", "manager_email"],
            [["Conflict CSV Building", "conflict@test.com"]],
        )
        db = _make_mock_session(
            commit_side_effect=IntegrityError("mock", {}, Exception("mock"))
        )

        with pytest.raises(HTTPException) as exc_info:
            await import_buildings_from_csv(csv_content, db)

        assert exc_info.value.status_code == 409
        assert "Concurrent import conflict" in exc_info.value.detail
        db.rollback.assert_awaited_once()


class TestImportBuildingsExcelIntegrityError:
    async def test_integrity_error_on_commit_raises_409(self):
        """IntegrityError during commit raises HTTPException 409."""
        excel_content = _make_excel(
            ["building_name", "manager_email"],
            [["Conflict Excel Building", "conflict-excel@test.com"]],
        )
        db = _make_mock_session(
            commit_side_effect=IntegrityError("mock", {}, Exception("mock"))
        )

        with pytest.raises(HTTPException) as exc_info:
            await import_buildings_from_excel(excel_content, db)

        assert exc_info.value.status_code == 409
        assert "Concurrent import conflict" in exc_info.value.detail
        db.rollback.assert_awaited_once()
