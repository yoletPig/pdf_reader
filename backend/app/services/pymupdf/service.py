"""PyMuPDF 轻量解析引擎 - 快速文本/结构提取，替代 Docling 的默认路径"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import fitz

from app.services.pdf.types import BlockType, PDFBlock, PDFDocument, PDFPage


def _normalize_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").replace("\x00", " ")).strip()


@dataclass
class PageSource:
    page_number: int
    text: str = ""
    markdown: str = ""


@dataclass
class PymupdfExtraction:
    """与 DoclingExtraction 对齐的轻量抽取结果（无 chunk/图片）。"""

    source_ref: str
    source_type: str = "pdf"
    markdown: str = ""
    page_count: int = 0
    title: str = ""
    abstract: str = ""
    metadata: dict = field(default_factory=dict)
    pdf_document: Optional[PDFDocument] = None
    page_sources: list[PageSource] = field(default_factory=list)

    @property
    def chunks(self) -> list:
        return []  # pymupdf 引擎不产生 chunk（向量切分已移除）


class PymupdfService:
    """基于 PyMuPDF 的快速解析。"""

    _HEADING_RE = re.compile(r"^(abstract|introduction|background|methods?|related work|results?|conclusion|references|keywords?)\b", re.IGNORECASE)

    def extract(
        self,
        source_ref: str,
        *,
        paper_id: str = "",
        artifact_dir: Path | None = None,
        asset_url_prefix: str = "",
    ) -> PymupdfExtraction:
        if not source_ref or "://" in source_ref or not source_ref.lower().endswith(".pdf"):
            # 非 PDF 输入回退为空抽取
            return PymupdfExtraction(source_ref=source_ref, source_type="document")

        with fitz.open(source_ref) as doc:
            page_count = len(doc)
            metadata = {k: str(v) for k, v in (doc.metadata or {}).items() if v not in (None, "")}

            pages: list[PDFPage] = []
            page_sources: list[PageSource] = []
            for page_index in range(page_count):
                page = doc.load_page(page_index)
                page_number = page_index + 1
                blocks = self._extract_page_blocks(page, page_number)
                # 页面文本由过滤后的块重建，剔除图片内 OCR/矢量图文字
                normalized = "\n\n".join(b.text for b in blocks if b.text.strip())
                markdown = self._render_page_markdown(blocks)

                pages.append(
                    PDFPage(
                        page_number=page_number,
                        width=float(page.rect.width),
                        height=float(page.rect.height),
                        blocks=blocks,
                        text=normalized,
                        metadata={"markdown": markdown},
                    )
                )
                page_sources.append(
                    PageSource(page_number=page_number, text=normalized, markdown=markdown)
                )

            title = self._guess_title(metadata, pages, Path(source_ref).name)
            abstract = self._extract_abstract(page_sources)

            pdf_document = PDFDocument(
                file_path=source_ref,
                total_pages=page_count,
                pages=pages,
                metadata={"title": title, "source_type": "pdf", "engine": "pymupdf"},
            )

            markdown = "\n\n".join(
                f"<!-- page:{p.page_number} -->\n{p.markdown}" for p in page_sources if p.markdown
            )

            return PymupdfExtraction(
                source_ref=source_ref,
                source_type="pdf",
                markdown=markdown,
                page_count=page_count,
                title=title,
                abstract=abstract,
                metadata={"engine": "pymupdf", **metadata},
                pdf_document=pdf_document,
                page_sources=page_sources,
            )

    def _extract_page_blocks(self, page, page_number: int) -> list[PDFBlock]:
        blocks: list[PDFBlock] = []
        text_blocks = page.get_text("dict", flags=fitz.TEXTFLAGS_BLOCKS)["blocks"]

        # 图片区域（用于过滤图内文字）
        image_regions = [
            tuple(float(v) for v in block.get("bbox", (0.0, 0.0, 0.0, 0.0)))
            for block in text_blocks
            if block.get("type") == 1
        ]

        for block in text_blocks:
            if block.get("type") != 0:
                continue
            bbox = tuple(float(v) for v in block.get("bbox", (0.0, 0.0, 0.0, 0.0)))
            if self._inside_image(bbox, image_regions):
                continue  # 图内文字（图注之外）不提取
            text = _normalize_text("".join(
                span.get("text", "")
                for line in block.get("lines", [])
                for span in line.get("spans", [])
            ))
            if not text:
                continue
            sizes = [
                float(span.get("size", 0) or 0)
                for line in block.get("lines", [])
                for span in line.get("spans", [])
            ]
            avg_size = (sum(sizes) / len(sizes)) if sizes else 0.0
            block_type = BlockType.PARAGRAPH
            if self._HEADING_RE.match(text):
                block_type = BlockType.HEADING
            elif avg_size >= 13.5:
                block_type = BlockType.HEADING
            blocks.append(
                PDFBlock(
                    id=f"p{page_number}-b{len(blocks) + 1}",
                    text=text,
                    page=page_number,
                    bbox=bbox,
                    block_type=block_type,
                    section_title="",
                )
            )
        return blocks

    @staticmethod
    def _inside_image(
        item_bbox: tuple[float, float, float, float],
        image_regions: list[tuple[float, float, float, float]],
        threshold: float = 0.7,
    ) -> bool:
        """文本块面积 ≥ threshold 落在图片区域内 → 图内文字，过滤。"""
        x0, y0, x1, y1 = item_bbox
        item_area = max(0.0, x1 - x0) * max(0.0, y1 - y0)
        if item_area <= 0:
            return False
        for px0, py0, px1, py1 in image_regions:
            ix0, iy0 = max(x0, px0), max(y0, py0)
            ix1, iy1 = min(x1, px1), min(y1, py1)
            inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
            if inter / item_area >= threshold:
                return True
        return False

    def _render_page_markdown(self, blocks: list[PDFBlock]) -> str:
        lines: list[str] = []
        for block in blocks:
            if block.block_type == BlockType.HEADING:
                lines.append(f"## {block.text}")
            else:
                lines.append(block.text)
        return "\n\n".join(lines)

    def _guess_title(self, metadata: dict, pages: list[PDFPage], fallback: str) -> str:
        meta_title = _normalize_text(metadata.get("title", ""))
        if meta_title and len(meta_title) >= 6:
            return meta_title
        if pages:
            first_blocks = [b for b in pages[0].blocks if b.block_type == BlockType.HEADING]
            if first_blocks:
                return first_blocks[0].text
            if pages[0].blocks:
                return pages[0].blocks[0].text[:200]
        return fallback

    def _extract_abstract(self, page_sources: list[PageSource]) -> str:
        joined = "\n".join(p.text for p in page_sources[:2])
        match = re.search(r"abstract[\s:.\-–—]*(.{40,2000}?)(?:(?=\n\s*[A-Z][a-z]+\s+[A-Z])|$)", joined, re.IGNORECASE | re.DOTALL)
        if not match:
            return ""
        return _normalize_text(match.group(1))[:2200]


pymupdf_service = PymupdfService()
