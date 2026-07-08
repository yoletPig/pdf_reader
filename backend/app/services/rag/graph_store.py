"""
图谱存储：管理论文知识图谱（实体 - 关系网络），用于图谱增强检索。

使用 NetworkX 管理图结构，支持按实体关联检索相关 Chunk。
"""

from typing import Optional

from app.services.rag.types import Chunk, RetrievalItem

# 关系类型常量
REL_CITES = "cites"
REL_MENTIONS = "mentions"
REL_USES = "uses"
REL_OUTPERFORMS = "outperforms"
REL_PROPOSES = "proposes"
REL_PART_OF = "part_of"


class GraphStore:
    """
    知识图谱存储，管理实体和关系。

    节点: Entity (id, name, type, properties)
    边: (entity_a, entity_b, relation_type, properties)
    """

    def __init__(self):
        self._entities: dict[str, dict] = {}      # entity_id → {name, type, props}
        self._edges: list[tuple] = []              # [(src, dst, rel_type, props), ...]
        self._entity_to_chunks: dict[str, list[str]] = {}  # entity_id → [chunk_id, ...]

    # ------------------------------------------------------------------
    # 实体管理
    # ------------------------------------------------------------------

    def add_entity(
        self,
        entity_id: str,
        name: str,
        entity_type: str = "concept",
        properties: Optional[dict] = None,
    ) -> None:
        """添加或更新实体"""
        self._entities[entity_id] = {
            "name": name,
            "type": entity_type,
            "properties": properties or {},
        }

    def add_relation(
        self,
        src_id: str,
        dst_id: str,
        relation_type: str,
        properties: Optional[dict] = None,
    ) -> None:
        """添加关系边"""
        self._edges.append((src_id, dst_id, relation_type, properties or {}))

    def link_entity_to_chunk(self, entity_id: str, chunk_id: str) -> None:
        """将实体关联到 chunk"""
        if entity_id not in self._entity_to_chunks:
            self._entity_to_chunks[entity_id] = []
        if chunk_id not in self._entity_to_chunks[entity_id]:
            self._entity_to_chunks[entity_id].append(chunk_id)

    # ------------------------------------------------------------------
    # 图谱检索
    # ------------------------------------------------------------------

    def search_by_entity(
        self,
        entity_name: str,
        chunks: dict[str, Chunk],
        top_k: int = 5,
    ) -> list[RetrievalItem]:
        """
        按实体名称搜索相关 Chunk。

        Args:
            entity_name: 实体名称（模糊匹配）
            chunks: chunk_id → Chunk 映射
            top_k: 返回 top-k 结果

        Returns:
            RetrievalItem 列表
        """
        matched_entities = []
        for eid, entity in self._entities.items():
            if entity_name.lower() in entity["name"].lower():
                matched_entities.append(eid)

        if not matched_entities:
            return []

        # 收集关联的 chunk
        chunk_scores: dict[str, float] = {}
        for eid in matched_entities:
            linked_chunks = self._entity_to_chunks.get(eid, [])
            for cid in linked_chunks:
                if cid not in chunks:
                    continue
                # 分数：精确匹配 > 部分匹配
                entity = self._entities[eid]
                if entity["name"].lower() == entity_name.lower():
                    score = 1.0
                else:
                    score = 0.7
                chunk_scores[cid] = max(chunk_scores.get(cid, 0), score)

        # 排序
        sorted_chunks = sorted(chunk_scores.items(), key=lambda x: x[1], reverse=True)
        results = []
        for cid, score in sorted_chunks[:top_k]:
            results.append(RetrievalItem(
                chunk=chunks[cid],
                score=score,
                source="graph",
            ))

        return results

    def expand_entities(
        self,
        entity_ids: list[str],
        max_hops: int = 1,
    ) -> list[str]:
        """
        在图谱中扩展实体：从给定实体出发，沿关系边扩展 max_hops 跳。

        Returns:
            扩展后的实体 ID 列表
        """
        visited = set(entity_ids)
        frontier = set(entity_ids)

        for _ in range(max_hops):
            next_frontier = set()
            for src, dst, _, _ in self._edges:
                if src in frontier and dst not in visited:
                    next_frontier.add(dst)
                    visited.add(dst)
                if dst in frontier and src not in visited:
                    next_frontier.add(src)
                    visited.add(src)
            frontier = next_frontier
            if not frontier:
                break

        return list(visited)

    # ------------------------------------------------------------------
    # 统计 & 查询
    # ------------------------------------------------------------------

    def get_entity_neighbors(self, entity_id: str) -> list[dict]:
        """获取实体的邻居"""
        neighbors = []
        for src, dst, rel_type, props in self._edges:
            if src == entity_id:
                neighbors.append({"entity_id": dst, "relation": rel_type, "properties": props})
            elif dst == entity_id:
                neighbors.append({"entity_id": src, "relation": rel_type, "properties": props})
        return neighbors

    @property
    def entity_count(self) -> int:
        return len(self._entities)

    @property
    def edge_count(self) -> int:
        return len(self._edges)

    def get_entity(self, entity_id: str) -> Optional[dict]:
        return self._entities.get(entity_id)
