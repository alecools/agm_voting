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
    AddEmailRequest,
    GeneralMeetingBallotResetOut,
    GeneralMeetingCloseOut,
    GeneralMeetingCreate,
    GeneralMeetingDetail,
    GeneralMeetingListItem,
    GeneralMeetingOut,
    GeneralMeetingStartOut,
    BuildingArchiveOut,
    BuildingCreate,
    BuildingImportResult,
    BuildingOut,
    BuildingUpdate,
    FinancialPositionImportResult,
    LotOwnerCreate,
    LotOwnerImportResult,
    LotOwnerOut,
    LotOwnerUpdate,
    MotionAddRequest,
    MotionDetail,
    MotionOut,
    MotionUpdateRequest,
    MotionVisibilityOut,
    MotionVisibilityRequest,
    ProxyImportResult,
    ResendReportOut,
    SetProxyRequest,
)
from app.schemas.config import TenantConfigOut, TenantConfigUpdate
from app.services import admin_service
from app.services import config_service

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


@router.patch("/buildings/{building_id}", response_model=BuildingOut)
async def update_building(
    building_id: uuid.UUID,
    data: BuildingUpdate,
    db: AsyncSession = Depends(get_db),
) -> BuildingOut:
    building = await admin_service.update_building(building_id, data, db)
    return BuildingOut.model_validate(building)


