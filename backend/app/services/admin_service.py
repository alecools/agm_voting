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
    LotOwner,
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


async def list_buildings(db: AsyncSession) -> list[Building]:
    result = await db.execute(select(Building).order_by(Building.created_at))
    return list(result.scalars().all())


# ---------------------------------------------------------------------------
# Lot owners
# ---------------------------------------------------------------------------


async def get_building_or_404(building_id: uuid.UUID, db: AsyncSession) -> Building:
    result = await db.execute(select(Building).where(Building.id == building_id))
    building = result.scalar_one_or_none()
    if building is None:
        raise HTTPException(status_code=404, detail="Building not found")
    return building


async def list_lot_owners(building_id: uuid.UUID, db: AsyncSession) -> list[LotOwner]:
    await get_building_or_404(building_id, db)
    result = await db.execute(
        select(LotOwner).where(LotOwner.building_id == building_id)
    )
    return list(result.scalars().all())


async def import_lot_owners_from_csv(
    building_id: uuid.UUID,
    content: bytes,
    db: AsyncSession,
) -> dict[str, int]:
    """
    Parse a CSV of lot owners and replace all existing lot owners for the building.
    Returns {"imported": int}.
    """
    await get_building_or_404(building_id, db)

    text = content.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))

    required_headers = {"lot_number", "email", "unit_entitlement"}
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

    errors: list[str] = []
    seen_lot_numbers: dict[str, int] = {}
    parsed_rows: list[dict] = []

    for i, row in enumerate(rows, start=2):
        lot_number = row.get("lot_number", "").strip()
        email = row.get("email", "").strip()
        unit_entitlement_raw = row.get("unit_entitlement", "").strip()

        row_errors = []

        if not lot_number:
            row_errors.append(f"Row {i}: lot_number is empty")
        else:
            if lot_number in seen_lot_numbers:
                row_errors.append(
                    f"Row {i}: duplicate lot_number '{lot_number}' (first seen at row {seen_lot_numbers[lot_number]})"
                )
            else:
                seen_lot_numbers[lot_number] = i

        if not email:
            row_errors.append(f"Row {i}: email is empty")

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

        if row_errors:
            errors.extend(row_errors)
        else:
            parsed_rows.append(
                {
                    "lot_number": lot_number,
                    "email": email,
                    "unit_entitlement": unit_entitlement,
                }
            )

    if errors:
        raise HTTPException(status_code=422, detail=errors)

    # Load existing lot owners keyed by lot_number to preserve IDs
    # (and therefore AGMLotWeight snapshots for open/closed AGMs)
    existing_result = await db.execute(
        select(LotOwner).where(LotOwner.building_id == building_id)
    )
    existing: dict[str, LotOwner] = {
        lo.lot_number: lo for lo in existing_result.scalars().all()
    }

    new_lot_numbers: set[str] = {row["lot_number"] for row in parsed_rows}

    # Upsert: update existing, insert new
    for row_data in parsed_rows:
        if row_data["lot_number"] in existing:
            lo = existing[row_data["lot_number"]]
            lo.email = row_data["email"]
            lo.unit_entitlement = row_data["unit_entitlement"]
        else:
            db.add(LotOwner(
                building_id=building_id,
                lot_number=row_data["lot_number"],
                email=row_data["email"],
                unit_entitlement=row_data["unit_entitlement"],
            ))

    # Delete lot owners that are no longer in the import
    for lot_number, lo in existing.items():
        if lot_number not in new_lot_numbers:
            await db.delete(lo)

    await db.commit()
    return {"imported": len(parsed_rows)}


