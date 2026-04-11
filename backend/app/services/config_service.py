"""
Service layer for tenant configuration.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.tenant_config import TenantConfig
from app.schemas.config import TenantConfigUpdate

_DEFAULT_APP_NAME = "AGM Voting"
_DEFAULT_PRIMARY_COLOUR = "#005f73"
_CACHE_TTL_SECONDS = 60.0


@dataclass
class _ConfigCache:
    config: TenantConfig | None = field(default=None)
    cached_at: float | None = field(default=None)


_config_cache = _ConfigCache()


async def get_config(db: AsyncSession) -> TenantConfig:
    """Return the singleton config row (id=1).

    Creates a default seed row if it is somehow missing — this is a defensive
    fallback only; the Alembic migration is responsible for seeding on deploy.

    Results are cached in-process for up to 60 seconds to avoid a DB round-trip
    on every page load. The cache is invalidated by update_config().
    """
    now = time.monotonic()
    if (
        _config_cache.config is not None
        and _config_cache.cached_at is not None
        and now - _config_cache.cached_at < _CACHE_TTL_SECONDS
    ):
        return _config_cache.config

    result = await db.execute(select(TenantConfig).where(TenantConfig.id == 1))
    config = result.scalar_one_or_none()
    if config is None:
        config = TenantConfig(
            id=1,
            app_name=_DEFAULT_APP_NAME,
            logo_url="",
            favicon_url=None,
            primary_colour=_DEFAULT_PRIMARY_COLOUR,
            support_email="",
        )
        db.add(config)
        await db.flush()
        await db.commit()
        await db.refresh(config)

    db.expunge(config)
    _config_cache.config = config
    _config_cache.cached_at = now
    return config


async def update_config(data: TenantConfigUpdate, db: AsyncSession) -> TenantConfig:
    """Upsert the singleton config row (id=1) with the supplied values.

    Invalidates the module-level cache so the next get_config() call reads
    fresh data from the DB.
    """
    result = await db.execute(select(TenantConfig).where(TenantConfig.id == 1))
    config = result.scalar_one_or_none()
    if config is None:
        config = TenantConfig(id=1)
        db.add(config)

    config.app_name = data.app_name
    config.logo_url = data.logo_url
    config.favicon_url = data.favicon_url
    config.primary_colour = data.primary_colour
    config.support_email = data.support_email

    await db.flush()
    await db.commit()
    await db.refresh(config)

    _config_cache.config = None
    return config
