/**
 * 论文问答 Agent - 基于 pi-agent-core 的运行时封装。
 *
 * 每个会话（session）持有一个 Agent 实例，支持：
 * - 流式回答（message_update / text_delta）
 * - 工具调用轨迹（tool_execution_*）
 * - 会话内多轮上下文
 */
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Models, Model } from "@earendil-works/pi-ai";
import { paperTools } from "./tools/papers.js";

const SYSTEM_PROMPT = `你是一个论文阅读助手，帮助用户阅读、理解和分析学术论文。

行为准则:
- 回答前优先使用工具查阅论文原文，不要凭空编造论文内容。
- 需要跨论文对比时，先用 list_papers 或 search_paper_library 找到相关论文，再读取具体内容。
- 引用原文时注明页码，如 (p.3)。
- 用户用中文提问就用中文回答；用户用英文提问就用英文回答。
- 没有足够信息时明确说明，并建议用户上传或指定论文。
- 回答保持结构化（markdown），重点突出。`;

export interface SessionAgent {
  agent: Agent;
  createdAt: number;
  lastActiveAt: number;
  paperId?: string;
}

/** 会话注册表：session_id → Agent 实例 */
const sessions = new Map<string, SessionAgent>();

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 小时

function sweepExpiredSessions() {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now - entry.lastActiveAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

export function createSession(
  sessionId: string,
  models: Models,
  model: Model<any>,
  options: { paperId?: string } = {},
): SessionAgent {
  sweepExpiredSessions();

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools: paperTools as AgentTool[],
      messages: [],
    },
    streamFn: models.streamSimple.bind(models),
    sessionId,
    toolExecution: "parallel",
  });

  const entry: SessionAgent = {
    agent,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    paperId: options.paperId,
  };
  sessions.set(sessionId, entry);
  return entry;
}

export function getSession(sessionId: string): SessionAgent | undefined {
  sweepExpiredSessions();
  const entry = sessions.get(sessionId);
  if (entry) entry.lastActiveAt = Date.now();
  return entry;
}

export function getOrCreateSession(
  sessionId: string,
  models: Models,
  model: Model<any>,
  options: { paperId?: string } = {},
): SessionAgent {
  return getSession(sessionId) ?? createSession(sessionId, models, model, options);
}

export function resetSession(sessionId: string): boolean {
  const entry = sessions.get(sessionId);
  if (!entry) return false;
  entry.agent.reset();
  entry.lastActiveAt = Date.now();
  return true;
}

/** 当前活跃会话数（健康检查/观测用） */
export function activeSessionCount(): number {
  sweepExpiredSessions();
  return sessions.size;
}
