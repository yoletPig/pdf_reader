/**
 * agent-gateway HTTP 服务器。
 *
 * 端点:
 *   GET  /health                       健康检查（含 MCP 状态）
 *   POST /api/agent-runs/stream        SSE 流式问答（兼容原前端协议）
 *   POST /api/agent-runs               同步问答（ReaderPage 用）
 *   POST /api/agent-runs/reset         重置会话
 *   GET  /api/agent-runs/status        agent 状态/上下文用量（?session_id= 可选）
 *   GET  /api/agent-runs/sessions      全部活跃会话状态
 *   POST /api/agent-runs/mcp-test      测试 MCP 服务器连接（设置页用）
 *
 * 模型配置实时从 Python 后端 /api/config/model 读取，
 * 与系统设置页保存的配置联动。
 */
import http from "node:http";
import { Agent } from "@earendil-works/pi-agent-core";
import { buildModels, fetchModelConfig, type ModelConfig } from "./models.js";
import { fetchAgentConfig, type AgentConfig } from "./agent-config.js";
import { mcpManager, type McpServerStatus } from "./mcp.js";
import {
  getOrCreateSession,
  resetSession,
  activeSessionCount,
  getSessionStatus,
  listSessionStatuses,
  type SessionAgent,
} from "./agent.js";

const PORT = Number(process.env.AGENT_GATEWAY_PORT || 8002);

// ---------- 日志（写入 stdout，由 start.sh 重定向到 logs/gateway.log） ----------

function log(level: "INFO" | "WARN" | "ERROR", tag: string, message: string, extra?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const tail = extra ? ` ${JSON.stringify(extra)}` : "";
  const line = `${ts} [${level}] [${tag}] ${message}${tail}`;
  if (level === "ERROR") console.error(line);
  else if (level === "WARN") console.warn(line);
  else console.log(line);
}

// ---------- 工具函数 ----------

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

interface StreamRequest {
  question?: string;
  paper_id?: string;
  session_id?: string;
  selected_text?: string;
  current_page?: number;
  /** 历史对话（仅在会话冷启动时注入，帮助模型恢复上下文） */
  history?: Array<{ role: string; content: string }>;
}

