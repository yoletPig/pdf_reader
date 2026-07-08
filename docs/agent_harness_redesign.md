# PDF Reader Agent Harness 重设计方案

本文面向“跳槽项目打磨”重新设计 `pdf_reader` 后端。目标不是把现有功能名字堆得更多，而是让项目体现完整的工程能力：Agent 运行时、工具调用、RAG、状态管理、事件流、可观测性、评测和可演示闭环。

## 1. 当前问题判断

当前项目的基础方向是对的，但作为作品集项目会显得不够扎实，主要问题在这些地方：

1. Agent 只是“意图到类的分发”，没有真正的 Agent 运行时。
2. RAG、搜索、解释、笔记等模块有设计痕迹，但 API 和 Service 没有完整闭环。
3. PDF 解析结果主要在内存，服务重启后阅读上下文不可恢复。
4. 上传论文没有自动完成解析、分块、索引、状态更新。
5. 缺少任务事件流、Trace、工具调用记录，难以展示复杂 Agent 的执行过程。
6. 缺少评测集和可重复测试，面试时很难证明“效果可靠”。

所以重构方向应从“多个 Agent 类”升级为“Agent Harness”。Harness 是统一的任务运行框架，Agent 只是其中一种可插拔策略。

## 2. 新项目定位

推荐把项目定位为：

> 面向学术论文阅读的 Agentic Research Workspace：支持论文摄入、结构化解析、混合检索、上下文问答、术语解释、翻译润色、阅读笔记生成，并提供可追踪、可评测的 Agent 运行框架。

这个定位比“PDF 阅读器 + 翻译”更适合跳槽项目，因为它能展示：

- 后端架构设计能力
- RAG 工程能力
- Agent 工程能力
- 异步任务与事件流能力
- LLM 应用可靠性设计
- 前后端产品闭环能力

## 3. Harness 核心思想

旧结构：

```text
IntentEngine -> AgentOrchestrator -> SomeAgent.execute()
```

新结构：

```text
API -> AgentRunService -> AgentHarness -> Planner -> Tool Loop -> Verifier -> Response
                                      |              |
                                      |              -> Tools: PDF / RAG / Search / Notes / Translation / LLM
                                      -> Event Stream / Trace / Run Store / Eval Hooks
```

Agent Harness 要负责这些通用能力：

- 创建一次 `run`
- 加载上下文
- 选择 agent profile
- 规划步骤
- 调用工具
- 管理中间状态
- 生成结构化事件
- 保存 trace
- 输出最终结果
- 支持 replay 和 eval

Agent 本身只负责策略：

- 这个任务该如何思考
- 可用哪些工具
- 最终输出格式是什么
- 如何判断结果是否合格

## 4. 推荐后端目录结构

建议在 `backend/app/services/agent_harness/` 下新建运行时，不要直接在旧 `services/agent/` 上继续堆代码。

```text
backend/app/
├── api/
│   ├── agent_runs.py              # 新 Agent Run API
│   ├── papers.py
│   ├── rag.py
│   └── ...
├── services/
│   ├── agent_harness/
│   │   ├── runtime.py             # AgentHarness 主运行时
│   │   ├── run_service.py         # 应用层入口，负责 DB / SSE / 权限
│   │   ├── registry.py            # Agent / Tool 注册中心
│   │   ├── context.py             # RunContext / PaperContext / UserContext
│   │   ├── events.py              # 事件模型
│   │   ├── state.py               # run 状态机
│   │   ├── planner.py             # 任务规划
│   │   ├── verifier.py            # 输出校验与引用校验
│   │   ├── traces.py              # trace 记录与 replay
│   │   ├── schemas.py             # Pydantic 输入输出协议
│   │   ├── agents/
│   │   │   ├── base.py
│   │   │   ├── paper_qa.py
│   │   │   ├── deep_read.py
│   │   │   ├── translate.py
│   │   │   ├── literature_search.py
│   │   │   └── note_writer.py
│   │   └── tools/
│   │       ├── base.py
│   │       ├── pdf_tools.py
│   │       ├── rag_tools.py
│   │       ├── search_tools.py
│   │       ├── note_tools.py
│   │       ├── translation_tools.py
│   │       └── citation_tools.py
│   ├── ingestion/
│   │   ├── pipeline.py            # 论文摄入闭环
│   │   ├── jobs.py                # 后台任务
│   │   └── status.py
│   ├── rag/
│   ├── pdf/
│   ├── llm/
│   └── prompt/
├── models/
│   ├── agent_run.py
│   ├── agent_event.py
│   ├── paper_chunk.py
│   ├── citation.py
│   └── ...
└── database.py
```