async def import_lot_owners_from_excel(
    building_id: uuid.UUID,
    content: bytes,
    db: AsyncSession,
) -> dict[str, int]:
    """
    Parse an Excel file of lot owners and replace all existing lot owners for the building.
    Required columns (case-insensitive): Lot#, UOE2, Email.
    Returns {"imported": int}.
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

    required_headers = {"lot#", "uoe2", "email"}
    missing = required_headers - set(headers)
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Missing required Excel headers: {sorted(missing)}",
        )

    lot_idx = headers.index("lot#")
    uoe2_idx = headers.index("uoe2")
    email_idx = headers.index("email")

    data_rows = list(rows_iter)
    wb.close()

    errors: list[str] = []
    seen_lot_numbers: dict[str, int] = {}
    parsed_rows: list[dict] = []

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

        lot_number = _cell(lot_idx)
        email = _cell(email_idx)
        unit_entitlement_raw = _cell(uoe2_idx)

        row_errors = []

        if not lot_number:
            row_errors.append(f"Row {row_num}: lot_number is empty")
        else:
            if lot_number in seen_lot_numbers:
                row_errors.append(
                    f"Row {row_num}: duplicate lot_number '{lot_number}' (first seen at row {seen_lot_numbers[lot_number]})"
                )
            else:
                seen_lot_numbers[lot_number] = row_num

        if not email:
            row_errors.append(f"Row {row_num}: email is empty")

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

        if row_errors:
            errors.extend(row_errors)
        else:
            parsed_rows.append(
                {
                    "lot_number": lot_number,
                    "email": email,
                    "unit_entitlement": unit_entitlement,
                }
            )

    if errors:
        raise HTTPException(status_code=422, detail=errors)

    # Load existing lot owners keyed by lot_number to preserve IDs
    # (and therefore AGMLotWeight snapshots for open/closed AGMs)
    existing_result = await db.execute(
        select(LotOwner).where(LotOwner.building_id == building_id)
    )
    existing: dict[str, LotOwner] = {
        lo.lot_number: lo for lo in existing_result.scalars().all()
    }

    new_lot_numbers: set[str] = {row["lot_number"] for row in parsed_rows}

    # Upsert: update existing, insert new
    for row_data in parsed_rows:
        if row_data["lot_number"] in existing:
            lo = existing[row_data["lot_number"]]
            lo.email = row_data["email"]
            lo.unit_entitlement = row_data["unit_entitlement"]
        else:
            db.add(LotOwner(
                building_id=building_id,
                lot_number=row_data["lot_number"],
                email=row_data["email"],
                unit_entitlement=row_data["unit_entitlement"],
            ))

    # Delete lot owners that are no longer in the import
    for lot_number, lo in existing.items():
        if lot_number not in new_lot_numbers:
            await db.delete(lo)

    await db.commit()
    return {"imported": len(parsed_rows)}


async def add_lot_owner(
    building_id: uuid.UUID,
    data: LotOwnerCreate,
    db: AsyncSession,
) -> LotOwner:
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
        email=data.email,
        unit_entitlement=data.unit_entitlement,
    )
    db.add(lot_owner)
    await db.commit()
    await db.refresh(lot_owner)
    return lot_owner


async def update_lot_owner(
    lot_owner_id: uuid.UUID,
    data: LotOwnerUpdate,
    db: AsyncSession,
) -> LotOwner:
    result = await db.execute(
        select(LotOwner).where(LotOwner.id == lot_owner_id)
    )
    lot_owner = result.scalar_one_or_none()
    if lot_owner is None:
        raise HTTPException(status_code=404, detail="Lot owner not found")

    if data.email is not None:
        lot_owner.email = data.email
    if data.unit_entitlement is not None:
        lot_owner.unit_entitlement = data.unit_entitlement

    await db.commit()
    await db.refresh(lot_owner)
    return lot_owner


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
        )
        db.add(motion)

    # Snapshot lot weights
    lot_owners_result = await db.execute(
        select(LotOwner).where(LotOwner.building_id == data.building_id)
    )
    lot_owners = list(lot_owners_result.scalars().all())

    for lot_owner in lot_owners:
        weight = AGMLotWeight(
            agm_id=agm.id,
            lot_owner_id=lot_owner.id,
            voter_email=lot_owner.email,
            unit_entitlement_snapshot=lot_owner.unit_entitlement,
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

    # Load lot weights (snapshot)
    weights_result = await db.execute(
        select(AGMLotWeight).where(AGMLotWeight.agm_id == agm_id)
    )
    weights = list(weights_result.scalars().all())

    # Total eligible voters = distinct voter emails in agm_lot_weights
    eligible_emails: set[str] = {w.voter_email for w in weights}
    total_eligible_voters = len(eligible_emails)

    # Load ballot submissions
    submissions_result = await db.execute(
        select(BallotSubmission).where(BallotSubmission.agm_id == agm_id)
    )
    submissions = list(submissions_result.scalars().all())
    submitted_emails: set[str] = {s.voter_email for s in submissions}
    total_submitted = len(submitted_emails)

    # Load submitted votes
    votes_result = await db.execute(
        select(Vote).where(
            Vote.agm_id == agm_id,
            Vote.status == VoteStatus.submitted,
        )
    )
    submitted_votes = list(votes_result.scalars().all())

    # Build per-voter entitlement from snapshot (sum over all lots for same email)
    voter_entitlement: dict[str, int] = {}
    for w in weights:
        voter_entitlement[w.voter_email] = (
            voter_entitlement.get(w.voter_email, 0) + w.unit_entitlement_snapshot
        )

    # Build per-motion tallies
    motion_details = []
    for motion in motions:
        # Group votes for this motion by email
        motion_votes: dict[str, str] = {}
        for vote in submitted_votes:
            if vote.motion_id == motion.id:
                # Only count voters who submitted
                if vote.voter_email in submitted_emails:
                    choice = vote.choice.value if vote.choice and hasattr(vote.choice, "value") else vote.choice
                    motion_votes[vote.voter_email] = choice or "abstained"

        yes_voters: list[dict] = []
        no_voters: list[dict] = []
        abstained_voters: list[dict] = []
        absent_voters: list[dict] = []

        # Submitted voters: categorize by vote choice
        for email in submitted_emails:
            entitlement = voter_entitlement.get(email, 0)
            choice = motion_votes.get(email, "abstained")
            entry = {"voter_email": email, "entitlement": entitlement}
            if choice == "yes":
                yes_voters.append(entry)
            elif choice == "no":
                no_voters.append(entry)
            else:
                abstained_voters.append(entry)

        # Absent voters: in eligible but not submitted
        for email in eligible_emails - submitted_emails:
            entitlement = voter_entitlement.get(email, 0)
            absent_voters.append({"voter_email": email, "entitlement": entitlement})

        def _tally(voter_list: list[dict]) -> dict:
            return {
                "voter_count": len(voter_list),
                "entitlement_sum": sum(v["entitlement"] for v in voter_list),
            }

        motion_details.append(
            {
                "id": motion.id,
                "title": motion.title,
                "description": motion.description,
                "order_index": motion.order_index,
                "tally": {
                    "yes": _tally(yes_voters),
                    "no": _tally(no_voters),
                    "abstained": _tally(abstained_voters),
                    "absent": _tally(absent_voters),
                },
                "voter_lists": {
                    "yes": yes_voters,
                    "no": no_voters,
                    "abstained": abstained_voters,
                    "absent": absent_voters,
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
