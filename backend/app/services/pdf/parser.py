"""PDF 文本提取器 (PyMuPDF)"""
from typing import Optional
from pathlib import Path
from app.services.pdf.types import PDFDocument, PDFPage, PDFBlock, BlockType


class PDFParser:
    """使用 PyMuPDF 精确提取文本、坐标和字体信息"""

    async def parse(self, file_path: str) -> PDFDocument:
        """解析 PDF 文件"""
        import fitz  # PyMuPDF

        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError(f"PDF 文件不存在: {file_path}")

        doc = fitz.open(file_path)
        pdf_doc = PDFDocument(
            file_path=file_path,
            total_pages=len(doc),
            metadata={
                "title": doc.metadata.get("title", ""),
                "author": doc.metadata.get("author", ""),
                "subject": doc.metadata.get("subject", ""),
                "creator": doc.metadata.get("creator", ""),
                "producer": doc.metadata.get("producer", ""),
                "format": doc.metadata.get("format", ""),
            },
        )

        for page_num in range(len(doc)):
            page = doc[page_num]
            pdf_page = self._parse_page(page, page_num)
            pdf_doc.pages.append(pdf_page)

        doc.close()
        return pdf_doc

    def _parse_page(self, page, page_num: int) -> PDFPage:
        """解析单页"""
        import fitz

        # 获取页面尺寸
        rect = page.rect
        pdf_page = PDFPage(
            page_number=page_num + 1,
            width=rect.width,
            height=rect.height,
            text=page.get_text(),
        )

        # 提取文本块
        blocks = page.get_text("dict")["blocks"]
        block_index = 0

        for block in blocks:
            if block["type"] == 0:  # 文本块
                for line in block.get("lines", []):
                    text_parts = []
                    font_sizes = []
                    font_names = []

                    for span in line.get("spans", []):
                        text_parts.append(span["text"])
                        font_sizes.append(span["size"])
                        font_names.append(span.get("font", ""))

                    full_text = "".join(text_parts).strip()
                    if not full_text:
                        continue

                    bbox = tuple(line["bbox"])  # x0, y0, x1, y1
                    avg_font_size = sum(font_sizes) / len(font_sizes) if font_sizes else 10.0

                    # 判断块类型
                    block_type = self._classify_block_type(full_text, avg_font_size, bbox, rect)

                    pdf_block = PDFBlock(
                        id=f"p{page_num + 1}_b{block_index}",
                        text=full_text,
                        page=page_num + 1,
                        bbox=bbox,
                        block_type=block_type,
                        font_size=avg_font_size,
                        font_name=font_names[0] if font_names else "",
                    )

                    pdf_page.blocks.append(pdf_block)
                    block_index += 1

            elif block["type"] == 1:  # 图片块
                # 图片块标记但不提取内容
                pass

        return pdf_page

    def _classify_block_type(
        self,
        text: str,
        font_size: float,
        bbox: tuple[float, float, float, float],
        page_rect,
    ) -> BlockType:
        """分类文本块类型"""
        # 字体较大的可能是标题
        if font_size >= 14:
            return BlockType.HEADING

        # 检查是否是页眉/页脚
        y0 = bbox[1]
        y1 = bbox[3]
        page_height = page_rect.height

        if y1 < 50:  # 页面顶部
            return BlockType.HEADER
        if y0 > page_height - 50:  # 页面底部
            return BlockType.FOOTER

        # 检查是否是参考文献
        text_lower = text.lower().strip()
        if text_lower.startswith("references") or text_lower.startswith("bibliography"):
            return BlockType.HEADING

        # 检查是否包含公式特征
        if any(c in text for c in "∑∫∏√∞∂∇∈∉⊂⊃∪∩"):
            return BlockType.EQUATION

        # 默认段落
        return BlockType.PARAGRAPH
