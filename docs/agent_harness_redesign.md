# PDF Reader Agent Harness 设计文档

本文基于当前 `pdf_reader` 项目和对话讨论，重新整理 Agent Harness 的设计方向。目标不是把“翻译、检索、对话”重新命名成 Agent，而是把项目升级成一个能体现 Agent 工程能力的论文阅读工作台：有工具调用、有循环控制、有状态、有事件、有引用、有评测。

## 1. 设计判断

当前项目已经具备论文阅读产品的基础能力：

- 论文上传、缓存 PDF、数据库持久化
- PDF 元数据提取、标题与摘要回填
- 全文翻译、划词翻译
- 论文画像
- arXiv 检索、URL 下载入库
- Paper QA 对话
- 初版 `agent_harness`、`agent_runs`、`agent_events`

但从 Agent 项目角度看，核心问题仍然是：

- 很多功能仍是“一次输入 -> 一次调用 -> 一次输出”。
- `paper_qa` 已有 tool 调用和事件记录，但还不是通用 ReAct / tool loop。
- 工具注册、错误恢复、上下文压缩、终止条件、评测和 Trace 展示还不完整。
- 前端已经能展示 QA 和来源，但还没有展示 Agent 的完整执行过程。

因此，下一阶段重点不是继续增加按钮，而是把现有能力放进一个稳定的 Agent Harness 中。

## 2. 核心概念

### 2.1 Agent 与普通 LLM 功能的区别

普通 LLM 功能通常是：

```text
用户输入 -> 拼 prompt -> LLM 输出
```

Agent 应该是：

```text
用户目标 -> 规划 / 判断 -> 调工具 -> 观察结果 -> 继续判断 -> 输出
```

也就是说，Agent 的关键不是“有聊天框”，而是它能在多步任务里自己决定下一步动作，并能根据中间结果修正路径。

### 2.2 Loop Engineering

Loop Engineering 是把 ReAct 循环作为工程对象来设计。基础循环很简单：

```text
LLM decision -> tool call -> observation -> next LLM decision -> final answer
```

但要能稳定运行，需要补齐这些能力：

- 终止条件：最大步数、重复工具调用检测、成本阈值、空结果提前结束。
- 上下文管理：滑动窗口、历史摘要、工具结果压缩、来源去重。
- 错误恢复：工具失败后的重试、降级、把错误反馈给 LLM 重新规划。
- 并发策略：检索类工具可以并行，写入类工具默认串行。
- 预算控制：token、耗时、工具调用次数都需要可记录和可限制。

### 2.3 Harness

Harness 是包住 Agent loop 的运行环境。它的核心是：

> 让 LLM 的每一步决策，都在可控、可观测、可纠错的边界内执行。

落到工程上就是三件事：

- 约束：工具 schema、权限边界、上下文范围、输出格式。
- 兜底：超时、重试、降级、失败事件、人工确认。
- 可见：run、event、trace、tool latency、citation check、eval 指标。

Loop 决定 Agent 如何“思考-行动”，Harness 决定这个过程能不能被信任。

## 3. 当前代码现状

当前已经落地的最小闭环：

```text
POST /api/agent-runs
  -> AgentRunService.create_run
  -> AgentRun(status=running)
  -> emit run_started
  -> AgentHarnessRuntime.run
  -> PaperQAAgent.run
  -> rag.retrieve
  -> llm.chat
  -> citation.verify
  -> AgentRun(status=completed)
  -> AgentEvent persist
  -> response(answer + sources + trace_summary)
```

对应文件：

| 模块 | 当前职责 |
| --- | --- |
| `backend/app/api/agent_runs.py` | 创建 run、查询 run、查询 events |
| `backend/app/services/agent_harness/run_service.py` | run 生命周期、会话历史、事件持久化 |
| `backend/app/services/agent_harness/runtime.py` | runtime 入口，按 agent 名称执行 |
| `backend/app/services/agent_harness/registry.py` | 注册 `paper_qa`、`rag.retrieve`、`citation.verify` |
| `backend/app/services/agent_harness/agents/paper_qa.py` | 当前 Paper QA 策略 |
| `backend/app/services/agent_harness/tools/rag_tools.py` | 基于 `paper_chunks` 的最小检索 |
| `backend/app/services/agent_harness/tools/citation_tools.py` | 最小引用校验 |
| `backend/app/models/agent_run.py` | run 总记录 |
| `backend/app/models/agent_event.py` | run 事件记录 |

