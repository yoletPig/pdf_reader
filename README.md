# PDF Reader Agent — 论文阅读智能助手

基于 **Python 后端 + pi agent (Node) + React 前端** 的前后端分离架构。集成论文管理、中英对照翻译、pi agent 驱动的论文问答（工具调用循环），以及运行时可编辑的系统设置（PDF 识别方式、模型配置）。

> v2 重要变更：移除了旧自研 agent harness、向量切分与向量检索（embedding/chroma），问答链路全面改用开源 [pi agent](https://pi.dev) 框架；新增系统设置页。

## 架构

```
┌─────────────┐   /api    ┌──────────────────┐  代理   ┌────────────────────┐
│  React 前端  │ ────────→ │  FastAPI 后端     │ ─────→ │ agent-gateway       │
│  (Vite)     │           │  papers/translation│        │ (pi-agent-core)     │
└─────────────┘           │  settings/config  │        │  · Agent 会话管理    │
                          └──────────────────┘        │  · 论文工具(5个)     │
                                 │                    │  · SSE 事件流转换    │
                                 ▼                    └─────────┬──────────┘
                          SQLite + 本地文件                       │ 读取模型配置
                          (papers/, db/)                ◄────────┘ + 调用后端工具
```

| 层级 | 技术 |
|------|------|
| **前端** | React 19 + Vite + TypeScript(strict) + Zustand + CSS Modules |
| **后端** | FastAPI (Python 3.10+) + SQLAlchemy(async) + SQLite |
| **PDF 解析** | PyMuPDF（默认，快速轻量）/ Docling（可选，深度解析，`pip install .[docling]`） |
| **Agent** | [@earendil-works/pi-agent-core](https://github.com/earendil-works/pi) + pi-ai（OpenAI 兼容 provider） |
| **LLM** | 单模型 OpenAI 兼容接口（系统设置页运行时可改） |

## 快速开始

### 1. 后端（端口 8000）

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### 2. agent-gateway（端口 8002）

```bash
cd agent-gateway
npm install
npm run build && npm start
# 开发模式: npm run dev
```

### 3. 前端（端口 5173）

```bash
cd frontend
npm install
npm run dev
```

访问: http://localhost:5173

## LLM 配置

两种方式（数据库覆盖值优先）：

1. **系统设置页**（推荐）：前端 `/settings` → 模型配置 → 填写 Base URL / API Key / 模型名 → 保存即时生效，无需重启。
2. **`backend/.env`**（引导默认值）：

```env
PDF_READER_LLM_MODEL=Qwen/Qwen3-32B
PDF_READER_LLM_API_KEY=your-api-key
PDF_READER_LLM_BASE_URL=https://your-openai-compatible-endpoint/v1
PDF_READER_LLM_TRUST_ENV=false
PDF_READER_LLM_MAX_TOKENS=4096
PDF_READER_LLM_TEMPERATURE=0.3
```

连通性测试：设置页点「测试模型连通性」，或 `curl -X POST http://127.0.0.1:8000/api/config/test`。

## PDF 识别方式

设置页 → PDF 识别 → 解析引擎：

- **PyMuPDF**（默认）：快速轻量，纯文本 + 标题结构提取，无需 GPU。
- **Docling**：深度解析（公式/表格/图片/版式），需安装可选依赖：

```bash
pip install ".[docling]"
```

切换后新上传的论文即刻使用新引擎；已有论文可在论文列表触发「重建解析」。

## pi agent 工具集

agent-gateway 为 LLM 提供 5 个论文工具（通过调用后端 API 实现）：

| 工具 | 功能 |
|------|------|
| `list_papers` | 列出论文库（标题/摘要/页数） |
| `search_paper_library` | 关键词搜索论文库 |
| `read_paper_page` | 读取指定页原文 |
| `read_paper_markdown` | 分页读取全文 markdown |
| `read_paper_translation` | 读取已有中文译文 |

## 系统设置项

| 分组 | 设置项 | 存储位置 |
|------|--------|----------|
| PDF 识别 | `pdf.pdf_engine`（pymupdf/docling） | `app_settings` 表覆盖 → .env 兜底 |
| 模型配置 | `llm.base_url` / `llm.api_key` / `llm.model` / `llm.max_tokens` / `llm.temperature` | 同上 |

设置 API：`GET/PUT /api/config/settings`，引擎列表：`GET /api/config/engines`。

## 项目结构

```
pdf_reader/
├── backend/                  # FastAPI 后端
│   └── app/
│       ├── main.py           # 入口 + lifespan
│       ├── config.py         # 配置（.env）
│       ├── database.py       # async SQLAlchemy
│       ├── api/              # papers / translation / config(设置) / prompts / search / agent_proxy
│       ├── services/
│       │   ├── pymupdf/      # PyMuPDF 解析引擎（默认）
│       │   ├── docling/      # Docling 解析引擎（可选）
│       │   ├── ingestion/    # 解析→blocks 落库（无向量索引）
│       │   ├── settings_store.py  # 运行时设置（DB 覆盖 + .env 兜底）
│       │   ├── translation/  # 翻译服务
│       │   ├── llm/          # LLM 路由（支持运行时热更新）
│       │   └── prompt/
│       └── models/           # Paper / PaperBlock / TranslationCache / AppSetting
├── agent-gateway/            # pi agent 网关 (Node/TypeScript)
│   └── src/
│       ├── server.ts         # HTTP + SSE（兼容旧 /api/agent-runs 协议）
│       ├── agent.ts          # 会话化的 pi Agent 实例管理
│       ├── models.ts         # OpenAI 兼容 provider（从后端读配置）
│       └── tools/papers.ts   # 5 个论文工具
├── frontend/                 # React 前端
│   └── src/
│       ├── pages/            # Home / Reader / Chat / Search / Settings / VerifyPDF
│       ├── stores/           # Zustand
│       └── api/              # axios 客户端 + SSE
└── docs/
```

## API 速览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/papers` | 论文列表 |
| POST | `/api/papers/upload` | 上传 PDF（自动解析） |
| GET | `/api/papers/{id}/page-source?page=N` | 页级原文 |
| POST | `/api/translate/page` | 页级翻译 |
| GET | `/api/config/settings` | 读系统设置 |
| PUT | `/api/config/settings` | 保存设置（即时生效） |
| POST | `/api/agent-runs/stream` | SSE 论文问答（→ pi agent） |
| POST | `/api/agent-runs` | 同步论文问答 |
| GET | `/api/agent-runs/health` | agent-gateway 健康状态 |

## 故障排查

- **问答返回空内容**：查看 `agent-gateway` 日志；429 表示模型方限流，稍后重试。
- **"模型配置不完整"**：设置页确认 Base URL / 模型名已保存。
- **Docling 引擎报错**：确认已安装可选依赖 `pip install ".[docling]"`。
- **agent 服务未启动**：设置页模型配置区会显示 agent 服务状态；`cd agent-gateway && npm start` 启动。
