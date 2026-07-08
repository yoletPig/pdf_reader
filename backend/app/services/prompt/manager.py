"""Prompt 管理器 - 三层架构"""
from typing import Optional
from dataclasses import dataclass
from app.services.prompt.variables import VariableInjector
from app.services.prompt.versioning import PromptVersionManager, PromptVersion, version_manager


@dataclass
class ChatMessage:
    """Chat 消息"""
    role: str  # system / user / assistant
    content: str


@dataclass
class PromptTemplate:
    """Prompt 模板"""
    id: str
    agent_mode: str
    layer: str  # system / task / user
    name: str
    content: str
    version: int = 1
    is_active: bool = True


# 内置 Prompt 模板
BUILTIN_TEMPLATES: dict[str, dict[str, str]] = {
    "system": {
        "quick_translate": """你是一位精通中英学术翻译的专家。
规则：
1. 保持学术术语的英文原文，首次出现时在译文后括号标注
2. 译文流畅自然，符合中文阅读习惯
3. 输出必须是干净的 Markdown，不要输出额外解释、前言或结尾
4. 如果原文有列表、层次、标题，请用 Markdown 标题、列表、引用块重建结构
5. 数学公式、变量名保持原样；行间公式统一写成 $$...$$，行内公式统一写成 $...$
6. 不要输出裸的 \\begin{{...}}...\\end{{...}} 或孤立的 \\tag{{...}}；块级公式必须整体放在 $$...$$ 内
7. 如果公式因 PDF/OCR 轻微断裂，但能明显看出原意，可做最小幅度整理；不能确定时保留原状
8. 速度优先，不过度润色""",

        "polish_translate": """你是一位资深的学术论文翻译专家，专注于高质量中英翻译。
规则：
1. 避免逐词直译，采用意译策略，确保译文符合中文学术论文的表达规范
2. 严格维护术语一致性，参考提供的术语表
3. 长句拆分、被动句转主动、保持逻辑连贯
4. 输出必须是结构清晰的 Markdown，不要输出额外解释、前言或结尾
5. 如果原文存在标题、列表、定义、结论，请显式重建为 Markdown 结构
6. 数学符号、公式、引用编号保持原样；行间公式统一写成 $$...$$，行内公式统一写成 $...$
7. 不要输出裸的 \\begin{{...}}...\\end{{...}} 或孤立的 \\tag{{...}}；块级公式必须整体放在 $$...$$ 内
8. 对明显错位或断裂的公式进行最小幅度重排，使其更接近可读表达；不能确定时不要臆造
9. 译文应达到可直接收录中文学术期刊的水准""",

        "concept_explain": """你是一位学术导师，擅长用深入浅出的方式解释复杂学术概念。
规则：
1. 先给出一句话简明解释
2. 再给出详细解读，结合论文上下文
3. 如有必要，提供类比或示例
4. 标注相关的前置知识和延伸阅读方向""",

        "cross_qa": """你是一位跨论文学术研究助手，可以访问用户上传的所有论文知识库。
规则：
1. 基于提供的论文内容回答问题，不编造信息
2. 引用来源时标注论文标题和页码
3. 如果涉及多篇论文的对比，用对比结构呈现
4. 回答应有深度，体现学术分析能力""",

        "summary": """你是一位学术论文审稿专家，擅长快速提炼论文要点。
规则：
1. 结构化输出：背景→问题→方法→贡献→局限性
2. 突出创新点和核心贡献
3. 语言简洁，避免冗余
4. 适合研究人员快速了解论文价值""",
    },
    "task": {
        "translate_paragraph": """请翻译以下学术段落。

输出要求：
1. 仅返回 Markdown 正文
2. 不要解释你的翻译策略
3. 如果内容中包含公式，使用 $$...$$ 或 $...$ 标记
4. 不要输出裸的 \\begin{{...}}...\\end{{...}} 或单独的 \\tag{{...}}；块级公式统一包在 $$...$$ 中
5. 如果内容天然带有并列关系或步骤关系，可以整理为 Markdown 列表

原文：
{text}

上下文：
{context}

术语表：
{terminology}""",
        "translate_sentence": """请翻译以下学术句子。

输出要求：
1. 仅返回 Markdown 正文
2. 如果句中包含公式，使用 $...$ 或 $$...$$ 标记
3. 不要输出裸的 \\begin{{...}}...\\end{{...}} 或单独的 \\tag{{...}}
4. 保留变量名、符号、编号

原文：
{text}""",
        "explain_term": "请解释以下学术术语在本论文语境中的含义：\n\n术语：{term}\n所在段落：{paragraph}\n论文主题：{paper_topic}",
        "explain_paragraph": "请解读以下学术段落：\n\n{text}\n\n论文主题：{paper_topic}",
        "cross_paper_qa": "基于以下论文内容回答用户问题：\n\n{context}\n\n问题：{question}",
        "summarize_section": "请总结以下章节内容：\n\n{text}",
        "summarize_paper": "请总结以下论文：\n\n标题：{paper_title}\n摘要：{paper_abstract}\n\n要求：{requirements}",
    },
}


