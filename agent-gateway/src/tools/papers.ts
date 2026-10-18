/**
 * 论文工具集 - 暴露给 pi agent 的论文检索/阅读能力。
 *
 * 全部通过调用 Python FastAPI 后端（/api/papers）实现，
 * agent-gateway 自身不直接访问数据库或文件。
 */
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Tool } from "@earendil-works/pi-ai";

const BACKEND_URL = process.env.PDF_READER_BACKEND_URL || "http://127.0.0.1:8000";

async function backendFetch(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`backend ${path} failed: ${response.status} ${text.slice(0, 200)}`);
  }
  return response.json();
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

/** 列出论文库中的论文（含标题/摘要/页数） */
export const listPapersTool: AgentTool = {
  name: "list_papers",
  label: "列出论文",
  description: "列出用户论文库中的全部论文，返回标题、摘要、页数与论文 ID。跨论文对比或选择论文时先调用。",
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "可选：按标题/摘要过滤的关键词" })),
  }),
  execute: async (_toolCallId, rawParams) => {
    const params = rawParams as { query?: string };
    const data = await backendFetch(
      `/api/papers?page=1&page_size=100${params.query ? `&query=${encodeURIComponent(params.query)}` : ""}`,
    );
    const papers = (data.papers || []).map((p: any) => ({
      id: p.id,
      title: p.title,
      year: p.year,
      page_count: p.page_count,
      abstract: (p.abstract || "").slice(0, 400),
    }));
    return textResult(JSON.stringify({ total: data.total, papers }, null, 2));
  },
};

/** 读取指定论文某一页的原文（文本 + markdown） */
export const readPaperPageTool: AgentTool = {
  name: "read_paper_page",
  label: "读取论文页",
  description: "读取指定论文某一页的原文文本和 markdown。需要引用原文细节、核对页码时调用。",
  parameters: Type.Object({
    paper_id: Type.String({ description: "论文 ID（来自 list_papers 或用户指定）" }),
    page: Type.Number({ description: "页码，从 1 开始" }),
  }),
  execute: async (_toolCallId, rawParams) => {
    const params = rawParams as { paper_id: string; page: number };
    const data = await backendFetch(
      `/api/papers/${encodeURIComponent(params.paper_id)}/page-source?page=${params.page}`,
    );
    const text = String(data.text || data.markdown || "").slice(0, 8000);
    return textResult(`论文页 (p.${data.page_number}) 原文:\n\n${text}`);
  },
};

/** 读取论文全文 markdown */
export const readPaperMarkdownTool: AgentTool = {
  name: "read_paper_markdown",
  label: "读取论文全文",
  description: "读取论文的完整 markdown 文本（已由后端解析）。适合需要通读全文、总结结构时调用。长文档会截断。",
  parameters: Type.Object({
    paper_id: Type.String({ description: "论文 ID" }),
    offset: Type.Optional(Type.Number({ description: "字符偏移量，用于分页读取长文" })),
  }),
  execute: async (_toolCallId, rawParams) => {
    const params = rawParams as { paper_id: string; offset?: number };
    const data = await backendFetch(`/api/papers/${encodeURIComponent(params.paper_id)}/markdown`);
    const full: string = data.content || "";
    const offset = params.offset || 0;
    const window = full.slice(offset, offset + 12000);
    return textResult(
      `全文总长 ${full.length} 字符，当前读取 offset=${offset}:\n\n${window}${offset + 12000 < full.length ? `\n\n[未完，续读请传 offset=${offset + 12000}]` : ""}`,
    );
  },
};

/** 搜索论文库（标题/摘要/作者） */
export const searchPaperLibraryTool: AgentTool = {
  name: "search_paper_library",
  label: "搜索论文库",
  description: "按关键词在论文库中搜索（匹配标题/摘要/作者）。用户想找某篇论文时调用。",
  parameters: Type.Object({
    query: Type.String({ description: "搜索关键词" }),
  }),
  execute: async (_toolCallId, rawParams) => {
    const params = rawParams as { query: string };
    const data = await backendFetch(
      `/api/papers?page=1&page_size=50&query=${encodeURIComponent(params.query)}`,
    );
    const papers = (data.papers || []).map((p: any) => ({
      id: p.id,
      title: p.title,
      abstract: (p.abstract || "").slice(0, 300),
    }));
    return textResult(JSON.stringify({ total: data.total, papers }, null, 2));
  },
};

/** 读取论文已有译文（若用户翻译过） */
export const readPaperTranslationTool: AgentTool = {
  name: "read_paper_translation",
  label: "读取论文译文",
  description: "读取指定论文某一页的中文译文（如果用户已翻译过该页）。回答中文问题时优先参考。",
  parameters: Type.Object({
    paper_id: Type.String({ description: "论文 ID" }),
    page: Type.Number({ description: "页码" }),
  }),
  execute: async (_toolCallId, rawParams) => {
    const params = rawParams as { paper_id: string; page: number };
    const data = await backendFetch(
      `/api/translate/page?paper_id=${encodeURIComponent(params.paper_id)}&page=${params.page}`,
    );
    const translated = data.translated_text || data.markdown || "";
    if (!translated) {
      return textResult(`该页暂无译文 (p.${params.page})。请使用 read_paper_page 读取原文。`);
    }
    return textResult(`译文 (p.${params.page}):\n\n${String(translated).slice(0, 6000)}`);
  },
};

export const paperTools: AgentTool[] = [
  listPapersTool,
  searchPaperLibraryTool,
  readPaperPageTool,
  readPaperMarkdownTool,
  readPaperTranslationTool,
];

/** pi-ai 需要的 Tool 声明（schema 部分，供上下文序列化） */
export function toolDeclarations(): Tool[] {
  return paperTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  })) as Tool[];
}