/** 构建用户问题（附上下文；冷启动时注入历史对话） */
function buildUserPrompt(data: StreamRequest, includeHistory = false): string {
  const parts: string[] = [];
  if (includeHistory && data.history && data.history.length > 0) {
    const lines = data.history
      .slice(-12)
      .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content.slice(0, 800)}`)
      .join("\n");
    parts.push(`（以下是本会话之前的对话记录，仅供背景参考，不需要重复回答）\n${lines}`);
  }
  if (data.paper_id) {
    parts.push(`（当前论文 ID: ${data.paper_id}）`);
  }
  if (data.selected_text) {
    parts.push(`（用户选中的原文片段，来自 p.${data.current_page ?? "?"}:）\n> ${data.selected_text.slice(0, 1500)}`);
  }
  parts.push(data.question || "");
  return parts.filter(Boolean).join("\n\n");
}

// ---------- 模型配置缓存（带 TTL，设置页保存后 ~10s 内生效） ----------

let cachedConfig: {
  config: ModelConfig;
  models: ReturnType<typeof buildModels>;
  agentConfig: AgentConfig;
  mcpStatus: McpServerStatus[];
  at: number;
} | null = null;
const CONFIG_TTL_MS = 10_000;

/** 模型 + agent 行为配置（含 MCP 连接同步），带 TTL 缓存 */
async function getRuntime() {
  if (cachedConfig && Date.now() - cachedConfig.at < CONFIG_TTL_MS) {
    return {
      config: cachedConfig.config,
      models: cachedConfig.models,
      agentConfig: cachedConfig.agentConfig,
      mcpStatus: cachedConfig.mcpStatus,
      mcpTools: mcpManager.tools(),
    };
  }
  const config = await fetchModelConfig();
  if (!config.base_url || !config.model) {
    throw new Error("模型配置不完整：请在系统设置页配置 Base URL 与模型名");
  }
  const models = buildModels(config);

  // agent 行为配置（自定义指令/技能/MCP）拉取失败不阻塞问答，回退默认
  let agentConfig: AgentConfig;
  try {
    agentConfig = await fetchAgentConfig();
  } catch (err: any) {
    log("WARN", "config", "拉取 agent 配置失败，使用默认", { error: String(err?.message || err) });
    agentConfig = { system_prompt: "", max_turns: 25, context_window: 128000, skills: [], mcp_servers: [] };
  }

  // 同步 MCP 连接（增量：配置未变的连接保留）
  try {
    await mcpManager.sync(agentConfig.mcp_servers);
  } catch (err: any) {
    log("WARN", "mcp", "MCP 同步失败", { error: String(err?.message || err) });
  }
  const mcpStatus = mcpManager.status();

  cachedConfig = { config, models, agentConfig, mcpStatus, at: Date.now() };
  return { config, models, agentConfig, mcpStatus, mcpTools: mcpManager.tools() };
}

function invalidateModelCache() {
  cachedConfig = null;
}

// ---------- SSE 事件生成 ----------

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface ToolTrace {
  id: string;
  kind: string;
  status: "running" | "completed" | "failed";
  title: string;
  content: string;
}

interface RunCounters {
  toolCalls: number;
  llmCalls: number;
}

/** 发送 agent 状态帧（状态/上下文用量实时更新） */
function emitStatus(
  write: (chunk: string) => void,
  sessionId: string,
  runId: string,
  phase: string,
  counters: RunCounters,
  startedAt: number,
) {
  const status = getSessionStatus(sessionId);
  write(sseFrame("status", {
    run_id: runId,
    phase,
    state: status.state,
    context: {
      tokens: status.context_tokens,
      estimated_tokens: status.estimated_tokens,
      window: status.context_window,
      percent: status.context_percent,
      messages: status.message_count,
    },
    usage: status.usage,
    tool_calls: counters.toolCalls,
    llm_calls: counters.llmCalls,
    elapsed_ms: Date.now() - startedAt,
  }));
}

/**
 * 运行一次 agent 问答并把 pi agent 事件流转换为前端 SSE 协议。
 * 兼容原 /api/agent-runs/stream 的事件：run_created / event / answer_delta / result / error
 */
async function runAgentAndStream(
  data: StreamRequest,
  write: (chunk: string) => void,
): Promise<void> {
  const { config, models, agentConfig, mcpTools, mcpStatus } = await getRuntime();
  const model = models.getModel("pdf-reader", config.model);
  if (!model) throw new Error(`模型不存在: ${config.model}`);

  const sessionId = data.session_id || `session-${Date.now().toString(36)}`;
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();

  const { entry: sessionEntry, isNew } = getOrCreateSession(sessionId, models, model, {
    paperId: data.paper_id,
    agentConfig,
    extraTools: mcpTools,
  });
  const agent: Agent = sessionEntry.agent;
  sessionEntry.turnCount = 0;
  sessionEntry.activity = "thinking";

  log("INFO", "run", `流式问答开始`, {
    run_id: runId,
    session_id: sessionId,
    session_new: isNew,
    paper_id: data.paper_id || "(all)",
    question: (data.question || "").slice(0, 120),
    model: config.model,
    base_url: config.base_url,
    skills: agentConfig.skills.map((s) => s.name),
    mcp_tools: mcpTools.length,
  });

  write(sseFrame("run_created", {
    run_id: runId,
    agent: "paper_qa",
    status: "running",
    execution: {
      mode: "agent",
      trace_visibility: "expanded",
      reason: "pi-agent 工具调用循环",
    },
    thought: null,
    agent_info: {
      model: config.model,
      max_turns: agentConfig.max_turns,
      skills: agentConfig.skills.map((s) => ({ name: s.name, description: s.description })),
      mcp: mcpStatus,
      tools: (agent.state.tools || []).map((t: any) => t.name),
    },
  }));

  const toolTraces: ToolTrace[] = [];
  let answerText = "";
  let thinkingText = ""; // 模型思考过程（reasoning/thinking 块）
  let finalText = ""; // 最终 assistant 消息中的文本（作为 answerText 的兜底）
  let stopReason = "";
  let providerError = "";
  let tokenUsage = { input: 0, output: 0, total_tokens: 0 };
  let toolCalls = 0;
  let llmCalls = 0;
  let failed = false;
  let errorMessage = "";

  const unsubscribe = agent.subscribe((event: any) => {
    try {
      switch (event.type) {
        case "message_update": {
          const inner = event.assistantMessageEvent;
          if (inner?.type === "thinking_delta") {
            // 推理模型思考过程（reasoning_content）实时转发给前端
            thinkingText += inner.delta;
            write(sseFrame("thinking_delta", { content: inner.delta }));
          } else if (inner?.type === "text_delta") {
            answerText += inner.delta;
            write(sseFrame("answer_delta", { content: inner.delta }));
          } else if (inner?.type === "toolcall_start") {
            // 仅更新活动状态；轨迹由 tool_execution_start 统一创建（带工具调用 ID），
            // 避免同一次调用产生两条轨迹
            sessionEntry.activity = "tool_calling";
          }
          break;
        }
        case "tool_execution_start": {
          sessionEntry.activity = "tool_calling";
          log("INFO", "tool", `工具调用`, { run_id: runId, tool: event.toolName, args: String(JSON.stringify(event.args || {})).slice(0, 200) });
          const trace: ToolTrace = {
            id: `tool-${event.toolCallId || toolTraces.length + 1}`,
            kind: "tool",
            status: "running",
            title: `调用 ${event.toolName}`,
            content: String(JSON.stringify(event.args || {})).slice(0, 300),
          };
          toolTraces.push(trace);
          write(sseFrame("event", trace));
          emitStatus(write, sessionId, runId, "tool_start", { toolCalls, llmCalls }, startedAt);
          break;
        }
        case "tool_execution_end": {
          const last = toolTraces.find((t) => t.id === `tool-${event.toolCallId}`) || toolTraces[toolTraces.length - 1];
          if (last) {
            last.status = event.isError ? "failed" : "completed";
            write(sseFrame("event", last));
          }
          sessionEntry.activity = "thinking";
          log(event.isError ? "WARN" : "INFO", "tool", `工具结束`, {
            run_id: runId,
            tool: event.toolName,
            status: event.isError ? "failed" : "ok",
            result_preview: String(JSON.stringify(event.result ?? event.error ?? "")).slice(0, 200),
          });
          emitStatus(write, sessionId, runId, "tool_end", { toolCalls, llmCalls }, startedAt);
          break;
        }
        case "message_end": {
          if (event.message?.role === "assistant") {
            llmCalls += 1;
            const usage = event.message.usage;
            if (usage) {
              tokenUsage = {
                input: tokenUsage.input + (usage.input || 0),
                output: tokenUsage.output + (usage.output || 0),
                total_tokens: 0,
              };
              tokenUsage.total_tokens = tokenUsage.input + tokenUsage.output;
              sessionEntry.lastUsage = {
                input: usage.input || 0,
                output: usage.output || 0,
                total: usage.totalTokens || 0,
              };
            }
            sessionEntry.activity = "thinking";
            emitStatus(write, sessionId, runId, "llm_response", { toolCalls, llmCalls }, startedAt);
            const toolCallsInMessage = (event.message.content || []).filter(
              (b: any) => b.type === "toolCall",
            ).length;
            toolCalls += toolCallsInMessage;
            // 记录最终消息文本与错误（answerText 可能因 interleave/仅 thinking 而为空）
            const texts = (event.message.content || [])
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text || "")
              .join("");
            if (texts) finalText = texts;
            stopReason = event.message.stopReason || stopReason;
            providerError = event.message.errorMessage || providerError;
            log("INFO", "llm", `LLM 响应`, {
              run_id: runId,
              stop_reason: stopReason,
              error: providerError || undefined,
              text_len: texts.length,
              tool_calls: toolCallsInMessage,
              usage,
            });
          }
          break;
        }
      }
    } catch (err) {
      console.error("事件处理错误:", err);
    }
  });

  try {
    await agent.prompt(buildUserPrompt(data, isNew));
    // 兜底：answerText 为空时取最终消息文本；模型报错时给出可诊断的提示
    let content = answerText.trim() || finalText.trim();
    if (!content && providerError) {
      content = `⚠️ 模型调用失败（${stopReason || "error"}）: ${providerError.slice(0, 300)}`;
    } else if (!content && stopReason === "aborted") {
      content = "⚠️ 生成已被中止。";
    } else if (!content) {
      content = "（模型未返回文本内容）";
    }
    log("INFO", "run", `流式问答结束`, {
      run_id: runId,
      stop_reason: stopReason || "(none)",
      error: providerError || undefined,
      answer_len: content.length,
      thinking_len: thinkingText.length,
      tool_calls: toolCalls,
      llm_calls: llmCalls,
      usage: tokenUsage,
      duration_ms: Date.now() - startedAt,
    });
    sessionEntry.activity = "idle";
    const finalStatus = getSessionStatus(sessionId);
    emitStatus(write, sessionId, runId, "completed", { toolCalls, llmCalls }, startedAt);
    write(sseFrame("result", {
      run_id: runId,
      agent: "paper_qa",
      status: "completed",
      answer: {
        content,
        sources: [],
        trace_summary: {
          event_count: toolTraces.length + llmCalls,
          tool_calls: toolCalls,
          llm_calls: llmCalls,
          tools_used: toolTraces.map((t) => t.title.replace("调用 ", "")),
          stop_reason: stopReason,
          error_message: providerError || undefined,
          token_usage: tokenUsage,
          thinking: thinkingText.slice(0, 50000) || undefined,
          tool_trace: toolTraces,
          duration_ms: Date.now() - startedAt,
          context: {
            tokens: finalStatus.context_tokens,
            estimated_tokens: finalStatus.estimated_tokens,
            window: finalStatus.context_window,
            percent: finalStatus.context_percent,
            messages: finalStatus.message_count,
          },
        },
      },
      execution: {
        mode: "agent",
        trace_visibility: "expanded",
        reason: "pi-agent 工具调用循环",
      },
    }));
  } catch (err: any) {
    failed = true;
    errorMessage = String(err?.message || err);
    log("ERROR", "run", `流式问答异常`, { run_id: runId, error: errorMessage });
    write(sseFrame("error", {
      run_id: runId,
      detail: errorMessage,
      error_type: "agent_error",
    }));
  } finally {
    sessionEntry.activity = "idle";
    unsubscribe();
  }
}

/** 同步（非流式）运行，返回最终结果（ReaderPage 旧接口兼容） */
async function runAgentSync(data: StreamRequest) {
  const { config, models, agentConfig, mcpTools } = await getRuntime();
  const model = models.getModel("pdf-reader", config.model);
  if (!model) throw new Error(`模型不存在: ${config.model}`);

  const sessionId = data.session_id || `session-${Date.now().toString(36)}`;
  const runId = `run-${Date.now().toString(36)}`;
  const startedAt = Date.now();

  const { entry: sessionEntry, isNew } = getOrCreateSession(sessionId, models, model, {
    paperId: data.paper_id,
    agentConfig,
    extraTools: mcpTools,
  });
  sessionEntry.turnCount = 0;
  sessionEntry.activity = "thinking";

  log("INFO", "run", `同步问答开始`, {
    run_id: runId,
    session_id: sessionId,
    session_new: isNew,
    paper_id: data.paper_id || "(all)",
    question: (data.question || "").slice(0, 120),
    model: config.model,
  });

  let answerText = "";
  let thinkingText = "";
  let finalText = "";
  let stopReason = "";
  let providerError = "";
  let toolCalls = 0;
  let llmCalls = 0;
  let toolNames: string[] = [];

  const unsubscribe = sessionEntry.agent.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_delta") {
      thinkingText += event.assistantMessageEvent.delta;
    }
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      answerText += event.assistantMessageEvent.delta;
    }

    if (event.type === "tool_execution_start") {
      toolCalls += 1;
      toolNames.push(event.toolName);
      log("INFO", "tool", `工具调用`, { run_id: runId, tool: event.toolName, args: String(JSON.stringify(event.args || {})).slice(0, 200) });
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      llmCalls += 1;
      const texts = (event.message.content || [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text || "")
        .join("");
      if (texts) finalText = texts;
      stopReason = event.message.stopReason || stopReason;
      providerError = event.message.errorMessage || providerError;
      log("INFO", "llm", `LLM 响应`, {
        run_id: runId,
        stop_reason: stopReason,
        error: providerError || undefined,
        text_len: texts.length,
      });
    }
  });

  try {
    await sessionEntry.agent.prompt(buildUserPrompt(data, isNew));
    // 兜底：answerText 为空时取最终消息文本；模型报错时给出可诊断的提示
    let content = answerText.trim() || finalText.trim();
    if (!content && providerError) {
      content = `⚠️ 模型调用失败（${stopReason || "error"}）: ${providerError.slice(0, 300)}`;
    } else if (!content && stopReason === "aborted") {
      content = "⚠️ 生成已被中止。";
    } else if (!content) {
      content = "（模型未返回文本内容）";
    }
    log("INFO", "run", `同步问答结束`, {
      run_id: runId,
      stop_reason: stopReason || "(none)",
      error: providerError || undefined,
      answer_len: content.length,
      tool_calls: toolCalls,
      llm_calls: llmCalls,
    });
    return {
      run_id: runId,
      agent: "paper_qa",
      status: "completed",
      answer: {
        content,
        sources: [],
        trace_summary: {
          tool_calls: toolCalls,
          tools_used: toolNames,
          llm_calls: llmCalls,
          stop_reason: stopReason,
          error_message: providerError || undefined,
          thinking: thinkingText.slice(0, 50000) || undefined,
          duration_ms: Date.now() - startedAt,
          context: (() => {
            const s = getSessionStatus(sessionId);
            return {
              tokens: s.context_tokens,
              estimated_tokens: s.estimated_tokens,
              window: s.context_window,
              percent: s.context_percent,
              messages: s.message_count,
            };
          })(),
        },
      },
      execution: {
        mode: "agent",
        trace_visibility: "compact",
        reason: "pi-agent",
      },
    };
  } finally {
    sessionEntry.activity = "idle";
    unsubscribe();
  }
}

// ---------- HTTP 服务器 ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // 健康检查
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      status: "ok",
      service: "agent-gateway",
      active_sessions: activeSessionCount(),
      model: cachedConfig?.config.model || "",
      mcp: mcpManager.status(),
    });
    return;
  }

  // agent 状态 / 上下文用量（带 session_id 时返回单会话，否则返回概览）
  if (req.method === "GET" && url.pathname === "/api/agent-runs/status") {
    // 刷新运行时缓存（模型/agent 配置/MCP 连接），保证状态面板不显示过期连接
    await getRuntime().catch(() => {});
    const sessionId = url.searchParams.get("session_id") || "";
    if (sessionId) {
      sendJson(res, 200, getSessionStatus(sessionId));
      return;
    }
    sendJson(res, 200, {
      status: "ok",
      model: cachedConfig?.config.model || "",
      active_sessions: activeSessionCount(),
      skills: (cachedConfig?.agentConfig.skills || []).map((s) => s.name),
      mcp: mcpManager.status(),
      sessions: listSessionStatuses(),
    });
    return;
  }

  // 全部活跃会话状态
  if (req.method === "GET" && url.pathname === "/api/agent-runs/sessions") {
    sendJson(res, 200, { sessions: listSessionStatuses() });
    return;
  }

  // 测试 MCP 服务器连接（不持久化）
  if (req.method === "POST" && url.pathname === "/api/agent-runs/mcp-test") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const serverConfig = body.server;
      if (!serverConfig || typeof serverConfig !== "object") {
        sendJson(res, 400, { detail: "缺少 server 配置" });
        return;
      }
      const status = await mcpManager.testServer(serverConfig);
      sendJson(res, 200, status);
    } catch (err: any) {
      sendJson(res, 400, { detail: String(err?.message || err) });
    }
    return;
  }

  // 配置失效（后端设置保存后可调用，立即重新拉取模型配置）
  if (req.method === "POST" && url.pathname === "/api/agent-runs/invalidate-config") {
    invalidateModelCache();
    sendJson(res, 200, { status: "ok" });
    return;
  }

  // 重置会话
  if (req.method === "POST" && url.pathname === "/api/agent-runs/reset") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const ok = resetSession(String(body.session_id || ""));
      sendJson(res, 200, { status: ok ? "ok" : "not_found" });
    } catch (err: any) {
      sendJson(res, 400, { detail: String(err?.message || err) });
    }
    return;
  }

  // 流式问答（SSE）
  if (req.method === "POST" && url.pathname === "/api/agent-runs/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "X-Accel-Buffering": "no",
    });

    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);

    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const input = body.input || {};
      const context = body.context || {};
      await runAgentAndStream(
        {
          question: input.question,
          paper_id: input.paper_id || context.paper_id,
          session_id: context.session_id,
          selected_text: context.selected_text,
          current_page: context.current_page,
          history: Array.isArray(body.history) ? body.history : undefined,
        },
        (chunk) => res.write(chunk),
      );
    } catch (err: any) {
      log("ERROR", "http", "stream 请求失败", { error: String(err?.message || err) });
      res.write(sseFrame("error", {
        run_id: "",
        detail: String(err?.message || err),
        error_type: "gateway_error",
      }));
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
    return;
  }

  // 同步问答
  if (req.method === "POST" && url.pathname === "/api/agent-runs") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const input = body.input || {};
      const context = body.context || {};
      const result = await runAgentSync({
        question: input.question,
        paper_id: input.paper_id || context.paper_id,
        session_id: context.session_id,
        selected_text: context.selected_text,
        current_page: context.current_page,
        history: Array.isArray(body.history) ? body.history : undefined,
      });
      sendJson(res, 200, result);
    } catch (err: any) {
      log("ERROR", "http", "同步请求失败", { error: String(err?.message || err) });
      sendJson(res, 500, { detail: String(err?.message || err) });
    }
    return;
  }

  sendJson(res, 404, { detail: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`✅ agent-gateway (pi agent) 已启动: http://127.0.0.1:${PORT}`);
  console.log(`   后端地址: ${process.env.PDF_READER_BACKEND_URL || "http://127.0.0.1:8000"}`);
});
