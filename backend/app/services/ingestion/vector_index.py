"""Lightweight persisted vector index for chunk retrieval."""
from __future__ import annotations

import json
from dataclasses import dataclass
from hashlib import md5
from pathlib import Path
from threading import Lock

import numpy as np

from app.config import settings
from app.services.embedding import embedding_client


def _tokenize(text: str) -> list[str]:
    normalized = (text or "").lower()
    raw_tokens = []
    current = []

    for ch in normalized:
        if ch.isascii() and (ch.isalnum() or ch == "_"):
            current.append(ch)
            continue
        if current:
            raw_tokens.append("".join(current))
            current = []
        if "\u4e00" <= ch <= "\u9fff":
            raw_tokens.append(ch)
    if current:
        raw_tokens.append("".join(current))

    tokens: list[str] = []
    for token in raw_tokens:
        tokens.append(token)
        if len(token) > 1:
            tokens.extend(token[idx: idx + 2] for idx in range(len(token) - 1))
            tokens.extend(token[idx: idx + 3] for idx in range(len(token) - 2))

    compact_text = "".join(ch for ch in normalized if not ch.isspace())
    tokens.extend(compact_text[idx: idx + 3] for idx in range(len(compact_text) - 2))
    return [token for token in tokens if token]


def _hash_feature(token: str, dim: int) -> tuple[int, float]:
    digest = md5(token.encode("utf-8")).digest()
    index = int.from_bytes(digest[:4], "big") % dim
    sign = 1.0 if digest[4] % 2 == 0 else -1.0
    return index, sign


@dataclass
class VectorIndexEntry:
    chunk_id: str
    paper_id: str
    page: int
    section_title: str
    text: str


class VectorIndexService:
    def __init__(self, dim: int = 2048):
        self.dim = dim
        self.index_dir = Path(settings.VECTOR_DB_PATH)
        if not self.index_dir.is_absolute():
            self.index_dir = (settings.DATA_DIR.parent / self.index_dir).resolve()
        self.index_dir.mkdir(parents=True, exist_ok=True)
        self._metadata_path = self.index_dir / "chunk_index_meta.json"
        self._matrix_path = self.index_dir / "chunk_index_vectors.npy"
        self._lock = Lock()

    async def upsert_entries(self, paper_id: str, entries: list[VectorIndexEntry]):
        new_metadata = [
            {
                "chunk_id": entry.chunk_id,
                "paper_id": entry.paper_id,
                "page": entry.page,
                "section_title": entry.section_title,
                "text": entry.text,
            }
            for entry in entries
        ]
        new_matrix = await self._embed_texts([entry.text for entry in entries])

        with self._lock:
            metadata, matrix = self._load_index()
            kept_indices = [idx for idx, item in enumerate(metadata) if item.get("paper_id") != paper_id]
            kept_metadata = [metadata[idx] for idx in kept_indices]
            kept_matrix = matrix[kept_indices] if len(matrix) and kept_indices else np.empty((0, self.dim), dtype=np.float32)

            merged_metadata = kept_metadata + new_metadata
            merged_matrix = (
                np.vstack([kept_matrix, new_matrix]).astype(np.float32)
                if len(kept_matrix) or len(new_matrix)
                else np.empty((0, self.dim), dtype=np.float32)
            )
            self._save_index(merged_metadata, merged_matrix)

    def delete_paper(self, paper_id: str):
        with self._lock:
            metadata, matrix = self._load_index()
            kept_indices = [idx for idx, item in enumerate(metadata) if item.get("paper_id") != paper_id]
            kept_metadata = [metadata[idx] for idx in kept_indices]
            kept_matrix = matrix[kept_indices] if len(matrix) and kept_indices else np.empty((0, self.dim), dtype=np.float32)
            self._save_index(kept_metadata, kept_matrix)

    async def query(self, query_text: str, *, paper_id: str | None = None, top_k: int = 8) -> list[dict]:
        with self._lock:
            metadata, matrix = self._load_index()
            if not metadata or matrix.size == 0:
                return []

            candidate_indices = [
                idx for idx, item in enumerate(metadata)
                if paper_id is None or item.get("paper_id") == paper_id
            ]
            if not candidate_indices:
                return []

            candidate_matrix = matrix[candidate_indices]

        query_matrix = await self._embed_texts([query_text])
        query_vector = query_matrix[0]
        scores = candidate_matrix @ query_vector
        ranked = sorted(
            [
                {
                    "chunk_id": metadata[candidate_indices[idx]]["chunk_id"],
                    "paper_id": metadata[candidate_indices[idx]]["paper_id"],
                    "page": metadata[candidate_indices[idx]]["page"],
                    "score": float(scores[idx]),
                }
                for idx in range(len(candidate_indices))
            ],
            key=lambda item: item["score"],
            reverse=True,
        )
        return ranked[:top_k]

    async def _embed_texts(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.empty((0, self.dim), dtype=np.float32)

        provider = (settings.EMBEDDING_PROVIDER or "local_hash").lower()
        if provider == "local_api":
            vectors = await embedding_client.embed_texts(texts)
            matrix = np.array(vectors, dtype=np.float32)
        else:
            matrix = np.vstack([self._vectorize_text(text) for text in texts]).astype(np.float32)

        if matrix.ndim == 1:
            matrix = matrix.reshape(1, -1)

        # Always normalize so retrieval uses cosine similarity semantics even if
        # the provider does not return unit-length vectors.
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        matrix = matrix / norms

        if matrix.shape[1] != self.dim:
            self.dim = matrix.shape[1]
        return matrix.astype(np.float32)

    def _vectorize_text(self, text: str) -> np.ndarray:
        vector = np.zeros(self.dim, dtype=np.float32)
        for token in _tokenize(text):
            index, sign = _hash_feature(token, self.dim)
            vector[index] += sign

        norm = float(np.linalg.norm(vector))
        if norm > 0:
            vector /= norm
        return vector

    def _load_index(self) -> tuple[list[dict], np.ndarray]:
        metadata: list[dict] = []
        matrix = np.empty((0, self.dim), dtype=np.float32)

        if self._metadata_path.exists():
            try:
                metadata = json.loads(self._metadata_path.read_text(encoding="utf-8"))
            except Exception:
                metadata = []

        if self._matrix_path.exists():
            try:
                matrix = np.load(self._matrix_path)
                if matrix.ndim == 1:
                    matrix = matrix.reshape(1, -1)
                if matrix.size:
                    self.dim = int(matrix.shape[1])
            except Exception:
                matrix = np.empty((0, self.dim), dtype=np.float32)
                metadata = []

        if len(metadata) != len(matrix):
            return [], np.empty((0, self.dim), dtype=np.float32)

        return metadata, matrix.astype(np.float32)

    def _save_index(self, metadata: list[dict], matrix: np.ndarray):
        self._metadata_path.write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
        np.save(self._matrix_path, matrix.astype(np.float32))


vector_index_service = VectorIndexService()
