/**
 * 论文问答 Agent - 基于 pi-agent-core 的运行时封装。
 *
 * 每个会话（session）持有一个 Agent 实例，支持：
 * - 流式回答（message_update / text_delta）
 * - 思考过程流（thinking_delta）
 * - 工具调用轨迹（tool_execution_*）
 * - 会话内多轮上下文
 * - 技能（Skills）与 MCP 外部工具
 * - 会话状态 / 上下文用量观测
 */
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Models, type Model } from "@earendil-works/pi-ai";
import { proxiedFetch } from "./models.js";
import { paperTools } from "./tools/papers.js";
import { agentConfigFingerprint, type AgentConfig, type SkillConfig } from "./agent-config.js";

const BASE_SYSTEM_PROMPT = `你是一个论文阅读助手，帮助用户阅读、理解和分析学术论文。

行为准则:
- 回答前优先使用工具查阅论文原文，不要凭空编造论文内容。
- 需要跨论文对比时，先用 list_papers 或 search_paper_library 找到相关论文，再读取具体内容。
- 引用原文时注明页码，如 (p.3)。
- 用户用中文提问就用中文回答；用户用英文提问就用英文回答。
- 没有足够信息时明确说明，并建议用户上传或指定论文。
- 回答保持结构化（markdown），重点突出。`;

/** 构建系统提示：内置提示 + 用户自定义指令 + 技能清单 */
export function buildSystemPrompt(config: AgentConfig): string {
  const parts = [BASE_SYSTEM_PROMPT];
  if (config.system_prompt.trim()) {
    parts.push(`## 用户自定义指令（优先遵守）\n${config.system_prompt.trim()}`);
  }
  if (config.skills.length > 0) {
    const lines = config.skills
      .map((s) => `- ${s.name}${s.description ? `：${s.description}` : ""}`)
      .join("\n");
    parts.push(
      `## 可用技能（Skills）\n以下是用户预置的技能。任务与某个技能相关时，先用 use_skill 工具加载其全文，再按其指引完成任务：\n${lines}`,
    );
  }
  return parts.join("\n\n");
}

/** 技能加载工具：把预置技能全文返回给模型 */
export function buildSkillTool(skills: SkillConfig[]): AgentTool | null {
  if (!skills.length) return null;
  const table = skills.map((s) => `${s.name}（${s.description || "无描述"}）`).join("、");
  return {
    name: "use_skill",
    label: "加载技能",
    description: `加载并返回指定技能的完整内容（提示词/知识片段），随后按技能指引完成任务。可用技能：${table}`,
    parameters: Type.Object({
      name: Type.String({ description: "技能名" }),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as { name?: string };
      const wanted = String(params.name || "").trim();
      const skill = skills.find((s) => s.name === wanted);
      if (!skill) {
        return {
          content: [{ type: "text", text: `未找到技能 ${wanted}。可用技能：${skills.map((s) => s.name).join(", ")}` }],
          details: { found: false },
        };
      }
      return {
        content: [{ type: "text", text: `技能 ${skill.name} 全文：\n\n${skill.content}` }],
        details: { found: true, name: skill.name },
      };
    },
  };
}

export type AgentActivity = "idle" | "thinking" | "tool_calling";

export interface SessionAgent {
  agent: Agent;
  createdAt: number;
  lastActiveAt: number;
  paperId?: string;
  /** agent 配置指纹（系统提示/技能变化时重建会话 agent） */
  configFingerprint: string;
  /** 当前活动状态（server.ts 在事件流中更新） */
  activity: AgentActivity;
  /** 单次 run 内的工具调用轮计数（配合 max_turns） */
  turnCount: number;
  /** 最近一次 LLM 响应的 token 用量 */
  lastUsage?: { input: number; output: number; total: number };
  contextWindow: number;
  maxTurns: number;
  modelId: string;
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
  options: {
    paperId?: string;
    agentConfig?: AgentConfig;
    extraTools?: AgentTool[];
    messages?: any[];
  } = {},
): SessionAgent {
  sweepExpiredSessions();

  const agentConfig = options.agentConfig;
  const systemPrompt = agentConfig ? buildSystemPrompt(agentConfig) : BASE_SYSTEM_PROMPT;
  const skillTool = agentConfig ? buildSkillTool(agentConfig.skills) : null;
  const tools = [
    ...paperTools,
    ...(skillTool ? [skillTool] : []),
    ...(options.extraTools || []),
  ] as AgentTool[];

  const entry: SessionAgent = {
    agent: null as any, // 下方赋值（shouldStopAfterTurn 闭包需引用 entry）
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    paperId: options.paperId,
    configFingerprint: agentConfig ? agentConfigFingerprint(agentConfig) : "",
    activity: "idle",
    turnCount: 0,
    contextWindow: agentConfig?.context_window || 128000,
    maxTurns: agentConfig?.max_turns || 25,
    modelId: String((model as any)?.id || ""),
  };

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      tools,
      // 重建会话时携带历史（系统提示由 systemPrompt 重新生成）
      messages: (options.messages as any) || [],
    },
    // streamSimple 支持 options.fetch，注入代理感知 fetch 使 LLM 请求可走
    // http_proxy/https_proxy（服务器需代理访问自定义 LLM 地址）
    streamFn: (model, context, options) =>
      models.streamSimple(model, context, { ...options, fetch: proxiedFetch }),
    sessionId,
    toolExecution: "parallel",
    // 单次问答最大工具调用轮数（防止死循环）；每次 run 开始时重置计数
    shouldStopAfterTurn: () => {
      entry.turnCount += 1;
      return entry.turnCount >= entry.maxTurns;
    },
  });
  entry.agent = agent;
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
  options: {
    paperId?: string;
    agentConfig?: AgentConfig;
    extraTools?: AgentTool[];
  } = {},
): { entry: SessionAgent; isNew: boolean } {
  const existing = getSession(sessionId);
  const fingerprint = options.agentConfig ? agentConfigFingerprint(options.agentConfig) : "";
  if (existing && existing.configFingerprint === fingerprint) {
    // 运行参数类配置（max_turns / context_window）无需重建，直接同步
    if (options.agentConfig) {
      existing.maxTurns = options.agentConfig.max_turns;
      existing.contextWindow = options.agentConfig.context_window;
    }
    return { entry: existing, isNew: false };
  }
  if (existing) {
    // 配置变化：保留对话历史（过滤系统消息，系统提示/工具声明由新配置重建）
    const history = (existing.agent.state.messages || []).filter(
      (m: any) => m?.role !== "system",
    );
    sessions.delete(sessionId);
    const entry = createSession(sessionId, models, model, { ...options, messages: history });
    return { entry, isNew: false };
  }
  return { entry: createSession(sessionId, models, model, options), isNew: true };
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

// ---------------------------------------------------------------------------
// 会话状态 / 上下文用量观测
// ---------------------------------------------------------------------------

/** 粗略 token 估算：中日韩字符约 1 字符/token，其余约 4 字符/token */
function estimateTokens(chars: number, cjkChars: number): number {
  return Math.ceil(cjkChars * 1 + (chars - cjkChars) / 4);
}

function messageChars(message: any): { chars: number; cjk: number } {
  let text = "";
  const content = message?.content;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block?.text === "string") text += block.text;
      else if (typeof block?.thinking === "string") text += block.thinking;
      else if (block?.type === "toolCall") text += JSON.stringify(block.arguments || {});
    }
  }
  const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return { chars: text.length, cjk };
}

