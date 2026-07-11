"""Minimal chunking utilities for persisted paper QA retrieval."""
from dataclasses import dataclass, field


@dataclass
class TextChunk:
    chunk_id: str
    text: str
    paper_id: str = ""
    page_number: int = 0
    block_id: str = ""
    metadata: dict = field(default_factory=dict)


class ChunkSplitter:
    def __init__(self, chunk_size: int = 512, chunk_overlap_blocks: int = 1):
        self.chunk_size = chunk_size
        self.chunk_overlap_blocks = max(0, chunk_overlap_blocks)

    def split_blocks(self, blocks: list, paper_id: str = "") -> list[TextChunk]:
        chunks: list[TextChunk] = []
        current_text: list[str] = []
        current_blocks: list = []
        current_len = 0
        chunk_idx = 0

        for block in blocks:
            block_text = (block.text or "").strip()
            if not block_text:
                continue

            if current_text and current_len + len(block_text) > self.chunk_size:
                chunks.append(self._build_chunk(paper_id, chunk_idx, current_text, current_blocks))
                chunk_idx += 1

                overlap_blocks = current_blocks[-self.chunk_overlap_blocks :] if self.chunk_overlap_blocks else []
                current_blocks = list(overlap_blocks)
                current_text = [(item.text or "").strip() for item in current_blocks if (item.text or "").strip()]
                current_len = sum(len(text) for text in current_text)

            current_blocks.append(block)
            current_text.append(block_text)
            current_len += len(block_text)

        if current_text:
            chunks.append(self._build_chunk(paper_id, chunk_idx, current_text, current_blocks))

        return chunks

    def _build_chunk(self, paper_id: str, chunk_idx: int, texts: list[str], blocks: list) -> TextChunk:
        first_block = blocks[0] if blocks else None
        return TextChunk(
            chunk_id=f"{paper_id}_chunk_{chunk_idx}",
            text="\n".join(texts),
            paper_id=paper_id,
            page_number=getattr(first_block, "page", 0) if first_block else 0,
            block_id=getattr(first_block, "id", "") if first_block else "",
            metadata={
                "block_count": len(blocks),
                "section_title": getattr(first_block, "section_title", "") if first_block else "",
            },
        )
