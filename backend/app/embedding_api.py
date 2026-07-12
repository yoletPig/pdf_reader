"""Standalone local embedding API."""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel, Field

from app.config import settings
from app.services.embedding import local_embedding_provider


class EmbeddingRequest(BaseModel):
    model: str = Field(default_factory=lambda: settings.EMBEDDING_MODEL)
    input: str | list[str]


app = FastAPI(title="PDF Reader Embedding API", version=settings.APP_VERSION)


@app.get("/health")
async def health():
    return {"status": "ok", "model": settings.EMBEDDING_MODEL}


@app.post("/v1/embeddings")
async def create_embeddings(data: EmbeddingRequest):
    inputs = data.input if isinstance(data.input, list) else [data.input]
    vectors = local_embedding_provider.embed_texts(inputs, model_name=data.model)
    return {
        "object": "list",
        "data": [
            {
                "object": "embedding",
                "index": idx,
                "embedding": vector,
            }
            for idx, vector in enumerate(vectors)
        ],
        "model": data.model,
        "usage": {
            "prompt_tokens": sum(len(text) for text in inputs),
            "total_tokens": sum(len(text) for text in inputs),
        },
    }
