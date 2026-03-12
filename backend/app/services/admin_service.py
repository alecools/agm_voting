"""
Service layer for admin portal operations.
"""
from __future__ import annotations

import csv
import io
import logging
import uuid
from datetime import UTC, datetime

import openpyxl

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    AGM,
    AGMLotWeight,
    AGMStatus,
    BallotSubmission,
    Building,
    EmailDelivery,
    EmailDeliveryStatus,
    FinancialPosition,
    FinancialPositionSnapshot,
    LotOwner,
    LotOwnerEmail,
    LotProxy,
    Motion,
    Vote,
    VoteStatus,
)
from app.schemas.admin import (
    AGMCreate,
    LotOwnerCreate,
    LotOwnerUpdate,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Buildings
# ---------------------------------------------------------------------------


async def import_buildings_from_csv(
    content: bytes,
    db: AsyncSession,
) -> dict[str, int]:
    """
    Parse a CSV of buildings and upsert records.
    Returns {"created": int, "updated": int}.
    Raises HTTPException 422 on validation errors.
    """
    text = content.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))

    required_headers = {"building_name", "manager_email"}
    if reader.fieldnames is None:
        raise HTTPException(status_code=422, detail="CSV has no headers")

    fieldnames_lower = {f.strip().lower() for f in reader.fieldnames}
    missing = required_headers - fieldnames_lower
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Missing required CSV headers: {sorted(missing)}",
        )

    rows = list(reader)

    # Validate all rows first, collect errors
    errors: list[str] = []
    for i, row in enumerate(rows, start=2):  # row 1 is header
        building_name = row.get("building_name", "").strip()
        manager_email = row.get("manager_email", "").strip()
        if not building_name:
            errors.append(f"Row {i}: building_name is empty")
        if not manager_email:
            errors.append(f"Row {i}: manager_email is empty")

    if errors:
        raise HTTPException(status_code=422, detail=errors)

    created = 0
    updated = 0

    for row in rows:
        building_name = row["building_name"].strip()
        manager_email = row["manager_email"].strip()

        # Case-insensitive lookup
        result = await db.execute(
            select(Building).where(
                func.lower(Building.name) == func.lower(building_name)
            )
        )
        existing = result.scalar_one_or_none()

        if existing is None:
            new_building = Building(name=building_name, manager_email=manager_email)
            db.add(new_building)
            created += 1
        else:
            existing.manager_email = manager_email
            updated += 1

    await db.commit()
    return {"created": created, "updated": updated}


async def import_buildings_from_excel(
    content: bytes,
    db: AsyncSession,
) -> dict[str, int]:
    """
    Parse an Excel file of buildings and upsert records.
    Returns {"created": int, "updated": int}.
    Raises HTTPException 422 on validation errors.
    """
    try:
        wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid Excel file: {exc}") from exc

    ws = wb.worksheets[0]
    rows_iter = ws.iter_rows(values_only=True)

    # Read header row
    try:
        header_row = next(rows_iter)
    except StopIteration:
        raise HTTPException(status_code=422, detail="Excel file has no headers")

    if header_row is None or all(v is None for v in header_row):  # pragma: no cover  # openpyxl never yields None as a header row when the sheet has rows; StopIteration handles the empty case above
        raise HTTPException(status_code=422, detail="Excel file has no headers")

    headers = [str(h).strip().lower() if h is not None else "" for h in header_row]

    required_headers = {"building_name", "manager_email"}
    missing = required_headers - set(headers)
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Missing required Excel headers: {sorted(missing)}",
        )

    building_name_idx = headers.index("building_name")
    manager_email_idx = headers.index("manager_email")

    data_rows = list(rows_iter)
    wb.close()

    errors: list[str] = []
    parsed: list[dict] = []

    row_num = 0
    for raw_row in data_rows:
        # Skip completely blank rows
        if all(v is None or str(v).strip() == "" for v in raw_row):
            continue
        row_num += 1

        def _cell(idx: int) -> str:
            if idx < len(raw_row) and raw_row[idx] is not None:
                return str(raw_row[idx]).strip()
            return ""

        building_name = _cell(building_name_idx)
        manager_email = _cell(manager_email_idx)

        row_errors = []
        if not building_name:
            row_errors.append(f"Row {row_num}: building_name is empty")
        if not manager_email:
            row_errors.append(f"Row {row_num}: manager_email is empty")

        if row_errors:
            errors.extend(row_errors)
        else:
            parsed.append({"building_name": building_name, "manager_email": manager_email})

    if errors:
        raise HTTPException(status_code=422, detail=errors)

    created = 0
    updated = 0

    for row_data in parsed:
        building_name = row_data["building_name"]
        manager_email = row_data["manager_email"]

        result = await db.execute(
            select(Building).where(
                func.lower(Building.name) == func.lower(building_name)
            )
        )
        existing = result.scalar_one_or_none()

        if existing is None:
            new_building = Building(name=building_name, manager_email=manager_email)
            db.add(new_building)
            created += 1
        else:
            existing.manager_email = manager_email
            updated += 1

    await db.commit()
    return {"created": created, "updated": updated}


async def create_building(name: str, manager_email: str, db: AsyncSession) -> Building:
    result = await db.execute(
        select(Building).where(func.lower(Building.name) == func.lower(name))
    )
    if result.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=409,
            detail=f"A building named '{name}' already exists",
        )
    building = Building(name=name, manager_email=manager_email)
    db.add(building)
    await db.commit()
    await db.refresh(building)
    return building


async def list_buildings(db: AsyncSession) -> list[Building]:
    result = await db.execute(select(Building).order_by(Building.created_at))
    return list(result.scalars().all())


