# Backend 代码导读

本文基于 `/home/yyl/pdf_reader/backend` 当前代码整理，目标是帮助快速理解后端结构、主流程和当前实现状态。

## 1. 项目定位

这份后端是一个以 `FastAPI` 为入口的论文阅读助手，核心能力包括：

- 论文上传与本地存储
- PDF 文本块解析
- 翻译与翻译缓存
- Prompt 模板管理
- LLM 模型配置与路由
- 意图识别与 Agent 分发
- RAG / 知识库相关能力的预留与部分实现

技术栈以 `FastAPI + SQLAlchemy(Async) + SQLite + 本地文件存储` 为主，部分智能能力通过统一的 LLM Router 接外部模型。

## 2. 目录结构

```text
backend/
├── app/
│   ├── api/                # HTTP 路由层
│   ├── models/             # SQLAlchemy 数据模型
│   ├── services/           # 核心业务服务
│   ├── utils/              # 服务定位器、日志、文本工具
│   ├── config.py           # 全局配置
│   ├── database.py         # 数据库连接与会话
│   └── main.py             # FastAPI 应用入口
├── data/
│   ├── db/                 # SQLite 数据库
│   └── papers/             # 上传后的 PDF 文件
├── pyproject.toml
└── requirements.txt
```

## 3. 启动链路

入口文件是 `app/main.py`。

启动时会执行这些动作：

1. 创建数据目录：`data/`、`data/papers/`、`data/cache/`
2. 初始化数据库表：`app/database.py -> init_db()`
3. 从 `model_configs` 表读取模型配置
4. 把数据库中的模型注册到 `app.services.llm.llm_router`
5. 调用 `app.utils.service_locator.service_locator.wire_all()` 注入服务依赖
6. 注册各 API Router

这说明系统初始化的中心不是某个 DI 框架，而是一个手写的 `ServiceLocator`。

## 4. 配置与存储

### 4.1 全局配置

`app/config.py` 里的 `Settings` 管理全局配置，关键内容包括：

- 应用名、版本、调试开关
- `DATABASE_URL`
- 论文目录和缓存目录
- 向量库、Embedding、RAG 参数
- 默认 LLM 和分 Provider 的 API Key / Base URL
- CORS 配置

环境变量前缀是：

```text
PDF_READER_
```

例如：

- `PDF_READER_OPENAI_API_KEY`
- `PDF_READER_DEFAULT_LLM_MODEL`

### 4.2 数据库

`app/database.py` 使用异步 SQLAlchemy：

- `engine = create_async_engine(...)`
- `async_session_factory`
- `get_db()` 作为 FastAPI 依赖

当前默认数据库是：

```text
sqlite+aiosqlite:///./data/db/pdf_reader.db
```

### 4.3 数据模型

当前比较关键的模型有：

- `Paper`：论文基础信息、文件路径、阅读进度、是否已索引
- `ModelConfig`：模型配置、默认模型标记、用量统计
- `Note`
- `TranslationCache`
- `PromptTemplate`
- `KGEntity` / `KGRelation`
- `SearchHistory`

其中现阶段真正被主流程明显使用的是 `Paper` 和 `ModelConfig`。

## 5. 分层理解

### 5.1 API 层：`app/api/`

负责接收 HTTP 请求、做轻量参数整理、调用 service。

当前主要接口：

- `papers.py`
  - `GET /api/papers`
  - `POST /api/papers/upload`
  - `GET /api/papers/{paper_id}`
  - `DELETE /api/papers/{paper_id}`
  - `GET /api/papers/{paper_id}/file`
  - `GET /api/papers/{paper_id}/blocks`
- `translation.py`
  - `POST /api/translate`
  - `GET /api/translate/stream`
  - `GET /api/translate/cache/{paper_id}`
  - `POST /api/translate/page`
- `config.py`
  - 模型配置增删改查
  - Provider 列表
  - 模型连通性测试
- `prompts.py`
  - Prompt 列表
  - Prompt 更新 / 回退
- `intent_api.py`
  - `POST /api/intent/recognize`
- `agent_api.py`
  - `POST /api/agent/execute`
  - `GET /api/agent/stream`

另外还有 `search.py`、`explain.py`、`notes.py`、`rag.py`，但这些模块当前仍偏占位或半成品。

