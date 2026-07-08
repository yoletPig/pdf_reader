"""实体抽取器（方法、数据集、指标）"""
import re
from typing import Optional


class EntityExtractor:
    """从论文文本中抽取方法名、数据集、指标等实体"""

    # 常见数据集名称模式
    DATASET_PATTERNS = [
        r'\b(ImageNet|CIFAR-\d+|MNIST|COCO|Pascal\s*VOC|SQuAD|GLUE|SuperGLUE|'
        r'WMT\d*|PTB|WikiText|LibriSpeech|TIMIT|Cityscapes|KITTI|'
        r'LRA|Long\s*Range\s*Arena|BigBench|MMLU|HellaSwag|'
        r'ARC|TruthfulQA|HumanEval|MBPP)\b',
    ]

    # 常见指标名称模式
    METRIC_PATTERNS = [
        r'\b(accuracy|precision|recall|F\d|BLEU|ROUGE|METEOR|'
        r'perplexity|PPL|BPC|WER|CER|mAP|IoU|'
        r'PSNR|SSIM|FID|IS|AUC|MSE|MAE|RMSE)\b',
    ]

    # 常见方法名模式（大写缩写）
    METHOD_PATTERNS = [
        r'\b[A-Z]{2,}(?:\s*[-–]\s*[A-Z]{2,})*\b',  # LSTM, BERT, GPT-3
        r'\b(?:transformer|attention|CNN|RNN|GAN|VAE|'
        r'diffusion|normalizing\s*flow|reinforcement\s*learning|'
        r'self-supervised|contrastive|federated)\b',
    ]

    def extract(self, text: str) -> dict[str, list[dict]]:
        """从文本中抽取实体"""
        entities = {
            "datasets": self._extract_patterns(text, self.DATASET_PATTERNS, "dataset"),
            "metrics": self._extract_patterns(text, self.METRIC_PATTERNS, "metric"),
            "methods": self._extract_patterns(text, self.METHOD_PATTERNS, "method"),
        }
        return entities

    def _extract_patterns(
        self,
        text: str,
        patterns: list[str],
        entity_type: str,
    ) -> list[dict]:
        """提取匹配模式的实体"""
        results = []
        seen = set()

        for pattern in patterns:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                name = match.group(0).strip()
                if name.lower() not in seen:
                    seen.add(name.lower())
                    results.append({
                        "name": name,
                        "type": entity_type,
                        "position": match.start(),
                    })

        return results

    def extract_from_abstract(self, abstract: str) -> dict[str, list[dict]]:
        """从摘要中抽取（权重更高）"""
        return self.extract(abstract)


# 全局单例
entity_extractor = EntityExtractor()
