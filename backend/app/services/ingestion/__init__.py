"""论文摄入服务 - 仅解析与 block 落库，无向量索引"""
from app.services.ingestion.pipeline import paper_ingestion_service

__all__ = ["paper_ingestion_service"]
