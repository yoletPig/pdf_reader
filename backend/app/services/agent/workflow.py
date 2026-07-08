"""Agent 工作流定义"""
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class WorkflowType(str, Enum):
    SEQUENTIAL = "sequential"  # 串行
    PARALLEL = "parallel"      # 并行


@dataclass
class WorkflowStep:
    """工作流步骤"""
    agent_name: str
    params: dict = field(default_factory=dict)
    depends_on: Optional[str] = None  # 依赖的步骤名


@dataclass
class Workflow:
    """Agent 工作流"""
    name: str
    description: str
    workflow_type: WorkflowType = WorkflowType.SEQUENTIAL
    steps: list[WorkflowStep] = field(default_factory=list)


# 预定义工作流
PREDEFINED_WORKFLOWS = {
    "translate_and_explain": Workflow(
        name="translate_and_explain",
        description="先翻译，再解释关键术语",
        workflow_type=WorkflowType.SEQUENTIAL,
        steps=[
            WorkflowStep(agent_name="quick_translate", params={}),
            WorkflowStep(agent_name="concept_explain", params={}, depends_on="quick_translate"),
        ],
    ),
    "deep_read": Workflow(
        name="deep_read",
        description="深度阅读：翻译 + 解释 + 总结",
        workflow_type=WorkflowType.SEQUENTIAL,
        steps=[
            WorkflowStep(agent_name="polish_translate", params={}),
            WorkflowStep(agent_name="concept_explain", params={}, depends_on="polish_translate"),
            WorkflowStep(agent_name="summary", params={}, depends_on="concept_explain"),
        ],
    ),
}