async def archive_building(building_id: uuid.UUID, db: AsyncSession) -> Building:
    """
    Archive a building and any lot owners that have no emails in another non-archived building.
    """
    building = await get_building_or_404(building_id, db)

    if building.is_archived:
        raise HTTPException(status_code=409, detail="Building is already archived")

    building.is_archived = True

    # Find all active lot owners for this building
    owners_result = await db.execute(
        select(LotOwner).where(
            LotOwner.building_id == building_id,
            LotOwner.is_archived == False,  # noqa: E712
        )
    )
    owners = list(owners_result.scalars().all())

    for owner in owners:
        # Get all emails for this lot owner
        emails_result = await db.execute(
            select(LotOwnerEmail.email).where(LotOwnerEmail.lot_owner_id == owner.id)
        )
        owner_emails = [r[0] for r in emails_result.all() if r[0]]

        # Check if any of these emails appear in another non-archived building
        found_in_other = False
        for email in owner_emails:
            other_result = await db.execute(
                select(LotOwner)
                .join(Building, LotOwner.building_id == Building.id)
                .join(LotOwnerEmail, LotOwnerEmail.lot_owner_id == LotOwner.id)
                .where(
                    LotOwnerEmail.email == email,
                    LotOwner.building_id != building_id,
                    Building.is_archived == False,  # noqa: E712
                )
            )
            other = other_result.scalar_one_or_none()
            if other is not None:
                found_in_other = True
                break

        if not found_in_other:
            owner.is_archived = True

    await db.commit()
    await db.refresh(building)
    return building


# ---------------------------------------------------------------------------
# Lot owners
# ---------------------------------------------------------------------------


async def get_building_or_404(building_id: uuid.UUID, db: AsyncSession) -> Building:
    result = await db.execute(select(Building).where(Building.id == building_id))
    building = result.scalar_one_or_none()
    if building is None:
        raise HTTPException(status_code=404, detail="Building not found")
    return building


async def _get_proxy_email(lot_owner_id: uuid.UUID, db: AsyncSession) -> str | None:
    """Return the proxy_email for a lot owner, or None if no proxy is set."""
    proxy_result = await db.execute(
        select(LotProxy.proxy_email).where(LotProxy.lot_owner_id == lot_owner_id)
    )
    row = proxy_result.first()
    return row[0] if row is not None else None


async def list_lot_owners(building_id: uuid.UUID, db: AsyncSession) -> list[dict]:
    await get_building_or_404(building_id, db)
    result = await db.execute(
        select(LotOwner).where(LotOwner.building_id == building_id)
    )
    owners = list(result.scalars().all())

    # Load emails and proxy for each owner
    out = []
    for owner in owners:
        emails_result = await db.execute(
            select(LotOwnerEmail.email).where(LotOwnerEmail.lot_owner_id == owner.id)
        )
        emails = [r[0] for r in emails_result.all() if r[0] is not None]
        proxy_email = await _get_proxy_email(owner.id, db)
        out.append({
            "id": owner.id,
            "lot_number": owner.lot_number,
            "emails": emails,
            "unit_entitlement": owner.unit_entitlement,
            "financial_position": owner.financial_position.value if hasattr(owner.financial_position, "value") else owner.financial_position,
            "proxy_email": proxy_email,
        })
    return out


async def get_lot_owner(lot_owner_id: uuid.UUID, db: AsyncSession) -> dict:
    """Return a single lot owner by ID, including proxy_email."""
    result = await db.execute(
        select(LotOwner).where(LotOwner.id == lot_owner_id)
    )
    lot_owner = result.scalar_one_or_none()
    if lot_owner is None:
        raise HTTPException(status_code=404, detail="Lot owner not found")

    emails_result = await db.execute(
        select(LotOwnerEmail.email).where(LotOwnerEmail.lot_owner_id == lot_owner_id)
    )
    emails = [r[0] for r in emails_result.all() if r[0] is not None]
    proxy_email = await _get_proxy_email(lot_owner_id, db)

    return {
        "id": lot_owner.id,
        "lot_number": lot_owner.lot_number,
        "emails": emails,
        "unit_entitlement": lot_owner.unit_entitlement,
        "financial_position": lot_owner.financial_position.value if hasattr(lot_owner.financial_position, "value") else lot_owner.financial_position,
        "proxy_email": proxy_email,
    }


_CSV_LOT_OWNER_ALIASES: dict[str, str] = {
    "lot#": "lot_number",
    "uoe2": "unit_entitlement",
}


def _normalise_lot_owner_fieldnames(fieldnames: list[str]) -> list[str]:
    """Map alternate header names (Lot#, UOE2) to canonical names."""
    return [_CSV_LOT_OWNER_ALIASES.get(f.strip().lower(), f.strip().lower()) for f in fieldnames]


def _parse_financial_position(raw: str) -> FinancialPosition:
    """Parse a financial position string from an import row.

    Accepted values (case-insensitive): 'normal', 'in arrear', 'in_arrear'.
    Blank/missing values default to 'normal'.
    """
    normalised = raw.strip().lower().replace(" ", "_")
    if normalised == "" or normalised == "normal":
        return FinancialPosition.normal
    if normalised == "in_arrear":
        return FinancialPosition.in_arrear
    raise ValueError(f"Invalid financial_position value: '{raw}'")


