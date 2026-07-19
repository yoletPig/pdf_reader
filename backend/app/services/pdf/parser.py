"""Compatibility parser that now delegates to Docling."""
from app.services.docling import docling_service
from app.services.pdf.types import PDFDocument


class PDFParser:
    """保留旧接口名，内部改为使用 Docling。"""

    async def parse(self, file_path: str) -> PDFDocument:
        extraction = docling_service.extract(file_path)
        if not extraction.pdf_document:
            raise ValueError(f"Docling 未返回可用文档: {file_path}")
        return extraction.pdf_document