旧 `services/agent/` 可以先保留，但逐步迁移为 `agent_harness/agents/` 下的 profile。

## 5. 核心抽象

### 5.1 AgentProfile

Agent 不再只是一个类，而是一个 profile：

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
PaperQAAgent = AgentProfile(
    name="paper_qa",
    description="基于当前论文或论文库回答问题，必须给出引用",
    system_prompt_key="agent.paper_qa.system",
    allowed_tools=[
        "rag.retrieve",
        "pdf.get_blocks",
        "citation.verify",
        "llm.summarize",
    ],
    output_schema=PaperQAAnswer,
    require_citations=True,
)
```

这样面试时可以解释：Agent 是可配置能力单元，Harness 统一管理执行。

### 5.2 Tool

工具必须有稳定协议，不能让 Agent 直接 import service 随便调用。

```python
class ToolSpec(BaseModel):
    name: str
    description: str
    input_schema: type[BaseModel]
    output_schema: type[BaseModel]
    timeout_seconds: int = 30


class BaseTool(ABC):
    spec: ToolSpec

    @abstractmethod
    async def run(self, input: BaseModel, ctx: RunContext) -> BaseModel:
        ...
```

推荐第一批工具：

| Tool | 职责 |
| --- | --- |
| `pdf.parse` | 解析 PDF 并返回结构化页面 / 文本块 |
| `pdf.get_blocks` | 获取指定论文、页码、章节的文本块 |
| `rag.index_paper` | 将论文切块并写入检索索引 |
| `rag.retrieve` | 混合检索相关 chunk |
| `citation.verify` | 检查回答引用是否能对应到真实 chunk |
| `translate.text` | 翻译文本并使用术语表 |
| `search.literature` | 多源论文检索 |
| `notes.create` | 生成或保存结构化笔记 |

### 5.3 RunContext

所有 Agent 执行共享统一上下文：

```python
class RunContext(BaseModel):
    run_id: str
    session_id: str
    user_id: str | None = None
    paper_id: str | None = None
    selected_text: str | None = None
    selected_block_id: str | None = None
    current_page: int | None = None
    conversation_id: str | None = None
    metadata: dict = {}
```

这样翻译、问答、解释、笔记都能拿到同一套上下文，不需要 API 层到处拼 dict。

### 5.4 AgentEvent

Agent Harness 必须输出事件流。这个是项目高级感的关键。

```python
class AgentEvent(BaseModel):
    id: str
    run_id: str
    type: Literal[
        "run_started",
        "plan_created",
        "tool_started",
        "tool_finished",
        "llm_started",
        "llm_delta",
        "citation_checked",
        "run_finished",
        "run_failed",
    ]
    timestamp: datetime
    payload: dict
```

前端可以展示：

- Agent 当前在做什么
- 调用了哪些工具
- 检索到了哪些来源
- 最终引用是否通过校验

这比单纯返回一段文本更有说服力。

## 6. 新核心流程

### 6.1 论文摄入流程

```text
Upload PDF
  -> create Paper(status=uploaded)
  -> enqueue ingestion job
  -> parse PDF
  -> persist pages / blocks / sections
  -> chunk paper
  -> build BM25 index
  -> build vector index
  -> extract terms / citations
  -> Paper(status=indexed)
```

对应状态：

```text
uploaded -> parsing -> parsed -> indexing -> indexed -> failed
```

这条链路必须打通，否则后面的 RAG 和 Agent 都会显得像空架子。

### 6.2 阅读问答流程

```text
POST /api/agent-runs
  input: question + paper_id
  agent: paper_qa

AgentHarness
  -> load PaperContext
  -> plan: retrieve -> answer -> verify citations
  -> rag.retrieve
  -> llm.chat
  -> citation.verify
  -> persist answer + events
  -> return run_id + final answer
```

### 6.3 深度阅读流程

深度阅读是最适合作为演示的 Agent 工作流。

输入：当前论文、当前页或选中段落。

输出：

- 中文精读翻译
- 关键概念解释
- 方法 / 实验 / 贡献总结
- 可保存为笔记的结构化结果

流程：

```text
pdf.get_blocks
  -> translate.text
  -> rag.retrieve_related_context
  -> llm.extract_key_terms
  -> llm.generate_deep_read_note
  -> notes.create