当前这版已经比普通 QA 多了几个重要特征：

- 有 run ID 和状态。
- 有 session 维度的短期历史。
- 有工具事件。
- 有来源引用。
- 有 trace summary。

但还缺真正的通用 tool loop。现在 `paper_qa` 是固定顺序：

```text
retrieve -> answer -> verify
```

下一步要把它升级成可配置、可终止、可恢复的 loop。

## 4. 目标架构

推荐目标结构：

```text
API
  -> AgentRunService
    -> AgentHarnessRuntime
      -> AgentProfile
      -> Planner / Tool Loop
      -> Tool Registry
      -> Verifier
      -> Event Store
      -> Response
```

目标目录：

```text
backend/app/services/agent_harness/
├── runtime.py
├── run_service.py
├── registry.py
├── context.py
├── events.py
├── planner.py
├── loop.py
├── verifier.py
├── traces.py
├── schemas.py
├── agents/
│   ├── base.py
│   ├── paper_qa.py
│   ├── deep_read.py
│   ├── literature_search.py
│   └── note_writer.py
└── tools/
    ├── base.py
    ├── rag_tools.py
    ├── citation_tools.py
    ├── pdf_tools.py
    ├── search_tools.py
    ├── translation_tools.py
    └── note_tools.py
```

当前已有的 `runtime.py`、`run_service.py`、`registry.py`、`context.py`、`paper_qa.py`、`rag_tools.py`、`citation_tools.py` 可以保留并逐步增强。

## 5. 核心抽象

### 5.1 AgentProfile

后续不要让每个 Agent 只是一个随意实现的类，而应有稳定 profile：

```python
class AgentProfile(BaseModel):
    name: str
    description: str
    system_prompt_key: str
    allowed_tools: list[str]
    output_schema: type[BaseModel]
    max_steps: int = 8
    require_citations: bool = False
```

示例：

```python
PaperQAProfile = AgentProfile(
    name="paper_qa",
    description="基于论文上下文回答问题，必须返回可追溯来源",
    system_prompt_key="agent.paper_qa.system",
    allowed_tools=["rag.retrieve", "citation.verify"],
    output_schema=PaperQAAnswer,
    max_steps=4,
    require_citations=True,
)
```

### 5.2 Tool

工具需要稳定协议，不应该让 Agent 直接 import service 随意调用。

当前 `BaseTool` 只有：

```python
class BaseTool(ABC):
    name: str

    @abstractmethod
    async def run(self, tool_input: dict, ctx: RunContext) -> dict:
        ...
```

下一步建议升级为：

```python
class ToolSpec(BaseModel):
    name: str
    description: str
    input_schema: type[BaseModel]
    output_schema: type[BaseModel]
    timeout_seconds: int = 30
    retryable: bool = True


class BaseTool(ABC):
    spec: ToolSpec

    @abstractmethod
    async def run(self, tool_input: BaseModel, ctx: RunContext) -> BaseModel:
        ...
```

优先补齐的工具：

| Tool | 状态 | 职责 |
| --- | --- | --- |
| `rag.retrieve` | 已有最小版 | 从 `paper_chunks` 检索相关 chunk |
| `citation.verify` | 已有最小版 | 校验来源字段完整性，后续校验引用是否真支持答案 |
| `pdf.get_blocks` | 待实现 | 获取指定页、章节、选区附近文本块 |
| `search.literature` | 待实现 | 包装 arXiv / URL 导入 / 后续多源搜索 |
| `translate.text` | 待实现 | 复用翻译服务，支持术语和上下文 |
| `notes.create` | 待实现 | 保存结构化阅读笔记 |

### 5.3 RunContext

当前 `RunContext` 已经包含：

```python
class RunContext(BaseModel):
    run_id: str
    session_id: str = "default"
    paper_id: str | None = None
    current_page: int | None = None
    selected_text: str | None = None
    metadata: dict = {}
```

下一步建议补：

