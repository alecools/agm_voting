"""
Admin portal API router.
All endpoints are under /api/admin prefix (set in main.py).
Authentication is required via the require_admin dependency.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import aiosmtplib
import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, Request, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import engine, get_db
from app.utils import derive_origin
from app.logging_config import get_logger
from app.models import EmailDelivery, GeneralMeeting, get_effective_status
from app.dependencies import BetterAuthUser, require_admin, require_operator
from app.services.email_service import EmailService
from app.schemas.admin import (
    AddEmailRequest,
    AddOwnerEmailRequest,
    PersonOut,
    UpdateOwnerEmailRequest,
    UpdatePersonRequest,
    AdminUserInviteRequest,
    AdminUserListOut,
    AdminUserOut,
    GeneralMeetingBallotResetOut,
    GeneralMeetingCloseOut,
    GeneralMeetingCreate,
    GeneralMeetingDetail,
    GeneralMeetingListItem,
    GeneralMeetingOut,
    GeneralMeetingStartOut,
    BuildingArchiveOut,
    BuildingCreate,
    SubscriptionChangeRequest,
    SubscriptionResponse,
    SubscriptionUpdate,
    BuildingImportResult,
    BuildingOut,
    BuildingUpdate,
    FinancialPositionImportResult,
    LotOwnerCreate,
    LotOwnerImportResult,
    LotOwnerOut,
    LotOwnerUpdate,
    MotionAddRequest,
    AdminVoteEntryRequest,
    AdminVoteEntryResult,
    MotionDetail,
    MotionOut,
    MotionReorderOut,
    MotionReorderRequest,
    MotionUpdateRequest,
    MotionVisibilityOut,
    MotionVisibilityRequest,
    ProxyImportResult,
    ResendReportOut,
    SetProxyRequest,
)
from app.schemas.config import (
    FaviconUploadOut,
    LogoUploadOut,
    SmtpConfigOut,
    SmtpConfigUpdate,
    SmtpStatusOut,
    SmsConfigOut,
    SmsConfigUpdate,
    SmsTestRequest,
    TenantConfigOut,
    TenantConfigUpdate,
)
from app.services.sms_service import SmsDeliveryError, send as sms_send
from app.services import admin_service
from app.services import config_service
from app.services import smtp_config_service
from app.services import blob_service
from app.services import neon_auth_service
from app.services.neon_auth_service import (
    NeonAuthDuplicateUserError,
    NeonAuthNotConfiguredError,
    NeonAuthServiceError,
    NeonAuthUserNotFoundError,
)
from app.rate_limiter import (
    admin_import_limiter,
    admin_close_limiter,
    admin_invite_limiter,
    get_client_ip,
    provision_limiter,
    sms_test_rate_limiter,
    smtp_test_rate_limiter,
)

router = APIRouter(tags=["admin"], dependencies=[Depends(require_admin)])
# Separate router for endpoints that must NOT require admin auth.
# Currently only the test-only /auth/provision endpoint lives here — it is
# guarded by _require_debug_access() (TESTING_MODE=true) instead.
debug_unauthed_router = APIRouter(tags=["admin"])
logger = get_logger(__name__)

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

_IMAGE_CONTENT_TYPES = {
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
}

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

# SVG files are explicitly rejected because they can contain <script> tags and
# onload handlers that execute when served as image/svg+xml (HIGH-4 stored XSS).
_SVG_EXTENSIONS = {".svg"}
_SVG_CONTENT_TYPES = {"image/svg+xml"}

_MAX_LOGO_BYTES = 5 * 1024 * 1024  # 5 MB
_MAX_IMPORT_BYTES = 5 * 1024 * 1024  # 5 MB — applied to all import/upload endpoints


def _detect_image_format(file: UploadFile) -> str:
    """Return the MIME type for an image upload. Raise 415 if not a recognised image.
    Raise 422 if the file is an SVG (HIGH-4: SVG can contain embedded scripts).

    Extension takes precedence over content-type.
    """
    content_type = (file.content_type or "").lower().split(";")[0].strip()
    filename = (file.filename or "").lower()
    ext = os.path.splitext(filename)[1]

    # Reject SVG regardless of how it was detected — extension or content-type.
    if ext in _SVG_EXTENSIONS or content_type in _SVG_CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="SVG files are not supported. Please upload a PNG or WebP image.",
        )

    if ext in _IMAGE_EXTENSIONS:
        # Map extension to a canonical MIME type
        ext_to_mime = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".gif": "image/gif",
        }
        return ext_to_mime[ext]
    if content_type in _IMAGE_CONTENT_TYPES:
        return content_type
    raise HTTPException(
        status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        detail="File must be an image (PNG, JPEG, WebP, or GIF)",
    )


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
# Admin user management
# ---------------------------------------------------------------------------


@router.get("/users", response_model=AdminUserListOut)
async def list_admin_users(
    current_user: BetterAuthUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminUserListOut:
    """List all admin users by querying the neon_auth.user table.

    Returns 502 on database error.
    """
    try:
        users = await neon_auth_service.list_admin_users(db)
    except NeonAuthServiceError as exc:
        logger.error("list_admin_users_error", error=str(exc))
        raise HTTPException(status_code=502, detail="User management service error")
    return AdminUserListOut(users=users)


@router.post("/users/invite", response_model=AdminUserOut, status_code=status.HTTP_201_CREATED)
async def invite_admin_user(
    request: Request,
    data: AdminUserInviteRequest,
    current_user: BetterAuthUser = Depends(require_admin),
) -> AdminUserOut:
    """Create a new admin user and trigger a password-reset email.

    Rate limited to 10 calls per 10 minutes per admin session.
    Returns 409 if the email is already registered.
    Returns 422 if the email is not a valid email address (Pydantic validation).
    Returns 503 if Neon Auth management is not configured.
    """
    admin_invite_limiter.check(current_user.user_id)

    redirect_origin = derive_origin(request)

    try:
        user = await neon_auth_service.invite_admin_user(str(data.email), redirect_origin)
    except NeonAuthNotConfiguredError:
        raise HTTPException(status_code=503, detail="User management not configured")
    except NeonAuthDuplicateUserError:
        raise HTTPException(status_code=409, detail="A user with that email already exists.")
    except NeonAuthServiceError as exc:
        logger.error("invite_admin_user_error", error=str(exc))
        raise HTTPException(status_code=502, detail="User management service error")
    logger.info("admin_user_invited", performed_by=current_user.user_id, target_email=str(data.email))
    return user


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_admin_user(
    user_id: str,
    current_user: BetterAuthUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Remove an admin user.

    Returns 403 if attempting to remove the current user (self-removal guard).
    Returns 409 if this is the last admin user.
    Returns 404 if the user does not exist.
    Returns 503 if Neon Auth management is not configured.

    Note: there is a TOCTOU gap between the pre-delete count check and the
    actual delete — two concurrent requests could each see 2 users, both pass
    the guard, and one of them ends up deleting the last admin.  A true atomic
    fix requires Neon Auth to enforce a minimum-admin-count constraint
    server-side (or a distributed lock).  The post-delete re-query below
    narrows the window and gives us visibility if it ever occurs.
    """
    if user_id == current_user.user_id:
        raise HTTPException(status_code=403, detail="Cannot remove yourself.")

    try:
        users = await neon_auth_service.list_admin_users(db)
    except NeonAuthServiceError as exc:
        logger.error("remove_admin_user_list_error", error=str(exc))
        raise HTTPException(status_code=502, detail="User management service error")

    if len(users) <= 1:
        raise HTTPException(status_code=409, detail="Cannot remove the last admin user.")

    try:
        await neon_auth_service.remove_admin_user(user_id)
    except NeonAuthNotConfiguredError:
        raise HTTPException(status_code=503, detail="User management not configured")
    except NeonAuthUserNotFoundError:
        raise HTTPException(status_code=404, detail="User not found.")
    except NeonAuthServiceError as exc:
        logger.error("remove_admin_user_error", error=str(exc), user_id=user_id)
        raise HTTPException(status_code=502, detail="User management service error")

    logger.info("admin_user_removed", performed_by=current_user.user_id, target_user_id=user_id)

    # Post-delete guard: re-query to verify at least one admin still exists.
    # The pre-check above has a TOCTOU gap under concurrent requests; this
    # re-query narrows the window and gives critical visibility if it fires.
    try:
        remaining = await neon_auth_service.list_admin_users(db)
        if len(remaining) == 0:
            logger.critical(
                "admin_user_removal_left_zero_admins",
                removed_user_id=user_id,
                performed_by=current_user.user_id,
            )
    except NeonAuthServiceError:
        pass  # post-delete verification failure must not mask the successful delete


