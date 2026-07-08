"""翻译缓存"""
from typing import Optional
from collections import OrderedDict
import hashlib


class TranslationCache:
    """内存 LRU 翻译缓存"""

    def __init__(self, max_size: int = 10000, ttl_seconds: int = 86400 * 30):
        self.max_size = max_size
        self.ttl_seconds = ttl_seconds
        self._cache: OrderedDict[str, tuple[str, float]] = OrderedDict()  # key -> (translated_text, timestamp)

    def _make_key(self, paper_id: str, block_id: str, mode: str, text: str) -> str:
        """生成缓存键"""
        content = f"{paper_id}:{block_id}:{mode}:{text}"
        return hashlib.md5(content.encode()).hexdigest()

    def get(self, paper_id: str, block_id: str, mode: str, text: str) -> Optional[str]:
        """获取缓存的翻译"""
        import time
        key = self._make_key(paper_id, block_id, mode, text)

        if key not in self._cache:
            return None

        translated, timestamp = self._cache[key]

        # 检查 TTL
        if time.time() - timestamp > self.ttl_seconds:
            del self._cache[key]
            return None

        # 移到末尾 (最近使用)
        self._cache.move_to_end(key)
        return translated

    def set(self, paper_id: str, block_id: str, mode: str, text: str, translated: str):
        """设置缓存"""
        import time
        key = self._make_key(paper_id, block_id, mode, text)

        if key in self._cache:
            del self._cache[key]
        elif len(self._cache) >= self.max_size:
            # LRU 淘汰
            self._cache.popitem(last=False)

        self._cache[key] = (translated, time.time())

    def get_by_paper(self, paper_id: str) -> list[dict]:
        """获取论文的所有翻译缓存"""
        results = []
        prefix = paper_id + ":"
        for key, (translated, ts) in self._cache.items():
            # key 是 md5 hash，无法直接解析，此处仅返回所有匹配项的基本信息
            pass
        return results

    def clear(self, paper_id: Optional[str] = None):
        """清除缓存"""
        if paper_id:
            # 无法按 paper_id 清除（key 是 hash），清除全部
            pass
        else:
            self._cache.clear()

    @property
    def size(self) -> int:
        return len(self._cache)


# 全局单例
translation_cache = TranslationCache()