### 5.2 Services 层：`app/services/`

这是代码主体，按能力拆分。

#### `services/llm/`

统一模型路由层。

- `router.py` 定义 `LLMRouter`
- `adapters/` 下有 `openai`、`gemini`、`deepseek`、`custom`

职责：

- 根据 provider / model 找到适配器
- 对外提供统一 `chat()` / `stream_chat()`
- 支持从数据库配置热重载模型

这是全系统调用外部大模型的统一出口。

#### `services/translation/`

翻译服务主入口是 `translation/service.py` 的 `TranslationService`。

核心流程：

1. 根据 `paper_id + block_id + mode + text` 查缓存
2. 获取术语表
3. 通过 `PromptManager` 组装 Prompt
4. 调用 `LLMRouter`
5. 写回翻译缓存

它已经是一个相对完整的可用模块。

#### `services/prompt/`

Prompt 管理由 `prompt/manager.py` 负责。

当前设计是两层真正生效：

- system 层
- task 层

能力包括：

- 内置 Prompt 模板
- 变量注入
- 用户覆盖规则
- 版本历史管理
- 模板更新和回滚

这部分是翻译 Agent、解释 Agent、问答 Agent 的共用基础设施。

#### `services/pdf/`

PDF 服务入口是 `pdf/service.py` 的 `PDFService`。

内部组合了：

- `PDFParser`
- `LayoutAnalyzer`
- `TableExtractor`
- `CoordinateMapper`

主要职责：

- 解析 PDF
- 保存内存态解析结果
- 按页或全局返回文本块
- 按坐标定位块
- 抽取表格

`/api/papers/{paper_id}/blocks` 和整页翻译都依赖这里。

#### `services/intent/`

意图识别入口是 `intent/engine.py` 的 `IntentEngine`。

它的结构比较清晰：

- `classifier.py`：规则和关键词快速分类
- `context.py`：会话上下文管理
- `router.py`：意图到 Agent / API 的映射
- `intent_types.py`：意图枚举与上下文数据结构

当前策略：

- 能用规则判断的优先规则
- 判断不了时用启发式兜底，不是真正的 LLM 分类

所以“LLM 兜底分类”目前还是设计意图，不是完整实现。

#### `services/agent/`

Agent 编排器在 `agent/orchestrator.py`。

当前已注册的 Agent：

- `QuickTranslateAgent`
- `PolishTranslateAgent`
- `ConceptExplainAgent`
- `CrossQAAgent`
- `SummaryAgent`
- `CustomAgent`

编排逻辑很薄：

- 根据意图拿 `suggested_agent`
- 组装 `AgentRequest`
- 分发给对应 agent

它更像一个简单 dispatcher，而不是复杂工作流引擎。

#### `services/rag/`

RAG 相关实现集中在：

- `engine.py`
- `vector_store.py`
- `bm25.py`
- `graph_store.py`
- `fusion.py`
- `chunker.py`

从代码结构看，目标是做“向量检索 + BM25 + 图谱检索 + 融合排序”的混合检索。

但按当前主流程判断，它还没有完全打通到 API 和 Agent 层。

#### `services/knowledge_base/`

这里是“论文摄入、图谱、标签、笔记、实体抽取”的聚合区域。

最关键的是 `paper_ingestion.py`，设计上负责：

1. 解析 PDF
2. 切块 / 建索引
3. 进入 RAG / 图谱

但它和当前 `rag_engine` 的接口并没有完全对齐，属于待继续收敛的模块。

#### `services/search/`

检索服务代码是有的：

- `service.py`
- `providers/arxiv.py`
- `providers/semantic_scholar.py`
- `providers/crossref.py`

说明项目已经具备多源论文检索服务层设计。

但 `api/search.py` 还没真正接上这个 service，目前接口返回的是占位结果。

## 6. 一条请求是怎么走的

### 6.1 论文上传

主入口：`POST /api/papers/upload`

流程：

1. 校验扩展名必须是 PDF
2. 为论文生成 `paper_id`
3. 在 `data/papers/{paper_id}/` 下保存文件
4. 用 `fitz` 读取元数据和第一页文本
5. 写入 `Paper` 表
6. 同时写入一个内存 `_papers_store`

这里有两个特点：

- 数据持久化走数据库
- 但仍保留了内存 fallback，说明系统在早期阶段兼容“数据库不可用时也能跑”

