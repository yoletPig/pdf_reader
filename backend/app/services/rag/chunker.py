"""
文档分块器：将论文文本切分为语义完整的 Chunk，保留标题层级信息。

策略：按 Section 切分 → 语义段落 → 滑窗合并，保证 chunk 大小可控且语义完整。
"""

import re
import hashlib
from datetime import datetime
from typing import Optional

from app.services.rag.types import Chunk

# 配置常量
TARGET_CHUNK_SIZE = 800       # 目标 chunk 大小（字符数）
CHUNK_OVERLAP = 150           # 相邻 chunk 重叠字符数
MAX_CHUNK_SIZE = 1200         # 最大 chunk 大小
MIN_CHUNK_SIZE = 200          # 最小 chunk 大小


def chunk_paper(
    full_text: str,
    paper_id: str,
    sections: Optional[list[dict]] = None,
) -> list[Chunk]:
    """
    将论文全文切分为 Chunk 列表。

    Args:
        full_text: 论文全文
        paper_id: 论文 ID
        sections: 可选的章节列表，每个元素为 {"title": str, "page": int}，
                  若不传则从文本中自动检测

    Returns:
        Chunk 列表
    """
    if not full_text.strip():
        return []

    if sections:
        chunks = _chunk_with_sections(full_text, paper_id, sections)
    else:
        chunks = _chunk_auto(full_text, paper_id)

    # 后处理：确保重叠
    chunks = _apply_overlap(chunks)

    return chunks


def _detect_sections(text: str) -> list[dict]:
    """
    自动检测文本中的章节标题（如 "1. Introduction", "2. Related Work" 等）。
    返回 [{"title": str, "start": int}, ...]
    """
    # 匹配模式：数字. 标题 或 罗马数字. 标题 或 "Abstract" / "References" 等
    patterns = [
        r'^(?:#+\s*)?(?:(\d+(?:\.\d+)*)\s+(.+))$',           # "1. Introduction" / "## 1.1 Background"
        r'^(?:#+\s*)?(Abstract|Introduction|Related Work|Background|Method|Experiment|Result|Discussion|Conclusion|References|Appendix|Acknowledgments?)\b',
    ]

    lines = text.split('\n')
    sections = []
    current_offset = 0

    for line in lines:
        stripped = line.strip()
        if not stripped:
            current_offset += len(line) + 1
            continue

        for pattern in patterns:
            match = re.match(pattern, stripped, re.IGNORECASE)
            if match:
                sections.append({
                    "title": stripped,
                    "start": current_offset,
                })
                break

        current_offset += len(line) + 1

    return sections


def _chunk_with_sections(
    full_text: str,
    paper_id: str,
    sections: list[dict],
) -> list[Chunk]:
    """根据已知章节信息切分"""
    chunks = []
    chunk_idx = 0

    for i, section in enumerate(sections):
        section_title = section.get("title", "")
        page = section.get("page", 0)

        # 确定该 section 的文本范围
        start = 0  # approximate
        end = len(full_text)

        section_text = full_text[start:end] if i == 0 else full_text[start:end]

        # 按段落切分
        paragraphs = _split_paragraphs(section_text)
        heading_level = _estimate_heading_level(section_title)

        # 滑窗合并段落
        current_text = ""
        current_start = 0

        for para in paragraphs:
            if not para.strip():
                continue

            if len(current_text) + len(para) <= MAX_CHUNK_SIZE:
                if current_text:
                    current_text += "\n\n" + para
                else:
                    current_text = para
            else:
                if current_text.strip() and len(current_text.strip()) >= MIN_CHUNK_SIZE:
                    chunk = Chunk(
                        id=_generate_chunk_id(paper_id, chunk_idx),
                        paper_id=paper_id,
                        text=current_text.strip(),
                        section_title=section_title,
                        page=page,
                        chunk_index=chunk_idx,
                        heading_level=heading_level,
                    )
                    chunks.append(chunk)
                    chunk_idx += 1

                # 开始新 chunk（带部分重叠）
                if len(para) > MAX_CHUNK_SIZE:
                    # 长段落：按句子切分
                    sub_chunks = _split_long_paragraph(
                        para, paper_id, chunk_idx, section_title, page, heading_level
                    )
                    chunks.extend(sub_chunks)
                    chunk_idx += len(sub_chunks)
                    current_text = ""
                else:
                    current_text = para

        # 处理剩余的
        if current_text.strip() and len(current_text.strip()) >= MIN_CHUNK_SIZE:
            chunk = Chunk(
                id=_generate_chunk_id(paper_id, chunk_idx),
                paper_id=paper_id,
                text=current_text.strip(),
                section_title=section_title,
                page=page,
                chunk_index=chunk_idx,
                heading_level=heading_level,
            )
            chunks.append(chunk)
            chunk_idx += 1

    return chunks


