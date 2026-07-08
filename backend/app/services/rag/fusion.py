"""
多路检索融合：混合向量检索、关键词检索、图谱检索的结果，排序去重后返回最终列表。

支持 Reciprocal Rank Fusion (RRF) 和加权分数融合两种策略。
"""

from typing import Optional

from app.services.rag.types import Chunk, RetrievalItem


class FusionRanker:
    """
    多路检索融合排序器。
    将不同来源（vector / bm25 / graph）的检索结果融合为统一排序列表。
    """

    def __init__(
        self,
        strategy: str = "rrf",            # "rrf" 或 "weighted"
        rrf_k: int = 60,                  # RRF 平滑参数
        weights: Optional[dict[str, float]] = None,  # 加权融合权重
    ):
        self.strategy = strategy
        self.rrf_k = rrf_k
        self.weights = weights or {
            "vector": 0.5,
            "bm25": 0.3,
            "graph": 0.2,
        }

    def fuse(
        self,
        vector_results: list[RetrievalItem],
        bm25_results: list[RetrievalItem],
        graph_results: list[RetrievalItem],
        top_k: int = 5,
        dedup_threshold: float = 0.9,
    ) -> list[RetrievalItem]:
        """
        融合多路检索结果。

        Args:
            vector_results: 向量检索结果
            bm25_results: BM25 关键词检索结果
            graph_results: 图谱检索结果
            top_k: 返回 top-k 结果
            dedup_threshold: 去重相似度阈值

        Returns:
            融合后的 RetrievalItem 列表
        """
        # 合并并按 chunk_id 去重（保留最高分）
        merged: dict[str, RetrievalItem] = {}

        for item in vector_results + bm25_results + graph_results:
            cid = item.chunk.id
            if cid in merged:
                # 保留分数更高的
                if item.score > merged[cid].score:
                    merged[cid] = item
            else:
                merged[cid] = item

        # 基于策略计算融合分数
        scored: list[tuple[RetrievalItem, float]] = []

        if self.strategy == "rrf":
            scored = self._rrf_fuse(vector_results, bm25_results, graph_results, merged)
        elif self.strategy == "weighted":
            scored = self._weighted_fuse(vector_results, bm25_results, graph_results, merged)
        else:
            # 默认按原始分数
            scored = [(item, item.score) for item in merged.values()]

        # 排序
        scored.sort(key=lambda x: x[1], reverse=True)

        # 取 top-k
        results = [item for item, _ in scored[:top_k]]

        return results

    def _rrf_fuse(
        self,
        vector_results: list[RetrievalItem],
        bm25_results: list[RetrievalItem],
        graph_results: list[RetrievalItem],
        merged: dict[str, RetrievalItem],
    ) -> list[tuple[RetrievalItem, float]]:
        """
        Reciprocal Rank Fusion (RRF)。

        RRF_score(d) = sum_{r in rankings} 1 / (k + rank(d, r))
        """
        # 构建各路的排名映射
        rankings = {
            "vector": {item.chunk.id: i + 1 for i, item in enumerate(vector_results)},
            "bm25": {item.chunk.id: i + 1 for i, item in enumerate(bm25_results)},
            "graph": {item.chunk.id: i + 1 for i, item in enumerate(graph_results)},
        }

        scored: list[tuple[RetrievalItem, float]] = []
        for cid, item in merged.items():
            rrf_score = 0.0
            for source, rank_map in rankings.items():
                rank = rank_map.get(cid, len(rank_map) + 100)  # 未出现给低排名
                rrf_score += 1.0 / (self.rrf_k + rank)
            scored.append((item, rrf_score))

        return scored

    def _weighted_fuse(
        self,
        vector_results: list[RetrievalItem],
        bm25_results: list[RetrievalItem],
        graph_results: list[RetrievalItem],
        merged: dict[str, RetrievalItem],
    ) -> list[tuple[RetrievalItem, float]]:
        """
        加权分数融合。

        final_score(d) = w_vector * score_vector(d) + w_bm25 * score_bm25(d) + w_graph * score_graph(d)
        """
        # 构建各路的分数映射
        score_maps = {
            "vector": {item.chunk.id: item.score for item in vector_results},
            "bm25": {item.chunk.id: item.score for item in bm25_results},
            "graph": {item.chunk.id: item.score for item in graph_results},
        }

        scored: list[tuple[RetrievalItem, float]] = []
        for cid, item in merged.items():
            weighted_score = 0.0
            for source, score_map in score_maps.items():
                s = score_map.get(cid, 0.0)
                weighted_score += self.weights.get(source, 0.0) * s
            scored.append((item, weighted_score))

        return scored