@router.delete("/buildings/{building_id}", status_code=204)
async def delete_building(
    building_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> None:
    await admin_service.delete_building(building_id, db)


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
    return [LotOwnerOut(**o) for o in owners]


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
    "/buildings/{building_id}/lot-owners/import-proxies",
    response_model=ProxyImportResult,
    status_code=status.HTTP_200_OK,
)
async def import_proxy_nominations(
    building_id: uuid.UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> ProxyImportResult:
    fmt = _detect_file_format(file)
    content = await file.read()
    if fmt == "csv":
        result = await admin_service.import_proxies_from_csv(building_id, content, db)
    else:
        result = await admin_service.import_proxies_from_excel(building_id, content, db)
    return ProxyImportResult(**result)


@router.post(
    "/buildings/{building_id}/lot-owners/import-financial-positions",
    response_model=FinancialPositionImportResult,
    status_code=status.HTTP_200_OK,
)
async def import_financial_positions(
    building_id: uuid.UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> FinancialPositionImportResult:
    fmt = _detect_file_format(file)
    content = await file.read()
    if fmt == "csv":
        result = await admin_service.import_financial_positions_from_csv(building_id, content, db)
    else:
        result = await admin_service.import_financial_positions_from_excel(building_id, content, db)
    return FinancialPositionImportResult(**result)


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
    return LotOwnerOut(**owner)


@router.get(
    "/lot-owners/{lot_owner_id}",
    response_model=LotOwnerOut,
)
async def get_lot_owner(
    lot_owner_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> LotOwnerOut:
    owner = await admin_service.get_lot_owner(lot_owner_id, db)
    return LotOwnerOut(**owner)


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
    return LotOwnerOut(**owner)


@router.post(
    "/lot-owners/{lot_owner_id}/emails",
    response_model=LotOwnerOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_email_to_lot_owner(
    lot_owner_id: uuid.UUID,
    data: AddEmailRequest,
    db: AsyncSession = Depends(get_db),
) -> LotOwnerOut:
    """Add an email address to a lot owner."""
    owner = await admin_service.add_email_to_lot_owner(lot_owner_id, data.email, db)
    return LotOwnerOut(**owner)


@router.delete(
    "/lot-owners/{lot_owner_id}/emails/{email}",
    response_model=LotOwnerOut,
)
async def remove_email_from_lot_owner(
    lot_owner_id: uuid.UUID,
    email: str,
    db: AsyncSession = Depends(get_db),
) -> LotOwnerOut:
    """Remove an email address from a lot owner."""
    owner = await admin_service.remove_email_from_lot_owner(lot_owner_id, email, db)
    return LotOwnerOut(**owner)


@router.put(
    "/lot-owners/{lot_owner_id}/proxy",
    response_model=LotOwnerOut,
)
async def set_lot_owner_proxy(
    lot_owner_id: uuid.UUID,
    data: SetProxyRequest,
    db: AsyncSession = Depends(get_db),
) -> LotOwnerOut:
    """Set or replace the proxy nomination for a lot owner."""
    owner = await admin_service.set_lot_owner_proxy(lot_owner_id, data.proxy_email, db)
    return LotOwnerOut(**owner)


@router.delete(
    "/lot-owners/{lot_owner_id}/proxy",
    response_model=LotOwnerOut,
)
async def remove_lot_owner_proxy(
    lot_owner_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> LotOwnerOut:
    """Remove the proxy nomination for a lot owner."""
    owner = await admin_service.remove_lot_owner_proxy(lot_owner_id, db)
    return LotOwnerOut(**owner)


# ---------------------------------------------------------------------------
# Motions
# ---------------------------------------------------------------------------


@router.patch("/motions/{motion_id}/visibility", response_model=MotionDetail)
async def toggle_motion_visibility_endpoint(
    motion_id: uuid.UUID,
    data: MotionVisibilityRequest,
    db: AsyncSession = Depends(get_db),
) -> MotionDetail:
    """Toggle the visibility of a motion. Requires admin auth.

    Returns 200 with updated motion detail on success.
    Returns 404 if motion not found.
    Returns 409 if meeting is closed or if hiding a motion that has votes.
    """
    result = await admin_service.toggle_motion_visibility(motion_id, data.is_visible, db)
    return MotionDetail(**result)


@router.post(
    "/general-meetings/{general_meeting_id}/motions",
    response_model=MotionOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_motion_to_meeting_endpoint(
    general_meeting_id: uuid.UUID,
    data: MotionAddRequest,
    db: AsyncSession = Depends(get_db),
) -> MotionOut:
    """Add a new motion to an existing General Meeting.

    Returns 201 with the created motion.
    Returns 404 if the meeting does not exist.
    Returns 409 if the meeting is closed.
    """
    result = await admin_service.add_motion_to_meeting(general_meeting_id, data, db)
    return MotionOut(**result)


@router.patch(
    "/motions/{motion_id}",
    response_model=MotionVisibilityOut,
    status_code=status.HTTP_200_OK,
)
async def update_motion_endpoint(
    motion_id: uuid.UUID,
    data: MotionUpdateRequest,
    db: AsyncSession = Depends(get_db),
) -> MotionVisibilityOut:
    """Edit title, description, or motion_type of a hidden motion.

    Returns 200 with the updated motion.
    Returns 404 if the motion does not exist.
    Returns 409 if the motion is visible or the meeting is closed.
    """
    result = await admin_service.update_motion(motion_id, data, db)
    return MotionVisibilityOut(**result)


@router.delete(
    "/motions/{motion_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_motion_endpoint(
    motion_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Delete a hidden motion permanently.

    Returns 204 on success.
    Returns 404 if the motion does not exist.
    Returns 409 if the motion is visible or the meeting is closed.
    """
    await admin_service.delete_motion(motion_id, db)


# ---------------------------------------------------------------------------
# General Meetings
# ---------------------------------------------------------------------------


@router.post(
    "/general-meetings",
    response_model=GeneralMeetingOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_general_meeting(
    data: GeneralMeetingCreate,
    db: AsyncSession = Depends(get_db),
) -> GeneralMeetingOut:
    meeting_dict = await admin_service.create_general_meeting(data, db)
    return GeneralMeetingOut(**meeting_dict)


@router.get("/general-meetings", response_model=list[GeneralMeetingListItem])
async def list_general_meetings(
    db: AsyncSession = Depends(get_db),
) -> list[GeneralMeetingListItem]:
    items = await admin_service.list_general_meetings(db)
    return [GeneralMeetingListItem(**item) for item in items]


@router.get("/general-meetings/{general_meeting_id}", response_model=GeneralMeetingDetail)
async def get_general_meeting_detail(
    general_meeting_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> GeneralMeetingDetail:
    detail = await admin_service.get_general_meeting_detail(general_meeting_id, db)
    return GeneralMeetingDetail(**detail)


@router.post(
    "/general-meetings/{general_meeting_id}/start",
    response_model=GeneralMeetingStartOut,
)
async def start_general_meeting_endpoint(
    general_meeting_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> GeneralMeetingStartOut:
    meeting = await admin_service.start_general_meeting(general_meeting_id, db)
    return GeneralMeetingStartOut(
        id=meeting.id,
        status=meeting.status.value if hasattr(meeting.status, "value") else meeting.status,
        meeting_at=meeting.meeting_at,
    )


@router.post(
    "/general-meetings/{general_meeting_id}/close",
    response_model=GeneralMeetingCloseOut,
)
async def close_general_meeting(
    general_meeting_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> GeneralMeetingCloseOut:
    meeting = await admin_service.close_general_meeting(general_meeting_id, db)
    email_service = EmailService()
    asyncio.create_task(email_service.trigger_with_retry(meeting.id))
    return GeneralMeetingCloseOut(
        id=meeting.id,
        status=meeting.status.value if hasattr(meeting.status, "value") else meeting.status,
        closed_at=meeting.closed_at,
        voting_closes_at=meeting.voting_closes_at,
    )


@router.delete("/general-meetings/{general_meeting_id}", status_code=204)
async def delete_general_meeting_endpoint(
    general_meeting_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(require_admin),
):
    await admin_service.delete_general_meeting(general_meeting_id, db)


@router.post(
    "/general-meetings/{general_meeting_id}/resend-report",
    response_model=ResendReportOut,
)
async def resend_report(
    general_meeting_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> ResendReportOut:
    result = await admin_service.resend_report(general_meeting_id, db)
    email_service = EmailService()
    asyncio.create_task(email_service.trigger_with_retry(general_meeting_id))
    return ResendReportOut(**result)


@router.delete(
    "/general-meetings/{general_meeting_id}/ballots",
    response_model=GeneralMeetingBallotResetOut,
)
async def reset_general_meeting_ballots(
    general_meeting_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> GeneralMeetingBallotResetOut:
    """Delete all ballot submissions for a General Meeting.

    Intended for E2E test setup only — clears submitted votes so the test
    suite can re-run the voting flow without hitting a 409 conflict.
    """
    result = await admin_service.reset_general_meeting_ballots(general_meeting_id, db)
    return GeneralMeetingBallotResetOut(**result)


# ---------------------------------------------------------------------------
# Tenant configuration
# ---------------------------------------------------------------------------


@router.get("/config", response_model=TenantConfigOut)
async def get_admin_config(db: AsyncSession = Depends(get_db)) -> TenantConfigOut:
    """Return current branding config — admin only."""
    config = await config_service.get_config(db)
    return TenantConfigOut.model_validate(config)


@router.put("/config", response_model=TenantConfigOut)
async def update_admin_config(
    data: TenantConfigUpdate,
    db: AsyncSession = Depends(get_db),
) -> TenantConfigOut:
    """Update branding config — admin only. Returns 422 on validation failure."""
    config = await config_service.update_config(data, db)
    return TenantConfigOut.model_validate(config)
