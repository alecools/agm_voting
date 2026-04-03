"""
AES-256-GCM encryption/decryption utility for SMTP password storage.

Key format: base64-encoded 32-byte random value (set as SMTP_ENCRYPTION_KEY env var).
Ciphertext format: base64-encoded nonce (12 bytes) + ciphertext + tag (16 bytes).

Usage:
    key_b64 = base64.b64encode(os.urandom(32)).decode()
    enc = encrypt_smtp_password("mypassword", key_b64)
    dec = decrypt_smtp_password(enc, key_b64)
    assert dec == "mypassword"
"""
from __future__ import annotations

import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _decode_key(key_b64: str) -> bytes:
    """Decode a base64-encoded 32-byte AES key."""
    try:
        key = base64.b64decode(key_b64)
    except Exception as exc:
        raise ValueError(f"SMTP_ENCRYPTION_KEY is not valid base64: {exc}") from exc
    if len(key) != 32:
        raise ValueError(
            f"SMTP_ENCRYPTION_KEY must decode to exactly 32 bytes (got {len(key)})"
        )
    return key


def encrypt_smtp_password(plaintext: str, key_b64: str) -> str:
    """Encrypt a plaintext SMTP password using AES-256-GCM.

    Returns a base64-encoded string containing: nonce (12 bytes) + ciphertext + GCM tag (16 bytes).
    """
    key = _decode_key(key_b64)
    nonce = os.urandom(12)
    aesgcm = AESGCM(key)
    ciphertext_with_tag = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)
    # Concatenate nonce + ciphertext+tag and base64-encode the whole thing
    return base64.b64encode(nonce + ciphertext_with_tag).decode("ascii")


def decrypt_smtp_password(enc_b64: str, key_b64: str) -> str:
    """Decrypt an AES-256-GCM encrypted SMTP password.

    Expects a base64-encoded string of nonce (12 bytes) + ciphertext + GCM tag (16 bytes).
    Returns the decrypted plaintext string.
    Raises ValueError on decryption failure (wrong key, tampered ciphertext).
    """
    key = _decode_key(key_b64)
    try:
        raw = base64.b64decode(enc_b64)
    except Exception as exc:
        raise ValueError(f"Encrypted password is not valid base64: {exc}") from exc
    if len(raw) < 12 + 16:  # nonce (12) + minimum 0-byte plaintext + tag (16)
        raise ValueError("Encrypted password is too short to be valid AES-256-GCM output")
    nonce = raw[:12]
    ciphertext_with_tag = raw[12:]
    aesgcm = AESGCM(key)
    try:
        plaintext_bytes = aesgcm.decrypt(nonce, ciphertext_with_tag, None)
    except Exception as exc:
        raise ValueError(f"Failed to decrypt SMTP password: {exc}") from exc
    return plaintext_bytes.decode("utf-8")
