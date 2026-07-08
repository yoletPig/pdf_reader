"""术语一致性引擎"""
from typing import Optional
from collections import OrderedDict


class TerminologyEngine:
    """自动维护全文术语表，确保翻译术语统一"""

    def __init__(self, max_terms: int = 200):
        self.max_terms = max_terms
        self._terms: dict[str, dict[str, str]] = {}  # paper_id -> {en_term: zh_term}
        self._term_frequency: dict[str, dict[str, int]] = {}  # paper_id -> {en_term: count}

    def add_term(self, paper_id: str, en_term: str, zh_term: str):
        """添加术语对"""
        if paper_id not in self._terms:
            self._terms[paper_id] = OrderedDict()
            self._term_frequency[paper_id] = {}

        self._terms[paper_id][en_term] = zh_term
        self._term_frequency[paper_id][en_term] = self._term_frequency[paper_id].get(en_term, 0) + 1

        # LRU 淘汰
        if len(self._terms[paper_id]) > self.max_terms:
            # 移除频率最低的
            sorted_terms = sorted(
                self._term_frequency[paper_id].items(),
                key=lambda x: x[1]
            )
            for term, _ in sorted_terms:
                if term in self._terms[paper_id]:
                    del self._terms[paper_id][term]
                    del self._term_frequency[paper_id][term]
                    break

    def get_term(self, paper_id: str, en_term: str) -> Optional[str]:
        """获取术语的中文翻译"""
        if paper_id in self._terms:
            return self._terms[paper_id].get(en_term)
        return None

    def get_all_terms(self, paper_id: str) -> dict[str, str]:
        """获取论文的所有术语"""
        return dict(self._terms.get(paper_id, {}))

    def extract_candidates(self, text: str) -> list[str]:
        """从文本中提取可能的术语候选（基于大写/缩写模式）"""
        import re
        candidates = set()

        # 大写缩写词 (如 CNN, LSTM, BERT)
        abbreviations = re.findall(r'\b[A-Z]{2,}(?:\s+[A-Z]{2,})*\b', text)
        candidates.update(abbreviations)

        # 首字母大写的多词短语 (如 "Natural Language Processing")
        phrases = re.findall(r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4}\b', text)
        candidates.update(phrases)

        # 技术术语模式 (如 "self-attention", "back-propagation")
        tech_terms = re.findall(r'\b[a-z]+(?:-[a-z]+){1,3}\b', text)
        candidates.update(tech_terms)

        return list(candidates)

    def clear(self, paper_id: str):
        """清除论文术语表"""
        self._terms.pop(paper_id, None)
        self._term_frequency.pop(paper_id, None)


# 全局单例
terminology_engine = TerminologyEngine()