```

## 7. 推荐 Agent 设计

不要保留现在“6 个按钮对应 6 个 Agent”的设计。建议改成 5 个高价值 Agent。

| Agent | 面试价值 | 核心能力 |
| --- | --- | --- |
| `paper_qa` | RAG + 引用校验 | 当前论文 / 跨论文问答，返回来源 |
| `deep_read` | 工作流编排 | 翻译、解释、总结、笔记一条链 |
| `translate` | LLM 产品细节 | 术语一致性、缓存、上下文翻译 |
| `literature_search` | 外部工具调用 | arXiv / Semantic Scholar / CrossRef 聚合检索 |
| `research_map` | 高级展示 | 从多篇论文抽取方法、数据集、指标，生成研究脉络 |

其中 `paper_qa` 和 `deep_read` 必须做扎实，它们最容易打动面试官。

## 8. API 重新设计

保留现有 API，同时新增一组 Agent Run API。

```text
POST   /api/agent-runs
GET    /api/agent-runs/{run_id}
GET    /api/agent-runs/{run_id}/events
GET    /api/agent-runs/{run_id}/stream
POST   /api/agent-runs/{run_id}/cancel
POST   /api/agent-runs/{run_id}/replay
```

创建 run：

```json
{
  "agent": "paper_qa",
  "input": {
    "question": "这篇论文的核心贡献是什么？",
    "paper_id": "paper_123"
  },
  "context": {
    "current_page": 3,
    "selected_text": ""
  }
}
```

返回：

```json
{
  "run_id": "run_123",
  "status": "completed",
  "answer": {
    "content": "这篇论文的核心贡献包括...",
    "citations": [
      {
        "paper_id": "paper_123",
        "page": 4,
        "chunk_id": "chunk_456",
        "quote": "..."
      }
    ]
  },
  "trace_summary": {
    "tool_calls": 3,
    "llm_calls": 1,
    "tokens": 3120,
    "duration_ms": 8500
  }
}
```

## 9. 数据模型补强

建议新增这些表：

```text
agent_runs
agent_events
paper_pages
paper_blocks
paper_chunks
paper_terms
citations
conversation_messages
eval_cases
eval_runs
```

核心表职责：

| 表 | 用途 |
| --- | --- |
| `agent_runs` | 一次 Agent 执行的总记录 |
| `agent_events` | 工具调用、LLM 调用、状态变化事件 |
| `paper_blocks` | 持久化 PDF 解析块，替代纯内存缓存 |
| `paper_chunks` | RAG 检索 chunk |
| `citations` | 回答引用和 chunk 的对应关系 |
| `eval_cases` | 固定评测问题 |
| `eval_runs` | 评测结果和指标 |

## 10. RAG 重新设计

当前 RAG 代码应收敛为一个稳定协议：

```python
class RAGService:
    async def index_paper(self, paper_id: str) -> IndexResult:
        ...

    async def retrieve(
        self,
        query: str,
        scope: RetrievalScope,
        top_k: int = 8,
    ) -> list[RetrievedChunk]:
        ...

    async def answer(
        self,
        question: str,
        scope: RetrievalScope,
        require_citations: bool = True,
    ) -> RAGAnswer:
        ...
```

检索策略：

```text
query rewrite
  -> BM25 top 30
  -> vector top 30
  -> section / paper filters
  -> RRF fusion
  -> optional rerank
  -> context packing
```

输出必须包含：

- `chunk_id`
- `paper_id`
- `page`
- `section_title`
- `score`
- `text`

没有这些字段，引用校验和前端来源跳转都做不稳。

## 11. Prompt 与输出协议

Prompt 不应只作为字符串模板存在。建议每个 Agent 配套：

- system prompt
- tool policy
- output schema
- verifier
- eval cases

例如 `paper_qa`：

```text
prompts/
├── paper_qa.system.md
├── paper_qa.answer_schema.json
├── paper_qa.verifier.md
└── paper_qa.eval.yaml
```

输出统一结构：

```python
class CitedAnswer(BaseModel):
    answer: str
    citations: list[CitedSource]
    confidence: float
    limitations: list[str] = []