async def import_lot_owners_from_csv(
    building_id: uuid.UUID,
    content: bytes,
    db: AsyncSession,
) -> dict[str, int]:
    """
    Parse a CSV of lot owners. Multiple rows with the same lot_number create one lot with
    multiple LotOwnerEmail records. Blank email is allowed (no email entry created).
    Returns {"imported": int, "emails": int}.
    """
    await get_building_or_404(building_id, db)

    text = content.decode("utf-8-sig")
    raw_reader = csv.DictReader(io.StringIO(text))

    if raw_reader.fieldnames is None:
        raise HTTPException(status_code=422, detail="CSV has no headers")

    normalised_fieldnames = _normalise_lot_owner_fieldnames(list(raw_reader.fieldnames))
    # Re-read with normalised fieldnames
    reader = csv.DictReader(io.StringIO(text), fieldnames=normalised_fieldnames)
    next(reader)  # skip original header row

    required_headers = {"lot_number", "unit_entitlement"}
    missing = required_headers - set(normalised_fieldnames)
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Missing required CSV headers: {sorted(missing)}",
        )

    rows = list(reader)

    errors: list[str] = []
    # Parse rows: group by lot_number
    lot_data: dict[str, dict] = {}  # lot_number -> {unit_entitlement, financial_position, emails: set}

    for i, row in enumerate(rows, start=2):
        lot_number = row.get("lot_number", "").strip()
        email = row.get("email", "").strip()
        unit_entitlement_raw = row.get("unit_entitlement", "").strip()
        financial_position_raw = row.get("financial_position", "").strip()

        row_errors = []

        if not lot_number:
            row_errors.append(f"Row {i}: lot_number is empty")

        unit_entitlement = None
        if not unit_entitlement_raw:
            row_errors.append(f"Row {i}: unit_entitlement is empty")
        else:
            try:
                unit_entitlement = int(unit_entitlement_raw)
                if unit_entitlement < 0:
                    row_errors.append(
                        f"Row {i}: unit_entitlement must be >= 0, got {unit_entitlement}"
                    )
            except ValueError:
                row_errors.append(
                    f"Row {i}: unit_entitlement must be an integer, got '{unit_entitlement_raw}'"
                )

        financial_position = FinancialPosition.normal
        try:
            financial_position = _parse_financial_position(financial_position_raw)
        except ValueError as e:
            row_errors.append(f"Row {i}: {e}")

        if row_errors:
            errors.extend(row_errors)
        else:
            if lot_number not in lot_data:
                lot_data[lot_number] = {
                    "unit_entitlement": unit_entitlement,
                    "financial_position": financial_position,
                    "emails": set(),
                }
            else:
                # If lot already seen, the unit_entitlement and financial_position should be consistent
                # Use values from first occurrence
                pass
            for addr in email.split(";"):
                addr = addr.strip()
                if addr:
                    lot_data[lot_number]["emails"].add(addr)

    if errors:
        raise HTTPException(status_code=422, detail=errors)

    return await _upsert_lot_owners(building_id, lot_data, db)


async def import_lot_owners_from_excel(
    building_id: uuid.UUID,
    content: bytes,
    db: AsyncSession,
) -> dict[str, int]:
    """
    Parse an Excel file of lot owners. Multiple rows with the same Lot# create one lot
    with multiple LotOwnerEmail records. Blank email is allowed.
    Returns {"imported": int, "emails": int}.
    """
    await get_building_or_404(building_id, db)

    try:
        wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid Excel file: {exc}") from exc

    ws = wb.worksheets[0]
    rows_iter = ws.iter_rows(values_only=True)

    # Read header row
    try:
        header_row = next(rows_iter)
    except StopIteration:
        raise HTTPException(status_code=422, detail="Excel file has no headers")

    if header_row is None or all(v is None for v in header_row):  # pragma: no cover  # openpyxl never yields None as a header row when the sheet has rows; StopIteration handles the empty case above
        raise HTTPException(status_code=422, detail="Excel file has no headers")

    headers = [str(h).strip().lower() if h is not None else "" for h in header_row]

    required_headers = {"lot#", "uoe2"}
    missing = required_headers - set(headers)
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Missing required Excel headers: {sorted(missing)}",
        )

    lot_idx = headers.index("lot#")
    uoe2_idx = headers.index("uoe2")
    email_idx = headers.index("email") if "email" in headers else None
    fp_idx = headers.index("financial position") if "financial position" in headers else (
        headers.index("financial_position") if "financial_position" in headers else None
    )

    data_rows = list(rows_iter)
    wb.close()

    errors: list[str] = []
    lot_data: dict[str, dict] = {}  # lot_number -> {unit_entitlement, financial_position, emails: set}

    row_num = 0
    for raw_row in data_rows:
        # Skip completely blank rows
        if all(v is None or str(v).strip() == "" for v in raw_row):
            continue
        row_num += 1

        def _cell(idx: int) -> str:
            if idx is not None and idx < len(raw_row) and raw_row[idx] is not None:
                return str(raw_row[idx]).strip()
            return ""

        lot_number = _cell(lot_idx)
        email = _cell(email_idx) if email_idx is not None else ""
        unit_entitlement_raw = _cell(uoe2_idx)
        financial_position_raw = _cell(fp_idx) if fp_idx is not None else ""

        row_errors = []

        if not lot_number:
            row_errors.append(f"Row {row_num}: lot_number is empty")

        unit_entitlement = None
        if not unit_entitlement_raw:
            row_errors.append(f"Row {row_num}: unit_entitlement is empty")
        else:
            try:
                unit_entitlement = int(unit_entitlement_raw)
                if unit_entitlement < 0:
                    row_errors.append(
                        f"Row {row_num}: unit_entitlement must be >= 0, got {unit_entitlement}"
                    )
            except ValueError:
                row_errors.append(
                    f"Row {row_num}: unit_entitlement must be an integer, got '{unit_entitlement_raw}'"
                )

        financial_position = FinancialPosition.normal
        try:
            financial_position = _parse_financial_position(financial_position_raw)
        except ValueError as e:
            row_errors.append(f"Row {row_num}: {e}")

        if row_errors:
            errors.extend(row_errors)
        else:
            if lot_number not in lot_data:
                lot_data[lot_number] = {
                    "unit_entitlement": unit_entitlement,
                    "financial_position": financial_position,
                    "emails": set(),
                }
            for addr in email.split(";"):
                addr = addr.strip()
                if addr:
                    lot_data[lot_number]["emails"].add(addr)

    if errors:
        raise HTTPException(status_code=422, detail=errors)

    return await _upsert_lot_owners(building_id, lot_data, db)


