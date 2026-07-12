"""Embedding services."""
from app.services.embedding.client import embedding_client
from app.services.embedding.local_provider import local_embedding_provider

__all__ = ["embedding_client", "local_embedding_provider"]
