"""Embedding client used by the main backend."""
from __future__ import annotations

from typing import Any

import httpx

from app.config import settings


class EmbeddingClient:
    async def embed_texts(self, texts: list[str], *, model: str | None = None) -> list[list[float]]:
        if not texts:
            return []

        provider = (settings.EMBEDDING_PROVIDER or "local_hash").lower()
        if provider != "local_api" or not settings.EMBEDDING_API_URL:
            raise ValueError("embedding provider is not configured for local_api")

        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                settings.EMBEDDING_API_URL,
                json={
                    "model": model or settings.EMBEDDING_MODEL,
                    "input": texts,
                },
                headers={"Authorization": f"Bearer {settings.EMBEDDING_API_KEY}"} if settings.EMBEDDING_API_KEY else None,
            )
            response.raise_for_status()
            payload = response.json()
            data = payload.get("data") or []
            return [item.get("embedding", []) for item in data]


embedding_client = EmbeddingClient()
