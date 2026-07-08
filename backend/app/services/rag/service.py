"""RAG 检索增强生成服务 - 文档分块、向量化、检索"""
from typing import Optional
from dataclasses import dataclass, field
import numpy as np


@dataclass
class TextChunk:
    """文本块"""
    chunk_id: str
    text: str
    paper_id: str = ""
    page_number: int = 0
    block_id: str = ""
    metadata: dict = field(default_factory=dict)


@dataclass
class RetrievalResult:
    """检索结果"""
    chunk: TextChunk
    score: float = 0.0
    rank: int = 0


class ChunkSplitter:
    """文本分块器"""

    def __init__(self, chunk_size: int = 512, chunk_overlap: int = 64):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def split_text(self, text: str, paper_id: str = "", metadata: dict = None) -> list[TextChunk]:
        """将文本分割为重叠的块"""
        if not text.strip():
            return []

        chunks: list[TextChunk] = []
        start = 0
        chunk_idx = 0

        while start < len(text):
            end = min(start + self.chunk_size, len(text))
            chunk_text = text[start:end].strip()

            if chunk_text:
                chunks.append(TextChunk(
                    chunk_id=f"{paper_id}_chunk_{chunk_idx}",
                    text=chunk_text,
                    paper_id=paper_id,
                    metadata=metadata or {},
                ))
                chunk_idx += 1

            if end >= len(text):
                break
            start = end - self.chunk_overlap

        return chunks

    def split_blocks(self, blocks: list, paper_id: str = "") -> list[TextChunk]:
        """将 PDFBlock 列表分割为文本块"""
        chunks: list[TextChunk] = []
        current_text: list[str] = []
        current_len = 0
        chunk_idx = 0
        first_block = None

        for block in blocks:
            block_text = block.text.strip()
            if not block_text:
                continue

            if first_block is None:
                first_block = block

            if current_len + len(block_text) > self.chunk_size and current_text:
                chunk_text = "\n".join(current_text)
                chunks.append(TextChunk(
                    chunk_id=f"{paper_id}_chunk_{chunk_idx}",
                    text=chunk_text,
                    paper_id=paper_id,
                    page_number=first_block.page_number if first_block else 0,
                    block_id=first_block.block_id if first_block else "",
                ))
                chunk_idx += 1
                # 保留重叠
                overlap_text = current_text[-max(1, len(current_text) // 4):]
                current_text = overlap_text + [block_text]
                current_len = sum(len(t) for t in current_text)
                first_block = block
            else:
                current_text.append(block_text)
                current_len += len(block_text)

        # 最后一个块
        if current_text:
            chunk_text = "\n".join(current_text)
            chunks.append(TextChunk(
                chunk_id=f"{paper_id}_chunk_{chunk_idx}",
                text=chunk_text,
                paper_id=paper_id,
                page_number=first_block.page_number if first_block else 0,
                block_id=first_block.block_id if first_block else "",
            ))

        return chunks


class BM25Retriever:
    """BM25 关键词检索器"""

    def __init__(self):
        self.chunks: list[TextChunk] = []
        self._corpus: list[str] = []
        self._bm25 = None
        self._tokenized_corpus: list[list[str]] = []

    def index(self, chunks: list[TextChunk]):
        """索引文档块"""
        self.chunks = chunks
        self._corpus = [chunk.text for chunk in chunks]
        self._tokenized_corpus = [self._tokenize(text) for text in self._corpus]

        try:
            from rank_bm25 import BM25Okapi
            self._bm25 = BM25Okapi(self._tokenized_corpus)
        except ImportError:
            self._bm25 = None

    def search(self, query: str, top_k: int = 10) -> list[RetrievalResult]:
        """BM25 检索"""
        if not self._bm25 or not self.chunks:
            return []

        tokenized_query = self._tokenize(query)
        scores = self._bm25.get_scores(tokenized_query)

        # 获取 top_k 结果
        top_indices = np.argsort(scores)[::-1][:top_k]

        results = []
        for rank, idx in enumerate(top_indices):
            if scores[idx] > 0:
                results.append(RetrievalResult(
                    chunk=self.chunks[idx],
                    score=float(scores[idx]),
                    rank=rank + 1,
                ))

        return results

    def _tokenize(self, text: str) -> list[str]:
        """简单分词"""
        import re
        # 英文按空格分词，中文按字符
        tokens = []
        for word in re.findall(r'[a-zA-Z]+|[一-鿿]|[0-9]+', text.lower()):
            if len(word) > 1 or word.isdigit():
                tokens.append(word)
        return tokens


class RAGService:
    """RAG 服务 - 统一检索入口"""

    def __init__(
        self,
        chunk_size: int = 512,
        chunk_overlap: int = 64,
        top_k: int = 10,
    ):
        self.splitter = ChunkSplitter(chunk_size=chunk_size, chunk_overlap=chunk_overlap)
        self.bm25 = BM25Retriever()
        self.vector_retriever = None  # 将在后续接入 ChromaDB
        self.top_k = top_k
        self._all_chunks: list[TextChunk] = []

    def index_paper(self, paper_id: str, blocks: list, full_text: str = ""):
        """为论文建立索引"""
        # 使用 block 级别的分块
        chunks = self.splitter.split_blocks(blocks, paper_id=paper_id)
        if not chunks and full_text:
            chunks = self.splitter.split_text(full_text, paper_id=paper_id)

        self._all_chunks.extend(chunks)

        # 更新 BM25 索引
        self.bm25.index(self._all_chunks)

    def remove_paper(self, paper_id: str):
        """移除论文索引"""
        self._all_chunks = [c for c in self._all_chunks if c.paper_id != paper_id]
        if self._all_chunks:
            self.bm25.index(self._all_chunks)
        else:
            self.bm25 = BM25Retriever()

    def search(
        self,
        query: str,
        top_k: int = 0,
        paper_id: Optional[str] = None,
    ) -> list[RetrievalResult]:
        """混合检索"""
        k = top_k or self.top_k
        results = self.bm25.search(query, top_k=k)

        # 如果指定了论文 ID，过滤结果
        if paper_id:
            results = [r for r in results if r.chunk.paper_id == paper_id]

        return results[:k]

    def get_context_for_qa(
        self,
        query: str,
        paper_id: Optional[str] = None,
        max_tokens: int = 8000,
    ) -> str:
        """获取问答上下文"""
        results = self.search(query, top_k=10, paper_id=paper_id)

        if not results:
            return ""

        context_parts = []
        total_len = 0
        chars_per_token = 4  # 粗略估计

        for r in results:
            text = r.chunk.text
            estimated_tokens = len(text) / chars_per_token
            if total_len + estimated_tokens > max_tokens:
                break
            context_parts.append(f"[Chunk {r.chunk.chunk_id} (Page {r.chunk.page_number})]:\n{text}")
            total_len += estimated_tokens

        return "\n\n---\n\n".join(context_parts)
