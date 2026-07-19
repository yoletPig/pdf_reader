"""翻译服务模块"""
from app.services.translation.service import TranslationService, TranslationQualityError, translation_service
from app.services.translation.types import TranslationRequest, TranslationResult, TranslationMode, PDFBlock
from app.services.translation.terminology import TerminologyEngine, terminology_engine
from app.services.translation.cache import TranslationCache as TransCache, translation_cache

__all__ = [
    "TranslationService",
    "TranslationQualityError",
    "translation_service",
    "TranslationRequest",
    "TranslationResult",
    "TranslationMode",
    "PDFBlock",
    "TerminologyEngine",
    "terminology_engine",
    "TransCache",
    "translation_cache",
]
