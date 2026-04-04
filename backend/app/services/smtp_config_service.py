"""
Service layer for DB-backed SMTP configuration.

Provides get/update/status operations for the tenant_smtp_config singleton row.
Password encryption/decryption is handled by app.crypto using SMTP_ENCRYPTION_KEY.
"""
from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.crypto import decrypt_smtp_password, encrypt_smtp_password
from app.logging_config import get_logger
from app.models.tenant_smtp_config import TenantSmtpConfig
from app.schemas.config import SmtpConfigUpdate

logger = get_logger(__name__)


async def get_smtp_config(db: AsyncSession) -> TenantSmtpConfig:
    """Return the singleton SMTP config row (id=1).

    Creates an empty default row if the table has no row yet (defensive fallback
    — the Alembic migration is responsible for seeding on deploy).
    """
    result = await db.execute(select(TenantSmtpConfig).where(TenantSmtpConfig.id == 1))
    config = result.scalar_one_or_none()
    if config is None:
        config = TenantSmtpConfig(
            id=1,
            smtp_host="",
            smtp_port=587,
            smtp_username="",
            smtp_password_enc=None,
            smtp_from_email="",
        )
        db.add(config)
        await db.flush()
        await db.commit()
        await db.refresh(config)
    return config


async def update_smtp_config(data: SmtpConfigUpdate, db: AsyncSession) -> TenantSmtpConfig:
    """Upsert the singleton SMTP config row.

    If smtp_password in data is None or empty string, the existing encrypted
    password is retained unchanged. Otherwise the new password is encrypted
    with SMTP_ENCRYPTION_KEY and stored.
    """
    result = await db.execute(select(TenantSmtpConfig).where(TenantSmtpConfig.id == 1))
    config = result.scalar_one_or_none()
    if config is None:
        config = TenantSmtpConfig(id=1)
        db.add(config)

    config.smtp_host = data.smtp_host
    config.smtp_port = data.smtp_port
    config.smtp_username = data.smtp_username
    config.smtp_from_email = data.smtp_from_email

    if data.smtp_password:
        key = settings.smtp_encryption_key
        if not key:
            # RR5-05: Raise 500 when a new password is supplied but the encryption key
            # is absent — silently discarding the password would create a confusing state
            # where the admin thinks they set a password but SMTP still fails.
            raise HTTPException(
                status_code=500,
                detail="SMTP encryption key not configured on server",
            )
        config.smtp_password_enc = encrypt_smtp_password(data.smtp_password, key)

    await db.flush()
    await db.commit()
    await db.refresh(config)
    return config


def get_decrypted_password(config: TenantSmtpConfig) -> str:
    """Decrypt and return the SMTP password from a config row.

    Returns empty string if:
    - smtp_password_enc is NULL
    - SMTP_ENCRYPTION_KEY is not set
    - Decryption fails (logs a warning)
    """
    if not config.smtp_password_enc:
        return ""
    key = settings.smtp_encryption_key
    if not key:
        logger.warning(
            "smtp_decryption_skipped",
            message="SMTP_ENCRYPTION_KEY is not set — cannot decrypt stored password",
        )
        return ""
    try:
        return decrypt_smtp_password(config.smtp_password_enc, key)
    except Exception as exc:
        logger.warning(
            "smtp_decryption_failed",
            error=str(exc),
        )
        return ""


async def is_smtp_configured(db: AsyncSession) -> bool:
    """Return True only when all required SMTP fields are set in the DB.

    Required: smtp_host, smtp_username, smtp_from_email non-empty AND
    smtp_password_enc is not NULL.
    """
    config = await get_smtp_config(db)
    return bool(
        config.smtp_host
        and config.smtp_username
        and config.smtp_from_email
        and config.smtp_password_enc is not None
    )