```python
selected_block_id: str | None = None
user_id: str | None = None
conversation_id: str | None = None
budget: RunBudget | None = None
permissions: dict = {}
```

这样同一个 harness 可以支撑单论文 QA、跨论文 QA、深读、自动调研。

### 5.4 AgentEvent

当前事件类型包括：

```text
run_started
tool_started
tool_finished
llm_started
citation_checked
run_finished
run_failed
```

建议扩展为：

```text
plan_created
tool_failed
llm_finished
context_compacted
retry_scheduled
budget_exceeded
human_approval_required
run_cancelled
```

前端 Trace 面板应该直接消费这些事件。

## 6. 关键流程

### 6.1 论文摄入闭环

当前已经完成大部分闭环：

```text
Upload / URL Import
  -> create Paper
  -> extract title / abstract / pdf_metadata
  -> parse PDF
  -> persist paper_blocks
  -> persist paper_chunks
  -> mark Paper.is_indexed
```

后续增强：

- 增加 ingestion 状态字段，而不仅是 `is_indexed`。
- 增加失败原因和可重试入口。
- chunk 生成后建立 BM25 / vector 双索引。
- 标题、摘要、作者、年份作为可检索 metadata。

### 6.2 Paper QA 流程

当前流程：

```text
question + context
  -> load conversation history
  -> load paper title / abstract / ai_summary
  -> rag.retrieve
  -> llm.chat
  -> citation.verify
  -> save answer and events
```

下一步目标：

```text
question
  -> plan_created
  -> loop step 1: decide retrieve / ask clarification / answer from context
  -> tool call with retry and timeout
  -> observation compaction
  -> loop step N
  -> citation.verify
  -> final answer
```

### 6.3 Deep Read 流程

这是最适合作为“Agent 感”演示的第二个工作流：

```text
selected_text / current_page
  -> pdf.get_blocks
  -> translate.text
  -> rag.retrieve related context
  -> extract key terms
  -> generate deep-read note
  -> notes.create
```

输出应包含：

- 精读翻译
- 概念解释
- 方法 / 实验 / 贡献总结
- 可继续追问的问题
- 可保存笔记

### 6.4 自主文献调研流程

这是面试展示的高级方向：

```text
research question
  -> plan search strategy
  -> search.literature
  -> import selected papers
  -> retrieve and extract claims
  -> compare methods / datasets / metrics
  -> synthesize survey
  -> cite sources
```

这个功能天然需要多步计划、工具调用、去重、信息是否足够的判断，比单轮 QA 更能体现 Agent 能力。

## 7. RAG 设计

当前 `rag.retrieve` 是基于 token overlap 的最小版本。它适合最小闭环，但还不够作为长期 RAG 能力。

目标协议：

```python
class RetrievalScope(BaseModel):
    paper_id: str | None = None
    page_range: tuple[int, int] | None = None
    source_filter: list[str] = []


class RetrievedChunk(BaseModel):
    chunk_id: str
    paper_id: str
    paper_title: str
    page: int
    section_title: str = ""
    text: str
    score: float
    retriever: str
```

目标检索链：

```text
query rewrite
  -> BM25 top 30
  -> vector top 30
  -> metadata filter
  -> RRF fusion
  -> optional rerank
  -> context packing
```

引用相关字段必须稳定包含：

- `paper_id`
- `paper_title`
- `page`
- `chunk_id`
- `chunk_text`
- `relevance_score`

前端来源跳转和引用校验都依赖这些字段。

## 8. API 设计

当前已实现：

```text
POST /api/agent-runs
GET  /api/agent-runs/{run_id}
GET  /api/agent-runs/{run_id}/events
```

创建 run：

```json
{
  "agent": "paper_qa",
  "input": {
    "question": "这篇论文的核心贡献是什么？",
    "paper_id": "paper_123",
    "top_k": 8
  },
  "context": {
    "session_id": "qa:paper_123",
    "paper_id": "paper_123",
    "current_page": 3,
    "selected_text": ""
  }
}
```

建议后续补：

```text
GET  /api/agent-runs/{run_id}/stream
POST /api/agent-runs/{run_id}/cancel
POST /api/agent-runs/{run_id}/replay
POST /api/evals/run
GET  /api/evals/{eval_run_id}
```

