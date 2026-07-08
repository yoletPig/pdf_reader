"""翻译服务类型定义"""
from dataclasses import dataclass, field
from enum import Enum


class TranslationMode(str, Enum):
    QUICK = "quick"
    POLISH = "polish"


@dataclass
class TranslationRequest:
    """翻译请求"""
    paper_id: str
    block_id: str
    text: str
    mode: TranslationMode = TranslationMode.QUICK
    context: str = ""
    terminology: dict[str, str] = field(default_factory=dict)


@dataclass
class TranslationResult:
    """翻译结果"""
    paper_id: str
    block_id: str
    original_text: str
    translated_text: str
    mode: TranslationMode
    from_cache: bool = False
    model_used: str = ""
    tokens_used: int = 0


@dataclass
class PDFBlock:
    """PDF 文本块"""
    id: str
    text: str
    page: int
    bbox: tuple[float, float, float, float]  # x0, y0, x1, y1
    block_type: str = "paragraph"  # paragraph / heading / table / figure / equation
    font_size: float = 10.0
    section_title: str = ""
