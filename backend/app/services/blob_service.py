"""
Service for uploading files to Vercel Blob storage.

Uses the Vercel Blob REST API directly with an httpx async client.
Requires the BLOB_READ_WRITE_TOKEN environment variable to be set.
"""
from __future__ import annotations

import os

import httpx
from fastapi import HTTPException, status

_VERCEL_BLOB_BASE_URL = "https://blob.vercel-storage.com"


async def upload_to_blob(filename: str, content: bytes, content_type: str) -> str:
    """Upload bytes to Vercel Blob and return the public URL.

    Args:
        filename: The desired filename in the blob store (a random suffix is appended).
        content: Raw file bytes to upload.
        content_type: MIME type of the file (e.g. "image/png").

    Returns:
        The public URL of the uploaded blob.

    Raises:
        HTTPException(500): If BLOB_READ_WRITE_TOKEN is not configured.
        HTTPException(502): If the Vercel Blob API returns a non-2xx response.
    """
    token = os.environ.get("BLOB_READ_WRITE_TOKEN")
    if not token:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Blob storage not configured",
        )

    url = f"{_VERCEL_BLOB_BASE_URL}/{filename}"
    headers = {
        "Authorization": f"Bearer {token}",
        "x-content-type": content_type,
        "x-add-random-suffix": "1",
    }

    async with httpx.AsyncClient() as client:
        response = await client.put(url, content=content, headers=headers)

    if not response.is_success:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Logo upload failed",
        )

    data = response.json()
    return data["url"]