async def _upsert_lot_owners(
    building_id: uuid.UUID,
    lot_data: dict[str, dict],
    db: AsyncSession,
) -> dict[str, int]:
    """
    Upsert lot owners from parsed lot_data.
    lot_data: {lot_number -> {unit_entitlement, financial_position, emails: set}}
    Returns {"imported": int, "emails": int}.
    """
    # Load existing lot owners keyed by lot_number to preserve IDs
    existing_result = await db.execute(
        select(LotOwner).where(LotOwner.building_id == building_id)
    )
    existing: dict[str, LotOwner] = {
        lo.lot_number: lo for lo in existing_result.scalars().all()
    }

    new_lot_numbers: set[str] = set(lot_data.keys())

    # Upsert: update existing, insert new
    for lot_number, data in lot_data.items():
        if lot_number in existing:
            lo = existing[lot_number]
            lo.unit_entitlement = data["unit_entitlement"]
            lo.financial_position = data["financial_position"]
            await db.flush()
            # Replace emails: delete existing, insert new set
            await db.execute(
                delete(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lo.id)
            )
            for email in data["emails"]:
                db.add(LotOwnerEmail(lot_owner_id=lo.id, email=email))
        else:
            new_lo = LotOwner(
                building_id=building_id,
                lot_number=lot_number,
                unit_entitlement=data["unit_entitlement"],
                financial_position=data["financial_position"],
            )
            db.add(new_lo)
            await db.flush()
            for email in data["emails"]:
                db.add(LotOwnerEmail(lot_owner_id=new_lo.id, email=email))

    # Delete lot owners that are no longer in the import
    for lot_number, lo in existing.items():
        if lot_number not in new_lot_numbers:
            await db.delete(lo)

    await db.commit()

    total_emails = sum(len(data["emails"]) for data in lot_data.values())
    return {"imported": len(lot_data), "emails": total_emails}


async def add_lot_owner(
    building_id: uuid.UUID,
    data: LotOwnerCreate,
    db: AsyncSession,
) -> dict:
    await get_building_or_404(building_id, db)

    # Check uniqueness within building
    result = await db.execute(
        select(LotOwner).where(
            LotOwner.building_id == building_id,
            LotOwner.lot_number == data.lot_number,
        )
    )
    existing = result.scalar_one_or_none()
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=f"lot_number '{data.lot_number}' already exists in this building",
        )

    lot_owner = LotOwner(
        building_id=building_id,
        lot_number=data.lot_number,
        unit_entitlement=data.unit_entitlement,
        financial_position=FinancialPosition(data.financial_position),
    )
    db.add(lot_owner)
    await db.flush()

    email_strs = []
    for email in data.emails:
        if email.strip():
            db.add(LotOwnerEmail(lot_owner_id=lot_owner.id, email=email.strip()))
            email_strs.append(email.strip())

    await db.commit()

    return {
        "id": lot_owner.id,
        "lot_number": lot_owner.lot_number,
        "emails": email_strs,
        "unit_entitlement": lot_owner.unit_entitlement,
        "financial_position": lot_owner.financial_position.value if hasattr(lot_owner.financial_position, "value") else lot_owner.financial_position,
        "proxy_email": None,
    }


async def update_lot_owner(
    lot_owner_id: uuid.UUID,
    data: LotOwnerUpdate,
    db: AsyncSession,
) -> dict:
    result = await db.execute(
        select(LotOwner).where(LotOwner.id == lot_owner_id)
    )
    lot_owner = result.scalar_one_or_none()
    if lot_owner is None:
        raise HTTPException(status_code=404, detail="Lot owner not found")

    if data.unit_entitlement is not None:
        lot_owner.unit_entitlement = data.unit_entitlement
    if data.financial_position is not None:
        lot_owner.financial_position = FinancialPosition(data.financial_position)

    await db.commit()

    # Load emails
    emails_result = await db.execute(
        select(LotOwnerEmail.email).where(LotOwnerEmail.lot_owner_id == lot_owner_id)
    )
    emails = [r[0] for r in emails_result.all() if r[0] is not None]

    proxy_email = await _get_proxy_email(lot_owner_id, db)
    return {
        "id": lot_owner.id,
        "lot_number": lot_owner.lot_number,
        "emails": emails,
        "unit_entitlement": lot_owner.unit_entitlement,
        "financial_position": lot_owner.financial_position.value if hasattr(lot_owner.financial_position, "value") else lot_owner.financial_position,
        "proxy_email": proxy_email,
    }