```

这能避免 LLM 随便输出一大段无法消费的文本。

## 12. 可观测性与评测

作为跳槽项目，建议必须做一个简单但真实的评测面板。

### 12.1 Trace

每次 Agent run 展示：

- 使用哪个 Agent
- 规划了哪些步骤
- 调用了哪些工具
- 每个工具耗时
- LLM token 用量
- 检索来源
- 引用校验结果

### 12.2 Eval

先做 10 个固定问题即可：

```yaml
- id: qa_contribution
  agent: paper_qa
  question: "这篇论文的核心贡献是什么？"
  expected_sources:
    - section: "Introduction"
    - section: "Conclusion"
  checks:
    - has_citation
    - cites_existing_chunk
    - answer_not_empty
```

评测指标不需要一开始很复杂，先做：

- 是否有引用
- 引用是否存在
- 回答是否为空
- 检索 top-k 是否命中目标章节
- 平均耗时
- 平均 token

这已经能明显拉开和普通 Demo 的差距。

## 13. 前端展示建议

前端不需要大改成花哨页面，重点做一个“Agent 执行过程可见”的工作台。

推荐三个主视图：

| 视图 | 价值 |
| --- | --- |
| 阅读工作台 | 左 PDF，右 Agent 面板，支持选中文本深读 |
| Agent Trace | 展示 run 过程、工具调用、来源引用 |
| Evaluation | 展示固定评测问题和运行结果 |

阅读页右侧 Agent 面板可以显示：

```text
用户问题
Agent plan
Tool calls
Retrieved sources
Final answer
Save as note
```

这个展示方式比“聊天框返回一句话”更工程化。

## 14. 分阶段落地路线

### Phase 1：打通论文摄入闭环

目标：上传 PDF 后可以稳定查询文本块和 RAG chunk。

任务：

- 新增 `paper_blocks` / `paper_chunks` 表
- 上传后触发 ingestion pipeline
- PDF 解析结果持久化
- RAG index 接口签名统一
- `Paper.is_indexed` 和状态字段真实更新

验收：

- 上传 PDF 后，刷新服务仍能读取 blocks
- RAG retrieve 能返回带页码和 chunk_id 的结果

### Phase 2：建立 Agent Harness 最小闭环

目标：用 `paper_qa` 跑通一次完整 run。

任务：

- 新增 `AgentHarness`
- 新增 `ToolRegistry`
- 新增 `AgentRun` / `AgentEvent` 模型
- 实现 `rag.retrieve` 和 `citation.verify` 两个工具
- 新增 `/api/agent-runs`

验收：

- 提问后能看到事件流
- 最终回答带真实引用
- 数据库中保存 run 和 events

### Phase 3：实现 Deep Read 工作流

目标：选中一段论文文本，生成可保存的深读笔记。

任务：

- 实现 `deep_read` agent
- 接入 `translate.text`
- 接入 `notes.create`
- 输出结构化深读笔记

验收：

- 前端选中文本后可触发深读
- 输出包含翻译、术语解释、方法总结、延伸问题
- 可以一键保存为笔记

### Phase 4：补评测与展示

目标：让项目变成能讲清楚可靠性的作品。

任务：

- 新增 eval cases
- 新增 eval runner
- 新增 trace 页面
- 新增 token / latency / citation pass rate 统计

验收：

- 可以一键跑 10 个评测问题
- 能看到每次 run 的工具调用与引用校验结果

## 15. 面试讲法

你可以这样介绍这个项目：

> 我把它设计成一个面向论文阅读的 Agent Harness，而不是普通聊天应用。核心是把 Agent 执行抽象成 run，每次 run 都有上下文、工具调用、事件流、trace 和引用校验。RAG 不是简单拼 prompt，而是通过 PDF 结构化解析、chunk 持久化、混合检索、引用验证来保证回答可追溯。前端不仅展示答案，还展示 Agent 的执行过程和评测结果。

这个讲法能覆盖：

- Agent runtime
- Tool calling
- RAG
- Observability
- Evaluation
- Product thinking

## 16. 近期最值得做的 5 件事

1. 修正 RAG API 和 RAGService 的接口漂移。
2. 上传 PDF 后自动解析并持久化 `paper_blocks`。
3. 新建 `agent_runs` 和 `agent_events`，先跑通 `paper_qa`。
4. 给回答增加真实 citation，做最小引用校验。
5. 前端加一个 Agent Trace 面板，把工具调用过程展示出来。

只要这 5 件事完成，项目质感会明显提升。
