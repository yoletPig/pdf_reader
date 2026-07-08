"""知识图谱服务 - 实体抽取、关系构建、图谱查询"""
from typing import Optional
from dataclasses import dataclass, field


@dataclass
class KGEntity:
    """知识实体"""
    id: str = ""
    name: str = ""
    entity_type: str = ""  # method / dataset / metric / concept / tool
    description: str = ""
    paper_id: str = ""
    page_number: int = 0


@dataclass
class KGRelation:
    """知识关系"""
    id: str = ""
    source_id: str = ""
    target_id: str = ""
    relation_type: str = ""  # uses / compares / extends / outperforms / based_on
    paper_id: str = ""


@dataclass
class KnowledgeGraph:
    """知识图谱"""
    entities: list[KGEntity] = field(default_factory=list)
    relations: list[KGRelation] = field(default_factory=list)

    def to_networkx(self):
        """转换为 NetworkX 图"""
        import networkx as nx
        G = nx.DiGraph()

        for entity in self.entities:
            G.add_node(entity.id, name=entity.name, type=entity.entity_type, description=entity.description)

        for rel in self.relations:
            G.add_edge(rel.source_id, rel.target_id, type=rel.relation_type)

        return G

    def get_entity_by_name(self, name: str) -> Optional[KGEntity]:
        """按名称查找实体"""
        for entity in self.entities:
            if entity.name.lower() == name.lower():
                return entity
        return None

    def get_entities_by_type(self, entity_type: str) -> list[KGEntity]:
        """按类型查找实体"""
        return [e for e in self.entities if e.entity_type == entity_type]

    def get_relations_for_entity(self, entity_id: str) -> list[KGRelation]:
        """获取与实体相关的所有关系"""
        return [r for r in self.relations if r.source_id == entity_id or r.target_id == entity_id]

    def get_related_entities(self, entity_id: str) -> list[tuple[KGEntity, str]]:
        """获取关联实体及其关系类型"""
        results = []
        entity_map = {e.id: e for e in self.entities}

        for rel in self.relations:
            if rel.source_id == entity_id:
                target = entity_map.get(rel.target_id)
                if target:
                    results.append((target, rel.relation_type))
            elif rel.target_id == entity_id:
                source = entity_map.get(rel.source_id)
                if source:
                    results.append((source, f"inverse_{rel.relation_type}"))

        return results

    def find_path(self, source_id: str, target_id: str) -> list[list[str]]:
        """查找两个实体之间的路径"""
        G = self.to_networkx()
        try:
            import networkx as nx
            paths = list(nx.all_simple_paths(G, source_id, target_id, cutoff=3))
            return paths
        except (ImportError, Exception):
            return []


class KGService:
    """知识图谱服务"""

    def __init__(self):
        self._graphs: dict[str, KnowledgeGraph] = {}  # paper_id -> KnowledgeGraph

    def get_graph(self, paper_id: str) -> KnowledgeGraph:
        """获取论文的知识图谱"""
        if paper_id not in self._graphs:
            self._graphs[paper_id] = KnowledgeGraph()
        return self._graphs[paper_id]

    def add_entity(self, paper_id: str, entity: KGEntity):
        """添加实体"""
        graph = self.get_graph(paper_id)
        graph.entities.append(entity)

    def add_relation(self, paper_id: str, relation: KGRelation):
        """添加关系"""
        graph = self.get_graph(paper_id)
        graph.relations.append(relation)

    def remove_paper(self, paper_id: str):
        """移除论文图谱"""
        self._graphs.pop(paper_id, None)

    def query_entities(self, paper_id: str, entity_type: str = "") -> list[KGEntity]:
        """查询实体"""
        graph = self.get_graph(paper_id)
        if entity_type:
            return graph.get_entities_by_type(entity_type)
        return graph.entities

    def query_relations(self, paper_id: str, entity_id: str = "") -> list[KGRelation]:
        """查询关系"""
        graph = self.get_graph(paper_id)
        if entity_id:
            return graph.get_relations_for_entity(entity_id)
        return graph.relations

    def search_entity(self, paper_id: str, name: str) -> Optional[KGEntity]:
        """搜索实体"""
        graph = self.get_graph(paper_id)
        return graph.get_entity_by_name(name)

    def get_subgraph_json(self, paper_id: str, entity_id: str) -> dict:
        """获取子图（JSON 格式，用于前端可视化）"""
        graph = self.get_graph(paper_id)
        related = graph.get_related_entities(entity_id)

        entity_map = {e.id: e for e in graph.entities}
        center = entity_map.get(entity_id)

        nodes = []
        edges = []

        if center:
            nodes.append({
                "id": center.id,
                "name": center.name,
                "type": center.entity_type,
                "is_center": True,
            })

        seen_ids = {entity_id}
        for entity, rel_type in related:
            if entity.id not in seen_ids:
                nodes.append({
                    "id": entity.id,
                    "name": entity.name,
                    "type": entity.entity_type,
                    "is_center": False,
                })
                seen_ids.add(entity.id)

            edges.append({
                "source": entity_id,
                "target": entity.id,
                "type": rel_type,
            })

        return {"nodes": nodes, "edges": edges}
