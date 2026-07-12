"""Local embedding provider backed by fastembed."""
from __future__ import annotations

from threading import Lock

from fastembed import TextEmbedding

from app.config import settings


class LocalEmbeddingProvider:
    def __init__(self):
        self._model: TextEmbedding | None = None
        self._active_model_name: str | None = None
        self._lock = Lock()

    def embed_texts(self, texts: list[str], *, model_name: str | None = None) -> list[list[float]]:
        if not texts:
            return []
        model = self._get_model(model_name or settings.EMBEDDING_MODEL)
        vectors = list(model.embed(texts, batch_size=64))
        return [vector.tolist() for vector in vectors]

    def _get_model(self, model_name: str) -> TextEmbedding:
        with self._lock:
            if self._model is not None and self._active_model_name == model_name:
                return self._model

            self._model = TextEmbedding(
                model_name=model_name,
                cache_dir=str(settings.CACHE_DIR / "fastembed"),
                threads=1,
                providers=["CPUExecutionProvider"],
                lazy_load=False,
            )
            self._active_model_name = model_name
            return self._model


local_embedding_provider = LocalEmbeddingProvider()