## 9. 数据模型

已落地：

| 表 | 用途 |
| --- | --- |
| `papers` | 论文基础信息、标题摘要、来源、索引状态 |
| `paper_blocks` | PDF 解析块 |
| `paper_chunks` | RAG chunk |
| `translation_caches` | 翻译缓存 |
| `agent_runs` | 一次 Agent 执行 |
| `agent_events` | Agent 执行事件 |

建议新增：

| 表 | 用途 |
| --- | --- |
| `paper_terms` | 术语、缩写、定义 |
| `citations` | 回答引用和 chunk 的强绑定关系 |
| `notes` | 用户保存的深读笔记 |
| `eval_cases` | 固定评测问题 |
| `eval_runs` | 评测执行结果 |
| `saved_views` | 知识库筛选视图 |

## 10. 前端设计

当前前端已经完成这些改造：

- 阅读页三栏布局：原文、全文翻译、工具栏。
- 工具栏支持论文画像、全文翻译、划词翻译、Paper QA。
- Paper QA 改为对话形式，输入框在底部，支持回车发送。
- 选中文本不直接提交，而是包裹进输入框由用户确认。
- 搜索页支持 arXiv 搜索、分页、滚动、URL 自动入库。
- 知识库页改为管理台式布局，支持检索、筛选、排序、分组、分页。

下一步前端重点是 Agent Trace：

```text
Agent 面板
  -> 当前问题
  -> plan
  -> tool calls
  -> retrieved sources
  -> citation check
  -> final answer
```

推荐把 Trace 放在阅读页第三栏的 Paper QA 面板里：

- 默认展示对话。
- 展开“执行过程”后显示 run events。
- 来源引用可以点击跳转到 PDF 页和选词翻译上下文。
- 失败时展示 tool error 和可重试按钮。

## 11. Prompt 与输出协议

Prompt 不要散落在代码字符串里。建议每个 Agent 配套：

```text
prompts/
├── paper_qa.system.md
├── paper_qa.tool_policy.md
├── paper_qa.answer_schema.json
├── paper_qa.verifier.md
└── paper_qa.eval.yaml
```

`paper_qa` 输出应稳定为：

```python
class PaperQAAnswer(BaseModel):
    content: str
    sources: list[PaperQASource]
    trace_summary: dict
```

后续可扩展：

```python
class CitedAnswer(BaseModel):
    answer: str
    citations: list[CitedSource]
    confidence: float
    limitations: list[str] = []
```

## 12. 可观测性与评测

### 12.1 Trace

每次 Agent run 应展示：

- Agent 名称
- run 状态
- 事件数量
- 工具调用次数
- LLM 调用次数
- 每个工具耗时
- 检索来源
- citation verify 结果
- 错误与重试记录

当前 `trace_summary` 已有 `event_count`、`tool_calls`、`llm_calls`。后续应补：

- `duration_ms`
- `token_usage`
- `tool_latency_ms`
- `citation_pass_rate`
- `retrieval_empty_rate`

### 12.2 Eval

先做 10 个固定问题，不需要一开始复杂：

```yaml
- id: qa_contribution
  agent: paper_qa
  question: "这篇论文的核心贡献是什么？"
  expected_sources:
    - section: "Introduction"
    - section: "Conclusion"
  checks:
    - answer_not_empty
    - has_citation
    - cites_existing_chunk
```

最小指标：

- 回答非空率
- 是否有引用
- 引用是否对应真实 chunk
- 平均工具调用次数
- 平均耗时
- 平均 token

## 13. 框架策略

结合对话里的学习目标，建议路线是：

1. 先手写 ReAct / tool loop。
2. 用项目里的论文 Agent 打磨 harness、tool、trace、eval。
3. 再学习 LangGraph，并把同一个 workflow 映射成 graph。

原因：

- 手写能讲清楚底层：工具 schema、循环、终止、错误恢复、上下文管理。
- LangGraph 适合后续做复杂状态机、可视化调试、checkpoint、replay。
- 面试时“我从零实现过 harness，再用 LangGraph 做生产化迁移”比单纯调用框架更有说服力。