export interface SessionStatus {
  session_id: string;
  exists: boolean;
  state: AgentActivity | "streaming";
  is_streaming: boolean;
  message_count: number;
  context_chars: number;
  estimated_tokens: number;
  context_tokens: number;
  context_window: number;
  context_percent: number;
  usage: { input: number; output: number; total: number };
  pending_tool_calls: string[];
  tool_count: number;
  model: string;
  max_turns: number;
  last_error?: string;
}

/** 计算会话状态与上下文用量 */
export function getSessionStatus(sessionId: string): SessionStatus {
  const entry = sessions.get(sessionId);
  if (!entry) {
    return {
      session_id: sessionId,
      exists: false,
      state: "idle",
      is_streaming: false,
      message_count: 0,
      context_chars: 0,
      estimated_tokens: 0,
      context_tokens: 0,
      context_window: 0,
      context_percent: 0,
      usage: { input: 0, output: 0, total: 0 },
      pending_tool_calls: [],
      tool_count: 0,
      model: "",
      max_turns: 0,
    };
  }

  const messages = entry.agent.state.messages || [];
  let chars = 0;
  let cjk = 0;
  let usage = entry.lastUsage || { input: 0, output: 0, total: 0 };
  for (const message of messages) {
    const c = messageChars(message);
    chars += c.chars;
    cjk += c.cjk;
    const u = (message as any)?.usage;
    if (u && typeof u.input === "number") {
      usage = { input: u.input || 0, output: u.output || 0, total: u.totalTokens || 0 };
    }
  }
  const estimated = estimateTokens(chars, cjk);
  // 优先使用 provider 报告的最近一次输入 token（更接近真实上下文大小）
  const contextTokens = usage.input + usage.output > 0
    ? usage.input + usage.output
    : estimated;
  const window = entry.contextWindow || 128000;

  return {
    session_id: sessionId,
    exists: true,
    state: entry.agent.state.isStreaming ? entry.activity : "idle",
    is_streaming: entry.agent.state.isStreaming,
    message_count: messages.length,
    context_chars: chars,
    estimated_tokens: estimated,
    context_tokens: contextTokens,
    context_window: window,
    context_percent: Math.min(100, Math.round((contextTokens / window) * 1000) / 10),
    usage,
    pending_tool_calls: [...(entry.agent.state.pendingToolCalls || [])],
    tool_count: (entry.agent.state.tools || []).length,
    model: entry.modelId,
    max_turns: entry.maxTurns,
    last_error: entry.agent.state.errorMessage || undefined,
  };
}

/** 全部活跃会话概览 */
export function listSessionStatuses(): SessionStatus[] {
  sweepExpiredSessions();
  return [...sessions.keys()].map(getSessionStatus);
}
