"""
向量存储：基于 FAISS 的向量索引，支持增量添加、持久化、相似度搜索。

使用 sentence-transformers 生成嵌入向量，FAISS 进行高效检索。
"""

import os
import pickle
from typing import Optional

import numpy as np

from app.services.rag.types import Chunk, RetrievalItem

# 向量维度（根据实际使用的 embedding 模型调整）
VECTOR_DIM = 768
INDEX_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "..", "data", "faiss_index")


class VectorStore:
    """FAISS 向量存储，管理论文文本块的向量索引与检索。"""

    def __init__(self, dim: int = VECTOR_DIM):
        self.dim = dim
        self._index = None
        self._chunks: list[Chunk] = []
        self._embeddings: Optional[np.ndarray] = None
        self._id_to_idx: dict[str, int] = {}

    # ------------------------------------------------------------------
    # 公共 API
    # ------------------------------------------------------------------

    def add_chunks(self, chunks: list[Chunk], embeddings: Optional[np.ndarray] = None) -> None:
        """
        批量添加 chunk 及其嵌入向量。若不提供 embeddings，则置空等待后续生成。
        """
        if not chunks:
            return

        # 更新 chunk 列表和 id 映射
        for chunk in chunks:
            if chunk.id not in self._id_to_idx:
                self._id_to_idx[chunk.id] = len(self._chunks)
                self._chunks.append(chunk)

        # 更新嵌入矩阵
        if embeddings is not None:
            if self._embeddings is None:
                self._embeddings = embeddings.astype(np.float32)
            else:
                self._embeddings = np.vstack([self._embeddings, embeddings.astype(np.float32)])

    def build_index(self, index_type: str = "Flat") -> None:
        """
        构建 / 重建 FAISS 索引。

        Args:
            index_type: 索引类型，支持 "Flat"（精确搜索）和 "IVF"（近似搜索）
        """
        try:
            import faiss
        except ImportError:
            raise ImportError("请安装 faiss-cpu: pip install faiss-cpu")

        if self._embeddings is None or len(self._embeddings) == 0:
            return

        dim = self._embeddings.shape[1]

        if index_type == "IVF":
            nlist = max(1, int(len(self._embeddings) ** 0.5))
            quantizer = faiss.IndexFlatIP(dim)
            self._index = faiss.IndexIVFFlat(quantizer, dim, nlist, faiss.METRIC_INNER_PRODUCT)
            self._index.train(self._embeddings)
        else:
            self._index = faiss.IndexFlatIP(dim)

        self._index.add(self._embeddings)

    def search(
        self,
        query_embedding: np.ndarray,
        top_k: int = 5,
        min_score: float = 0.0,
    ) -> list[RetrievalItem]:
        """
        向量相似度搜索。

        Args:
            query_embedding: 查询向量，shape (1, dim) 或 (dim,)
            top_k: 返回 top-k 结果
            min_score: 最低相似度阈值

        Returns:
            RetrievalItem 列表，按相似度降序
        """
        if self._index is None:
            return []

        if query_embedding.ndim == 1:
            query_embedding = query_embedding.reshape(1, -1)

        query_embedding = query_embedding.astype(np.float32)

        scores, indices = self._index.search(query_embedding, min(top_k, len(self._chunks)))

        results: list[RetrievalItem] = []
        for score, idx in zip(scores[0], indices[0]):
            if idx == -1 or idx >= len(self._chunks):
                continue
            if float(score) < min_score:
                continue
            results.append(RetrievalItem(
                chunk=self._chunks[idx],
                score=float(score),
                source="vector",
            ))

        return results

    def get_chunk_by_id(self, chunk_id: str) -> Optional[Chunk]:
        """按 ID 获取 chunk"""
        idx = self._id_to_idx.get(chunk_id)
        if idx is not None and idx < len(self._chunks):
            return self._chunks[idx]
        return None

    def remove_paper(self, paper_id: str) -> int:
        """移除指定论文的所有 chunk，返回移除数量。需要重建索引。"""
        before = len(self._chunks)
        self._chunks = [c for c in self._chunks if c.paper_id != paper_id]
        self._id_to_idx = {c.id: i for i, c in enumerate(self._chunks)}

        # 移除对应的 embedding
        if self._embeddings is not None:
            kept = [i for i, c in enumerate(self._chunks) if c.paper_id != paper_id]
            # 需要基于原始列表过滤
            removed = before - len(self._chunks)
            # 简化：清空 embeddings，由调用方重建
            self._embeddings = None
            self._index = None
            return removed

        self._index = None
        return before - len(self._chunks)

    @property
    def chunk_count(self) -> int:
        return len(self._chunks)

    @property
    def is_built(self) -> bool:
        return self._index is not None

    # ------------------------------------------------------------------
    # 持久化
    # ------------------------------------------------------------------

    def save(self, path: Optional[str] = None) -> str:
        """
        持久化向量存储到磁盘。

        Returns:
            保存路径
        """
        try:
            import faiss
        except ImportError:
            raise ImportError("请安装 faiss-cpu: pip install faiss-cpu")

        save_path = path or os.path.join(INDEX_DIR, "vector_store")
        os.makedirs(os.path.dirname(save_path), exist_ok=True)

        # 保存 FAISS 索引
        if self._index is not None:
            faiss.write_index(self._index, f"{save_path}.index")

        # 保存元数据（chunk 列表、映射等）
        meta = {
            "chunks": self._chunks,
            "id_to_idx": self._id_to_idx,
            "dim": self.dim,
        }
        with open(f"{save_path}.meta", "wb") as f:
            pickle.dump(meta, f)

        # 保存 embeddings
        if self._embeddings is not None:
            np.save(f"{save_path}.embeddings.npy", self._embeddings)

        return save_path

    @classmethod
    def load(cls, path: Optional[str] = None) -> "VectorStore":
        """
        从磁盘加载向量存储。

        Returns:
            VectorStore 实例
        """
        try:
            import faiss
        except ImportError:
            raise ImportError("请安装 faiss-cpu: pip install faiss-cpu")

        load_path = path or os.path.join(INDEX_DIR, "vector_store")
        store = cls()

        # 加载元数据
        meta_path = f"{load_path}.meta"
        if os.path.exists(meta_path):
            with open(meta_path, "rb") as f:
                meta = pickle.load(f)
            store._chunks = meta.get("chunks", [])
            store._id_to_idx = meta.get("id_to_idx", {})
            store.dim = meta.get("dim", VECTOR_DIM)

        # 加载 FAISS 索引
        index_path = f"{load_path}.index"
        if os.path.exists(index_path):
            store._index = faiss.read_index(index_path)

        # 加载 embeddings
        emb_path = f"{load_path}.embeddings.npy"
        if os.path.exists(emb_path):
            store._embeddings = np.load(emb_path)

        return store
