"""
BM25 关键词检索器：基于词频统计的稀疏检索，与向量检索互补。
使用 rank-bm25 库实现。
"""

import re
from typing import Optional

from app.services.rag.types import Chunk, RetrievalItem


class BM25Retriever:
    """BM25 关键词检索器。"""

    def __init__(self):
        self._chunks: list[Chunk] = []
        self._corpus: list[str] = []
        self._bm25 = None
        self._id_to_idx: dict[str, int] = {}

    def add_chunks(self, chunks: list[Chunk]) -> None:
        """添加 chunk 到检索器"""
        for chunk in chunks:
            if chunk.id not in self._id_to_idx:
                self._id_to_idx[chunk.id] = len(self._chunks)
                self._chunks.append(chunk)
                self._corpus.append(self._tokenize(chunk.text))

    def build(self) -> None:
        """构建 BM25 索引"""
        if not self._corpus:
            return

        try:
            from rank_bm25 import BM25Okapi
        except ImportError:
            raise ImportError("请安装 rank-bm25: pip install rank-bm25")

        self._bm25 = BM25Okapi(self._corpus)

    def search(
        self,
        query: str,
        top_k: int = 5,
        min_score: float = 0.0,
    ) -> list[RetrievalItem]:
        """
        BM25 关键词搜索。

        Args:
            query: 查询字符串
            top_k: 返回 top-k 结果
            min_score: 最低分数阈值

        Returns:
            RetrievalItem 列表，按分数降序
        """
        if self._bm25 is None:
            return []

        tokenized_query = self._tokenize(query)
        scores = self._bm25.get_scores(tokenized_query)

        # 归一化分数
        max_score = scores.max()
        if max_score > 0:
            scores = scores / max_score

        # 获取 top-k
        if len(scores) == 0:
            return []

        top_indices = scores.argsort()[::-1][:top_k]

        results: list[RetrievalItem] = []
        for idx in top_indices:
            score = float(scores[idx])
            if score < min_score:
                continue
            results.append(RetrievalItem(
                chunk=self._chunks[idx],
                score=score,
                source="bm25",
            ))

        return results

    def remove_paper(self, paper_id: str) -> int:
        """移除指定论文的所有 chunk"""
        before = len(self._chunks)
        kept = [(c, t) for c, t in zip(self._chunks, self._corpus) if c.paper_id != paper_id]
        self._chunks = [c for c, _ in kept]
        self._corpus = [t for _, t in kept]
        self._id_to_idx = {c.id: i for i, c in enumerate(self._chunks)}
        self._bm25 = None  # 需要重建
        return before - len(self._chunks)

    @property
    def chunk_count(self) -> int:
        return len(self._chunks)

    @property
    def is_built(self) -> bool:
        return self._bm25 is not None

    @staticmethod
    def _tokenize(text: str) -> list[str]:
        """简单分词：小写 + 按非字母数字分割"""
        text = text.lower()
        tokens = re.findall(r'[a-zA-Z0-9]+', text)
        # 过滤太短的 token
        return [t for t in tokens if len(t) > 1]
