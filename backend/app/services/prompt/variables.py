"""动态变量注入"""
from typing import Optional


class VariableInjector:
    """将动态变量注入 Prompt 模板"""

    DEFAULT_VARIABLES = {
        "app_name": "PDF Reader Agent",
        "language": "中文",
    }

    @classmethod
    def inject(
        cls,
        template: str,
        variables: dict,
        paper_metadata: Optional[dict] = None,
        terminology: Optional[dict] = None,
    ) -> str:
        """注入变量到模板中"""
        result = template

        # 注入默认变量
        for key, value in cls.DEFAULT_VARIABLES.items():
            placeholder = "{" + key + "}"
            if placeholder in result:
                result = result.replace(placeholder, str(value))

        # 注入用户变量
        for key, value in variables.items():
            placeholder = "{" + key + "}"
            if placeholder in result:
                result = result.replace(placeholder, str(value))

        # 注入论文元数据
        if paper_metadata:
            for key, value in paper_metadata.items():
                placeholder = "{paper_" + key + "}"
                if placeholder in result:
                    result = result.replace(placeholder, str(value))

        # 注入术语表
        if terminology:
            terms_text = "\n".join(f"- {k}: {v}" for k, v in terminology.items())
            if "{terminology}" in result:
                result = result.replace("{terminology}", terms_text)

        return result

    @classmethod
    def get_placeholders(cls, template: str) -> list[str]:
        """提取模板中的占位符变量名"""
        import re
        return re.findall(r'\{(\w+)\}', template)
