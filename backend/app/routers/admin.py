"""
Admin portal API router.
All endpoints are under /api/admin prefix (set in main.py).
Authentication is required via the require_admin dependency.
"""
from __future__ import annotations

import asyncio
import os
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.routers.admin_auth import require_admin
from app.services.email_service import EmailService
from app.schemas.admin import (
    AGMBallotResetOut,
    AGMCloseOut,
    AGMCreate,
    AGMDetail,
    AGMListItem,
    AGMOut,
    BuildingArchiveOut,
    BuildingCreate,
    BuildingImportResult,
    BuildingOut,
    LotOwnerCreate,
    LotOwnerImportResult,
    LotOwnerOut,
    LotOwnerUpdate,
    ResendReportOut,
)
from app.services import admin_service

router = APIRouter(tags=["admin"], dependencies=[Depends(require_admin)])

_CSV_CONTENT_TYPES = {
    "text/csv",
    "application/csv",
    "text/plain",
    "text/x-csv",
    "application/octet-stream",
}

_EXCEL_CONTENT_TYPES = {
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
}

_EXCEL_EXTENSIONS = {".xlsx", ".xls"}


def _detect_file_format(file: UploadFile) -> str:
    """Return 'csv' or 'excel'. Raise 415 if neither.

    Extension takes precedence over content-type because browsers and HTTP
    clients often send a generic content-type (e.g. application/octet-stream)
    for both CSV and Excel files.
    """
    content_type = (file.content_type or "").lower().split(";")[0].strip()
    filename = (file.filename or "").lower()
    ext = os.path.splitext(filename)[1]

    if ext == ".csv":
        return "csv"
    if ext in _EXCEL_EXTENSIONS:
        return "excel"
    if content_type in _CSV_CONTENT_TYPES:
        return "csv"
    if content_type in _EXCEL_CONTENT_TYPES:
        return "excel"
    raise HTTPException(
        status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        detail="File must be a CSV or Excel file",
    )


# ---------------------------------------------------------------------------
# Buildings
# ---------------------------------------------------------------------------


@router.post(
    "/buildings/import",
    response_model=BuildingImportResult,
    status_code=status.HTTP_200_OK,
)
async def import_buildings(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> BuildingImportResult:
    fmt = _detect_file_format(file)
    content = await file.read()
    if fmt == "csv":
        result = await admin_service.import_buildings_from_csv(content, db)
    else:
        result = await admin_service.import_buildings_from_excel(content, db)
    return BuildingImportResult(**result)


@router.post(
    "/buildings",
    response_model=BuildingOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_building(
    data: BuildingCreate,
    db: AsyncSession = Depends(get_db),
) -> BuildingOut:
    building = await admin_service.create_building(data.name, data.manager_email, db)
    return BuildingOut.model_validate(building)


@router.get("/buildings", response_model=list[BuildingOut])
async def list_buildings(
    db: AsyncSession = Depends(get_db),
) -> list[BuildingOut]:
    buildings = await admin_service.list_buildings(db)
    return [BuildingOut.model_validate(b) for b in buildings]


@router.post(
    "/buildings/{building_id}/archive",
    response_model=BuildingArchiveOut,
)
async def archive_building(
    building_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> BuildingArchiveOut:
    building = await admin_service.archive_building(building_id, db)
    return BuildingArchiveOut.model_validate(building)


# ---------------------------------------------------------------------------
# Lot owners
# ---------------------------------------------------------------------------


@router.get(
    "/buildings/{building_id}/lot-owners",
    response_model=list[LotOwnerOut],
)
async def list_lot_owners(
    building_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> list[LotOwnerOut]:
    owners = await admin_service.list_lot_owners(building_id, db)
    return [LotOwnerOut.model_validate(o) for o in owners]


@router.post(
    "/buildings/{building_id}/lot-owners/import",
    response_model=LotOwnerImportResult,
    status_code=status.HTTP_200_OK,
)
async def import_lot_owners(
    building_id: uuid.UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> LotOwnerImportResult:
    fmt = _detect_file_format(file)
    content = await file.read()
    if fmt == "csv":
        result = await admin_service.import_lot_owners_from_csv(building_id, content, db)
    else:
        result = await admin_service.import_lot_owners_from_excel(building_id, content, db)
    return LotOwnerImportResult(**result)


@router.post(
    "/buildings/{building_id}/lot-owners",
    response_model=LotOwnerOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_lot_owner(
    building_id: uuid.UUID,
    data: LotOwnerCreate,
    db: AsyncSession = Depends(get_db),
) -> LotOwnerOut:
    owner = await admin_service.add_lot_owner(building_id, data, db)
    return LotOwnerOut.model_validate(owner)


@router.patch(
    "/lot-owners/{lot_owner_id}",
    response_model=LotOwnerOut,
)
async def update_lot_owner(
    lot_owner_id: uuid.UUID,
    data: LotOwnerUpdate,
    db: AsyncSession = Depends(get_db),
) -> LotOwnerOut:
    owner = await admin_service.update_lot_owner(lot_owner_id, data, db)
    return LotOwnerOut.model_validate(owner)


# ---------------------------------------------------------------------------
# AGMs
# ---------------------------------------------------------------------------


@router.post(
    "/agms",
    response_model=AGMOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_agm(
    data: AGMCreate,
    db: AsyncSession = Depends(get_db),
) -> AGMOut:
    agm_dict = await admin_service.create_agm(data, db)
    return AGMOut(**agm_dict)


@router.get("/agms", response_model=list[AGMListItem])
async def list_agms(
    db: AsyncSession = Depends(get_db),
) -> list[AGMListItem]:
    items = await admin_service.list_agms(db)
    return [AGMListItem(**item) for item in items]


@router.get("/agms/{agm_id}", response_model=AGMDetail)
async def get_agm_detail(
    agm_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> AGMDetail:
    detail = await admin_service.get_agm_detail(agm_id, db)
    return AGMDetail(**detail)


@router.post(
    "/agms/{agm_id}/close",
    response_model=AGMCloseOut,
)
async def close_agm(
    agm_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> AGMCloseOut:
    agm = await admin_service.close_agm(agm_id, db)
    email_service = EmailService()
    asyncio.create_task(email_service.trigger_with_retry(agm.id))
    return AGMCloseOut(
        id=agm.id,
        status=agm.status.value if hasattr(agm.status, "value") else agm.status,
        closed_at=agm.closed_at,
    )


@router.post(
    "/agms/{agm_id}/resend-report",
    response_model=ResendReportOut,
)
async def resend_report(
    agm_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> ResendReportOut:
    result = await admin_service.resend_report(agm_id, db)
    email_service = EmailService()
    asyncio.create_task(email_service.trigger_with_retry(agm_id))
    return ResendReportOut(**result)


@router.delete(
    "/agms/{agm_id}/ballots",
    response_model=AGMBallotResetOut,
)
async def reset_agm_ballots(
    agm_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> AGMBallotResetOut:
    """Delete all ballot submissions for an AGM.

    Intended for E2E test setup only — clears submitted votes so the test
    suite can re-run the voting flow without hitting a 409 conflict.
    """
    result = await admin_service.reset_agm_ballots(agm_id, db)
    return AGMBallotResetOut(**result)