CrewAI、AutoGen、OpenAI Agents SDK 可以了解，但这个项目的主线不建议一开始依赖它们。

## 14. 分阶段路线

### Phase 0：已完成的基础闭环

状态：基本完成。

- PDF 上传和缓存。
- PDF 元数据、标题、摘要提取。
- 论文摄入、blocks、chunks 持久化。
- 全文翻译、划词翻译、翻译缓存。
- 论文画像。
- arXiv 搜索、URL 导入。
- 知识库管理页。
- `paper_qa` 最小 agent run。
- `agent_runs` / `agent_events`。

### Phase 1：加固 Paper QA Harness

目标：让 `paper_qa` 从固定流程升级为可观测、可恢复的最小 Agent loop。

任务：

- 引入 `AgentProfile`。
- 引入 `ToolSpec` 和输入输出 schema。
- 为工具增加 timeout、错误事件、重试策略。
- 为 run 增加 `duration_ms`、token 统计、工具耗时。
- 前端展示 events。

验收：

- 一次 QA 可以看到完整 run events。
- 工具失败不会导致 ASGI 崩溃。
- 回答有来源，来源字段可跳转。

### Phase 2：改造 RAG

目标：让引用质量足以支撑论文问答。

任务：

- BM25 检索从当前 token overlap 升级为稳定服务。
- 加 vector retrieve。
- 做 RRF fusion。
- 做 context packing。
- citation verify 从字段检查升级为 chunk 支持性检查。

验收：

- 固定 QA 问题能命中正确章节。
- 引用不存在时能明确拒答或说明信息不足。

### Phase 3：Deep Read Agent

目标：做出最能体现产品价值的阅读型 Agent。

任务：

- `pdf.get_blocks`
- `translate.text`
- `rag.retrieve_related_context`
- `notes.create`
- 结构化 deep read 输出

验收：

- 用户选中文本后生成精读结果。
- 输出包含翻译、概念解释、方法总结、延伸问题。
- 可以保存笔记。

### Phase 4：自主文献调研 Agent

目标：体现多步计划和外部工具调用能力。

任务：

- `literature_search` profile。
- 多关键词检索策略。
- 搜索结果去重。
- 自动导入候选论文。
- 多论文比较与综述生成。

验收：

- 用户输入研究问题后，Agent 能规划检索词并返回带引用综述。
- 前端展示检索、筛选、抽取、写作过程。

### Phase 5：Eval 与展示

目标：让项目可量化、可回放、可面试演示。

任务：

- `eval_cases`
- `eval_runs`
- Agent Trace 页面
- 指标面板

验收：

- 一键跑固定评测。
- 能展示工具调用成功率、引用通过率、平均耗时。

## 15. 面试讲法

可以这样介绍：

> 这个项目不是简单的论文聊天应用。我把论文阅读能力收敛到一个 Agent Harness：每次任务都是 run，run 有上下文、工具调用、事件流、来源引用和 trace summary。当前已经实现了 Paper QA 的最小闭环，包括 RAG 检索、LLM 回答、引用校验和事件持久化。下一步会把固定流程升级成通用 tool loop，加上 timeout、重试、上下文压缩和评测，让它从 demo 变成可观察、可纠错、可评估的 Agent 系统。

重点可讲：

- 为什么 Agent 不等于聊天框。
- Harness 的核心是约束、兜底、可见。
- Loop Engineering 解决终止、上下文、错误恢复、预算。
- RAG 为什么需要持久化 chunk 和 citation verify。
- 前端为什么要展示 Trace，而不只是最终答案。

## 16. 近期优先级

接下来最值得做的 6 件事：

1. 给 `BaseTool` 增加 `ToolSpec`、timeout、输入输出 schema。
2. 给 `AgentRunService` 记录工具耗时、run 耗时、错误类型。
3. 把 `paper_qa` 改成 profile + loop 的形式。
4. 前端 Paper QA 面板增加 run event 展示。
5. 把 `rag.retrieve` 从 token overlap 升级为 BM25 + vector 混合检索。
6. 建立 10 条最小 eval cases，统计引用通过率和回答非空率。

完成这些以后，这个项目就能从“功能型论文阅读器”升级成一个可以讲深的 Agent 工程项目。
