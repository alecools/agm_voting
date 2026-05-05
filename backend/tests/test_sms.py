"""
Tests for SMS OTP backend slice.

Covers:
- app.services.sms_service: all four drivers + SmsDeliveryError paths
- app.services.smtp_config_service: SMS get/update/build helpers
- app.schemas.config: SmsConfigUpdate, SmsTestRequest validators
- POST /api/auth/request-otp: channel=sms validation, has_phone field
- GET/PUT /api/admin/config/sms: read/write SMS config
- POST /api/admin/config/sms/test: test SMS endpoint
- admin_service: phone normalisation + lot owner import (CSV + Excel)

Structure:
  # --- Happy path ---
  # --- Input validation ---
  # --- Boundary values ---
  # --- State / precondition errors ---
  # --- Edge cases ---
"""
from __future__ import annotations

import base64
import io
import os
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import openpyxl
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Building, GeneralMeeting, GeneralMeetingStatus, LotOwner
from app.models.lot_owner_email import LotOwnerEmail
from app.models.tenant_smtp_config import TenantSmtpConfig
from app.services import smtp_config_service
from app.services.sms_service import (
    SmsDeliveryError,
    _send_clicksend,
    _send_smtp2go,
    _send_twilio,
    _send_webhook,
    send,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_test_key() -> str:
    return base64.b64encode(os.urandom(32)).decode("ascii")


async def _clear_smtp_config(db: AsyncSession) -> None:
    await db.execute(delete(TenantSmtpConfig))
    await db.flush()


async def _seed_sms_config(
    db: AsyncSession,
    *,
    sms_enabled: bool = True,
    sms_provider: str | None = "webhook",
    sms_webhook_url: str | None = "https://hook.example.com",
    sms_from_number: str | None = "+61400000000",
) -> TenantSmtpConfig:
    await _clear_smtp_config(db)
    config = TenantSmtpConfig(
        id=1,
        smtp_host="smtp.example.com",
        smtp_port=587,
        smtp_username="u",
        smtp_from_email="noreply@example.com",
        sms_enabled=sms_enabled,
        sms_provider=sms_provider,
        sms_webhook_url=sms_webhook_url,
        sms_from_number=sms_from_number,
    )
    db.add(config)
    await db.flush()
    await db.commit()
    await db.refresh(config)
    return config


def make_csv(headers: list[str], rows: list[list[str]]) -> bytes:
    import csv as _csv
    buf = io.StringIO()
    writer = _csv.writer(buf)
    writer.writerow(headers)
    for row in rows:
        writer.writerow(row)
    return buf.getvalue().encode()


def make_excel(headers: list, rows: list[list]) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(headers)
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf.read()


def _future(days: int = 2) -> datetime:
    return datetime.now(UTC) + timedelta(days=days)


def _past(hours: int = 1) -> datetime:
    return datetime.now(UTC) - timedelta(hours=hours)


# ---------------------------------------------------------------------------
# SmsService — driver unit tests (mock httpx)
# ---------------------------------------------------------------------------


class TestSmsServiceSmtp2go:
    # --- Happy path ---

    @pytest.mark.asyncio
    async def test_send_smtp2go_success(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"data": {"succeeded": 1}}
        with patch("app.services.sms_service.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_cls.return_value = mock_client
            await _send_smtp2go("key123", "SenderName", "+61400000001", "Test message")
        mock_client.post.assert_awaited_once()
        call_kwargs = mock_client.post.call_args
        payload = call_kwargs[1]["json"]
        assert payload["api_key"] == "key123"
        assert payload["destination"] == ["+61400000001"]
        assert payload["content"] == "Test message"
        assert payload["sender"] == "SenderName"

    # --- State / precondition errors ---

    @pytest.mark.asyncio
    async def test_send_smtp2go_non_200_raises(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 400
        with patch("app.services.sms_service.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_cls.return_value = mock_client
            with pytest.raises(SmsDeliveryError, match="smtp2go returned 400"):
                await _send_smtp2go("key", "Sender", "+61400000001", "msg")

    @pytest.mark.asyncio
    async def test_send_smtp2go_zero_succeeded_raises(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"data": {"succeeded": 0}}
        with patch("app.services.sms_service.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_cls.return_value = mock_client
            with pytest.raises(SmsDeliveryError, match="no messages succeeded"):
                await _send_smtp2go("key", "Sender", "+61400000001", "msg")


class TestSmsServiceTwilio:
    # --- Happy path ---

    @pytest.mark.asyncio
    async def test_send_twilio_success(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 201
        with patch("app.services.sms_service.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_cls.return_value = mock_client
            await _send_twilio("AC123", "token456", "+61200000000", "+61400000001", "Hello")
        call_kwargs = mock_client.post.call_args
        assert call_kwargs[1]["auth"] == ("AC123", "token456")
        assert call_kwargs[1]["data"]["To"] == "+61400000001"
        assert call_kwargs[1]["data"]["From"] == "+61200000000"
        assert call_kwargs[1]["data"]["Body"] == "Hello"
        assert "AC123" in call_kwargs[0][0]

    # --- State / precondition errors ---

    @pytest.mark.asyncio
    async def test_send_twilio_non_201_raises(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 400
        with patch("app.services.sms_service.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_cls.return_value = mock_client
            with pytest.raises(SmsDeliveryError, match="Twilio returned 400"):
                await _send_twilio("sid", "tok", "+61200000000", "+61400000001", "msg")


class TestSmsServiceClickSend:
    # --- Happy path ---

    @pytest.mark.asyncio
    async def test_send_clicksend_success(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        with patch("app.services.sms_service.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_cls.return_value = mock_client
            await _send_clicksend("user", "apikey", "+61200000000", "+61400000001", "Hello")
        call_kwargs = mock_client.post.call_args
        assert call_kwargs[1]["auth"] == ("user", "apikey")
        payload = call_kwargs[1]["json"]
        assert payload["messages"][0]["to"] == "+61400000001"
        assert payload["messages"][0]["body"] == "Hello"

    # --- State / precondition errors ---

    @pytest.mark.asyncio
    async def test_send_clicksend_non_200_raises(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 503
        with patch("app.services.sms_service.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_cls.return_value = mock_client
            with pytest.raises(SmsDeliveryError, match="ClickSend returned 503"):
                await _send_clicksend("u", "k", "+61200000000", "+61400000001", "msg")


class TestSmsServiceWebhook:
    # --- Happy path ---

    @pytest.mark.asyncio
    async def test_send_webhook_success_no_secret(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        with patch("app.services.sms_service.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_cls.return_value = mock_client
            await _send_webhook("https://hook.example.com", "+61400000001", "Hello", secret=None)
        call_kwargs = mock_client.post.call_args
        assert call_kwargs[0][0] == "https://hook.example.com"
        headers = call_kwargs[1]["headers"]
        assert "X-Signature" not in headers

    @pytest.mark.asyncio
    async def test_send_webhook_with_secret_adds_hmac_header(self):
        import hashlib
        import hmac as hmac_mod
        import json as _json

        mock_resp = MagicMock()
        mock_resp.status_code = 202
        with patch("app.services.sms_service.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_cls.return_value = mock_client
            await _send_webhook("https://hook.example.com", "+61400000001", "Hello", secret="mysecret")

        call_kwargs = mock_client.post.call_args
        headers = call_kwargs[1]["headers"]
        body_bytes = call_kwargs[1]["content"]
        assert "X-Signature" in headers
        expected_sig = hmac_mod.new(b"mysecret", body_bytes, hashlib.sha256).hexdigest()
        assert headers["X-Signature"] == f"hmac-sha256={expected_sig}"
        payload = _json.loads(body_bytes)
        assert payload["to"] == "+61400000001"
        assert payload["message"] == "Hello"

    @pytest.mark.asyncio
    async def test_send_webhook_accepts_204(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 204
        with patch("app.services.sms_service.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_cls.return_value = mock_client
            await _send_webhook("https://hook.example.com", "+61400000001", "Hello")

    # --- State / precondition errors ---

    @pytest.mark.asyncio
    async def test_send_webhook_non_200_raises(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        with patch("app.services.sms_service.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_cls.return_value = mock_client
            with pytest.raises(SmsDeliveryError, match="Webhook returned 500"):
                await _send_webhook("https://hook.example.com", "+61400000001", "Hello")


class TestSmsServiceDispatch:
    # --- Happy path ---

    @pytest.mark.asyncio
    async def test_dispatch_smtp2go(self):
        with patch("app.services.sms_service._send_smtp2go", new=AsyncMock()) as mock_fn:
            await send(
                provider="smtp2go",
                to="+61400000001",
                message="Hello",
                smtp2go_api_key="key",
                smtp2go_sender="Sender",
            )
            mock_fn.assert_awaited_once_with("key", "Sender", "+61400000001", "Hello")

    @pytest.mark.asyncio
    async def test_dispatch_twilio(self):
        with patch("app.services.sms_service._send_twilio", new=AsyncMock()) as mock_fn:
            await send(
                provider="twilio",
                to="+61400000001",
                message="Hello",
                twilio_account_sid="sid",
                twilio_auth_token="tok",
                twilio_from_number="+61200000000",
            )
            mock_fn.assert_awaited_once_with("sid", "tok", "+61200000000", "+61400000001", "Hello")

    @pytest.mark.asyncio
    async def test_dispatch_clicksend(self):
        with patch("app.services.sms_service._send_clicksend", new=AsyncMock()) as mock_fn:
            await send(
                provider="clicksend",
                to="+61400000001",
                message="Hello",
                clicksend_username="user",
                clicksend_api_key="apikey",
                clicksend_from_number="+61200000000",
            )
            mock_fn.assert_awaited_once_with("user", "apikey", "+61200000000", "+61400000001", "Hello")

    @pytest.mark.asyncio
    async def test_dispatch_webhook(self):
        with patch("app.services.sms_service._send_webhook", new=AsyncMock()) as mock_fn:
            await send(
                provider="webhook",
                to="+61400000001",
                message="Hello",
                webhook_url="https://hook.example.com",
                webhook_secret="secret",
            )
            mock_fn.assert_awaited_once_with(
                "https://hook.example.com", "+61400000001", "Hello", secret="secret"
            )

    # --- Input validation ---

    @pytest.mark.asyncio
    async def test_dispatch_unknown_provider_raises(self):
        with pytest.raises(SmsDeliveryError, match="Unknown SMS provider"):
            await send(provider="unknown_provider", to="+61400000001", message="Hello")

    @pytest.mark.asyncio
    async def test_dispatch_smtp2go_missing_key_raises(self):
        with pytest.raises(SmsDeliveryError):
            await send(provider="smtp2go", to="+61400000001", message="Hello")

    @pytest.mark.asyncio
    async def test_dispatch_twilio_missing_credentials_raises(self):
        with pytest.raises(SmsDeliveryError):
            await send(provider="twilio", to="+61400000001", message="Hello")

    @pytest.mark.asyncio
    async def test_dispatch_clicksend_missing_credentials_raises(self):
        with pytest.raises(SmsDeliveryError):
            await send(provider="clicksend", to="+61400000001", message="Hello")

    @pytest.mark.asyncio
    async def test_dispatch_webhook_missing_url_raises(self):
        with pytest.raises(SmsDeliveryError):
            await send(provider="webhook", to="+61400000001", message="Hello")

    @pytest.mark.asyncio
    async def test_unexpected_exception_wrapped_as_delivery_error(self):
        with patch(
            "app.services.sms_service._send_webhook",
            new=AsyncMock(side_effect=RuntimeError("boom")),
        ):
            with pytest.raises(SmsDeliveryError, match="Unexpected error"):
                await send(
                    provider="webhook",
                    to="+61400000001",
                    message="Hello",
                    webhook_url="https://hook.example.com",
                )


# ---------------------------------------------------------------------------
# smtp_config_service — SMS helpers
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestSmsConfigService:
    # --- Happy path ---

    async def test_update_and_retrieve_sms_config(self, db_session: AsyncSession):
        from app.schemas.config import SmsConfigUpdate
        key = _make_test_key()
        await _clear_smtp_config(db_session)
        data = SmsConfigUpdate(
            sms_enabled=True,
            sms_provider="webhook",
            sms_webhook_url="https://hook.example.com",
            sms_webhook_secret="mysecret",
            sms_from_number="+61400000000",
        )
        with patch("app.services.smtp_config_service.settings") as mock_settings:
            mock_settings.smtp_encryption_key = key
            config = await smtp_config_service.update_sms_config(data, db_session)
        assert config.sms_enabled is True
        assert config.sms_provider == "webhook"
        assert config.sms_webhook_url == "https://hook.example.com"
        assert config.sms_webhook_secret_enc is not None
        assert config.sms_from_number == "+61400000000"

    async def test_build_sms_config_out_secrets_not_exposed(self, db_session: AsyncSession):
        key = _make_test_key()
        from app.crypto import encrypt_smtp_password
        enc = encrypt_smtp_password("mysecret", key)
        await _clear_smtp_config(db_session)
        config = TenantSmtpConfig(
            id=1,
            smtp_host="h",
            smtp_port=587,
            smtp_username="u",
            smtp_from_email="f@e.com",
            sms_enabled=True,
            sms_provider="twilio",
            sms_twilio_account_sid="ACabc",
            sms_twilio_auth_token_enc=enc,
            sms_twilio_from_number="+61200000000",
        )
        db_session.add(config)
        await db_session.flush()
        out = smtp_config_service.build_sms_config_out(config)
        assert out.sms_twilio_account_sid == "ACabc"
        assert out.sms_twilio_auth_token_is_set is True
        assert out.sms_twilio_from_number == "+61200000000"
        # Secrets must not appear in output
        assert not hasattr(out, "sms_twilio_auth_token")

    async def test_update_sms_config_blank_secret_retains_existing(self, db_session: AsyncSession):
        from app.schemas.config import SmsConfigUpdate
        from app.crypto import encrypt_smtp_password
        key = _make_test_key()
        enc = encrypt_smtp_password("original_secret", key)
        await _clear_smtp_config(db_session)
        config = TenantSmtpConfig(
            id=1,
            smtp_host="h",
            smtp_port=587,
            smtp_username="u",
            smtp_from_email="f@e.com",
            sms_webhook_secret_enc=enc,
        )
        db_session.add(config)
        await db_session.flush()
        await db_session.commit()

        data = SmsConfigUpdate(sms_enabled=False, sms_webhook_secret=None)
        with patch("app.services.smtp_config_service.settings") as mock_settings:
            mock_settings.smtp_encryption_key = key
            updated = await smtp_config_service.update_sms_config(data, db_session)
        assert updated.sms_webhook_secret_enc == enc

    async def test_get_sms_send_kwargs_decrypts_secrets(self, db_session: AsyncSession):
        from app.crypto import encrypt_smtp_password
        key = _make_test_key()
        enc_tok = encrypt_smtp_password("auth_token_value", key)
        config = TenantSmtpConfig(
            id=1,
            smtp_host="h",
            smtp_port=587,
            smtp_username="u",
            smtp_from_email="f@e.com",
            sms_provider="twilio",
            sms_twilio_account_sid="ACabc",
            sms_twilio_auth_token_enc=enc_tok,
            sms_twilio_from_number="+61200000000",
        )
        with patch("app.services.smtp_config_service.settings") as mock_settings:
            mock_settings.smtp_encryption_key = key
            kwargs = smtp_config_service.get_sms_send_kwargs(config)
        assert kwargs["twilio_account_sid"] == "ACabc"
        assert kwargs["twilio_auth_token"] == "auth_token_value"
        assert kwargs["twilio_from_number"] == "+61200000000"

    async def test_update_sms_config_no_key_raises_500_when_secret_set(self, db_session: AsyncSession):
        from fastapi import HTTPException
        from app.schemas.config import SmsConfigUpdate
        await _clear_smtp_config(db_session)
        data = SmsConfigUpdate(sms_enabled=True, sms_smtp2go_api_key="some_key")
        with patch("app.services.smtp_config_service.settings") as mock_settings:
            mock_settings.smtp_encryption_key = ""
            with pytest.raises(HTTPException) as exc_info:
                await smtp_config_service.update_sms_config(data, db_session)
        assert exc_info.value.status_code == 500

    async def test_update_sms_config_creates_row_if_missing(self, db_session: AsyncSession):
        from app.schemas.config import SmsConfigUpdate
        await _clear_smtp_config(db_session)
        data = SmsConfigUpdate(sms_enabled=True, sms_provider="webhook", sms_webhook_url="https://h.com")
        with patch("app.services.smtp_config_service.settings") as mock_settings:
            mock_settings.smtp_encryption_key = ""
            config = await smtp_config_service.update_sms_config(data, db_session)
        assert config.id == 1
        assert config.sms_provider == "webhook"

    async def test_update_sms_config_twilio_auth_token_encrypted(self, db_session: AsyncSession):
        """Covers line 205: sms_twilio_auth_token_enc is set when token supplied."""
        from app.schemas.config import SmsConfigUpdate
        key = _make_test_key()
        await _clear_smtp_config(db_session)
        data = SmsConfigUpdate(
            sms_enabled=True,
            sms_provider="twilio",
            sms_twilio_account_sid="ACabc",
            sms_twilio_auth_token="tokenval",
            sms_twilio_from_number="+61200000000",
        )
        with patch("app.services.smtp_config_service.settings") as mock_settings:
            mock_settings.smtp_encryption_key = key
            config = await smtp_config_service.update_sms_config(data, db_session)
        assert config.sms_twilio_auth_token_enc is not None
        assert config.sms_twilio_account_sid == "ACabc"

    async def test_update_sms_config_clicksend_api_key_encrypted(self, db_session: AsyncSession):
        """Covers line 207: sms_clicksend_api_key_enc is set when key supplied."""
        from app.schemas.config import SmsConfigUpdate
        key = _make_test_key()
        await _clear_smtp_config(db_session)
        data = SmsConfigUpdate(
            sms_enabled=True,
            sms_provider="clicksend",
            sms_clicksend_username="csuser",
            sms_clicksend_api_key="cskey",
            sms_clicksend_from_number="+61200000000",
        )
        with patch("app.services.smtp_config_service.settings") as mock_settings:
            mock_settings.smtp_encryption_key = key
            config = await smtp_config_service.update_sms_config(data, db_session)
        assert config.sms_clicksend_api_key_enc is not None
        assert config.sms_clicksend_username == "csuser"

    async def test_decrypt_secret_empty_key_returns_empty(self):
        """Covers _decrypt_secret line 134: no key → empty string."""
        from app.services.smtp_config_service import _decrypt_secret
        from app.crypto import encrypt_smtp_password
        key = _make_test_key()
        enc = encrypt_smtp_password("secret", key)
        # Pass empty key → should return "" without attempting decryption
        result = _decrypt_secret(enc, "", "test_field")
        assert result == ""

    async def test_decrypt_secret_bad_ciphertext_returns_empty(self):
        """Covers _decrypt_secret lines 137-139: decryption failure → empty string."""
        from app.services.smtp_config_service import _decrypt_secret
        key = _make_test_key()
        # Provide garbage that can't be decrypted
        result = _decrypt_secret("not-valid-base64!!!", key, "test_field")
        assert result == ""


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------


class TestSmsConfigUpdateSchema:
    def test_valid_schema_minimal(self):
        from app.schemas.config import SmsConfigUpdate
        data = SmsConfigUpdate(sms_enabled=False)
        assert data.sms_enabled is False
        assert data.sms_provider is None

    def test_valid_providers(self):
        from app.schemas.config import SmsConfigUpdate
        for p in ("smtp2go", "twilio", "clicksend", "webhook"):
            data = SmsConfigUpdate(sms_enabled=True, sms_provider=p)
            assert data.sms_provider == p

    def test_invalid_provider_rejected(self):
        from pydantic import ValidationError
        from app.schemas.config import SmsConfigUpdate
        with pytest.raises(ValidationError):
            SmsConfigUpdate(sms_enabled=True, sms_provider="unknown")


class TestSmsTestRequestSchema:
    def test_valid(self):
        from app.schemas.config import SmsTestRequest
        r = SmsTestRequest(to="+61400000001")
        assert r.to == "+61400000001"

    def test_strips_whitespace(self):
        from app.schemas.config import SmsTestRequest
        r = SmsTestRequest(to="  +61400000001  ")
        assert r.to == "+61400000001"

    def test_empty_to_rejected(self):
        from pydantic import ValidationError
        from app.schemas.config import SmsTestRequest
        with pytest.raises(ValidationError):
            SmsTestRequest(to="   ")


# ---------------------------------------------------------------------------
# POST /api/auth/request-otp — SMS channel
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def sms_building_and_meeting(db_session: AsyncSession):
    """Building with one open GeneralMeeting and one lot owner who has a phone on their email row."""
    b = Building(name=f"SMS Bldg {uuid.uuid4().hex[:6]}", manager_email="smsmgr@test.com")
    db_session.add(b)
    await db_session.flush()

    lo = LotOwner(
        building_id=b.id,
        lot_number="SMS-1",
        unit_entitlement=100,
    )
    db_session.add(lo)
    await db_session.flush()

    lo_email = LotOwnerEmail(lot_owner_id=lo.id, email="sms_voter@test.com", phone_number="+61411111111")
    db_session.add(lo_email)

    agm = GeneralMeeting(
        building_id=b.id,
        title="SMS Test Meeting",
        status=GeneralMeetingStatus.open,
        meeting_at=_past(),
        voting_closes_at=_future(),
    )
    db_session.add(agm)
    await db_session.flush()

    return {"building": b, "lot_owner": lo, "voter_email": "sms_voter@test.com", "agm": agm}


@pytest_asyncio.fixture
async def sms_building_no_phone(db_session: AsyncSession):
    """Building with a voter who has no phone number on their email row."""
    b = Building(name=f"NoPh Bldg {uuid.uuid4().hex[:6]}", manager_email="noph@test.com")
    db_session.add(b)
    await db_session.flush()

    lo = LotOwner(
        building_id=b.id,
        lot_number="NP-1",
        unit_entitlement=100,
    )
    db_session.add(lo)
    await db_session.flush()

    lo_email = LotOwnerEmail(lot_owner_id=lo.id, email="nophone_voter@test.com", phone_number=None)
    db_session.add(lo_email)

    agm = GeneralMeeting(
        building_id=b.id,
        title="No Phone Meeting",
        status=GeneralMeetingStatus.open,
        meeting_at=_past(),
        voting_closes_at=_future(),
    )
    db_session.add(agm)
    await db_session.flush()

    return {"building": b, "lot_owner": lo, "voter_email": "nophone_voter@test.com", "agm": agm}


@pytest.mark.asyncio(loop_scope="session")
class TestRequestOtpSmsChannel:
    # --- Happy path ---

    async def test_sms_channel_sends_sms_and_returns_200(
        self, app, db_session: AsyncSession, sms_building_and_meeting
    ):
        agm = sms_building_and_meeting["agm"]
        voter_email = sms_building_and_meeting["voter_email"]
        await _seed_sms_config(db_session)
        with patch("app.routers.auth.sms_send", new=AsyncMock()) as mock_sms, \
             patch("app.routers.auth.smtp_config_service.get_smtp_config", new=AsyncMock()) as mock_cfg:
            cfg = MagicMock()
            cfg.sms_enabled = True
            cfg.sms_provider = "webhook"
            mock_cfg.return_value = cfg
            with patch("app.routers.auth.smtp_config_service.get_sms_send_kwargs", return_value={
                "provider": "webhook",
                "webhook_url": "https://hook.example.com",
                "webhook_secret": None,
                "smtp2go_api_key": "",
                "smtp2go_sender": "",
                "twilio_account_sid": "",
                "twilio_auth_token": "",
                "twilio_from_number": "",
                "clicksend_username": "",
                "clicksend_api_key": "",
                "clicksend_from_number": "",
            }):
                async with AsyncClient(
                    transport=ASGITransport(app=app),
                    base_url="http://test",
                    headers={"X-Requested-With": "XMLHttpRequest"},
                ) as client:
                    resp = await client.post(
                        "/api/auth/request-otp",
                        json={
                            "email": voter_email,
                            "general_meeting_id": str(agm.id),
                            "channel": "sms",
                        },
                    )
        assert resp.status_code == 200
        body = resp.json()
        assert body["sent"] is True
        assert body["has_phone"] is True
        mock_sms.assert_awaited_once()
        # Verify the OTP message format
        call_args = mock_sms.call_args
        assert "AGM Voting code" in call_args[1].get("message", call_args[0][1] if len(call_args[0]) > 1 else "")

    async def test_response_has_phone_true_when_phone_present(
        self, app, db_session: AsyncSession, sms_building_and_meeting
    ):
        agm = sms_building_and_meeting["agm"]
        voter_email = sms_building_and_meeting["voter_email"]
        with patch("app.routers.auth.send_otp_email", new=AsyncMock()):
            async with AsyncClient(
                transport=ASGITransport(app=app),
                base_url="http://test",
                headers={"X-Requested-With": "XMLHttpRequest"},
            ) as client:
                resp = await client.post(
                    "/api/auth/request-otp",
                    json={"email": voter_email, "general_meeting_id": str(agm.id)},
                )
        assert resp.status_code == 200
        assert resp.json()["has_phone"] is True

    async def test_response_has_phone_false_when_no_phone(
        self, app, db_session: AsyncSession, sms_building_no_phone
    ):
        agm = sms_building_no_phone["agm"]
        voter_email = sms_building_no_phone["voter_email"]
        with patch("app.routers.auth.send_otp_email", new=AsyncMock()):
            async with AsyncClient(
                transport=ASGITransport(app=app),
                base_url="http://test",
                headers={"X-Requested-With": "XMLHttpRequest"},
            ) as client:
                resp = await client.post(
                    "/api/auth/request-otp",
                    json={"email": voter_email, "general_meeting_id": str(agm.id)},
                )
        assert resp.status_code == 200
        assert resp.json()["has_phone"] is False

    async def test_has_phone_false_for_unknown_email(
        self, app, db_session: AsyncSession, sms_building_and_meeting
    ):
        agm = sms_building_and_meeting["agm"]
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            headers={"X-Requested-With": "XMLHttpRequest"},
        ) as client:
            resp = await client.post(
                "/api/auth/request-otp",
                json={"email": "unknown@test.com", "general_meeting_id": str(agm.id)},
            )
        assert resp.status_code == 200
        assert resp.json()["has_phone"] is False

    # --- State / precondition errors ---

    async def test_sms_channel_503_when_sms_disabled(
        self, app, db_session: AsyncSession, sms_building_and_meeting
    ):
        agm = sms_building_and_meeting["agm"]
        voter_email = sms_building_and_meeting["voter_email"]
        await _seed_sms_config(db_session, sms_enabled=False)
        with patch("app.routers.auth.smtp_config_service.get_smtp_config", new=AsyncMock()) as mock_cfg:
            cfg = MagicMock()
            cfg.sms_enabled = False
            cfg.sms_provider = "webhook"
            mock_cfg.return_value = cfg
            async with AsyncClient(
                transport=ASGITransport(app=app),
                base_url="http://test",
                headers={"X-Requested-With": "XMLHttpRequest"},
            ) as client:
                resp = await client.post(
                    "/api/auth/request-otp",
                    json={
                        "email": voter_email,
                        "general_meeting_id": str(agm.id),
                        "channel": "sms",
                    },
                )
        assert resp.status_code == 503

    async def test_sms_channel_503_when_provider_null(
        self, app, db_session: AsyncSession, sms_building_and_meeting
    ):
        agm = sms_building_and_meeting["agm"]
        voter_email = sms_building_and_meeting["voter_email"]
        with patch("app.routers.auth.smtp_config_service.get_smtp_config", new=AsyncMock()) as mock_cfg:
            cfg = MagicMock()
            cfg.sms_enabled = True
            cfg.sms_provider = None
            mock_cfg.return_value = cfg
            async with AsyncClient(
                transport=ASGITransport(app=app),
                base_url="http://test",
                headers={"X-Requested-With": "XMLHttpRequest"},
            ) as client:
                resp = await client.post(
                    "/api/auth/request-otp",
                    json={
                        "email": voter_email,
                        "general_meeting_id": str(agm.id),
                        "channel": "sms",
                    },
                )
        assert resp.status_code == 503

    async def test_sms_channel_400_when_no_phone(
        self, app, db_session: AsyncSession, sms_building_no_phone
    ):
        agm = sms_building_no_phone["agm"]
        voter_email = sms_building_no_phone["voter_email"]
        with patch("app.routers.auth.smtp_config_service.get_smtp_config", new=AsyncMock()) as mock_cfg:
            cfg = MagicMock()
            cfg.sms_enabled = True
            cfg.sms_provider = "webhook"
            mock_cfg.return_value = cfg
            async with AsyncClient(
                transport=ASGITransport(app=app),
                base_url="http://test",
                headers={"X-Requested-With": "XMLHttpRequest"},
            ) as client:
                resp = await client.post(
                    "/api/auth/request-otp",
                    json={
                        "email": voter_email,
                        "general_meeting_id": str(agm.id),
                        "channel": "sms",
                    },
                )
        assert resp.status_code == 400
        assert "phone" in resp.json()["detail"].lower()

    async def test_sms_delivery_error_returns_502(
        self, app, db_session: AsyncSession, sms_building_and_meeting
    ):
        agm = sms_building_and_meeting["agm"]
        voter_email = sms_building_and_meeting["voter_email"]
        with patch("app.routers.auth.smtp_config_service.get_smtp_config", new=AsyncMock()) as mock_cfg, \
             patch("app.routers.auth.sms_send", new=AsyncMock(side_effect=SmsDeliveryError("fail"))) as mock_sms, \
             patch("app.routers.auth.smtp_config_service.get_sms_send_kwargs", return_value={
                 "provider": "webhook", "webhook_url": "https://h.com", "webhook_secret": None,
                 "smtp2go_api_key": "", "smtp2go_sender": "",
                 "twilio_account_sid": "", "twilio_auth_token": "", "twilio_from_number": "",
                 "clicksend_username": "", "clicksend_api_key": "", "clicksend_from_number": "",
             }):
            cfg = MagicMock()
            cfg.sms_enabled = True
            cfg.sms_provider = "webhook"
            mock_cfg.return_value = cfg
            async with AsyncClient(
                transport=ASGITransport(app=app),
                base_url="http://test",
                headers={"X-Requested-With": "XMLHttpRequest"},
            ) as client:
                resp = await client.post(
                    "/api/auth/request-otp",
                    json={
                        "email": voter_email,
                        "general_meeting_id": str(agm.id),
                        "channel": "sms",
                    },
                )
        assert resp.status_code == 502
        assert "SMS delivery failed" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# GET/PUT /api/admin/config/sms
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestGetSmsConfig:
    # --- Happy path ---

    async def test_returns_sms_fields(self, app, db_session: AsyncSession):
        await _seed_sms_config(
            db_session,
            sms_enabled=True,
            sms_provider="twilio",
            sms_from_number="+61200000000",
        )
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            headers={"X-Requested-With": "XMLHttpRequest"},
        ) as client:
            resp = await client.get("/api/admin/config/sms")
        assert resp.status_code == 200
        body = resp.json()
        assert body["sms_enabled"] is True
        assert body["sms_provider"] == "twilio"
        assert body["sms_from_number"] == "+61200000000"
        assert "sms_twilio_auth_token" not in body

    async def test_returns_defaults_when_no_row(self, app, db_session: AsyncSession):
        await _clear_smtp_config(db_session)
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            headers={"X-Requested-With": "XMLHttpRequest"},
        ) as client:
            resp = await client.get("/api/admin/config/sms")
        assert resp.status_code == 200
        body = resp.json()
        assert body["sms_enabled"] is False
        assert body["sms_provider"] is None


@pytest.mark.asyncio(loop_scope="session")
class TestUpdateSmsConfig:
    # --- Happy path ---

    async def test_put_saves_sms_fields(self, app, db_session: AsyncSession):
        key = _make_test_key()
        await _clear_smtp_config(db_session)
        payload = {
            "sms_enabled": True,
            "sms_provider": "webhook",
            "sms_webhook_url": "https://hook.example.com",
            "sms_webhook_secret": "mysecret",
            "sms_from_number": "+61400000000",
        }
        with patch("app.services.smtp_config_service.settings") as mock_settings:
            mock_settings.smtp_encryption_key = key
            async with AsyncClient(
                transport=ASGITransport(app=app),
                base_url="http://test",
                headers={"X-Requested-With": "XMLHttpRequest"},
            ) as client:
                resp = await client.put("/api/admin/config/sms", json=payload)
        assert resp.status_code == 200
        body = resp.json()
        assert body["sms_enabled"] is True
        assert body["sms_provider"] == "webhook"
        assert body["sms_webhook_url"] == "https://hook.example.com"
        assert body["sms_webhook_secret_is_set"] is True
        assert "sms_webhook_secret" not in body

    # --- Input validation ---

    async def test_put_invalid_provider_rejected(self, app, db_session: AsyncSession):
        payload = {"sms_enabled": True, "sms_provider": "carrier_pigeon"}
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            headers={"X-Requested-With": "XMLHttpRequest"},
        ) as client:
            resp = await client.put("/api/admin/config/sms", json=payload)
        assert resp.status_code == 422

    async def test_put_no_encryption_key_with_secret_returns_500(self, app, db_session: AsyncSession):
        await _clear_smtp_config(db_session)
        payload = {"sms_enabled": True, "sms_smtp2go_api_key": "some_key"}
        with patch("app.services.smtp_config_service.settings") as mock_settings:
            mock_settings.smtp_encryption_key = ""
            async with AsyncClient(
                transport=ASGITransport(app=app),
                base_url="http://test",
                headers={"X-Requested-With": "XMLHttpRequest"},
            ) as client:
                resp = await client.put("/api/admin/config/sms", json=payload)
        assert resp.status_code == 500


# ---------------------------------------------------------------------------
# POST /api/admin/config/sms/test
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestSmsTestEndpoint:
    # --- Happy path ---

    async def test_returns_ok_on_success(self, app, db_session: AsyncSession):
        await _seed_sms_config(db_session)
        from app.rate_limiter import sms_test_rate_limiter
        sms_test_rate_limiter.reset("sms_test")
        with patch("app.routers.admin.sms_send", new=AsyncMock()), \
             patch("app.routers.admin.smtp_config_service.get_sms_send_kwargs", return_value={
                 "provider": "webhook", "webhook_url": "https://h.com", "webhook_secret": None,
                 "smtp2go_api_key": "", "smtp2go_sender": "",
                 "twilio_account_sid": "", "twilio_auth_token": "", "twilio_from_number": "",
                 "clicksend_username": "", "clicksend_api_key": "", "clicksend_from_number": "",
             }):
            async with AsyncClient(
                transport=ASGITransport(app=app),
                base_url="http://test",
                headers={"X-Requested-With": "XMLHttpRequest"},
            ) as client:
                resp = await client.post(
                    "/api/admin/config/sms/test", json={"to": "+61400000001"}
                )
        assert resp.status_code == 200
        assert resp.json()["ok"] is True

    # --- State / precondition errors ---

    async def test_returns_503_when_not_configured(self, app, db_session: AsyncSession):
        await _seed_sms_config(db_session, sms_enabled=False, sms_provider=None)
        from app.rate_limiter import sms_test_rate_limiter
        sms_test_rate_limiter.reset("sms_test")
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            headers={"X-Requested-With": "XMLHttpRequest"},
        ) as client:
            resp = await client.post(
                "/api/admin/config/sms/test", json={"to": "+61400000001"}
            )
        assert resp.status_code == 503

    async def test_returns_503_when_provider_null(self, app, db_session: AsyncSession):
        await _seed_sms_config(db_session, sms_enabled=True, sms_provider=None)
        from app.rate_limiter import sms_test_rate_limiter
        sms_test_rate_limiter.reset("sms_test")
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            headers={"X-Requested-With": "XMLHttpRequest"},
        ) as client:
            resp = await client.post(
                "/api/admin/config/sms/test", json={"to": "+61400000001"}
            )
        assert resp.status_code == 503

    async def test_returns_502_on_delivery_failure(self, app, db_session: AsyncSession):
        await _seed_sms_config(db_session)
        from app.rate_limiter import sms_test_rate_limiter
        sms_test_rate_limiter.reset("sms_test")
        with patch("app.routers.admin.sms_send", new=AsyncMock(side_effect=SmsDeliveryError("fail"))), \
             patch("app.routers.admin.smtp_config_service.get_sms_send_kwargs", return_value={
                 "provider": "webhook", "webhook_url": "https://h.com", "webhook_secret": None,
                 "smtp2go_api_key": "", "smtp2go_sender": "",
                 "twilio_account_sid": "", "twilio_auth_token": "", "twilio_from_number": "",
                 "clicksend_username": "", "clicksend_api_key": "", "clicksend_from_number": "",
             }):
            async with AsyncClient(
                transport=ASGITransport(app=app),
                base_url="http://test",
                headers={"X-Requested-With": "XMLHttpRequest"},
            ) as client:
                resp = await client.post(
                    "/api/admin/config/sms/test", json={"to": "+61400000001"}
                )
        assert resp.status_code == 502

    async def test_rate_limit_after_5_calls(self, app, db_session: AsyncSession):
        await _seed_sms_config(db_session)
        from app.rate_limiter import sms_test_rate_limiter
        sms_test_rate_limiter.reset("sms_test")
        for _ in range(5):
            sms_test_rate_limiter.check("sms_test")
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            headers={"X-Requested-With": "XMLHttpRequest"},
        ) as client:
            resp = await client.post(
                "/api/admin/config/sms/test", json={"to": "+61400000001"}
            )
        assert resp.status_code == 429


# ---------------------------------------------------------------------------
# Phone normalisation
# ---------------------------------------------------------------------------


class TestNormalisePhoneE164:
    from app.services.admin_service import _normalise_phone_e164

    # --- Happy path ---

    def test_au_mobile_04_prefix(self):
        from app.services.admin_service import _normalise_phone_e164
        assert _normalise_phone_e164("0412 345 678") == "+61412345678"

    def test_already_e164_kept(self):
        from app.services.admin_service import _normalise_phone_e164
        assert _normalise_phone_e164("+61412345678") == "+61412345678"

    def test_international_plus_kept(self):
        from app.services.admin_service import _normalise_phone_e164
        assert _normalise_phone_e164("+1 800 555 1234") == "+18005551234"

    def test_strips_dashes_brackets_dots(self):
        from app.services.admin_service import _normalise_phone_e164
        assert _normalise_phone_e164("04-12-345-678") == "+61412345678"
        assert _normalise_phone_e164("(0412) 345-678") == "+61412345678"

    def test_non_au_without_plus_stored_as_is(self):
        from app.services.admin_service import _normalise_phone_e164
        result = _normalise_phone_e164("0212345678")
        assert result == "0212345678"

    # --- Boundary values ---

    def test_blank_returns_none(self):
        from app.services.admin_service import _normalise_phone_e164
        assert _normalise_phone_e164("") is None
        assert _normalise_phone_e164("   ") is None

    def test_whitespace_only_returns_none(self):
        from app.services.admin_service import _normalise_phone_e164
        assert _normalise_phone_e164("\t\n") is None


# ---------------------------------------------------------------------------
# Lot owner CSV import — Phone column
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestLotOwnerImportWithPhone:
    """Phone number is now stored per LotOwnerEmail (per-contact), not per LotOwner."""

    # --- Happy path ---

    async def test_csv_import_stores_phone_e164(self, app, db_session: AsyncSession):
        """CSV import: phone stored on the LotOwnerEmail row matching the email column."""
        building = Building(name=f"PhoneImport {uuid.uuid4().hex[:6]}", manager_email="mgr@t.com")
        db_session.add(building)
        await db_session.flush()

        content = make_csv(
            ["Lot#", "UOE2", "Email", "Phone"],
            [["1", "100", "voter@test.com", "0412 345 678"]],
        )
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            headers={"X-Requested-With": "XMLHttpRequest"},
        ) as client:
            resp = await client.post(
                f"/api/admin/buildings/{building.id}/lot-owners/import",
                files={"file": ("owners.csv", content, "text/csv")},
            )
        assert resp.status_code == 200
        # Phone is on the LotOwnerEmail row, not LotOwner
        lo_result = await db_session.execute(
            select(LotOwner).where(
                LotOwner.building_id == building.id,
                LotOwner.lot_number == "1",
            )
        )
        lo = lo_result.scalar_one()
        em_result = await db_session.execute(
            select(LotOwnerEmail).where(
                LotOwnerEmail.lot_owner_id == lo.id,
                LotOwnerEmail.email == "voter@test.com",
            )
        )
        em = em_result.scalar_one()
        assert em.phone_number == "+61412345678"

    async def test_csv_import_no_phone_column_sets_none(self, app, db_session: AsyncSession):
        """CSV without phone column: LotOwnerEmail.phone_number is NULL."""
        building = Building(name=f"NoPhCol {uuid.uuid4().hex[:6]}", manager_email="mgr@t.com")
        db_session.add(building)
        await db_session.flush()

        content = make_csv(
            ["Lot#", "UOE2", "Email"],
            [["1", "100", "voter@test.com"]],
        )
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            headers={"X-Requested-With": "XMLHttpRequest"},
        ) as client:
            resp = await client.post(
                f"/api/admin/buildings/{building.id}/lot-owners/import",
                files={"file": ("owners.csv", content, "text/csv")},
            )
        assert resp.status_code == 200
        lo_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == building.id)
        )
        lo = lo_result.scalar_one()
        em_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lo.id)
        )
        em = em_result.scalar_one()
        assert em.phone_number is None

    async def test_csv_import_blank_phone_cell_stores_none(self, app, db_session: AsyncSession):
        """CSV with blank phone cell: LotOwnerEmail.phone_number is NULL.
        No email column — the lot is imported without an email row, so phone is silently ignored."""
        building = Building(name=f"BlankPh {uuid.uuid4().hex[:6]}", manager_email="mgr@t.com")
        db_session.add(building)
        await db_session.flush()

        # Include an email so a LotOwnerEmail row is created to assert on
        content = make_csv(
            ["Lot#", "UOE2", "Email", "Phone"],
            [["1", "100", "voter@test.com", ""]],
        )
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            headers={"X-Requested-With": "XMLHttpRequest"},
        ) as client:
            resp = await client.post(
                f"/api/admin/buildings/{building.id}/lot-owners/import",
                files={"file": ("owners.csv", content, "text/csv")},
            )
        assert resp.status_code == 200
        lo_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == building.id)
        )
        lo = lo_result.scalar_one()
        em_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lo.id)
        )
        em = em_result.scalar_one()
        assert em.phone_number is None

    async def test_csv_import_updates_phone_on_existing_lot(self, app, db_session: AsyncSession):
        """Re-importing updates phone_number on the new LotOwnerEmail row for the same lot."""
        building = Building(name=f"PhUpd {uuid.uuid4().hex[:6]}", manager_email="mgr@t.com")
        db_session.add(building)
        await db_session.flush()
        # Pre-existing lot owner with an email row that already has a phone
        lo = LotOwner(
            building_id=building.id,
            lot_number="1",
            unit_entitlement=100,
        )
        db_session.add(lo)
        await db_session.flush()
        old_em = LotOwnerEmail(lot_owner_id=lo.id, email="voter@test.com", phone_number="+61400000000")
        db_session.add(old_em)
        await db_session.flush()

        content = make_csv(
            ["Lot#", "UOE2", "Email", "Phone"],
            [["1", "100", "voter@test.com", "0499999999"]],
        )
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            headers={"X-Requested-With": "XMLHttpRequest"},
        ) as client:
            resp = await client.post(
                f"/api/admin/buildings/{building.id}/lot-owners/import",
                files={"file": ("owners.csv", content, "text/csv")},
            )
        assert resp.status_code == 200
        # Import replaces email rows; fetch the new row
        em_result = await db_session.execute(
            select(LotOwnerEmail).where(
                LotOwnerEmail.lot_owner_id == lo.id,
                LotOwnerEmail.email == "voter@test.com",
            )
        )
        new_em = em_result.scalar_one()
        assert new_em.phone_number == "+61499999999"

    # --- Excel import with phone ---

    async def test_excel_import_stores_phone_e164(self, app, db_session: AsyncSession):
        """Excel import: phone stored on the LotOwnerEmail row."""
        building = Building(name=f"XlsPhone {uuid.uuid4().hex[:6]}", manager_email="mgr@t.com")
        db_session.add(building)
        await db_session.flush()

        content = make_excel(
            ["Lot#", "UOE2", "Email", "Phone"],
            [["1", 100, "voter@test.com", "0412 345 678"]],
        )
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            headers={"X-Requested-With": "XMLHttpRequest"},
        ) as client:
            resp = await client.post(
                f"/api/admin/buildings/{building.id}/lot-owners/import",
                files={"file": (
                    "owners.xlsx",
                    content,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )},
            )
        assert resp.status_code == 200
        lo_result = await db_session.execute(
            select(LotOwner).where(
                LotOwner.building_id == building.id,
                LotOwner.lot_number == "1",
            )
        )
        lo = lo_result.scalar_one()
        em_result = await db_session.execute(
            select(LotOwnerEmail).where(
                LotOwnerEmail.lot_owner_id == lo.id,
                LotOwnerEmail.email == "voter@test.com",
            )
        )
        em = em_result.scalar_one()
        assert em.phone_number == "+61412345678"

    async def test_excel_import_phone_number_column_name(self, app, db_session: AsyncSession):
        """Excel with 'phone_number' header (not 'phone') is also accepted.
        No email column — phone is silently ignored since no email row is created."""
        building = Building(name=f"XlsPhNum {uuid.uuid4().hex[:6]}", manager_email="mgr@t.com")
        db_session.add(building)
        await db_session.flush()

        content = make_excel(
            ["Lot#", "UOE2", "Email", "phone_number"],
            [["2", 50, "voter2@test.com", "+61499123456"]],
        )
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            headers={"X-Requested-With": "XMLHttpRequest"},
        ) as client:
            resp = await client.post(
                f"/api/admin/buildings/{building.id}/lot-owners/import",
                files={"file": (
                    "owners.xlsx",
                    content,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )},
            )
        assert resp.status_code == 200
        lo_result = await db_session.execute(
            select(LotOwner).where(
                LotOwner.building_id == building.id,
                LotOwner.lot_number == "2",
            )
        )
        lo = lo_result.scalar_one()
        em_result = await db_session.execute(
            select(LotOwnerEmail).where(
                LotOwnerEmail.lot_owner_id == lo.id,
                LotOwnerEmail.email == "voter2@test.com",
            )
        )
        em = em_result.scalar_one()
        assert em.phone_number == "+61499123456"

