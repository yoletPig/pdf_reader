"""版面分析器"""
from app.services.pdf.types import PDFDocument, PDFPage, PDFBlock, BlockType


class LayoutAnalyzer:
    """分析 PDF 版面结构，识别双栏、章节层次等"""

    def analyze(self, pdf_doc: PDFDocument) -> PDFDocument:
        """分析版面结构"""
        for page in pdf_doc.pages:
            self._analyze_page(page)

        # 提取章节结构
        pdf_doc.sections = self._extract_sections(pdf_doc)
        return pdf_doc

    def _analyze_page(self, page: PDFPage):
        """分析单页版面"""
        if not page.blocks:
            return

        # 检测是否双栏布局
        is_two_column = self._detect_two_column(page)
        page.metadata["is_two_column"] = is_two_column

        # 为块分配章节标题
        current_section = ""
        current_level = 0

        for block in page.blocks:
            if block.block_type == BlockType.HEADING:
                # 判断标题级别
                if block.font_size >= 18:
                    block.heading_level = 1
                elif block.font_size >= 15:
                    block.heading_level = 2
                elif block.font_size >= 13:
                    block.heading_level = 3
                else:
                    block.heading_level = 4

                current_section = block.text
                current_level = block.heading_level

            block.section_title = current_section
            block.heading_level = current_level

    def _detect_two_column(self, page: PDFPage) -> bool:
        """检测是否双栏布局"""
        if len(page.blocks) < 4:
            return False

        # 获取所有块的水平中心点
        centers_x = [
            (b.bbox[0] + b.bbox[2]) / 2 for b in page.blocks
        ]

        if not centers_x:
            return False

        page_center = page.width / 2

        # 检查是否有块明显分布在两侧
        left_blocks = sum(1 for x in centers_x if x < page_center - 50)
        right_blocks = sum(1 for x in centers_x if x > page_center + 50)

        # 两侧都有块且比例合理
        total = left_blocks + right_blocks
        if total > 0 and left_blocks / max(total, 1) > 0.2 and right_blocks / max(total, 1) > 0.2:
            return True

        return False

    def _extract_sections(self, pdf_doc: PDFDocument) -> list[dict]:
        """提取章节结构"""
        sections = []
        seen_titles = set()

        for page in pdf_doc.pages:
            for block in page.blocks:
                if block.block_type == BlockType.HEADING and block.text not in seen_titles:
                    seen_titles.add(block.text)
                    sections.append({
                        "title": block.text,
                        "level": block.heading_level,
                        "page": block.page,
                        "block_id": block.id,
                    })

        return sections
