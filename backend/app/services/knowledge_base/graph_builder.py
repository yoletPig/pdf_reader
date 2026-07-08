"""知识图谱构建器"""
import networkx as nx
from typing import Optional


class GraphBuilder:
    """构建论文关系图谱 (NetworkX)"""

    def __init__(self):
        self._graph = nx.DiGraph()

    def add_paper_node(self, paper_id: str, title: str, metadata: dict = {}):
        """添加论文节点"""
        self._graph.add_node(
            paper_id,
            type="paper",
            title=title,
            **metadata,
        )

    def add_entity_node(self, entity_id: str, name: str, entity_type: str, paper_id: str):
        """添加实体节点"""
        self._graph.add_node(
            entity_id,
            type="entity",
            name=name,
            entity_type=entity_type,
            paper_id=paper_id,
        )

    def add_citation_edge(self, source_paper: str, target_paper: str):
        """添加引用关系"""
        self._graph.add_edge(source_paper, target_paper, relation="cites")

    def add_entity_relation(
        self,
        source_entity: str,
        target_entity: str,
        relation_type: str,
        paper_id: str,
    ):
        """添加实体关系"""
        self._graph.add_edge(
            source_entity,
            target_entity,
            relation=relation_type,
            paper_id=paper_id,
        )

    def get_paper_neighbors(self, paper_id: str, depth: int = 1) -> list[dict]:
        """获取论文的邻居节点"""
        if paper_id not in self._graph:
            return []

        neighbors = []
        for node in nx.descendants_at_distance(self._graph, paper_id, depth):
            node_data = self._graph.nodes[node]
            neighbors.append({"id": node, **node_data})
        return neighbors

    def get_related_papers(self, paper_id: str, max_results: int = 10) -> list[dict]:
        """获取相关论文"""
        if paper_id not in self._graph:
            return []

        # 通过共同实体关联
        related = set()
        # 获取论文的实体
        paper_entities = [
            n for n, d in self._graph.nodes(data=True)
            if d.get("paper_id") == paper_id and d.get("type") == "entity"
        ]

        for entity in paper_entities:
            # 找到共享此实体的其他论文
            for neighbor in self._graph.neighbors(entity):
                neighbor_data = self._graph.nodes.get(neighbor, {})
                neighbor_paper = neighbor_data.get("paper_id", "")
                if neighbor_paper and neighbor_paper != paper_id:
                    related.add(neighbor_paper)

        result = []
        for pid in list(related)[:max_results]:
            node_data = self._graph.nodes.get(pid, {})
            result.append({"id": pid, **node_data})
        return result

    def export_graph(self) -> dict:
        """导出图谱数据（用于前端可视化）"""
        nodes = []
        for node_id, data in self._graph.nodes(data=True):
            nodes.append({"id": node_id, **data})

        edges = []
        for source, target, data in self._graph.edges(data=True):
            edges.append({"source": source, "target": target, **data})

        return {"nodes": nodes, "edges": edges}

    @property
    def graph(self) -> nx.DiGraph:
        return self._graph


# 全局单例
graph_builder = GraphBuilder()