async def add_email_to_lot_owner(
    lot_owner_id: uuid.UUID,
    email: str,
    db: AsyncSession,
) -> dict:
    """Add an email to a lot owner. Returns the updated lot owner dict."""
    result = await db.execute(
        select(LotOwner).where(LotOwner.id == lot_owner_id)
    )
    lot_owner = result.scalar_one_or_none()
    if lot_owner is None:
        raise HTTPException(status_code=404, detail="Lot owner not found")

    # Check if email already exists for this lot owner
    existing = await db.execute(
        select(LotOwnerEmail).where(
            LotOwnerEmail.lot_owner_id == lot_owner_id,
            LotOwnerEmail.email == email,
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="Email already exists for this lot owner")

    db.add(LotOwnerEmail(lot_owner_id=lot_owner_id, email=email))
    await db.commit()

    emails_result = await db.execute(
        select(LotOwnerEmail.email).where(LotOwnerEmail.lot_owner_id == lot_owner_id)
    )
    emails = [r[0] for r in emails_result.all() if r[0] is not None]
    proxy_email = await _get_proxy_email(lot_owner_id, db)

    return {
        "id": lot_owner.id,
        "lot_number": lot_owner.lot_number,
        "emails": emails,
        "unit_entitlement": lot_owner.unit_entitlement,
        "financial_position": lot_owner.financial_position.value if hasattr(lot_owner.financial_position, "value") else lot_owner.financial_position,
        "proxy_email": proxy_email,
    }


async def remove_email_from_lot_owner(
    lot_owner_id: uuid.UUID,
    email: str,
    db: AsyncSession,
) -> dict:
    """Remove an email from a lot owner. Returns the updated lot owner dict."""
    result = await db.execute(
        select(LotOwner).where(LotOwner.id == lot_owner_id)
    )
    lot_owner = result.scalar_one_or_none()
    if lot_owner is None:
        raise HTTPException(status_code=404, detail="Lot owner not found")

    email_result = await db.execute(
        select(LotOwnerEmail).where(
            LotOwnerEmail.lot_owner_id == lot_owner_id,
            LotOwnerEmail.email == email,
        )
    )
    email_obj = email_result.scalar_one_or_none()
    if email_obj is None:
        raise HTTPException(status_code=404, detail="Email not found for this lot owner")

    await db.delete(email_obj)
    await db.commit()

    emails_result = await db.execute(
        select(LotOwnerEmail.email).where(LotOwnerEmail.lot_owner_id == lot_owner_id)
    )
    emails = [r[0] for r in emails_result.all() if r[0] is not None]
    proxy_email = await _get_proxy_email(lot_owner_id, db)

    return {
        "id": lot_owner.id,
        "lot_number": lot_owner.lot_number,
        "emails": emails,
        "unit_entitlement": lot_owner.unit_entitlement,
        "financial_position": lot_owner.financial_position.value if hasattr(lot_owner.financial_position, "value") else lot_owner.financial_position,
        "proxy_email": proxy_email,
    }


# ---------------------------------------------------------------------------
# AGMs
# ---------------------------------------------------------------------------


async def create_agm(data: AGMCreate, db: AsyncSession) -> AGM:
    # Validate building exists
    building = await get_building_or_404(data.building_id, db)

    # Check no open AGM already exists for this building
    result = await db.execute(
        select(AGM).where(
            AGM.building_id == data.building_id,
            AGM.status == AGMStatus.open,
        )
    )
    existing_open = result.scalar_one_or_none()
    if existing_open is not None:
        raise HTTPException(
            status_code=409,
            detail="An open AGM already exists for this building",
        )

    # Create AGM
    agm = AGM(
        building_id=data.building_id,
        title=data.title,
        status=AGMStatus.open,
        meeting_at=data.meeting_at,
        voting_closes_at=data.voting_closes_at,
    )
    db.add(agm)
    await db.flush()  # get agm.id

    # Create motions
    for motion_data in data.motions:
        motion = Motion(
            agm_id=agm.id,
            title=motion_data.title,
            description=motion_data.description,
            order_index=motion_data.order_index,
            motion_type=motion_data.motion_type,
        )
        db.add(motion)

    # Snapshot lot weights (include financial_position_snapshot)
    lot_owners_result = await db.execute(
        select(LotOwner).where(LotOwner.building_id == data.building_id)
    )
    lot_owners = list(lot_owners_result.scalars().all())

    for lot_owner in lot_owners:
        fp = lot_owner.financial_position
        fp_snapshot = FinancialPositionSnapshot(fp.value if hasattr(fp, "value") else fp)
        weight = AGMLotWeight(
            agm_id=agm.id,
            lot_owner_id=lot_owner.id,
            unit_entitlement_snapshot=lot_owner.unit_entitlement,
            financial_position_snapshot=fp_snapshot,
        )
        db.add(weight)

    await db.commit()
    await db.refresh(agm)

    # Load motions explicitly (avoid lazy load on async session)
    motions_result = await db.execute(
        select(Motion).where(Motion.agm_id == agm.id).order_by(Motion.order_index)
    )
    loaded_motions = list(motions_result.scalars().all())

    _ = building  # used for 404 check

    # Return as dict to avoid triggering lazy relationship loads during serialization
    return {
        "id": agm.id,
        "building_id": agm.building_id,
        "title": agm.title,
        "status": agm.status.value if hasattr(agm.status, "value") else agm.status,
        "meeting_at": agm.meeting_at,
        "voting_closes_at": agm.voting_closes_at,
        "motions": [
            {
                "id": m.id,
                "title": m.title,
                "description": m.description,
                "order_index": m.order_index,
                "motion_type": m.motion_type.value if hasattr(m.motion_type, "value") else m.motion_type,
            }
            for m in loaded_motions
        ],
    }


async def list_agms(db: AsyncSession) -> list[dict]:
    result = await db.execute(
        select(AGM, Building.name.label("building_name"))
        .join(Building, AGM.building_id == Building.id)
        .order_by(AGM.created_at.desc())
    )
    rows = result.all()
    items = []
    for agm, building_name in rows:
        items.append(
            {
                "id": agm.id,
                "building_id": agm.building_id,
                "building_name": building_name,
                "title": agm.title,
                "status": agm.status.value if hasattr(agm.status, "value") else agm.status,
                "meeting_at": agm.meeting_at,
                "voting_closes_at": agm.voting_closes_at,
                "created_at": agm.created_at,
            }
        )
    return items


async def get_agm_detail(agm_id: uuid.UUID, db: AsyncSession) -> dict:
    result = await db.execute(
        select(AGM, Building.name.label("building_name"))
        .join(Building, AGM.building_id == Building.id)
        .where(AGM.id == agm_id)
    )
    row = result.first()
    if row is None:
        raise HTTPException(status_code=404, detail="AGM not found")

    agm, building_name = row

    # Load motions
    motions_result = await db.execute(
        select(Motion).where(Motion.agm_id == agm_id).order_by(Motion.order_index)
    )
    motions = list(motions_result.scalars().all())

    # Load lot weights joined with lot_owner to get lot numbers
    weights_result = await db.execute(
        select(AGMLotWeight, LotOwner.lot_number.label("lot_number"))
        .join(LotOwner, AGMLotWeight.lot_owner_id == LotOwner.id)
        .where(AGMLotWeight.agm_id == agm_id)
    )
    weight_rows = weights_result.all()

    # Build per-lot_owner_id entitlement and lot info
    lot_entitlement: dict[uuid.UUID, int] = {}
    lot_info: dict[uuid.UUID, dict] = {}  # lot_owner_id -> {lot_number, emails, entitlement}

    for w, lot_num in weight_rows:
        lot_entitlement[w.lot_owner_id] = w.unit_entitlement_snapshot
        # Get emails for this lot owner
        emails_result = await db.execute(
            select(LotOwnerEmail.email).where(LotOwnerEmail.lot_owner_id == w.lot_owner_id)
        )
        emails = [r[0] for r in emails_result.all() if r[0]]
        lot_info[w.lot_owner_id] = {
            "lot_owner_id": w.lot_owner_id,
            "lot_number": lot_num,
            "emails": emails,
            "entitlement": w.unit_entitlement_snapshot,
        }

    # Fallback: if snapshot is empty
    if not lot_entitlement:
        current_result = await db.execute(
            select(LotOwner).where(LotOwner.building_id == agm.building_id)
        )
        for lo in current_result.scalars().all():
            lot_entitlement[lo.id] = lo.unit_entitlement
            emails_result = await db.execute(
                select(LotOwnerEmail.email).where(LotOwnerEmail.lot_owner_id == lo.id)
            )
            emails = [r[0] for r in emails_result.all() if r[0]]
            lot_info[lo.id] = {
                "lot_owner_id": lo.id,
                "lot_number": lo.lot_number,
                "emails": emails,
                "entitlement": lo.unit_entitlement,
            }

    eligible_lot_owner_ids: set[uuid.UUID] = set(lot_entitlement.keys())
    total_eligible_voters = len(eligible_lot_owner_ids)

    # Load ballot submissions
    submissions_result = await db.execute(
        select(BallotSubmission).where(BallotSubmission.agm_id == agm_id)
    )
    submissions = list(submissions_result.scalars().all())
    submitted_lot_owner_ids: set[uuid.UUID] = {s.lot_owner_id for s in submissions}
    total_submitted = len(submitted_lot_owner_ids)

    # Load submitted votes (joined with lot owner info via voter_email)
    votes_result = await db.execute(
        select(Vote).where(
            Vote.agm_id == agm_id,
            Vote.status == VoteStatus.submitted,
        )
    )
    submitted_votes = list(votes_result.scalars().all())

    def _tally(lot_owner_ids: set[uuid.UUID]) -> dict:
        return {
            "voter_count": len(lot_owner_ids),
            "entitlement_sum": sum(lot_entitlement.get(lid, 0) for lid in lot_owner_ids),
        }

    def _lots(lot_owner_ids: set[uuid.UUID]) -> list[dict]:
        result_list: list[dict] = []
        for lid in lot_owner_ids:
            info = lot_info.get(lid)
            if info:
                # Use first email as voter_email for backward compat display
                voter_email = info["emails"][0] if info["emails"] else ""
                result_list.append({
                    "voter_email": voter_email,
                    "lot_number": info["lot_number"],
                    "entitlement": info["entitlement"],
                })
        return result_list

    # Build per-motion tallies - votes now carry lot_owner_id directly
    # Also build lot_owner_id -> voter_email from submissions for tally
    lot_owner_to_email: dict[uuid.UUID, str] = {sub.lot_owner_id: sub.voter_email for sub in submissions}

    motion_details = []
    for motion in motions:
        # Group votes for this motion by lot_owner_id
        motion_votes: dict[uuid.UUID, str] = {}
        for vote in submitted_votes:
            if vote.motion_id == motion.id:
                lot_id = vote.lot_owner_id
                if lot_id is not None and lot_id in submitted_lot_owner_ids:
                    choice = vote.choice.value if vote.choice and hasattr(vote.choice, "value") else vote.choice
                    motion_votes[lot_id] = choice or "abstained"

        yes_ids: set[uuid.UUID] = set()
        no_ids: set[uuid.UUID] = set()
        abstained_ids: set[uuid.UUID] = set()
        not_eligible_ids: set[uuid.UUID] = set()

        for lot_id in submitted_lot_owner_ids:
            choice = motion_votes.get(lot_id, "abstained")
            if choice == "yes":
                yes_ids.add(lot_id)
            elif choice == "no":
                no_ids.add(lot_id)
            elif choice == "not_eligible":
                not_eligible_ids.add(lot_id)
            else:
                abstained_ids.add(lot_id)

        absent_ids: set[uuid.UUID] = eligible_lot_owner_ids - submitted_lot_owner_ids

        motion_details.append(
            {
                "id": motion.id,
                "title": motion.title,
                "description": motion.description,
                "order_index": motion.order_index,
                "motion_type": motion.motion_type.value if hasattr(motion.motion_type, "value") else motion.motion_type,
                "tally": {
                    "yes": _tally(yes_ids),
                    "no": _tally(no_ids),
                    "abstained": _tally(abstained_ids),
                    "absent": _tally(absent_ids),
                    "not_eligible": _tally(not_eligible_ids),
                },
                "voter_lists": {
                    "yes": _lots(yes_ids),
                    "no": _lots(no_ids),
                    "abstained": _lots(abstained_ids),
                    "absent": _lots(absent_ids),
                    "not_eligible": _lots(not_eligible_ids),
                },
            }
        )

    return {
        "id": agm.id,
        "building_name": building_name,
        "title": agm.title,
        "status": agm.status.value if hasattr(agm.status, "value") else agm.status,
        "meeting_at": agm.meeting_at,
        "voting_closes_at": agm.voting_closes_at,
        "closed_at": agm.closed_at,
        "total_eligible_voters": total_eligible_voters,
        "total_submitted": total_submitted,
        "motions": motion_details,
    }


async def close_agm(agm_id: uuid.UUID, db: AsyncSession, background_tasks=None) -> AGM:
    result = await db.execute(select(AGM).where(AGM.id == agm_id))
    agm = result.scalar_one_or_none()
    if agm is None:
        raise HTTPException(status_code=404, detail="AGM not found")
    if agm.status == AGMStatus.closed:
        raise HTTPException(status_code=409, detail="AGM is already closed")

    # Close the AGM
    agm.status = AGMStatus.closed
    agm.closed_at = datetime.now(UTC)

    # Delete draft votes
    await db.execute(
        delete(Vote).where(
            Vote.agm_id == agm_id,
            Vote.status == VoteStatus.draft,
        )
    )

    # Create EmailDelivery record
    email_delivery = EmailDelivery(
        agm_id=agm_id,
        status=EmailDeliveryStatus.pending,
        total_attempts=0,
    )
    db.add(email_delivery)

    await db.commit()
    await db.refresh(agm)

    # Stub: log email delivery trigger
    logger.info("Email delivery triggered for AGM %s", agm_id)

    return agm


async def resend_report(agm_id: uuid.UUID, db: AsyncSession) -> dict:
    result = await db.execute(select(AGM).where(AGM.id == agm_id))
    agm = result.scalar_one_or_none()
    if agm is None:
        raise HTTPException(status_code=404, detail="AGM not found")
    if agm.status == AGMStatus.open:
        raise HTTPException(status_code=409, detail="AGM is not closed")

    # Check EmailDelivery
    delivery_result = await db.execute(
        select(EmailDelivery).where(EmailDelivery.agm_id == agm_id)
    )
    delivery = delivery_result.scalar_one_or_none()
    if delivery is None:
        raise HTTPException(status_code=404, detail="Email delivery record not found")

    if delivery.status != EmailDeliveryStatus.failed:
        raise HTTPException(
            status_code=409,
            detail=f"Email delivery status is '{delivery.status.value}', not 'failed'",
        )

    # Reset delivery
    delivery.status = EmailDeliveryStatus.pending
    delivery.total_attempts = 0
    delivery.last_error = None
    delivery.next_retry_at = None

    await db.commit()

    # Stub: log email delivery trigger
    logger.info("Email delivery triggered for AGM %s", agm_id)

    return {"queued": True}


async def reset_agm_ballots(agm_id: uuid.UUID, db: AsyncSession) -> dict:
    """Delete all ballot submissions (and their associated submitted votes) for an AGM.

    Intended for E2E test setup only — clears submitted votes so the test
    suite can re-run the voting flow without hitting a 409 conflict.
    Returns the number of ballot submissions deleted.
    """
    result = await db.execute(select(AGM).where(AGM.id == agm_id))
    agm = result.scalar_one_or_none()
    if agm is None:
        raise HTTPException(status_code=404, detail="AGM not found")

    # Count submissions before deleting so we can return the count.
    count_result = await db.execute(
        select(func.count(BallotSubmission.id)).where(BallotSubmission.agm_id == agm_id)
    )
    deleted_count = count_result.scalar_one()

    # Delete submitted votes for this AGM (must come before ballot submissions
    # to avoid any application-level FK issues, even though there is no DB-level
    # FK from votes -> ballot_submissions).
    await db.execute(
        delete(Vote).where(Vote.agm_id == agm_id, Vote.status == VoteStatus.submitted)
    )

    # Delete all ballot submissions for this AGM.
    await db.execute(
        delete(BallotSubmission).where(BallotSubmission.agm_id == agm_id)
    )

    await db.commit()

    return {"deleted": deleted_count}


# ---------------------------------------------------------------------------
# Proxy nomination import (US-PX02)
# ---------------------------------------------------------------------------


def _parse_proxy_csv_rows(content: bytes) -> list[dict]:
    """Parse CSV bytes into list of {lot_number, proxy_email} dicts.

    Raises HTTPException 422 on missing headers.
    """
    text = content.decode("utf-8-sig")
    raw_reader = csv.DictReader(io.StringIO(text))

    if raw_reader.fieldnames is None:
        raise HTTPException(status_code=422, detail="CSV has no headers")

    normalised = {f.strip().lower() for f in raw_reader.fieldnames}
    required = {"lot#", "proxy email"}
    missing = required - normalised
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Missing required CSV headers: {sorted(missing)}",
        )

    rows = []
    for row in raw_reader:
        lot_number = row.get("Lot#") or row.get("lot#") or ""
        # Build a case-insensitive lookup
        row_lower = {k.strip().lower(): v for k, v in row.items()}
        lot_number = row_lower.get("lot#", "").strip()
        proxy_email = row_lower.get("proxy email", "").strip()
        rows.append({"lot_number": lot_number, "proxy_email": proxy_email})
    return rows


