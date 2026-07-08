"""PDF 解析相关类型定义"""
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class BlockType(str, Enum):
    PARAGRAPH = "paragraph"
    HEADING = "heading"
    TABLE = "table"
    FIGURE = "figure"
    EQUATION = "equation"
    REFERENCE = "reference"
    FOOTER = "footer"
    HEADER = "header"


@dataclass
class PDFBlock:
    """PDF 文本块"""
    id: str
    text: str
    page: int
    bbox: tuple[float, float, float, float]  # x0, y0, x1, y1
    block_type: BlockType = BlockType.PARAGRAPH
    font_size: float = 10.0
    font_name: str = ""
    section_title: str = ""
    heading_level: int = 0
    metadata: dict = field(default_factory=dict)


@dataclass
class PDFTable:
    """PDF 表格"""
    id: str
    page: int
    bbox: tuple[float, float, float, float]
    rows: list[list[str]] = field(default_factory=list)
    headers: list[str] = field(default_factory=list)
    caption: str = ""


@dataclass
class PDFPage:
    """PDF 页面"""
    page_number: int
    width: float
    height: float
    blocks: list[PDFBlock] = field(default_factory=list)
    tables: list[PDFTable] = field(default_factory=list)
    text: str = ""


@dataclass
class PDFDocument:
    """PDF 文档解析结果"""
    file_path: str
    total_pages: int
    pages: list[PDFPage] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)
    sections: list[dict] = field(default_factory=list)

    @property
    def all_blocks(self) -> list[PDFBlock]:
        """获取所有文本块"""
        blocks = []
        for page in self.pages:
            blocks.extend(page.blocks)
        return blocks