# ---------------------------------------------------------------------------
# Buildings
# ---------------------------------------------------------------------------


@router.post(
    "/buildings/import",
    response_model=BuildingImportResult,
    status_code=status.HTTP_200_OK,
)
async def import_buildings(
    request: Request,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> BuildingImportResult:
    admin_import_limiter.check("admin")
    fmt = _detect_file_format(file)
    content = await file.read()
    if len(content) > _MAX_IMPORT_BYTES:
        raise HTTPException(
            status_code=413,
            detail="File exceeds maximum size of 5 MB",
        )
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


_VALID_BUILDINGS_SORT_BY = {"name", "manager_email", "created_at"}
_VALID_LOT_OWNERS_SORT_BY = {"lot_number", "unit_entitlement", "financial_position", "email", "proxy_email"}
_VALID_SORT_DIRS = {"asc", "desc"}


@router.get("/buildings", response_model=list[BuildingOut])
async def list_buildings(
    limit: int = Query(default=100, le=1000),
    offset: int = Query(default=0, ge=0),
    name: str | None = Query(default=None),
    is_archived: bool | None = Query(default=None),
    sort_by: str | None = Query(default=None),
    sort_dir: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[BuildingOut]:
    if sort_by is not None and sort_by not in _VALID_BUILDINGS_SORT_BY:
        raise HTTPException(status_code=422, detail="Invalid sort_by value")
    if sort_dir is not None and sort_dir not in _VALID_SORT_DIRS:
        raise HTTPException(status_code=422, detail="Invalid sort_dir value")
    buildings = await admin_service.list_buildings(
        db, limit=limit, offset=offset, name=name, is_archived=is_archived,
        sort_by=sort_by, sort_dir=sort_dir,
    )
    return [BuildingOut.model_validate(b) for b in buildings]


@router.get("/buildings/count")
async def count_buildings(
    name: str | None = Query(default=None),
    is_archived: bool | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    """Return the total count of buildings, applying the same filters as the list endpoint."""
    count = await admin_service.count_buildings(db, name=name, is_archived=is_archived)
    return {"count": count}


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


@router.post(
    "/buildings/{building_id}/unarchive",
    response_model=BuildingArchiveOut,
)
async def unarchive_building(
    building_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: BetterAuthUser = Depends(require_operator),
) -> BuildingArchiveOut:
    building = await admin_service.unarchive_building(building_id, db)
    return BuildingArchiveOut.model_validate(building)


@router.get("/subscription", response_model=SubscriptionResponse)
async def get_subscription(
    db: AsyncSession = Depends(get_db),
) -> SubscriptionResponse:
    return await admin_service.get_subscription(db)


@router.post("/subscription", response_model=SubscriptionResponse)
async def update_subscription(
    data: SubscriptionUpdate,
    db: AsyncSession = Depends(get_db),
    _: BetterAuthUser = Depends(require_operator),
) -> SubscriptionResponse:
    return await admin_service.upsert_subscription(
        db,
        tier_name=data.tier_name,
        building_limit=data.building_limit,
    )


@router.post("/subscription/request-change")
async def request_subscription_change(
    request: Request,
    data: SubscriptionChangeRequest,
    current_user: BetterAuthUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Send a tier-change request email to support@ocss.tech.

    Returns 200 with {"message": "Request sent."} on success.
    Returns 503 if SMTP is not configured.
    """
    from app.services.email_service import SmtpNotConfiguredError

    origin = derive_origin(request)
    subscription = await admin_service.get_subscription(db)

    try:
        await admin_service.send_subscription_change_request(
            db,
            origin=origin,
            current_tier=subscription.tier_name,
            requested_tier=data.requested_tier,
            requester_email=current_user.email,
        )
    except SmtpNotConfiguredError:
        raise HTTPException(
            status_code=503,
            detail="Email not configured. Contact support@ocss.tech directly.",
        )

    logger.info(
        "subscription_change_requested",
        performed_by=current_user.user_id,
        requested_tier=data.requested_tier,
        origin=origin,
    )
    return {"message": "Request sent."}


@router.get("/buildings/{building_id}", response_model=BuildingOut)
async def get_building(
    building_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> BuildingOut:
    building = await admin_service.get_building_or_404(building_id, db)
    return BuildingOut.model_validate(building)


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
    limit: int = Query(default=20, le=1000),
    offset: int = Query(default=0, ge=0),
    sort_by: str | None = Query(None),
    sort_dir: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
) -> list[LotOwnerOut]:
    if sort_by is not None and sort_by not in _VALID_LOT_OWNERS_SORT_BY:
        raise HTTPException(status_code=400, detail="Invalid sort_by value")
    if sort_dir is not None and sort_dir not in _VALID_SORT_DIRS:
        raise HTTPException(status_code=400, detail="Invalid sort_dir value")
    owners = await admin_service.list_lot_owners(
        building_id, db, limit=limit, offset=offset, sort_by=sort_by, sort_dir=sort_dir
    )
    return [LotOwnerOut(**o) for o in owners]


@router.get("/buildings/{building_id}/lot-owners/count")
async def count_lot_owners_endpoint(
    building_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    count = await admin_service.count_lot_owners(building_id, db)
    return {"count": count}


@router.post(
    "/buildings/{building_id}/lot-owners/import",
    response_model=LotOwnerImportResult,
    status_code=status.HTTP_200_OK,
)
async def import_lot_owners(
    request: Request,
    building_id: uuid.UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> LotOwnerImportResult:
    admin_import_limiter.check("admin")
    fmt = _detect_file_format(file)
    content = await file.read()
    if len(content) > _MAX_IMPORT_BYTES:
        raise HTTPException(
            status_code=413,
            detail="File exceeds maximum size of 5 MB",
        )
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
    request: Request,
    building_id: uuid.UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> ProxyImportResult:
    admin_import_limiter.check("admin")
    fmt = _detect_file_format(file)
    content = await file.read()
    if len(content) > _MAX_IMPORT_BYTES:
        raise HTTPException(
            status_code=413,
            detail="File exceeds maximum size of 5 MB",
        )
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
    request: Request,
    building_id: uuid.UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> FinancialPositionImportResult:
    admin_import_limiter.check("admin")
    fmt = _detect_file_format(file)
    content = await file.read()
    if len(content) > _MAX_IMPORT_BYTES:
        raise HTTPException(
            status_code=413,
            detail="File exceeds maximum size of 5 MB",
        )
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


@router.post(
    "/lot-owners/{lot_owner_id}/owner-emails",
    response_model=LotOwnerOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_owner_email_to_lot_owner(
    lot_owner_id: uuid.UUID,
    data: AddOwnerEmailRequest,
    db: AsyncSession = Depends(get_db),
) -> LotOwnerOut:
    """Add an owner email (person) to a lot owner."""
    owner = await admin_service.add_owner_email_to_lot_owner(
        lot_owner_id, data.email, db,
        given_name=data.given_name,
        surname=data.surname,
        phone_number=data.phone_number,
    )
    return LotOwnerOut(**owner)


@router.patch(
    "/lot-owners/{lot_owner_id}/owner-emails/{email_id}",
    response_model=LotOwnerOut,
    status_code=status.HTTP_200_OK,
)
async def update_owner_email(
    lot_owner_id: uuid.UUID,
    email_id: uuid.UUID,
    data: UpdateOwnerEmailRequest,
    db: AsyncSession = Depends(get_db),
) -> LotOwnerOut:
    """Update the email address, name, and/or phone on an owner email record."""
    # phone_number=None in the request body means "no change requested" unless it is
    # explicitly supplied as null.  We detect explicit null by checking the raw request
    # dict (model_fields_set is not available on model_validate from dict in all Pydantic
    # versions, so we use __pydantic_fields_set__).
    phone_set = "phone_number" in data.model_fields_set
    owner = await admin_service.update_owner_email(
        lot_owner_id,
        email_id,
        data.email,
        data.given_name,
        data.surname,
        db,
        phone_number=data.phone_number if (phone_set and data.phone_number is not None) else None,
        clear_phone=(phone_set and data.phone_number is None),
    )
    return LotOwnerOut(**owner)


@router.delete(
    "/lot-owners/{lot_owner_id}/owner-emails/{email_id}",
    response_model=LotOwnerOut,
    status_code=status.HTTP_200_OK,
)
async def remove_owner_email_by_id(
    lot_owner_id: uuid.UUID,
    email_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> LotOwnerOut:
    """Remove an owner email record by its UUID."""
    owner = await admin_service.remove_owner_email_by_id(lot_owner_id, email_id, db)
    return LotOwnerOut(**owner)


@router.get(
    "/persons/search",
    response_model=list[PersonOut],
)
async def search_persons(
    q: str = Query(..., min_length=1, max_length=254),
    limit: int = Query(default=10, ge=1, le=20),
    db: AsyncSession = Depends(get_db),
) -> list[PersonOut]:
    """Prefix-search persons by email. Returns up to `limit` (max 20) matches."""
    persons = await admin_service.search_persons(q, db, limit=limit)
    return [PersonOut.model_validate(p) for p in persons]


@router.get(
    "/persons/lookup",
    response_model=PersonOut,
)
async def lookup_person(
    email: str,
    db: AsyncSession = Depends(get_db),
) -> PersonOut:
    """Look up a person by email address. Returns 404 if not found."""
    person = await admin_service.lookup_person(email, db)
    if person is None:
        raise HTTPException(status_code=404, detail="Person not found")
    return PersonOut.model_validate(person)


@router.patch(
    "/persons/{person_id}",
    response_model=PersonOut,
)
async def update_person(
    person_id: uuid.UUID,
    data: UpdatePersonRequest,
    db: AsyncSession = Depends(get_db),
) -> PersonOut:
    """Update name, email, and/or phone on a person row."""
    person = await admin_service.update_person(person_id, data, db)
    return PersonOut.model_validate(person)


@router.delete(
    "/lot-owners/{lot_owner_id}/persons/{person_id}",
    response_model=LotOwnerOut,
)
async def remove_person_from_lot(
    lot_owner_id: uuid.UUID,
    person_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> LotOwnerOut:
    """Remove a person from a lot by person_id."""
    owner = await admin_service.remove_person_from_lot(lot_owner_id, person_id, db)
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
    owner = await admin_service.set_lot_owner_proxy(
        lot_owner_id, data.proxy_email, db,
        given_name=data.given_name,
        surname=data.surname,
        phone_number=data.phone_number,
    )
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


@router.post("/motions/{motion_id}/close", response_model=MotionDetail)
async def close_motion_endpoint(
    motion_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> MotionDetail:
    """Close voting for a single motion. Requires admin auth.

    Returns 200 with updated motion detail on success.
    Returns 404 if motion not found.
    Returns 409 if motion is hidden, already closed, or meeting is not open.
    """
    result = await admin_service.close_motion(motion_id, db)
    return MotionDetail(**result)


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


@router.delete(
    "/motions/{motion_id}/options/{option_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_motion_option_endpoint(
    motion_id: uuid.UUID,
    option_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Delete a single option from a multi-choice motion.

    Returns 204 on success.
    Returns 404 if the motion or option does not exist.
    Returns 409 if any submitted votes reference the option.
    """
    await admin_service.delete_motion_option(motion_id, option_id, db)


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


_VALID_MEETINGS_SORT_BY = {"title", "created_at", "meeting_at", "voting_closes_at", "status", "building_name"}


@router.get("/general-meetings", response_model=list[GeneralMeetingListItem])
async def list_general_meetings(
    limit: int = Query(default=100, le=1000),
    offset: int = Query(default=0, ge=0),
    name: str | None = Query(default=None),
    building_id: uuid.UUID | None = Query(default=None),
    status: str | None = Query(default=None),
    sort_by: str | None = Query(default=None),
    sort_dir: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[GeneralMeetingListItem]:
    if sort_by is not None and sort_by not in _VALID_MEETINGS_SORT_BY:
        raise HTTPException(status_code=422, detail="Invalid sort_by value")
    if sort_dir is not None and sort_dir not in _VALID_SORT_DIRS:
        raise HTTPException(status_code=422, detail="Invalid sort_dir value")
    items = await admin_service.list_general_meetings(
        db, limit=limit, offset=offset, name=name, building_id=building_id, status=status,
        sort_by=sort_by, sort_dir=sort_dir,
    )
    return [GeneralMeetingListItem(**item) for item in items]


@router.get("/general-meetings/count")
async def count_general_meetings(
    name: str | None = Query(default=None),
    building_id: uuid.UUID | None = Query(default=None),
    status: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    """Return the total count of general meetings, applying the same filters as the list endpoint."""
    count = await admin_service.count_general_meetings(
        db, name=name, building_id=building_id, status=status
    )
    return {"count": count}


@router.get("/general-meetings/{general_meeting_id}", response_model=GeneralMeetingDetail)
async def get_general_meeting_detail(
    general_meeting_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> GeneralMeetingDetail:
    detail = await admin_service.get_general_meeting_detail(general_meeting_id, db)
    return GeneralMeetingDetail(**detail)


@router.put(
    "/general-meetings/{general_meeting_id}/motions/reorder",
    response_model=MotionReorderOut,
)
async def reorder_motions(
    general_meeting_id: uuid.UUID,
    data: MotionReorderRequest,
    db: AsyncSession = Depends(get_db),
) -> MotionReorderOut:
    """Bulk reorder motions for a general meeting.

    Replaces all display_order values atomically. The request must include
    exactly all motion IDs for this meeting.
    """
    result = await admin_service.reorder_motions(general_meeting_id, data, db)
    return MotionReorderOut(**result)


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
    request: Request,
    general_meeting_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> GeneralMeetingCloseOut:
    admin_close_limiter.check("admin")
    meeting = await admin_service.close_general_meeting(general_meeting_id, db)
    email_service = EmailService()
    base_url = str(request.base_url).rstrip("/")
    background_tasks.add_task(email_service.trigger_with_retry, meeting.id, base_url)
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
):
    # RR5-15: removed redundant _: str = Depends(require_admin) — the router-level
    # dependency already enforces authentication for all endpoints on this router.
    await admin_service.delete_general_meeting(general_meeting_id, db)


@router.post(
    "/general-meetings/{general_meeting_id}/resend-report",
    response_model=ResendReportOut,
)
async def resend_report(
    request: Request,
    general_meeting_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> ResendReportOut:
    result = await admin_service.resend_report(general_meeting_id, db)
    email_service = EmailService()
    base_url = str(request.base_url).rstrip("/")
    background_tasks.add_task(email_service.trigger_with_retry, general_meeting_id, base_url)
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

    Requires ENABLE_BALLOT_RESET=true env var (RR5-01). Returns 403 when unset
    to prevent accidental production use.
    """
    if not settings.enable_ballot_reset:
        raise HTTPException(
            status_code=403,
            detail="Ballot reset is disabled. Set ENABLE_BALLOT_RESET=true to enable.",
        )
    result = await admin_service.reset_general_meeting_ballots(general_meeting_id, db)
    return GeneralMeetingBallotResetOut(**result)


@router.post(
    "/general-meetings/{general_meeting_id}/enter-votes",
    response_model=AdminVoteEntryResult,
    status_code=status.HTTP_200_OK,
)
async def enter_votes_for_meeting(
    general_meeting_id: uuid.UUID,
    data: AdminVoteEntryRequest,
    db: AsyncSession = Depends(get_db),
    admin_user: BetterAuthUser = Depends(require_admin),
) -> AdminVoteEntryResult:
    """Enter in-person votes on behalf of lot owners (US-AVE-01/02/03).

    Returns 200 with submitted_count and skipped_count.
    Returns 404 if the meeting does not exist.
    Returns 409 if the meeting is not open.
    Returns 422 if unknown lot_owner_ids or invalid votes are provided.
    """
    result = await admin_service.enter_votes_for_meeting(
        general_meeting_id, data, db, admin_username=admin_user.email
    )
    return AdminVoteEntryResult(**result)


# ---------------------------------------------------------------------------
# Tenant configuration
# ---------------------------------------------------------------------------


@router.post(
    "/config/logo",
    response_model=LogoUploadOut,
    status_code=status.HTTP_200_OK,
)
async def upload_logo(
    file: UploadFile = File(...),
) -> LogoUploadOut:
    """Upload a logo image to Vercel Blob and return its public URL.

    The caller is responsible for then saving the URL via PUT /api/admin/config.

    Returns 400 if the file exceeds 5 MB.
    Returns 415 if the file is not a recognised image type.
    Returns 500 if BLOB_READ_WRITE_TOKEN is not configured.
    Returns 502 if the Vercel Blob upload fails.
    """
    mime_type = _detect_image_format(file)
    content = await file.read()
    if len(content) > _MAX_LOGO_BYTES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File exceeds maximum size of 5 MB",
        )
    filename = file.filename or "logo"
    url = await blob_service.upload_to_blob(filename, content, mime_type)
    return LogoUploadOut(url=url)



@router.post(
    "/config/favicon",
    response_model=FaviconUploadOut,
    status_code=status.HTTP_200_OK,
)
async def upload_favicon(
    file: UploadFile = File(...),
) -> FaviconUploadOut:
    """Upload a favicon image to Vercel Blob and return its public URL.

    The caller is responsible for then saving the URL via PUT /api/admin/config.

    Returns 400 if the file exceeds 5 MB.
    Returns 415 if the file is not a recognised image type.
    Returns 500 if BLOB_READ_WRITE_TOKEN is not configured.
    Returns 502 if the Vercel Blob upload fails.
    """
    mime_type = _detect_image_format(file)
    content = await file.read()
    if len(content) > _MAX_LOGO_BYTES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File exceeds maximum size of 5 MB",
        )
    filename = file.filename or "favicon"
    url = await blob_service.upload_to_blob(filename, content, mime_type)
    return FaviconUploadOut(url=url)

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


# ---------------------------------------------------------------------------
# SMTP configuration
# ---------------------------------------------------------------------------


def _check_smtp_test_rate_limit() -> None:
    """Raise 429 if more than 5 calls to /config/smtp/test occurred in the last 60s."""
    try:
        smtp_test_rate_limiter.check("smtp_test")
    except HTTPException as exc:
        raise HTTPException(status_code=429, detail="Rate limit exceeded: max 5 test emails per minute") from exc


@router.get("/config/smtp/status", response_model=SmtpStatusOut)
async def get_smtp_status(db: AsyncSession = Depends(get_db)) -> SmtpStatusOut:
    """Return whether SMTP is configured. Used by admin layout banner."""
    configured = await smtp_config_service.is_smtp_configured(db)
    return SmtpStatusOut(configured=configured)


@router.get("/config/smtp", response_model=SmtpConfigOut)
async def get_smtp_config(db: AsyncSession = Depends(get_db)) -> SmtpConfigOut:
    """Return current SMTP config — password is never included in the response."""
    config = await smtp_config_service.get_smtp_config(db)
    return SmtpConfigOut(
        smtp_host=config.smtp_host,
        smtp_port=config.smtp_port,
        smtp_username=config.smtp_username,
        smtp_from_email=config.smtp_from_email,
        password_is_set=config.smtp_password_enc is not None,
    )


@router.put("/config/smtp", response_model=SmtpConfigOut)
async def update_smtp_config(
    data: SmtpConfigUpdate,
    db: AsyncSession = Depends(get_db),
) -> SmtpConfigOut:
    """Save SMTP configuration. Password is encrypted at rest."""
    config = await smtp_config_service.update_smtp_config(data, db)
    return SmtpConfigOut(
        smtp_host=config.smtp_host,
        smtp_port=config.smtp_port,
        smtp_username=config.smtp_username,
        smtp_from_email=config.smtp_from_email,
        password_is_set=config.smtp_password_enc is not None,
    )


class SmtpTestRequest(BaseModel):
    to_email: str


@router.post("/config/smtp/test")
async def test_smtp_config(body: SmtpTestRequest, db: AsyncSession = Depends(get_db)) -> dict:
    """Attempt to connect to the configured SMTP server and send a test email.

    Rate limited to 5 requests per minute per server process.
    Returns {"ok": true} on success or raises 400 with the SMTP error message.
    Returns 409 if SMTP is not configured.
    """
    from email.mime.text import MIMEText

    _check_smtp_test_rate_limit()

    config = await smtp_config_service.get_smtp_config(db)
    if not config.smtp_host or not config.smtp_username or not config.smtp_from_email or config.smtp_password_enc is None:
        raise HTTPException(status_code=409, detail="SMTP is not configured")

    smtp_password = smtp_config_service.get_decrypted_password(config)

    msg = MIMEText("This is a test email from AGM Voting App.", "plain")
    msg["Subject"] = "Test email from AGM Voting App"
    msg["From"] = config.smtp_from_email
    msg["To"] = body.to_email

    try:
        await aiosmtplib.send(
            msg,
            hostname=config.smtp_host,
            port=config.smtp_port,
            username=config.smtp_username,
            password=smtp_password,
            start_tls=True,
        )
    except Exception as exc:
        logger.error("smtp_test_failed", error=str(exc))
        raise HTTPException(
            status_code=400,
            detail="SMTP connection test failed. Check settings and try again.",
        ) from exc

    return {"ok": True}


# ---------------------------------------------------------------------------
# SMS configuration
# ---------------------------------------------------------------------------


def _check_sms_test_rate_limit() -> None:
    """Raise 429 if more than 5 calls to /config/sms/test occurred in the last 60s."""
    try:
        sms_test_rate_limiter.check("sms_test")
    except HTTPException as exc:
        raise HTTPException(status_code=429, detail="Rate limit exceeded: max 5 test SMS per minute") from exc


@router.get("/config/sms", response_model=SmsConfigOut)
async def get_sms_config(db: AsyncSession = Depends(get_db)) -> SmsConfigOut:
    """Return current SMS config — secrets are never included in the response."""
    config = await smtp_config_service.get_smtp_config(db)
    return smtp_config_service.build_sms_config_out(config)


@router.put("/config/sms", response_model=SmsConfigOut)
async def update_sms_config(
    data: SmsConfigUpdate,
    db: AsyncSession = Depends(get_db),
) -> SmsConfigOut:
    """Save SMS configuration. Secrets are encrypted at rest."""
    config = await smtp_config_service.update_sms_config(data, db)
    return smtp_config_service.build_sms_config_out(config)


@router.post("/config/sms/test")
async def test_sms_config(body: SmsTestRequest, db: AsyncSession = Depends(get_db)) -> dict:
    """Send a test SMS to the supplied phone number using the current SMS configuration.

    Rate limited to 5 requests per minute.
    Returns {"ok": true} on success.
    Returns 503 if SMS is not configured.
    Returns 502 on delivery failure.
    """
    _check_sms_test_rate_limit()

    config = await smtp_config_service.get_smtp_config(db)
    if not config.sms_enabled or not config.sms_provider:
        raise HTTPException(status_code=503, detail="SMS is not configured")

    sms_kwargs = smtp_config_service.get_sms_send_kwargs(config)
    try:
        await sms_send(
            to=body.to,
            message="This is a test SMS from AGM Voting.",
            **sms_kwargs,
        )
    except SmsDeliveryError as exc:
        logger.error("sms_test_failed", error=str(exc))
        raise HTTPException(status_code=502, detail="SMS delivery failed") from exc

    return {"ok": True}


# ---------------------------------------------------------------------------
# Operator debug endpoints
# ---------------------------------------------------------------------------


def _require_debug_access() -> None:
    """Require testing_mode=True for debug endpoints (RR3-34).

    Debug endpoints are already admin-authenticated but in production deployments
    testing_mode is always False, so this guard prevents them from being reachable
    in production even if the admin session is compromised.
    """
    if not settings.testing_mode:
        raise HTTPException(status_code=404, detail="Not found")


@router.get("/debug/meeting-status/{meeting_id}")
async def debug_meeting_status(
    meeting_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Return stored and effective meeting status along with key timestamps.

    Useful for diagnosing unexpected meeting state (e.g. why a meeting appears
    open or closed when the admin expects otherwise).
    Only available when TESTING_MODE=true (RR3-34).
    """
    _require_debug_access()
    result = await db.execute(select(GeneralMeeting).where(GeneralMeeting.id == meeting_id))
    meeting = result.scalar_one_or_none()
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found")

    effective = get_effective_status(meeting)
    return {
        "meeting_id": str(meeting_id),
        "stored_status": meeting.status.value,
        "effective_status": effective.value,
        "voting_closes_at": meeting.voting_closes_at.isoformat() if meeting.voting_closes_at else None,
        "current_time": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/debug/email-deliveries")
async def debug_email_deliveries(
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """List EmailDelivery records ordered by last update descending.

    Useful for diagnosing email failures and checking retry state.
    Only available when TESTING_MODE=true (RR3-34).
    """
    _require_debug_access()
    result = await db.execute(
        select(EmailDelivery).order_by(EmailDelivery.updated_at.desc()).limit(limit)
    )
    deliveries = result.scalars().all()
    return [
        {
            "id": str(d.id),
            "general_meeting_id": str(d.general_meeting_id),
            "status": d.status.value,
            "total_attempts": d.total_attempts,
            "last_error": d.last_error,
            "updated_at": d.updated_at.isoformat() if d.updated_at else None,
        }
        for d in deliveries
    ]


@router.get("/debug/db-health")
async def debug_db_health() -> dict:
    """Return DB connection pool diagnostic information.

    A small persistent pool (pool_size=1) is used per Lambda instance.
    Returns pool type and current checked-in/checked-out/overflow counts.
    Only available when TESTING_MODE=true (RR3-34).
    """
    _require_debug_access()
    pool = engine.pool
    return {
        "pool_type": type(pool).__name__,
        "pool_size": pool.size(),
        "checked_in": pool.checkedin(),
        "checked_out": pool.checkedout(),
        "overflow": pool.overflow(),
    }


# ---------------------------------------------------------------------------
# Test-only admin provisioning endpoint
# ---------------------------------------------------------------------------


class _ProvisionAdminRequest(BaseModel):
    email: str
    password: str
    name: str = "Admin"


@debug_unauthed_router.post("/auth/provision", status_code=204)
async def provision_admin_user(request: Request, body: _ProvisionAdminRequest) -> None:
    """Create an admin user in Neon Auth directly (server-to-server).

    This endpoint is only available when TESTING_MODE=true.  It is used by the
    E2E global-setup to seed the admin account on fresh Neon branch deployments
    where no admin user yet exists.

    It calls Neon Auth's sign-up endpoint internally (server-to-server) so the
    resulting account is usable for sign-in/email — unlike the management API
    which creates users whose passwords cannot be used for session-based auth.

    Neon Auth requires an Origin header on the sign-up call; we derive it from
    the incoming request's x-forwarded-proto/x-forwarded-host headers (set by
    Vercel on all requests) so the server-to-server call satisfies that check.

    Idempotent: if the user already exists the upstream 4xx is silently ignored
    and 204 is still returned so global-setup can call this unconditionally.
    """
    _require_debug_access()
    provision_limiter.check(get_client_ip(request))

    if not settings.neon_auth_base_url:
        raise HTTPException(status_code=503, detail="Auth service not configured")

    # Derive the browser-facing origin so Neon Auth can validate the request
    # against its trusted_origins list.  Without this header Neon Auth returns
    # 400 MISSING_ORIGIN and the sign-up silently fails.
    origin = derive_origin(request)

    url = f"{settings.neon_auth_base_url.rstrip('/')}/sign-up/email"
    headers: dict[str, str] = {"content-type": "application/json"}
    if origin:
        headers["origin"] = origin

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            url,
            json={"email": body.email, "password": body.password, "name": body.name},
            headers=headers,
            timeout=15.0,
        )

    # 200/201 = created; 4xx = user already exists or validation error (idempotent).
    # Anything else (5xx, unexpected codes) is a real upstream error — raise 502.
    is_success = resp.status_code in (200, 201)
    is_client_error = 400 <= resp.status_code < 500
    if not is_success and not is_client_error:
        logger.error("provision_admin_user_upstream_error", status=resp.status_code)
        raise HTTPException(status_code=502, detail="Upstream auth error")
    if is_client_error and resp.status_code != 409:
        # 409 = already exists (expected idempotent case); any other 4xx is unexpected.
        # Log at WARNING so operator logs surface the issue without failing the endpoint.
        logger.warning(
            "provision_admin_user_unexpected_4xx",
            status=resp.status_code,
            body=resp.text[:200],
        )