def _parse_proxy_excel_rows(content: bytes) -> list[dict]:
    """Parse Excel bytes into list of {lot_number, proxy_email} dicts.

    Raises HTTPException 422 on invalid file or missing headers.
    """
    try:
        wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid Excel file: {exc}") from exc

    ws = wb.worksheets[0]
    rows_iter = ws.iter_rows(values_only=True)

    try:
        header_row = next(rows_iter)
    except StopIteration:
        raise HTTPException(status_code=422, detail="Excel file has no headers")

    if header_row is None or all(v is None for v in header_row):  # pragma: no cover
        raise HTTPException(status_code=422, detail="Excel file has no headers")

    headers = [str(h).strip().lower() if h is not None else "" for h in header_row]

    required = {"lot#", "proxy email"}
    missing = required - set(headers)
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Missing required Excel headers: {sorted(missing)}",
        )

    lot_idx = headers.index("lot#")
    proxy_idx = headers.index("proxy email")

    data_rows = list(rows_iter)
    wb.close()

    rows = []
    for raw_row in data_rows:
        if all(v is None or str(v).strip() == "" for v in raw_row):
            continue

        def _cell(idx: int) -> str:
            if idx < len(raw_row) and raw_row[idx] is not None:
                return str(raw_row[idx]).strip()
            return ""

        rows.append({
            "lot_number": _cell(lot_idx),
            "proxy_email": _cell(proxy_idx),
        })
    return rows