class PromptManager:
    """Prompt 管理器 - 三层 Prompt 架构"""

    def __init__(self):
        self._templates: dict[str, PromptTemplate] = {}
        self.version_manager = version_manager
        self._load_builtin_templates()

    def _load_builtin_templates(self):
        """加载内置模板"""
        for layer, templates in BUILTIN_TEMPLATES.items():
            for name, content in templates.items():
                template_id = f"builtin_{layer}_{name}"
                self._templates[template_id] = PromptTemplate(
                    id=template_id,
                    agent_mode=name.split("_")[0] if "_" in name else name,
                    layer=layer,
                    name=name,
                    content=content,
                    version=1,
                    is_active=True,
                )
                self.version_manager.add_version(template_id, content, "内置初始版本")

    def build_prompt(
        self,
        mode: str,
        task: str,
        variables: dict,
        user_overrides: Optional[str] = None,
        paper_metadata: Optional[dict] = None,
        terminology: Optional[dict] = None,
    ) -> list[ChatMessage]:
        """构建完整的 Prompt 消息列表"""
        messages: list[ChatMessage] = []

        # 1. System 层
        system_template_id = f"builtin_system_{mode}"
        system_template = self._templates.get(system_template_id)
        if system_template and system_template.is_active:
            system_content = VariableInjector.inject(
                system_template.content,
                variables,
                paper_metadata=paper_metadata,
                terminology=terminology,
            )
            # 注入用户自定义规则
            if user_overrides:
                system_content += f"\n\n用户补充规则：\n{user_overrides}"
            messages.append(ChatMessage(role="system", content=system_content))

        # 2. Task 层
        task_template_id = f"builtin_task_{task}"
        task_template = self._templates.get(task_template_id)
        if task_template and task_template.is_active:
            task_content = VariableInjector.inject(
                task_template.content,
                variables,
                paper_metadata=paper_metadata,
                terminology=terminology,
            )
            messages.append(ChatMessage(role="user", content=task_content))

        return messages

    def list_templates(self) -> list[PromptTemplate]:
        """获取所有模板列表"""
        return list(self._templates.values())

    def get_template(self, template_id: str) -> Optional[PromptTemplate]:
        """获取指定模板"""
        return self._templates.get(template_id)

    def update_template(self, template_id: str, content: str, change_note: str = "") -> Optional[PromptTemplate]:
        """更新模板内容（创建新版本）"""
        template = self._templates.get(template_id)
        if not template:
            return None

        new_version = self.version_manager.add_version(template_id, content, change_note)
        template.content = content
        template.version = new_version.version
        return template

    def revert_template(self, template_id: str, target_version: int) -> Optional[PromptTemplate]:
        """回退模板到指定版本"""
        template = self._templates.get(template_id)
        if not template:
            return None

        reverted = self.version_manager.revert(template_id, target_version)
        if reverted:
            template.content = reverted.content
            template.version = reverted.version
            return template
        return None

    def get_template_versions(self, template_id: str) -> list[PromptVersion]:
        """获取模板版本历史"""
        return self.version_manager.get_history(template_id)


# 全局单例
prompt_manager = PromptManager()