### 6.2 获取文本块

主入口：`GET /api/papers/{paper_id}/blocks`

流程：

1. 从 `pdf_service` 里读已缓存的 `PDFDocument`
2. 按 `page` 可选过滤
3. 返回 block 列表给前端

注意这里依赖“该 PDF 已经被 `pdf_service.parse_pdf()` 解析过”。如果没有解析过，结果会为空。

### 6.3 翻译

主入口：`POST /api/translate`

流程：

1. API 层把请求转成 `TranslationRequest`
2. `translation_service.translate()` 查缓存
3. 从 `terminology_engine` 读术语
4. `prompt_manager.build_prompt(...)`
5. `llm_router.chat(...)`
6. 结果入缓存并返回

这个链路是当前后端里最完整的一条智能流程。

### 6.4 Agent 执行

主入口：`POST /api/agent/execute`

流程：

1. `IntentEngine.recognize()` 识别意图
2. 意图结果转成 `AgentRequest`
3. `agent_orchestrator.dispatch()` 分发到具体 agent
4. agent 生成结果

现状上：

- 快速翻译 Agent 较完整
- 跨论文问答 Agent 目前主要还是占位响应
- 其他 Agent 需要结合各自文件再继续细看实现深度

## 7. 当前实现状态评估

如果从“能不能稳定支撑一个完整产品流程”看，当前后端更接近“能力框架已搭好，部分主链路可运行”。

### 7.1 相对完整的部分

- FastAPI 应用启动与路由注册
- 异步数据库会话管理
- 模型配置管理
- LLM 统一适配与路由
- Prompt 管理与版本回滚
- 翻译接口及缓存机制
- 论文上传、本地文件管理

### 7.2 半成品或待打通部分

- RAG API 和 `RAGEngine` 的方法签名不一致
- `PaperIngestionPipeline` 调用 `rag_engine.index_paper(...)` 的参数形式与当前实现不一致
- `CrossQAAgent` 还没有真正调用 RAG 和 LLM，只返回占位文本
- `search` service 已存在，但 `search API` 仍是 TODO
- `notes API` 还是空实现
- `explain API` 还是空实现

## 8. 需要特别注意的代码现状

### 8.1 API 与 Service 存在接口漂移

这是当前代码里最明显的问题。

例子：

- `api/rag.py` 里把 `rag_engine.query(...)` 当成 `async` 来 `await`
- 但 `services/rag/engine.py` 中的 `query()` 是同步函数
- `api/rag.py` 传的是 `paper_ids`
- 而 `RAGEngine.query()` 接的是 `paper_id`

这说明 RAG 部分经历过接口演进，但没有统一收口。

### 8.2 摄入链路尚未闭环

`papers/upload` 只负责保存文件和写 `Paper` 记录，没有自动触发：

- `pdf_service.parse_pdf()`
- `ingestion_pipeline.ingest()`
- `paper.is_indexed = True`

所以“上传成功”不等于“已经进入知识库并可 RAG 检索”。

### 8.3 PDF 解析结果主要在内存

`PDFService` 用 `_documents` 保存解析后的 `PDFDocument`。

这意味着：

- 服务重启后缓存会丢
- 若上传后没走解析流程，`blocks` 接口拿不到内容
- 目前不是持久化解析架构

### 8.4 Service Locator 是手工注入

优点是简单直接。

代价是：

- 初始化顺序要非常小心
- 模块之间依赖关系不够显式
- 后续测试和替换实现时成本会升高

## 9. 建议如何继续看这份代码

如果你准备继续开发这套后端，建议按下面顺序深入：

1. 先看 `app/main.py`、`app/config.py`、`app/database.py`
2. 再看 `api/translation.py` + `services/translation/`
3. 然后看 `services/llm/` 和 `services/prompt/`
4. 再看 `services/intent/` + `services/agent/`
5. 最后再处理 `services/rag/`、`services/knowledge_base/`、`services/search/`

这样会先抓住已经可运行的主链路，再回头补复杂模块。

## 10. 一句话总结

这份 `backend` 不是“已经完全做完的论文智能助手后端”，而是“以翻译、模型管理、Prompt 管理为主线，已经具备产品骨架，并在向 PDF 解析、RAG、知识库、Agent 化演进”的代码基础。