def _chunk_auto(full_text: str, paper_id: str) -> list[Chunk]:
    """自动检测章节并切分"""
    sections = _detect_sections(full_text)

    if not sections:
        # 没有检测到章节，按段落切分
        return _chunk_flat(full_text, paper_id)

    # 转换格式
    section_dicts = [{"title": s["title"], "page": 0} for s in sections]
    return _chunk_with_sections(full_text, paper_id, section_dicts)


def _chunk_flat(full_text: str, paper_id: str) -> list[Chunk]:
    """无章节信息时的扁平切分"""
    chunks = []
    paragraphs = _split_paragraphs(full_text)
    chunk_idx = 0
    current_text = ""

    for para in paragraphs:
        if not para.strip():
            continue

        if len(current_text) + len(para) <= MAX_CHUNK_SIZE:
            if current_text:
                current_text += "\n\n" + para
            else:
                current_text = para
        else:
            if current_text.strip() and len(current_text.strip()) >= MIN_CHUNK_SIZE:
                chunks.append(Chunk(
                    id=_generate_chunk_id(paper_id, chunk_idx),
                    paper_id=paper_id,
                    text=current_text.strip(),
                    chunk_index=chunk_idx,
                ))
                chunk_idx += 1

            if len(para) > MAX_CHUNK_SIZE:
                sub = _split_long_paragraph(para, paper_id, chunk_idx)
                chunks.extend(sub)
                chunk_idx += len(sub)
                current_text = ""
            else:
                current_text = para

    if current_text.strip() and len(current_text.strip()) >= MIN_CHUNK_SIZE:
        chunks.append(Chunk(
            id=_generate_chunk_id(paper_id, chunk_idx),
            paper_id=paper_id,
            text=current_text.strip(),
            chunk_index=chunk_idx,
        ))

    return chunks


def _split_long_paragraph(
    text: str,
    paper_id: str,
    start_idx: int,
    section_title: str = "",
    page: int = 0,
    heading_level: int = 0,
) -> list[Chunk]:
    """将过长的段落按句子切分为多个 chunk"""
    sentences = re.split(r'(?<=[.!?])\s+', text)
    chunks = []
    current = ""
    idx = start_idx

    for sent in sentences:
        if len(current) + len(sent) <= MAX_CHUNK_SIZE:
            current = (current + " " + sent).strip() if current else sent
        else:
            if current.strip() and len(current.strip()) >= MIN_CHUNK_SIZE:
                chunks.append(Chunk(
                    id=_generate_chunk_id(paper_id, idx),
                    paper_id=paper_id,
                    text=current.strip(),
                    section_title=section_title,
                    page=page,
                    chunk_index=idx,
                    heading_level=heading_level,
                ))
                idx += 1
            current = sent

    if current.strip() and len(current.strip()) >= MIN_CHUNK_SIZE:
        chunks.append(Chunk(
            id=_generate_chunk_id(paper_id, idx),
            paper_id=paper_id,
            text=current.strip(),
            section_title=section_title,
            page=page,
            chunk_index=idx,
            heading_level=heading_level,
        ))

    return chunks


def _apply_overlap(chunks: list[Chunk]) -> list[Chunk]:
    """为相邻 chunk 添加重叠文本"""
    if len(chunks) < 2:
        return chunks

    for i in range(1, len(chunks)):
        prev_text = chunks[i - 1].text
        if len(prev_text) > CHUNK_OVERLAP:
            overlap = prev_text[-CHUNK_OVERLAP:]
            # 从上一个句号后开始重叠，保持语义完整
            sentences = re.split(r'(?<=[.!?])\s+', prev_text)
            # 取最后一句作为重叠
            if sentences:
                overlap = sentences[-1]
                if len(overlap) > CHUNK_OVERLAP * 2:
                    overlap = overlap[-CHUNK_OVERLAP:]
            chunks[i].text = overlap + "\n\n" + chunks[i].text

    return chunks


def _split_paragraphs(text: str) -> list[str]:
    """按双换行切分段落"""
    return re.split(r'\n\s*\n', text)


def _generate_chunk_id(paper_id: str, index: int) -> str:
    """生成唯一的 chunk ID"""
    raw = f"{paper_id}_{index}_{datetime.utcnow().timestamp()}"
    return hashlib.md5(raw.encode()).hexdigest()[:12]


def _estimate_heading_level(title: str) -> int:
    """估算标题层级"""
    # "1. Introduction" → level 1
    # "1.1 Background" → level 2
    # "1.1.1 Details" → level 3
    match = re.match(r'^(\d+(?:\.\d+)*)\s', title)
    if match:
        return match.group(1).count('.') + 1
    # Abstract, References 等视为 level 1
    return 1
