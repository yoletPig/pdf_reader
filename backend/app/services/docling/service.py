"""Docling-backed document extraction and chunking."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, InputFormat, PdfFormatOption
from docling_core.transforms.chunker import HybridChunker
from docling_core.transforms.chunker.tokenizer.huggingface import HuggingFaceTokenizer
from transformers import AutoTokenizer

from app.services.pdf.types import BlockType, PDFBlock, PDFDocument, PDFPage


@dataclass
class TextChunk:
    """docling 引擎内部使用的文本块（向量索引已移除，仅保留结构用于抽取）。"""

    chunk_id: str
    text: str
    page_number: int = 1
    paper_id: str = ""
    block_id: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)


def _normalize_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").replace("\x00", " ")).strip()


def _hydrate_formula_texts(dl_doc) -> None:
    for item, _ in dl_doc.iterate_items():
        label = str(getattr(item, "label", "") or "")
        if label != "formula":
            continue
        if _normalize_text(getattr(item, "text", None)):
            continue
        fallback = _normalize_text(getattr(item, "orig", None))
        if fallback:
            item.text = fallback


def _extract_abstract(markdown: str) -> str:
    if not markdown:
        return ""

    lines = [line.rstrip() for line in markdown.splitlines()]
    in_abstract = False
    collected: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not in_abstract and re.match(r"^#{1,6}\s+abstract\b", stripped, re.IGNORECASE):
            in_abstract = True
            continue
        if in_abstract and re.match(r"^#{1,6}\s+\S+", stripped):
            break
        if in_abstract and stripped:
            collected.append(stripped)
        if sum(len(item) for item in collected) >= 2200:
            break
    return _normalize_text(" ".join(collected))[:2200]


def _guess_title(blocks: list[PDFBlock], fallback: str) -> str:
    for block in blocks:
        if block.block_type == BlockType.HEADING and _normalize_text(block.text):
            return _normalize_text(block.text)
    return fallback


def _bbox_tuple(prov) -> tuple[float, float, float, float]:
    bbox = getattr(prov, "bbox", None)
    if not bbox:
        return (0.0, 0.0, 0.0, 0.0)
    return (
        float(getattr(bbox, "l", 0.0) or 0.0),
        float(getattr(bbox, "t", 0.0) or 0.0),
        float(getattr(bbox, "r", 0.0) or 0.0),
        float(getattr(bbox, "b", 0.0) or 0.0),
    )


@dataclass
class PageSource:
    page_number: int
    text: str = ""
    markdown: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class DoclingExtraction:
    source_ref: str
    source_type: str
    markdown: str
    page_count: int
    title: str
    abstract: str
    metadata: dict[str, Any] = field(default_factory=dict)
    pdf_document: PDFDocument | None = None
    page_sources: list[PageSource] = field(default_factory=list)
    chunks: list[TextChunk] = field(default_factory=list)


class DoclingService:
    def __init__(self):
        pdf_options = PdfPipelineOptions()
        pdf_options.generate_picture_images = True
        pdf_options.generate_page_images = False
        # 图片导出分辨率倍数：越大越清晰（默认 2.0 偏糊）
        pdf_options.images_scale = 3.0
        self._converter = DocumentConverter(
            format_options={
                InputFormat.PDF: PdfFormatOption(pipeline_options=pdf_options),
            }
        )
        tokenizer = AutoTokenizer.from_pretrained("sentence-transformers/all-MiniLM-L6-v2")
        self._hybrid_chunker = HybridChunker(
            tokenizer=HuggingFaceTokenizer(tokenizer=tokenizer, max_tokens=512)
        )

    def extract(
        self,
        source_ref: str,
        *,
        paper_id: str = "",
        artifact_dir: Path | None = None,
        asset_url_prefix: str = "",
    ) -> DoclingExtraction:
        result = self._converter.convert(source_ref)
        dl_doc = result.document
        _hydrate_formula_texts(dl_doc)

        origin = dl_doc.origin.model_dump() if getattr(dl_doc, "origin", None) else {}
        source_type = self._source_type_from_origin(source_ref, origin)
        blocks = self._build_blocks(dl_doc)
        picture_markdowns = self._export_picture_markdowns(
            dl_doc,
            artifact_dir=artifact_dir,
            asset_url_prefix=asset_url_prefix,
        )
        page_sources = self._build_page_sources(dl_doc, blocks, picture_markdowns)
        raw_num_pages = getattr(dl_doc, "num_pages", 0)
        if callable(raw_num_pages):
            raw_num_pages = raw_num_pages()
        page_count = max((page.page_number for page in page_sources), default=int(raw_num_pages or 0))
        markdown = self._render_document_markdown(dl_doc, picture_markdowns)
        fallback_title = Path(source_ref).name if "://" not in source_ref else source_ref
        title = _guess_title(blocks, fallback_title)
        abstract = _extract_abstract(markdown)

        pdf_pages = [
            PDFPage(
                page_number=page.page_number,
                width=0.0,
                height=0.0,
                blocks=[block for block in blocks if block.page == page.page_number],
                text=page.text,
                metadata={"markdown": page.markdown},
            )
            for page in page_sources
        ]
        pdf_document = PDFDocument(
            file_path=source_ref,
            total_pages=page_count,
            pages=pdf_pages,
            metadata={
                "title": title,
                "origin": origin,
                "source_type": source_type,
            },
        )

        return DoclingExtraction(
            source_ref=source_ref,
            source_type=source_type,
            markdown=markdown,
            page_count=page_count,
            title=title,
            abstract=abstract,
            metadata={
                "origin": origin,
                "conversion_status": str(result.status),
            },
            pdf_document=pdf_document,
            page_sources=page_sources,
            chunks=self._build_chunks(dl_doc, paper_id),
        )

    def _collect_picture_regions(self, dl_doc) -> dict[int, list[tuple[float, float, float, float]]]:
        """收集所有图片区域 bbox（按页分组），用于过滤图内 OCR 文字。"""
        regions: dict[int, list[tuple[float, float, float, float]]] = {}
        for picture in list(getattr(dl_doc, "pictures", []) or []):
            for prov in list(getattr(picture, "prov", []) or []):
                page_number = int(getattr(prov, "page_no", 0) or 0)
                if page_number <= 0:
                    continue
                bbox = _bbox_tuple(prov)
                if bbox[2] > bbox[0] and bbox[3] > bbox[1]:
                    regions.setdefault(page_number, []).append(bbox)
        return regions

    @staticmethod
    def _inside_picture(
        item_bbox: tuple[float, float, float, float],
        picture_regions: list[tuple[float, float, float, float]],
        threshold: float = 0.7,
    ) -> bool:
        """文本块面积 ≥ threshold 落在图片区域内 → 判定为图内文字（OCR 产物），应过滤。"""
        x0, y0, x1, y1 = item_bbox
        item_area = max(0.0, x1 - x0) * max(0.0, y1 - y0)
        if item_area <= 0:
            return False
        for px0, py0, px1, py1 in picture_regions:
            ix0, iy0 = max(x0, px0), max(y0, py0)
            ix1, iy1 = min(x1, px1), min(y1, py1)
            inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
            if inter / item_area >= threshold:
                return True
        return False

    def _build_blocks(self, dl_doc) -> list[PDFBlock]:
        blocks: list[PDFBlock] = []
        current_section = ""
        picture_regions = self._collect_picture_regions(dl_doc)

        for idx, (item, level) in enumerate(dl_doc.iterate_items()):
            text = _normalize_text(getattr(item, "text", None))
            label = str(getattr(item, "label", "") or "")
            if not text:
                continue

            # 过滤图片区域内的 OCR 文字（图内文字不应进入正文/翻译）
            if label not in ("caption", "title", "section_header", "header"):
                prov_entries = list(getattr(item, "prov", []) or [])
                if prov_entries:
                    item_bbox = _bbox_tuple(prov_entries[0])
                    item_page = int(getattr(prov_entries[0], "page_no", 0) or 0)
                    if item_page in picture_regions and self._inside_picture(item_bbox, picture_regions[item_page]):
                        continue

            prov_entries = list(getattr(item, "prov", []) or [])
            page_numbers = sorted(
                {
                    int(getattr(prov, "page_no", 0) or 0)
                    for prov in prov_entries
                    if int(getattr(prov, "page_no", 0) or 0) > 0
                }
            )
            primary_page = page_numbers[0] if page_numbers else 1
            bbox = _bbox_tuple(prov_entries[0]) if prov_entries else (0.0, 0.0, 0.0, 0.0)

            block_type = BlockType.PARAGRAPH
            heading_level = 0
            if label in {"title", "section_header"}:
                block_type = BlockType.HEADING
                heading_level = 1 if label == "title" else max(2, level + 1)
                current_section = text
            elif label == "list_item":
                block_type = BlockType.PARAGRAPH
            elif label == "caption":
                block_type = BlockType.FIGURE
            elif label == "formula":
                block_type = BlockType.EQUATION

            section_title = text if block_type == BlockType.HEADING else current_section
            blocks.append(
                PDFBlock(
                    id=f"docling-b{idx}",
                    text=text,
                    page=primary_page,
                    bbox=bbox,
                    block_type=block_type,
                    section_title=section_title,
                    heading_level=heading_level,
                    metadata={
                        "label": label,
                        "level": level,
                        "page_numbers": page_numbers or [primary_page],
                    },
                )
            )

        return blocks

    def _build_page_sources(self, dl_doc, blocks: list[PDFBlock], picture_markdowns: dict[int, list[str]]) -> list[PageSource]:
        pages: dict[int, list[PDFBlock]] = {}
        for block in blocks:
            pages.setdefault(block.page, []).append(block)

        page_sources: list[PageSource] = []
        for page_number in sorted(set(pages) | set(picture_markdowns)):
            page_blocks = pages.get(page_number, [])
            text = "\n\n".join(block.text for block in page_blocks if block.text.strip())
            markdown = self._render_page_markdown(dl_doc, page_number, picture_markdowns.get(page_number, []))
            if picture_markdowns.get(page_number):
                picture_labels = [f"[Image {idx + 1}]" for idx in range(len(picture_markdowns[page_number]))]
                text = "\n\n".join(part for part in [text, "\n".join(picture_labels)] if part)
            page_sources.append(
                PageSource(
                    page_number=page_number,
                    text=text,
                    markdown=markdown,
                    metadata={
                        "block_count": len(page_blocks),
                        "picture_count": len(picture_markdowns.get(page_number, [])),
                    },
                )
            )
        return page_sources

    def _render_page_markdown(self, dl_doc, page_number: int, picture_markdowns: list[str]) -> str:
        placeholder = "[[DOCLING_IMAGE]]"
        page_md = dl_doc.export_to_markdown(page_no=page_number, image_placeholder=placeholder).strip()
        for picture_md in picture_markdowns:
            replacement = picture_md.strip() if picture_md.strip() else "<!-- image -->"
            page_md = page_md.replace(placeholder, replacement, 1)
        return page_md.replace(placeholder, "<!-- image -->")

    def _render_document_markdown(self, dl_doc, picture_markdowns: dict[int, list[str]]) -> str:
        placeholder = "[[DOCLING_IMAGE]]"
        markdown = dl_doc.export_to_markdown(image_placeholder=placeholder).strip()
        replacements = [item for page in sorted(picture_markdowns) for item in picture_markdowns[page]]
        for picture_md in replacements:
            markdown = markdown.replace(placeholder, picture_md.strip() if picture_md.strip() else "<!-- image -->", 1)
        return markdown.replace(placeholder, "<!-- image -->")

    def _export_picture_markdowns(
        self,
        dl_doc,
        *,
        artifact_dir: Path | None,
        asset_url_prefix: str,
    ) -> dict[int, list[str]]:
        pictures_by_page: dict[int, list[str]] = {}
        if artifact_dir is not None:
            artifact_dir.mkdir(parents=True, exist_ok=True)

        for index, picture in enumerate(list(getattr(dl_doc, "pictures", []) or [])):
            prov_entries = list(getattr(picture, "prov", []) or [])
            if not prov_entries:
                continue
            page_number = int(getattr(prov_entries[0], "page_no", 0) or 0)
            if page_number <= 0:
                continue

            caption_text = _normalize_text(picture.caption_text(dl_doc))
            asset_markdown = "<!-- image -->"
            image = picture.get_image(dl_doc)
            if image is not None and artifact_dir is not None:
                filename = f"page-{page_number:04d}-picture-{index:04d}.png"
                output_path = artifact_dir / filename
                image.save(output_path)
                url_prefix = asset_url_prefix.rstrip("/")
                asset_markdown = f"![{caption_text or f'Image {index + 1}'}]({url_prefix}/{filename})"
            pictures_by_page.setdefault(page_number, []).append(asset_markdown.strip())

        return pictures_by_page

    def _render_block_markdown(self, block: PDFBlock) -> str:
        label = str(block.metadata.get("label", "") or "")
        text = block.text.strip()
        if not text:
            return ""
        if block.block_type == BlockType.HEADING:
            level = max(1, min(block.heading_level or 2, 6))
            return f"{'#' * level} {text}"
        if label == "list_item":
            return f"- {text}"
        if block.block_type == BlockType.EQUATION:
            return f"$$\n{text}\n$$"
        return text

    def _build_chunks(self, dl_doc, paper_id: str) -> list[TextChunk]:
        chunks: list[TextChunk] = []
        for idx, chunk in enumerate(self._hybrid_chunker.chunk(dl_doc)):
            text = _normalize_text(getattr(chunk, "text", ""))
            if not text:
                continue

            meta = getattr(chunk, "meta", None)
            doc_items = list(getattr(meta, "doc_items", []) or [])
            headings = list(getattr(meta, "headings", []) or [])
            captions = list(getattr(meta, "captions", []) or [])
            page_numbers = sorted(
                {
                    int(getattr(prov, "page_no", 0) or 0)
                    for item in doc_items
                    for prov in list(getattr(item, "prov", []) or [])
                    if int(getattr(prov, "page_no", 0) or 0) > 0
                }
            )
            page_number = page_numbers[0] if page_numbers else 1
            block_id = str(getattr(doc_items[0], "self_ref", "") or f"docling-b{idx}") if doc_items else f"docling-b{idx}"
            chunks.append(
                TextChunk(
                    chunk_id=f"{paper_id}_chunk_{idx}" if paper_id else f"chunk_{idx}",
                    text=text,
                    paper_id=paper_id,
                    page_number=page_number,
                    block_id=block_id,
                    metadata={
                        "section_title": headings[-1] if headings else "",
                        "headings": headings,
                        "captions": captions,
                        "page_numbers": page_numbers or [page_number],
                    },
                )
            )
        return chunks

    def _source_type_from_origin(self, source_ref: str, origin: dict[str, Any]) -> str:
        mimetype = str(origin.get("mimetype", "") or "").lower()
        if mimetype == "application/pdf":
            return "pdf"
        if "word" in mimetype or source_ref.lower().endswith(".docx"):
            return "docx"
        if "presentation" in mimetype or source_ref.lower().endswith(".pptx"):
            return "pptx"
        if "spreadsheet" in mimetype or source_ref.lower().endswith(".xlsx"):
            return "xlsx"
        if "html" in mimetype or source_ref.lower().startswith(("http://", "https://")):
            return "html"
        if source_ref.lower().endswith(".md"):
            return "markdown"
        return "document"


docling_service = DoclingService()