async def import_proxies(
    building_id: uuid.UUID,
    rows: list[dict],
    db: AsyncSession,
) -> dict[str, int]:
    """Upsert proxy nominations from parsed rows.

    Each row: {lot_number: str, proxy_email: str}.
    Blank proxy_email removes the nomination.
    Unknown lot_number is skipped with a warning.
    Returns {"upserted": N, "removed": N, "skipped": N}.
    """
    await get_building_or_404(building_id, db)

    # Load all lot owners for this building keyed by lot_number
    existing_result = await db.execute(
        select(LotOwner).where(LotOwner.building_id == building_id)
    )
    lot_owner_map: dict[str, LotOwner] = {
        lo.lot_number: lo for lo in existing_result.scalars().all()
    }

    upserted = 0
    removed = 0
    skipped = 0

    for row in rows:
        lot_number = row["lot_number"]
        proxy_email = row["proxy_email"]

        lot_owner = lot_owner_map.get(lot_number)
        if lot_owner is None:
            logger.warning(
                "Proxy import: lot_number %r not found in building %s — skipping",
                lot_number,
                building_id,
            )
            skipped += 1
            continue

        # Load existing proxy for this lot owner
        proxy_result = await db.execute(
            select(LotProxy).where(LotProxy.lot_owner_id == lot_owner.id)
        )
        existing_proxy = proxy_result.scalar_one_or_none()

        if proxy_email == "":
            # Remove nomination
            if existing_proxy is not None:
                await db.delete(existing_proxy)
                removed += 1
        else:
            # Upsert nomination
            if existing_proxy is not None:
                existing_proxy.proxy_email = proxy_email
            else:
                db.add(LotProxy(lot_owner_id=lot_owner.id, proxy_email=proxy_email))
            upserted += 1

    await db.commit()
    return {"upserted": upserted, "removed": removed, "skipped": skipped}


