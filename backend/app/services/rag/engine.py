"""
RAG 知识库引擎：统一入口，协调检索、重排序、答案生成。

流程：查询 → 多路检索 → 融合排序 → 上下文构建 → LLM 生成 → 格式化返回
"""

from typing import Optional

from app.services.rag.types import (
    Chunk,
    RAGResult,
    RetrievalItem,
    RetrievalMode,
    Source,
)
from app.services.rag.vector_store import VectorStore
from app.services.rag.graph_store import GraphStore
from app.services.rag.bm25 import BM25Retriever
from app.services.rag.fusion import FusionRanker
from app.services.rag.chunker import chunk_paper


class RAGEngine:
    """
    RAG 知识库引擎。

    使用示例:
        engine = RAGEngine()
        engine.index_paper("paper_1", "论文全文...", sections=[...])

        result = engine.query("这篇论文的主要贡献是什么？", paper_id="paper_1")
        print(result.answer)
        for src in result.sources:
            print(f"  [{src.section_title}] (p{src.page}) {src.chunk_text[:100]}...")
    """

    def __init__(
        self,
        vector_store: Optional[VectorStore] = None,
        graph_store: Optional[GraphStore] = None,
        bm25: Optional[BM25Retriever] = None,
        fusion: Optional[FusionRanker] = None,
    ):
        self.vector_store = vector_store or VectorStore()
        self.graph_store = graph_store or GraphStore()
        self.bm25 = bm25 or BM25Retriever()
        self.fusion = fusion or FusionRanker(strategy="rrf")

        # 全局 chunk 注册表
        self._all_chunks: dict[str, Chunk] = {}

    # ------------------------------------------------------------------
    # 索引
    # ------------------------------------------------------------------

    def index_paper(
        self,
        paper_id: str,
        full_text: str,
        sections: Optional[list[dict]] = None,
        entities: Optional[list[dict]] = None,
        embeddings: Optional["np.ndarray"] = None,
    ) -> int:
        """
        索引一篇论文。

        Args:
            paper_id: 论文 ID
            full_text: 论文全文
            sections: 章节信息 [{"title": str, "page": int}, ...]
            entities: 知识图谱实体列表
            embeddings: 预生成的嵌入向量（可选，若不提供则需后续手动生成）

        Returns:
            索引的 chunk 数量
        """
        # 1. 切分
        chunks = chunk_paper(full_text, paper_id, sections)

        if not chunks:
            return 0

        # 2. 加入各存储
        self.vector_store.add_chunks(chunks, embeddings)
        self.bm25.add_chunks(chunks)

        # 3. 图谱关联
        if entities:
            for entity in entities:
                eid = entity.get("id", entity.get("name"))
                self.graph_store.add_entity(
                    entity_id=eid,
                    name=entity.get("name", ""),
                    entity_type=entity.get("type", "concept"),
                    properties=entity.get("properties"),
                )
                # 关联到相关 chunk
                for chunk in chunks:
                    if entity.get("name", "").lower() in chunk.text.lower():
                        self.graph_store.link_entity_to_chunk(eid, chunk.id)

            # 添加实体间关系
            for entity in entities:
                for rel in entity.get("relations", []):
                    self.graph_store.add_relation(
                        src_id=entity.get("id", entity.get("name")),
                        dst_id=rel.get("target"),
                        relation_type=rel.get("type", "related_to"),
                    )

        # 4. 更新全局 chunk 注册表
        for chunk in chunks:
            self._all_chunks[chunk.id] = chunk

        return len(chunks)

    def build_indices(self) -> None:
        """构建所有索引（向量 + BM25）"""
        self.vector_store.build_index()
        self.bm25.build()

    # ------------------------------------------------------------------
    # 检索
    # ------------------------------------------------------------------

    def retrieve(
        self,
        query: str,
        mode: RetrievalMode = RetrievalMode.HYBRID,
        top_k: int = 5,
        paper_id: Optional[str] = None,
        query_embedding: Optional["np.ndarray"] = None,
    ) -> list[RetrievalItem]:
        """
        多路检索。

        Args:
            query: 查询文本
            mode: 检索模式
            top_k: 返回 top-k 结果
            paper_id: 可选，限定在某篇论文内检索
            query_embedding: 查询的向量表示（向量检索时需要）

        Returns:
            RetrievalItem 列表
        """
        vector_results: list[RetrievalItem] = []
        bm25_results: list[RetrievalItem] = []
        graph_results: list[RetrievalItem] = []

        if mode in (RetrievalMode.HYBRID, RetrievalMode.VECTOR):
            if query_embedding is not None:
                vector_results = self.vector_store.search(
                    query_embedding, top_k=top_k * 2
                )

        if mode in (RetrievalMode.HYBRID, RetrievalMode.KEYWORD):
            bm25_results = self.bm25.search(query, top_k=top_k * 2)

        if mode in (RetrievalMode.HYBRID, RetrievalMode.GRAPH):
            graph_results = self.graph_store.search_by_entity(
                query, self._all_chunks, top_k=top_k
            )

        # 融合
        results = self.fusion.fuse(
            vector_results, bm25_results, graph_results, top_k=top_k
        )

        # 按 paper_id 过滤
        if paper_id:
            results = [r for r in results if r.chunk.paper_id == paper_id]

        return results

    # ------------------------------------------------------------------
    # 查询（检索 + 生成）
    # ------------------------------------------------------------------

    def query(
        self,
        question: str,
        paper_id: Optional[str] = None,
        mode: RetrievalMode = RetrievalMode.HYBRID,
        top_k: int = 5,
        query_embedding: Optional["np.ndarray"] = None,
        llm_generate: Optional[callable] = None,
    ) -> RAGResult:
        """
        执行 RAG 查询：检索 + 生成。

        Args:
            question: 用户问题
            paper_id: 可选，限定在某篇论文内
            mode: 检索模式
            top_k: 检索数量
            query_embedding: 查询向量
            llm_generate: LLM 生成函数，签名为
                          (context: str, question: str) → str
                          若不提供则仅返回检索结果拼接

        Returns:
            RAGResult
        """
        # 1. 检索
        items = self.retrieve(
            query=question,
            mode=mode,
            top_k=top_k,
            paper_id=paper_id,
            query_embedding=query_embedding,
        )

        # 2. 构建上下文
        context = self._build_context(items)

        # 3. 生成答案
        if llm_generate:
            answer = llm_generate(context, question)
        else:
            answer = self._default_generate(context, question)

        # 4. 构建来源
        sources = self._build_sources(items)

        # 5. 计算置信度
        confidence = self._calc_confidence(items)

        return RAGResult(
            answer=answer,
            sources=sources,
            confidence=confidence,
            tokens_used=len(context.split()),
        )

    # ------------------------------------------------------------------
    # 管理
    # ------------------------------------------------------------------

    def remove_paper(self, paper_id: str) -> dict:
        """移除一篇论文的所有索引数据"""
        return {
            "vector_chunks_removed": self.vector_store.remove_paper(paper_id),
            "bm25_chunks_removed": self.bm25.remove_paper(paper_id),
        }

    def save(self, base_path: Optional[str] = None) -> str:
        """持久化所有索引"""
        return self.vector_store.save(base_path)

    @classmethod
    def load(cls, base_path: Optional[str] = None) -> "RAGEngine":
        """从磁盘加载"""
        engine = cls(vector_store=VectorStore.load(base_path))
        # 重建 BM25
        for chunk in engine.vector_store._chunks:
            engine.bm25.add_chunks([chunk])
            engine._all_chunks[chunk.id] = chunk
        engine.bm25.build()
        return engine

    # ------------------------------------------------------------------
    # 内部方法
    # ------------------------------------------------------------------

    def _build_context(self, items: list[RetrievalItem]) -> str:
        """构建 LLM 上下文"""
        parts = []
        for i, item in enumerate(items, 1):
            chunk = item.chunk
            header = f"[{i}]"
            if chunk.section_title:
                header += f" Section: {chunk.section_title}"
            if chunk.page:
                header += f" (p{chunk.page})"
            parts.append(f"{header}\n{chunk.text}")

        return "\n\n---\n\n".join(parts)

    def _build_sources(self, items: list[RetrievalItem]) -> list[Source]:
        """构建引用来源列表"""
        sources = []
        for item in items:
            chunk = item.chunk
            sources.append(Source(
                paper_id=chunk.paper_id,
                paper_title="",  # 由调用方填充
                page=chunk.page,
                chunk_text=chunk.text[:200],
                relevance_score=item.score,
                section_title=chunk.section_title,
            ))
        return sources

    @staticmethod
    def _default_generate(context: str, question: str) -> str:
        """默认生成（无 LLM 时的回退方案：返回检索到的相关段落）"""
        if not context.strip():
            return "未找到相关内容。"
        lines = context.split("\n")
        # 返回前几行作为摘要
        summary_lines = [l for l in lines if l.strip() and not l.startswith("[")]
        summary = " ".join(summary_lines[:5])
        return f"基于检索到的内容，相关段落摘要：\n\n{summary}..."

    @staticmethod
    def _calc_confidence(items: list[RetrievalItem]) -> float:
        """根据检索结果计算置信度"""
        if not items:
            return 0.0
        scores = [item.score for item in items]
        avg_score = sum(scores) / len(scores)
        # 结合结果数量和平均分数
        count_factor = min(len(items) / 5, 1.0)
        return round(avg_score * 0.7 + count_factor * 0.3, 3)
