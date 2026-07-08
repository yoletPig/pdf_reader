"""表格提取器 (pdfplumber)"""
from app.services.pdf.types import PDFTable


class TableExtractor:
    """使用 pdfplumber 提取结构化表格数据"""

    async def extract_tables(self, file_path: str, page_numbers: list[int] | None = None) -> list[PDFTable]:
        """提取 PDF 中的表格"""
        import pdfplumber

        tables = []

        with pdfplumber.open(file_path) as pdf:
            pages_to_process = page_numbers or range(len(pdf.pages))

            for page_num in pages_to_process:
                if page_num >= len(pdf.pages):
                    continue

                page = pdf.pages[page_num]
                extracted = page.extract_tables()

                for i, table_data in enumerate(extracted):
                    if not table_data:
                        continue

                    # 第一行通常是表头
                    headers = table_data[0] if table_data else []
                    rows = table_data[1:] if len(table_data) > 1 else []

                    # 过滤空行
                    rows = [row for row in rows if any(cell and str(cell).strip() for cell in row)]

                    table = PDFTable(
                        id=f"table_p{page_num + 1}_{i}",
                        page=page_num + 1,
                        bbox=(0, 0, page.width, page.height),
                        rows=rows,
                        headers=[str(h) if h else "" for h in headers],
                    )
                    tables.append(table)

        return tables