async def import_proxies_from_csv(
    building_id: uuid.UUID,
    content: bytes,
    db: AsyncSession,
) -> dict[str, int]:
    rows = _parse_proxy_csv_rows(content)
    return await import_proxies(building_id, rows, db)


async def import_proxies_from_excel(
    building_id: uuid.UUID,
    content: bytes,
    db: AsyncSession,
) -> dict[str, int]:
    rows = _parse_proxy_excel_rows(content)
    return await import_proxies(building_id, rows, db)


# ---------------------------------------------------------------------------
# Financial position import (US-PX03)
# ---------------------------------------------------------------------------


def _parse_financial_position_import(raw: str) -> FinancialPosition | None:
    """Parse a financial position string from an import row.

    Accepted values (case-insensitive): 'Normal' -> normal, 'In Arrear' -> in_arrear.
    Returns None if empty (should be skipped or flagged).
    Raises ValueError on invalid value.
    """
    normalised = raw.strip().lower()
    if normalised == "normal":
        return FinancialPosition.normal
    if normalised in ("in arrear", "in_arrear"):
        return FinancialPosition.in_arrear
    raise ValueError(f"Invalid Financial Position value: '{raw}'")


def _parse_financial_position_csv_rows(content: bytes) -> list[dict]:
    """Parse CSV bytes into list of {lot_number, financial_position_raw} dicts.

    Raises HTTPException 422 on missing headers.
    """
    text = content.decode("utf-8-sig")
    raw_reader = csv.DictReader(io.StringIO(text))

    if raw_reader.fieldnames is None:
        raise HTTPException(status_code=422, detail="CSV has no headers")

    normalised = {f.strip().lower() for f in raw_reader.fieldnames}
    required = {"lot#", "financial position"}
    missing = required - normalised
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Missing required CSV headers: {sorted(missing)}",
        )

    rows = []
    for row in raw_reader:
        row_lower = {k.strip().lower(): v for k, v in row.items()}
        lot_number = row_lower.get("lot#", "").strip()
        fp_raw = row_lower.get("financial position", "").strip()
        rows.append({"lot_number": lot_number, "financial_position_raw": fp_raw})
    return rows


def _parse_financial_position_excel_rows(content: bytes) -> list[dict]:
    """Parse Excel bytes into list of {lot_number, financial_position_raw} dicts.

    Raises HTTPException 422 on invalid file or missing headers.
    """
    try:
        wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid Excel file: {exc}") from exc

    ws = wb.worksheets[0]
    rows_iter = ws.iter_rows(values_only=True)

    try:
        header_row = next(rows_iter)
    except StopIteration:
        raise HTTPException(status_code=422, detail="Excel file has no headers")

    if header_row is None or all(v is None for v in header_row):  # pragma: no cover
        raise HTTPException(status_code=422, detail="Excel file has no headers")

    headers = [str(h).strip().lower() if h is not None else "" for h in header_row]

    required = {"lot#", "financial position"}
    missing = required - set(headers)
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Missing required Excel headers: {sorted(missing)}",
        )

    lot_idx = headers.index("lot#")
    fp_idx = headers.index("financial position")

    data_rows = list(rows_iter)
    wb.close()

    rows = []
    for raw_row in data_rows:
        if all(v is None or str(v).strip() == "" for v in raw_row):
            continue

        def _cell(idx: int) -> str:
            if idx < len(raw_row) and raw_row[idx] is not None:
                return str(raw_row[idx]).strip()
            return ""

        rows.append({
            "lot_number": _cell(lot_idx),
            "financial_position_raw": _cell(fp_idx),
        })
    return rows


async def import_financial_positions(
    building_id: uuid.UUID,
    rows: list[dict],
    db: AsyncSession,
) -> dict[str, int]:
    """Update financial positions from parsed rows.

    Each row: {lot_number: str, financial_position_raw: str}.
    Unknown lot_number is skipped.
    Invalid financial_position_raw raises 422 with all offending rows listed.
    Returns {"updated": N, "skipped": N}.
    """
    await get_building_or_404(building_id, db)

    # Validate all rows first to collect errors
    errors: list[str] = []
    for i, row in enumerate(rows, start=2):
        raw = row["financial_position_raw"]
        if raw == "":
            errors.append(f"Row {i}: Financial Position is empty")
            continue
        try:
            _parse_financial_position_import(raw)
        except ValueError as exc:
            errors.append(f"Row {i}: {exc}")

    if errors:
        raise HTTPException(status_code=422, detail=errors)

    # Load all lot owners for this building keyed by lot_number
    existing_result = await db.execute(
        select(LotOwner).where(LotOwner.building_id == building_id)
    )
    lot_owner_map: dict[str, LotOwner] = {
        lo.lot_number: lo for lo in existing_result.scalars().all()
    }

    updated = 0
    skipped = 0

    for row in rows:
        lot_number = row["lot_number"]
        fp_raw = row["financial_position_raw"]

        lot_owner = lot_owner_map.get(lot_number)
        if lot_owner is None:
            logger.warning(
                "Financial position import: lot_number %r not found in building %s — skipping",
                lot_number,
                building_id,
            )
            skipped += 1
            continue

        fp = _parse_financial_position_import(fp_raw)
        lot_owner.financial_position = fp  # type: ignore[assignment]
        updated += 1

    await db.commit()
    return {"updated": updated, "skipped": skipped}


async def import_financial_positions_from_csv(
    building_id: uuid.UUID,
    content: bytes,
    db: AsyncSession,
) -> dict[str, int]:
    rows = _parse_financial_position_csv_rows(content)
    return await import_financial_positions(building_id, rows, db)


async def import_financial_positions_from_excel(
    building_id: uuid.UUID,
    content: bytes,
    db: AsyncSession,
) -> dict[str, int]:
    rows = _parse_financial_position_excel_rows(content)
    return await import_financial_positions(building_id, rows, db)
