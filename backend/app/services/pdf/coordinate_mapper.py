"""坐标映射工具"""
from app.services.pdf.types import PDFBlock, PDFPage


class CoordinateMapper:
    """为双栏对照翻译提供精确定位"""

    @staticmethod
    def find_block_at_position(
        blocks: list[PDFBlock],
        x: float,
        y: float,
        page: int,
    ) -> PDFBlock | None:
        """根据坐标查找对应的文本块"""
        for block in blocks:
            if block.page != page:
                continue
            x0, y0, x1, y1 = block.bbox
            if x0 <= x <= x1 and y0 <= y <= y1:
                return block
        return None

    @staticmethod
    def get_block_index_map(pages: list[PDFPage]) -> dict[str, int]:
        """获取块 ID 到全局索引的映射"""
        index_map = {}
        idx = 0
        for page in pages:
            for block in page.blocks:
                index_map[block.id] = idx
                idx += 1
        return index_map

    @staticmethod
    def get_aligned_blocks(original_blocks: list[PDFBlock], translated_block_ids: set[str]) -> list[tuple[PDFBlock, bool]]:
        """获取原文块与翻译状态的对齐列表"""
        return [(b, b.id in translated_block_ids) for b in original_blocks]
