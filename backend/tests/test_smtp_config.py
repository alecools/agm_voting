"""
Tests for Slice 8: DB-backed SMTP configuration.

Covers:
- app.crypto: encrypt_smtp_password, decrypt_smtp_password
- app.services.smtp_config_service: get_smtp_config, update_smtp_config, is_smtp_configured, get_decrypted_password
- GET  /api/admin/config/smtp           → SmtpConfigOut (no password)
- PUT  /api/admin/config/smtp           → upsert + encrypt
- POST /api/admin/config/smtp/test      → connect + send test email
- GET  /api/admin/config/smtp/status    → {configured: bool}
- email_service.SmtpNotConfiguredError raised when unconfigured
- trigger_with_retry immediately fails on SmtpNotConfiguredError
"""
from __future__ import annotations

import base64
import os
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.crypto import decrypt_smtp_password, encrypt_smtp_password
from app.models.tenant_smtp_config import TenantSmtpConfig
from app.schemas.config import SmtpConfigUpdate
from app.services import smtp_config_service
from app.services.smtp_config_service import (
    get_decrypted_password,
    get_smtp_config,
    is_smtp_configured,
    update_smtp_config,
)
from app.services.email_service import SmtpNotConfiguredError


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_test_key() -> str:
    """Generate a valid base64-encoded 32-byte AES key for testing."""
    return base64.b64encode(os.urandom(32)).decode("ascii")


async def _clear_smtp_config(db: AsyncSession) -> None:
    await db.execute(delete(TenantSmtpConfig))
    await db.flush()


async def _seed_smtp_config(
    db: AsyncSession,
    smtp_host: str = "smtp.example.com",
    smtp_port: int = 587,
    smtp_username: str = "user@example.com",
    smtp_password_enc: str | None = None,
    smtp_from_email: str = "noreply@example.com",
) -> TenantSmtpConfig:
    await _clear_smtp_config(db)
    config = TenantSmtpConfig(
        id=1,
        smtp_host=smtp_host,
        smtp_port=smtp_port,
        smtp_username=smtp_username,
        smtp_password_enc=smtp_password_enc,
        smtp_from_email=smtp_from_email,
    )
    db.add(config)
    await db.flush()
    await db.commit()
    await db.refresh(config)
    return config


# ---------------------------------------------------------------------------
# app.crypto — encrypt/decrypt
# ---------------------------------------------------------------------------


