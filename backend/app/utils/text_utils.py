"""文本处理工具"""
import re
import math


def truncate_text(text: str, max_length: int = 500, suffix: str = "...") -> str:
    """截断文本"""
    if len(text) <= max_length:
        return text
    return text[:max_length].rstrip() + suffix


def extract_keywords(text: str, top_n: int = 10) -> list[str]:
    """简单关键词提取（基于词频）"""
    words = re.findall(r'\b[a-zA-Z]{3,}\b', text.lower())
    # 停用词
    stopwords = {
        'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was',
        'were', 'been', 'have', 'has', 'had', 'not', 'but', 'all', 'can',
        'which', 'their', 'they', 'its', 'also', 'than', 'then', 'more',
        'some', 'these', 'those', 'each', 'such', 'other', 'into', 'over',
    }
    words = [w for w in words if w not in stopwords]

    freq = {}
    for w in words:
        freq[w] = freq.get(w, 0) + 1

    sorted_words = sorted(freq.items(), key=lambda x: x[1], reverse=True)
    return [w for w, _ in sorted_words[:top_n]]


def detect_language(text: str) -> str:
    """简单语言检测"""
    # 检测中文字符
    chinese_chars = len(re.findall(r'[一-鿿]', text))
    total_chars = len(text.strip())

    if total_chars == 0:
        return "unknown"

    if chinese_chars / total_chars > 0.3:
        return "zh"
    return "en"


def estimate_tokens(text: str) -> int:
    """估算 token 数量（粗略估算：英文 4 字符/token，中文 1.5 字符/token）"""
    lang = detect_language(text)
    if lang == "zh":
        return int(len(text) / 1.5)
    return int(len(text) / 4)


def split_sentences(text: str) -> list[str]:
    """句子分割"""
    # 匹配句子结束符：. ! ? 后跟空格或换行
    sentences = re.split(r'(?<=[.!?])\s+', text)
    return [s.strip() for s in sentences if s.strip()]


def extract_arxiv_id(text: str) -> str | None:
    """从文本中提取 arXiv ID"""
    # 匹配 arxiv.org/abs/XXXX.XXXXX 或 arxiv:XXXX.XXXXX
    patterns = [
        r'arxiv\.org/abs/([0-9]+\.[0-9]+(?:v\d+)?)',
        r'arxiv:([0-9]+\.[0-9]+(?:v\d+)?)',
        r'arXiv:([0-9]+\.[0-9]+(?:v\d+)?)',
        r'\[([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)\]',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(1)
    return None
