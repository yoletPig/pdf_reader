# PDF Reader Agent — 论文阅读智能助手

基于 **Python 后端 + React 前端** 的前后端分离架构，集成论文检索、RAG 跨论文知识库、中英对照翻译、多粒度 Prompt 管理、意图识别引擎，以及基于 `.env` 的单模型配置。

## 技术栈

| 层级 | 技术 |
|------|------|
| **前端** | React 18 + Vite + TypeScript + Zustand + CSS Modules |
| **后端** | FastAPI (Python 3.11+) + SQLAlchemy + SQLite |
| **PDF 解析** | PyMuPDF + pdfplumber |
| **向量检索** | ChromaDB + sentence-transformers |
| **知识图谱** | NetworkX |
| **LLM** | 单模型 OpenAI 兼容接口 |

## 快速开始

### 后端

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

访问 API 文档: http://localhost:8000/docs

### LLM 配置

后端只从 `backend/.env` 读取一套模型配置，要求接口兼容 OpenAI：

```env
PDF_READER_LLM_MODEL=Qwen/Qwen3-32B
PDF_READER_LLM_API_KEY=your-api-key
PDF_READER_LLM_BASE_URL=https://your-openai-compatible-endpoint/v1/
PDF_READER_LLM_TRUST_ENV=false
PDF_READER_LLM_MAX_TOKENS=4096
PDF_READER_LLM_TEMPERATURE=0.3
```

`PDF_READER_LLM_TRUST_ENV=false` 表示默认不读取系统里的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`。如果你明确需要走代理，再改成 `true`，并确保依赖里包含对应代理支持。

启动后可以用下面两个接口检查当前配置和模型连通性：

```bash
curl http://127.0.0.1:8000/api/config/model
curl -X POST http://127.0.0.1:8000/api/config/test
```

### 前端

```bash
cd frontend
npm install
npm run dev
```

访问: http://localhost:5173

## 项目结构

```
pdf_reader/
├── backend/                    # Python 后端
│   ├── app/
│   │   ├── main.py            # FastAPI 应用入口
│   │   ├── config.py          # 全局配置
│   │   ├── database.py        # 数据库连接
│   │   ├── api/               # API 路由层
│   │   │   ├── papers.py      # /api/papers
│   │   │   ├── search.py      # /api/search
│   │   │   ├── translation.py # /api/translate
│   │   │   ├── explain.py     # /api/explain
│   │   │   ├── rag.py         # /api/rag
│   │   │   ├── config.py      # /api/config
│   │   │   ├── prompts.py     # /api/prompts
│   │   │   ├── notes.py       # /api/notes
│   │   │   ├── intent_api.py  # /api/intent
│   │   │   └── agent_api.py   # /api/agent
│   │   ├── services/          # 业务逻辑层
│   │   │   ├── intent/        # 意图识别引擎
│   │   │   ├── agent/         # Agent 编排器
│   │   │   ├── prompt/        # Prompt 管理器
│   │   │   ├── rag/           # RAG 引擎
│   │   │   ├── knowledge_base/ # 知识库管理
│   │   │   ├── search/        # 论文检索
│   │   │   ├── pdf/           # PDF 解析
│   │   │   ├── translation/   # 翻译服务
│   │   │   └── llm/           # 大模型路由
│   │   ├── models/            # SQLAlchemy 模型
│   │   └── utils/             # 工具函数
│   └── data/                  # 数据存储
│       ├── papers/            # PDF 文件
│       ├── db/                # SQLite 数据库
│       └── cache/             # 缓存文件
├── frontend/                  # React 前端
│   └── src/
│       ├── api/               # API 调用层
│       ├── pages/             # 页面组件
│       ├── components/        # 通用组件
│       ├── stores/            # Zustand 状态
│       └── styles/            # 样式文件
└── docs/                      # 文档
```

## 核心功能

### 1. 意图识别引擎
- 多模态意图分类（翻译/解释/问答/检索/管理）
- 上下文感知 + 规则分类器 + LLM 兜底

### 2. Agent 编排系统
- 6 种 Agent 模式：快速翻译、严谨润色、概念解释、跨论文问答、摘要总结、自定义
- 三层 Prompt 架构（System/Task/User）

### 3. RAG 知识库引擎
- 混合检索：BM25 + 向量语义 + 图谱关系
- RRF 融合 + Re-ranking
- 来源标注与引用追踪

### 4. 论文检索
- 多源聚合：arXiv + Semantic Scholar + CrossRef
- 一键导入自动摄入管线

### 5. PDF 双栏阅读器
- PDF.js 渲染 + 文本选择
- 双栏对照翻译 + 同步滚动
- 悬浮工具栏

## 实施阶段

- [x] Phase 1: 基础框架搭建
- [x] Phase 2: PDF 解析与阅读器
- [x] Phase 3: Agent 系统 + 翻译服务
- [x] Phase 4: RAG 知识库引擎
- [ ] Phase 5: 论文检索 + 打磨优化

## 开发

```bash
# 后端测试
cd backend && python -c "from app.main import app; print('OK')"

# 前端构建
cd frontend && npm run build
```
