"""PDF 服务入口"""
from pathlib import Path
from typing import Optional
from app.services.pdf.types import PDFDocument, PDFPage, PDFBlock, PDFTable
from app.services.pdf.parser import PDFParser
from app.services.pdf.layout_analyzer import LayoutAnalyzer
from app.services.pdf.table_extractor import TableExtractor
from app.services.pdf.coordinate_mapper import CoordinateMapper


class PDFService:
    """PDF 解析服务 - 文本提取 + 版面分析 + 表格提取 + 坐标映射"""

    def __init__(self):
        self.parser = PDFParser()
        self.layout_analyzer = LayoutAnalyzer()
        self.table_extractor = TableExtractor()
        self.coordinate_mapper = CoordinateMapper()
        self._documents: dict[str, PDFDocument] = {}  # paper_id -> PDFDocument

    async def parse_pdf(self, paper_id: str, file_path: str) -> PDFDocument:
        """解析 PDF 文件"""
        # 1. 提取文本和坐标
        pdf_doc = await self.parser.parse(file_path)

        # 2. 版面分析
        pdf_doc = self.layout_analyzer.analyze(pdf_doc)

        # 3. 缓存解析结果
        self._documents[paper_id] = pdf_doc

        return pdf_doc

    async def extract_tables(self, paper_id: str, page_numbers: Optional[list[int]] = None) -> list[PDFTable]:
        """提取表格"""
        pdf_doc = self._documents.get(paper_id)
        if not pdf_doc:
            return []

        return await self.table_extractor.extract_tables(pdf_doc.file_path, page_numbers)

    def get_document(self, paper_id: str) -> Optional[PDFDocument]:
        """获取已解析的文档"""
        return self._documents.get(paper_id)

    def get_page(self, paper_id: str, page_number: int) -> Optional[PDFPage]:
        """获取指定页面"""
        doc = self._documents.get(paper_id)
        if doc and 0 <= page_number - 1 < len(doc.pages):
            return doc.pages[page_number - 1]
        return None

    def get_blocks(self, paper_id: str, page_number: Optional[int] = None) -> list[PDFBlock]:
        """获取文本块"""
        doc = self._documents.get(paper_id)
        if not doc:
            return []

        if page_number is not None:
            page = self.get_page(paper_id, page_number)
            return page.blocks if page else []

        return doc.all_blocks

    def find_block(self, paper_id: str, page: int, x: float, y: float) -> Optional[PDFBlock]:
        """根据坐标查找文本块"""
        doc = self._documents.get(paper_id)
        if not doc:
            return None

        blocks = doc.all_blocks
        return self.coordinate_mapper.find_block_at_position(blocks, x, y, page)

    def remove_document(self, paper_id: str):
        """移除缓存的文档"""
        self._documents.pop(paper_id, None)


# 全局单例
pdf_service = PDFService()