class TestCrypto:
    # --- Happy path ---

    def test_encrypt_and_decrypt_roundtrip(self):
        key = _make_test_key()
        plaintext = "MySecretPassword123!"
        enc = encrypt_smtp_password(plaintext, key)
        dec = decrypt_smtp_password(enc, key)
        assert dec == plaintext

    def test_encrypt_produces_different_ciphertext_each_call(self):
        """Each call uses a random nonce, so ciphertexts must differ."""
        key = _make_test_key()
        plaintext = "same-password"
        enc1 = encrypt_smtp_password(plaintext, key)
        enc2 = encrypt_smtp_password(plaintext, key)
        assert enc1 != enc2

    def test_decrypt_with_wrong_key_raises(self):
        key1 = _make_test_key()
        key2 = _make_test_key()
        enc = encrypt_smtp_password("secret", key1)
        with pytest.raises(ValueError):
            decrypt_smtp_password(enc, key2)

    def test_encrypt_empty_string(self):
        key = _make_test_key()
        enc = encrypt_smtp_password("", key)
        dec = decrypt_smtp_password(enc, key)
        assert dec == ""

    def test_encrypt_unicode_password(self):
        key = _make_test_key()
        plaintext = "p@$$w0rd_Ünïcödé_😀"
        enc = encrypt_smtp_password(plaintext, key)
        dec = decrypt_smtp_password(enc, key)
        assert dec == plaintext

    # --- Input validation ---

    def test_encrypt_invalid_base64_key_raises(self):
        with pytest.raises(ValueError, match="not valid base64"):
            encrypt_smtp_password("pass", "not-valid-base64!!")

    def test_encrypt_key_wrong_length_raises(self):
        short_key = base64.b64encode(b"short-key").decode()
        with pytest.raises(ValueError, match="32 bytes"):
            encrypt_smtp_password("pass", short_key)

    def test_decrypt_invalid_base64_ciphertext_raises(self):
        key = _make_test_key()
        with pytest.raises(ValueError, match="not valid base64"):
            decrypt_smtp_password("!!!not-base64!!!", key)

    def test_decrypt_too_short_ciphertext_raises(self):
        key = _make_test_key()
        # 27 bytes base64-encoded — too short for 12-byte nonce + 16-byte tag
        short = base64.b64encode(b"x" * 27).decode()
        with pytest.raises(ValueError, match="too short"):
            decrypt_smtp_password(short, key)

    def test_decrypt_tampered_ciphertext_raises(self):
        key = _make_test_key()
        enc = encrypt_smtp_password("secret", key)
        # Flip a byte in the ciphertext
        raw = bytearray(base64.b64decode(enc))
        raw[15] ^= 0xFF
        tampered = base64.b64encode(bytes(raw)).decode()
        with pytest.raises(ValueError, match="Failed to decrypt"):
            decrypt_smtp_password(tampered, key)

    def test_decrypt_invalid_key_base64_raises(self):
        with pytest.raises(ValueError, match="not valid base64"):
            decrypt_smtp_password("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "!!!bad-key!!!")


# ---------------------------------------------------------------------------
# smtp_config_service
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestSmtpConfigService:
    # --- get_smtp_config ---

    async def test_get_smtp_config_returns_existing_row(self, db_session: AsyncSession):
        await _seed_smtp_config(db_session, smtp_host="mail.test.com")
        config = await get_smtp_config(db_session)
        assert config.smtp_host == "mail.test.com"

    async def test_get_smtp_config_creates_default_when_missing(self, db_session: AsyncSession):
        await _clear_smtp_config(db_session)
        config = await get_smtp_config(db_session)
        assert config.id == 1
        assert config.smtp_host == ""
        assert config.smtp_port == 587
        assert config.smtp_password_enc is None

    # --- update_smtp_config ---

    async def test_update_smtp_config_saves_all_fields(self, db_session: AsyncSession):
        key = _make_test_key()
        await _seed_smtp_config(db_session)
        data = SmtpConfigUpdate(
            smtp_host="smtp.new.com",
            smtp_port=465,
            smtp_username="admin@new.com",
            smtp_from_email="send@new.com",
            smtp_password="NewPass123",
        )
        with patch("app.services.smtp_config_service.settings") as mock_settings:
            mock_settings.smtp_encryption_key = key
            config = await update_smtp_config(data, db_session)
        assert config.smtp_host == "smtp.new.com"
        assert config.smtp_port == 465
        assert config.smtp_username == "admin@new.com"
        assert config.smtp_from_email == "send@new.com"
        assert config.smtp_password_enc is not None

    async def test_update_smtp_config_blank_password_retains_existing(self, db_session: AsyncSession):
        """When smtp_password is blank/None, existing encrypted password is unchanged."""
        key = _make_test_key()
        original_enc = encrypt_smtp_password("original", key)
        await _seed_smtp_config(db_session, smtp_password_enc=original_enc)
        data = SmtpConfigUpdate(
            smtp_host="smtp.example.com",
            smtp_port=587,
            smtp_username="user",
            smtp_from_email="noreply@example.com",
            smtp_password=None,
        )
        config = await update_smtp_config(data, db_session)
        assert config.smtp_password_enc == original_enc

    async def test_update_smtp_config_empty_string_password_retains_existing(self, db_session: AsyncSession):
        key = _make_test_key()
        original_enc = encrypt_smtp_password("original", key)
        await _seed_smtp_config(db_session, smtp_password_enc=original_enc)
        data = SmtpConfigUpdate(
            smtp_host="smtp.example.com",
            smtp_port=587,
            smtp_username="user",
            smtp_from_email="noreply@example.com",
            smtp_password="",
        )
        config = await update_smtp_config(data, db_session)
        assert config.smtp_password_enc == original_enc

    async def test_update_smtp_config_creates_row_if_missing(self, db_session: AsyncSession):
        await _clear_smtp_config(db_session)
        data = SmtpConfigUpdate(
            smtp_host="new.smtp.com",
            smtp_port=587,
            smtp_username="u",
            smtp_from_email="from@new.com",
        )
        config = await update_smtp_config(data, db_session)
        assert config.id == 1
        assert config.smtp_host == "new.smtp.com"

    async def test_update_smtp_config_no_key_logs_warning_no_encrypt(self, db_session: AsyncSession):
        """When SMTP_ENCRYPTION_KEY is empty, password is not encrypted (key missing warning)."""
        await _seed_smtp_config(db_session)
        data = SmtpConfigUpdate(
            smtp_host="smtp.example.com",
            smtp_port=587,
            smtp_username="user",
            smtp_from_email="from@example.com",
            smtp_password="SomePass",
        )
        with patch("app.services.smtp_config_service.settings") as mock_settings:
            mock_settings.smtp_encryption_key = ""
            config = await update_smtp_config(data, db_session)
        # Password not stored when key is missing
        assert config.smtp_password_enc is None or config.smtp_password_enc == ""

    # --- is_smtp_configured ---

    async def test_is_smtp_configured_returns_true_when_all_fields_set(self, db_session: AsyncSession):
        key = _make_test_key()
        enc = encrypt_smtp_password("pass", key)
        await _seed_smtp_config(db_session, smtp_password_enc=enc)
        result = await is_smtp_configured(db_session)
        assert result is True

    async def test_is_smtp_configured_returns_false_when_no_row(self, db_session: AsyncSession):
        await _clear_smtp_config(db_session)
        result = await is_smtp_configured(db_session)
        assert result is False

    async def test_is_smtp_configured_returns_false_when_host_empty(self, db_session: AsyncSession):
        key = _make_test_key()
        enc = encrypt_smtp_password("pass", key)
        await _seed_smtp_config(db_session, smtp_host="", smtp_password_enc=enc)
        result = await is_smtp_configured(db_session)
        assert result is False

    async def test_is_smtp_configured_returns_false_when_password_null(self, db_session: AsyncSession):
        await _seed_smtp_config(db_session, smtp_password_enc=None)
        result = await is_smtp_configured(db_session)
        assert result is False

    async def test_is_smtp_configured_returns_false_when_username_empty(self, db_session: AsyncSession):
        key = _make_test_key()
        enc = encrypt_smtp_password("pass", key)
        await _seed_smtp_config(db_session, smtp_username="", smtp_password_enc=enc)
        result = await is_smtp_configured(db_session)
        assert result is False

    async def test_is_smtp_configured_returns_false_when_from_email_empty(self, db_session: AsyncSession):
        key = _make_test_key()
        enc = encrypt_smtp_password("pass", key)
        await _seed_smtp_config(db_session, smtp_from_email="", smtp_password_enc=enc)
        result = await is_smtp_configured(db_session)
        assert result is False

    # --- get_decrypted_password ---

    def test_get_decrypted_password_returns_plaintext(self):
        key = _make_test_key()
        enc = encrypt_smtp_password("Secret123", key)
        config = TenantSmtpConfig(id=1, smtp_host="h", smtp_port=587, smtp_username="u", smtp_from_email="f@e.com", smtp_password_enc=enc)
        with patch("app.services.smtp_config_service.settings") as mock_settings:
            mock_settings.smtp_encryption_key = key
            result = get_decrypted_password(config)
        assert result == "Secret123"

    def test_get_decrypted_password_returns_empty_when_enc_null(self):
        config = TenantSmtpConfig(id=1, smtp_host="h", smtp_port=587, smtp_username="u", smtp_from_email="f@e.com", smtp_password_enc=None)
        result = get_decrypted_password(config)
        assert result == ""

    def test_get_decrypted_password_returns_empty_when_no_key(self):
        config = TenantSmtpConfig(id=1, smtp_host="h", smtp_port=587, smtp_username="u", smtp_from_email="f@e.com", smtp_password_enc="enc")
        with patch("app.services.smtp_config_service.settings") as mock_settings:
            mock_settings.smtp_encryption_key = ""
            result = get_decrypted_password(config)
        assert result == ""

    def test_get_decrypted_password_returns_empty_on_decryption_failure(self):
        config = TenantSmtpConfig(id=1, smtp_host="h", smtp_port=587, smtp_username="u", smtp_from_email="f@e.com", smtp_password_enc="not-valid-enc")
        key = _make_test_key()
        with patch("app.services.smtp_config_service.settings") as mock_settings:
            mock_settings.smtp_encryption_key = key
            result = get_decrypted_password(config)
        assert result == ""


# ---------------------------------------------------------------------------
# Pydantic schema validation
# ---------------------------------------------------------------------------


class TestSmtpConfigUpdateSchema:
    def test_valid_schema(self):
        data = SmtpConfigUpdate(
            smtp_host="smtp.example.com",
            smtp_port=587,
            smtp_username="user",
            smtp_from_email="from@example.com",
        )
        assert data.smtp_host == "smtp.example.com"
        assert data.smtp_port == 587

    def test_strips_whitespace_from_host(self):
        data = SmtpConfigUpdate(
            smtp_host="  smtp.example.com  ",
            smtp_port=587,
            smtp_username="user",
            smtp_from_email="from@example.com",
        )
        assert data.smtp_host == "smtp.example.com"

    def test_rejects_empty_host(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            SmtpConfigUpdate(smtp_host="", smtp_port=587, smtp_username="user", smtp_from_email="from@example.com")

    def test_rejects_port_zero(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            SmtpConfigUpdate(smtp_host="smtp.example.com", smtp_port=0, smtp_username="user", smtp_from_email="from@example.com")

    def test_rejects_port_too_high(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            SmtpConfigUpdate(smtp_host="smtp.example.com", smtp_port=65536, smtp_username="user", smtp_from_email="from@example.com")

    def test_accepts_port_1(self):
        data = SmtpConfigUpdate(smtp_host="smtp.example.com", smtp_port=1, smtp_username="user", smtp_from_email="from@example.com")
        assert data.smtp_port == 1

    def test_accepts_port_65535(self):
        data = SmtpConfigUpdate(smtp_host="smtp.example.com", smtp_port=65535, smtp_username="user", smtp_from_email="from@example.com")
        assert data.smtp_port == 65535

    def test_rejects_empty_username(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            SmtpConfigUpdate(smtp_host="smtp.example.com", smtp_port=587, smtp_username="", smtp_from_email="from@example.com")

    def test_rejects_invalid_email(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            SmtpConfigUpdate(smtp_host="smtp.example.com", smtp_port=587, smtp_username="user", smtp_from_email="notanemail")

    def test_rejects_empty_from_email(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            SmtpConfigUpdate(smtp_host="smtp.example.com", smtp_port=587, smtp_username="user", smtp_from_email="")

    def test_strips_whitespace_from_from_email(self):
        data = SmtpConfigUpdate(
            smtp_host="smtp.example.com",
            smtp_port=587,
            smtp_username="user",
            smtp_from_email="  from@example.com  ",
        )
        assert data.smtp_from_email == "from@example.com"

    def test_password_optional(self):
        data = SmtpConfigUpdate(
            smtp_host="smtp.example.com",
            smtp_port=587,
            smtp_username="user",
            smtp_from_email="from@example.com",
        )
        assert data.smtp_password is None


# ---------------------------------------------------------------------------
# API endpoints — GET /api/admin/config/smtp
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestGetSmtpConfig:
    async def test_returns_config_fields(self, app, db_session: AsyncSession):
        key = _make_test_key()
        enc = encrypt_smtp_password("pass", key)
        await _seed_smtp_config(
            db_session,
            smtp_host="mail.example.com",
            smtp_port=465,
            smtp_username="user@example.com",
            smtp_from_email="send@example.com",
            smtp_password_enc=enc,
        )
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/admin/config/smtp")
        assert resp.status_code == 200
        body = resp.json()
        assert body["smtp_host"] == "mail.example.com"
        assert body["smtp_port"] == 465
        assert body["smtp_username"] == "user@example.com"
        assert body["smtp_from_email"] == "send@example.com"
        assert body["password_is_set"] is True
        assert "smtp_password" not in body
        assert "smtp_password_enc" not in body

    async def test_password_is_set_false_when_null(self, app, db_session: AsyncSession):
        await _seed_smtp_config(db_session, smtp_password_enc=None)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/admin/config/smtp")
        assert resp.status_code == 200
        assert resp.json()["password_is_set"] is False

    async def test_returns_empty_defaults_when_no_row(self, app, db_session: AsyncSession):
        await _clear_smtp_config(db_session)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/admin/config/smtp")
        assert resp.status_code == 200
        body = resp.json()
        assert body["smtp_host"] == ""
        assert body["password_is_set"] is False


# ---------------------------------------------------------------------------
# API endpoints — PUT /api/admin/config/smtp
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestUpdateSmtpConfig:
    async def test_upserts_all_fields(self, app, db_session: AsyncSession):
        key = _make_test_key()
        await _seed_smtp_config(db_session)
        payload = {
            "smtp_host": "new.smtp.com",
            "smtp_port": 465,
            "smtp_username": "newuser",
            "smtp_from_email": "new@example.com",
            "smtp_password": "NewPassword",
        }
        with patch("app.services.smtp_config_service.settings") as mock_settings:
            mock_settings.smtp_encryption_key = key
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.put("/api/admin/config/smtp", json=payload)
        assert resp.status_code == 200
        body = resp.json()
        assert body["smtp_host"] == "new.smtp.com"
        assert body["smtp_port"] == 465
        assert body["password_is_set"] is True

    async def test_rejects_invalid_email(self, app, db_session: AsyncSession):
        await _seed_smtp_config(db_session)
        payload = {
            "smtp_host": "smtp.com",
            "smtp_port": 587,
            "smtp_username": "user",
            "smtp_from_email": "not-an-email",
        }
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config/smtp", json=payload)
        assert resp.status_code == 422

    async def test_rejects_empty_host(self, app, db_session: AsyncSession):
        payload = {
            "smtp_host": "",
            "smtp_port": 587,
            "smtp_username": "user",
            "smtp_from_email": "from@example.com",
        }
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config/smtp", json=payload)
        assert resp.status_code == 422

    async def test_rejects_port_out_of_range(self, app, db_session: AsyncSession):
        payload = {
            "smtp_host": "smtp.com",
            "smtp_port": 70000,
            "smtp_username": "user",
            "smtp_from_email": "from@example.com",
        }
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config/smtp", json=payload)
        assert resp.status_code == 422

    async def test_blank_password_retains_existing(self, app, db_session: AsyncSession):
        key = _make_test_key()
        enc = encrypt_smtp_password("original", key)
        await _seed_smtp_config(db_session, smtp_password_enc=enc)
        payload = {
            "smtp_host": "smtp.example.com",
            "smtp_port": 587,
            "smtp_username": "user",
            "smtp_from_email": "from@example.com",
        }
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config/smtp", json=payload)
        assert resp.status_code == 200
        # password_is_set should still be True since we retained it
        assert resp.json()["password_is_set"] is True


# ---------------------------------------------------------------------------
# API endpoints — GET /api/admin/config/smtp/status
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestSmtpStatus:
    async def test_configured_true_when_all_fields_set(self, app, db_session: AsyncSession):
        key = _make_test_key()
        enc = encrypt_smtp_password("pass", key)
        await _seed_smtp_config(db_session, smtp_password_enc=enc)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/admin/config/smtp/status")
        assert resp.status_code == 200
        assert resp.json()["configured"] is True

    async def test_configured_false_when_no_row(self, app, db_session: AsyncSession):
        await _clear_smtp_config(db_session)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/admin/config/smtp/status")
        assert resp.status_code == 200
        assert resp.json()["configured"] is False

    async def test_configured_false_when_password_null(self, app, db_session: AsyncSession):
        await _seed_smtp_config(db_session, smtp_password_enc=None)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/admin/config/smtp/status")
        assert resp.status_code == 200
        assert resp.json()["configured"] is False


# ---------------------------------------------------------------------------
# API endpoints — POST /api/admin/config/smtp/test
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestSmtpTest:
    async def test_returns_ok_on_success(self, app, db_session: AsyncSession):
        key = _make_test_key()
        enc = encrypt_smtp_password("pass", key)
        await _seed_smtp_config(db_session, smtp_password_enc=enc)

        with patch("app.routers.admin.aiosmtplib") as mock_smtp, \
             patch("app.routers.admin.smtp_config_service.get_decrypted_password", return_value="pass"), \
             patch("app.routers.admin._smtp_test_call_times", []):
            mock_smtp.send = AsyncMock()
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post("/api/admin/config/smtp/test")
        assert resp.status_code == 200
        assert resp.json()["ok"] is True

    async def test_returns_400_on_smtp_failure(self, app, db_session: AsyncSession):
        key = _make_test_key()
        enc = encrypt_smtp_password("pass", key)
        await _seed_smtp_config(db_session, smtp_password_enc=enc)

        with patch("app.routers.admin.aiosmtplib") as mock_smtp, \
             patch("app.routers.admin.smtp_config_service.get_decrypted_password", return_value="pass"), \
             patch("app.routers.admin._smtp_test_call_times", []):
            mock_smtp.send = AsyncMock(side_effect=Exception("Connection refused"))
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post("/api/admin/config/smtp/test")
        assert resp.status_code == 400
        assert "Connection refused" in resp.json()["detail"]

    async def test_returns_409_when_not_configured(self, app, db_session: AsyncSession):
        await _clear_smtp_config(db_session)
        with patch("app.routers.admin._smtp_test_call_times", []):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post("/api/admin/config/smtp/test")
        assert resp.status_code == 409

    async def test_rate_limit_after_5_calls(self, app, db_session: AsyncSession):
        key = _make_test_key()
        enc = encrypt_smtp_password("pass", key)
        await _seed_smtp_config(db_session, smtp_password_enc=enc)

        import app.routers.admin as admin_module
        # Manually fill up the rate limit list with recent timestamps
        now = datetime.now(UTC)
        fake_times = [now - timedelta(seconds=i) for i in range(5)]

        with patch.object(admin_module, "_smtp_test_call_times", fake_times):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post("/api/admin/config/smtp/test")
        assert resp.status_code == 429

    async def test_rate_limit_pruned_after_60_seconds(self, app, db_session: AsyncSession):
        """Old entries older than 60s are pruned; test then succeeds."""
        key = _make_test_key()
        enc = encrypt_smtp_password("pass", key)
        await _seed_smtp_config(db_session, smtp_password_enc=enc)

        import app.routers.admin as admin_module
        # Fill with old timestamps (>60s ago) — should be pruned
        now = datetime.now(UTC)
        old_times = [now - timedelta(seconds=120 + i) for i in range(5)]

        with patch.object(admin_module, "_smtp_test_call_times", old_times), \
             patch("app.routers.admin.aiosmtplib") as mock_smtp, \
             patch("app.routers.admin.smtp_config_service.get_decrypted_password", return_value="pass"):
            mock_smtp.send = AsyncMock()
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post("/api/admin/config/smtp/test")
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# SmtpNotConfiguredError — email_service behaviour
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestSmtpNotConfiguredError:
    async def test_send_otp_email_raises_when_no_config(self):
        """send_otp_email raises SmtpNotConfiguredError when SMTP not configured."""
        from app.services.email_service import send_otp_email

        mock_config = MagicMock()
        mock_config.smtp_host = ""
        mock_config.smtp_username = ""
        mock_config.smtp_from_email = ""
        mock_config.smtp_password_enc = None

        mock_db = AsyncMock()
        with patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_config)):
            with pytest.raises(SmtpNotConfiguredError, match="SMTP not configured"):
                await send_otp_email("user@example.com", "Test Meeting", "123456", db=mock_db)

    async def test_send_report_raises_when_no_config(self, db_session: AsyncSession):
        """send_report raises SmtpNotConfiguredError when SMTP not configured."""
        from app.models import Building, GeneralMeeting, GeneralMeetingStatus, Motion
        from app.services.email_service import EmailService

        building = Building(name=f"NoSMTP {uuid.uuid4()}", manager_email="mgr@example.com")
        db_session.add(building)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=building.id,
            title="Test AGM NoSMTP",
            status=GeneralMeetingStatus.closed,
            meeting_at=datetime.now(UTC) + timedelta(days=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=2),
            closed_at=datetime.now(UTC),
        )
        db_session.add(agm)
        await db_session.flush()
        motion = Motion(general_meeting_id=agm.id, title="M1", description=None, display_order=1)
        db_session.add(motion)
        await db_session.commit()

        mock_config = MagicMock()
        mock_config.smtp_host = ""
        mock_config.smtp_username = ""
        mock_config.smtp_from_email = ""
        mock_config.smtp_password_enc = None

        service = EmailService()
        with patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_config)):
            with pytest.raises(SmtpNotConfiguredError):
                await service.send_report(agm.id, db_session)

    async def test_trigger_with_retry_fails_immediately_on_smtp_not_configured(
        self, db_session: AsyncSession, mocker
    ):
        """SmtpNotConfiguredError causes immediate failure (status=failed) without retry."""
        from app.models import (
            Building, GeneralMeeting, GeneralMeetingStatus, Motion,
            EmailDelivery, EmailDeliveryStatus
        )
        from app.services.email_service import EmailService

        building = Building(name=f"SMTP_ERR {uuid.uuid4()}", manager_email="mgr@example.com")
        db_session.add(building)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=building.id,
            title="Test AGM SmtpError",
            status=GeneralMeetingStatus.closed,
            meeting_at=datetime.now(UTC) + timedelta(days=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=2),
            closed_at=datetime.now(UTC),
        )
        db_session.add(agm)
        await db_session.flush()
        motion = Motion(general_meeting_id=agm.id, title="M1", description=None, display_order=1)
        db_session.add(motion)
        delivery = EmailDelivery(
            general_meeting_id=agm.id,
            status=EmailDeliveryStatus.pending,
            total_attempts=0,
        )
        db_session.add(delivery)
        await db_session.commit()

        mock_config = MagicMock()
        mock_config.smtp_host = ""
        mock_config.smtp_username = ""
        mock_config.smtp_from_email = ""
        mock_config.smtp_password_enc = None

        from tests.test_email import _make_mock_factory
        mock_factory = _make_mock_factory(db_session)
        mocker.patch(
            "app.services.email_service._make_session_factory",
            return_value=mock_factory,
        )
        mocker.patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_config))

        service = EmailService()
        await service.trigger_with_retry(agm.id)

        await db_session.refresh(delivery)
        assert delivery.status == EmailDeliveryStatus.failed
        assert delivery.total_attempts == 1
        assert "SMTP not configured" in (delivery.last_error or "")

    async def test_smtp_not_configured_error_is_non_retryable(
        self, db_session: AsyncSession, mocker
    ):
        """After SmtpNotConfiguredError, asyncio.sleep is NOT called (no retry)."""
        from app.models import (
            Building, GeneralMeeting, GeneralMeetingStatus, Motion,
            EmailDelivery, EmailDeliveryStatus
        )
        from app.services.email_service import EmailService

        building = Building(name=f"SMTP_ERR2 {uuid.uuid4()}", manager_email="mgr@example.com")
        db_session.add(building)
        await db_session.flush()
        agm = GeneralMeeting(
            building_id=building.id,
            title="Test AGM SmtpError2",
            status=GeneralMeetingStatus.closed,
            meeting_at=datetime.now(UTC) + timedelta(days=1),
            voting_closes_at=datetime.now(UTC) + timedelta(days=2),
            closed_at=datetime.now(UTC),
        )
        db_session.add(agm)
        await db_session.flush()
        motion = Motion(general_meeting_id=agm.id, title="M1", description=None, display_order=1)
        db_session.add(motion)
        delivery = EmailDelivery(
            general_meeting_id=agm.id,
            status=EmailDeliveryStatus.pending,
            total_attempts=0,
        )
        db_session.add(delivery)
        await db_session.commit()

        mock_config = MagicMock()
        mock_config.smtp_host = ""
        mock_config.smtp_username = ""
        mock_config.smtp_from_email = ""
        mock_config.smtp_password_enc = None

        from tests.test_email import _make_mock_factory
        mock_factory = _make_mock_factory(db_session)
        mocker.patch(
            "app.services.email_service._make_session_factory",
            return_value=mock_factory,
        )
        mocker.patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_config))
        sleep_mock = mocker.patch("asyncio.sleep", new=AsyncMock())

        service = EmailService()
        await service.trigger_with_retry(agm.id)

        # No sleep called — immediate failure, no retry
        sleep_mock.assert_not_called()
