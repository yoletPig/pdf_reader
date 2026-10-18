/**
 * agent-gateway HTTP 服务器。
 *
 * 端点:
 *   GET  /health                       健康检查
 *   POST /api/agent-runs/stream        SSE 流式问答（兼容原前端协议）
 *   POST /api/agent-runs               同步问答（ReaderPage 用）
 *   POST /api/agent-runs/reset         重置会话
 *
 * 模型配置实时从 Python 后端 /api/config/model 读取，
 * 与系统设置页保存的配置联动。
 */
import http from "node:http";
import { Agent } from "@earendil-works/pi-agent-core";
import { buildModels, fetchModelConfig, type ModelConfig } from "./models.js";
import {
  getOrCreateSession,
  resetSession,
  activeSessionCount,
} from "./agent.js";

const PORT = Number(process.env.AGENT_GATEWAY_PORT || 8002);

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
}

/** 构建用户问题（附上下文） */
function buildUserPrompt(data: StreamRequest): string {
  const parts: string[] = [];
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

let cachedConfig: { config: ModelConfig; models: ReturnType<typeof buildModels>; at: number } | null = null;
const CONFIG_TTL_MS = 10_000;

async function getModels() {
  if (cachedConfig && Date.now() - cachedConfig.at < CONFIG_TTL_MS) {
    return { config: cachedConfig.config, models: cachedConfig.models };
  }
  const config = await fetchModelConfig();
  if (!config.base_url || !config.model) {
    throw new Error("模型配置不完整：请在系统设置页配置 Base URL 与模型名");
  }
  if (!config.api_key) {
    // api_key 可为空（本地 ollama/vllm 等无鉴权端点也允许）
    // 但掩码形态视为"后端未提供完整 key"
  }
  const models = buildModels(config);
  cachedConfig = { config, models, at: Date.now() };
  return { config, models };
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

/**
 * 运行一次 agent 问答并把 pi agent 事件流转换为前端 SSE 协议。
 * 兼容原 /api/agent-runs/stream 的事件：run_created / event / answer_delta / result / error
 */
async function runAgentAndStream(
  data: StreamRequest,
  write: (chunk: string) => void,
): Promise<void> {
  const { config, models } = await getModels();
  const model = models.getModel("pdf-reader", config.model);
  if (!model) throw new Error(`模型不存在: ${config.model}`);

  const sessionId = data.session_id || `session-${Date.now().toString(36)}`;
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const sessionEntry = getOrCreateSession(sessionId, models, model, {
    paperId: data.paper_id,
  });
  const agent: Agent = sessionEntry.agent;

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
  }));

  const toolTraces: ToolTrace[] = [];
  let answerText = "";
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
          if (inner?.type === "text_delta") {
            answerText += inner.delta;
            write(sseFrame("answer_delta", { content: inner.delta }));
          } else if (inner?.type === "toolcall_start") {
            const name = inner.partial?.content?.[inner.contentIndex]?.name || "tool";
            const trace: ToolTrace = {
              id: `tool-${toolTraces.length + 1}`,
              kind: "tool",
              status: "running",
              title: `调用 ${name}`,
              content: "",
            };
            toolTraces.push(trace);
            write(sseFrame("event", trace));
          }
          break;
        }
        case "tool_execution_start": {
          const trace: ToolTrace = {
            id: `tool-${toolTraces.length + 1}`,
            kind: "tool",
            status: "running",
            title: `调用 ${event.toolName}`,
            content: String(JSON.stringify(event.args || {})).slice(0, 300),
          };
          toolTraces.push(trace);
          write(sseFrame("event", trace));
          break;
        }
        case "tool_execution_end": {
          const last = toolTraces[toolTraces.length - 1];
          if (last) {
            last.status = event.isError ? "failed" : "completed";
            write(sseFrame("event", last));
          }
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
            }
            const toolCallsInMessage = (event.message.content || []).filter(
              (b: any) => b.type === "toolCall",
            ).length;
            toolCalls += toolCallsInMessage;
          }
          break;
        }
      }
    } catch (err) {
      console.error("事件处理错误:", err);
    }
  });

  try {
    await agent.prompt(buildUserPrompt(data));
    write(sseFrame("result", {
      run_id: runId,
      agent: "paper_qa",
      status: "completed",
      answer: {
        content: answerText || "（无回答内容）",
        sources: [],
        trace_summary: {
          event_count: toolTraces.length + llmCalls,
          tool_calls: toolCalls,
          llm_calls: llmCalls,
          token_usage: tokenUsage,
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
    write(sseFrame("error", {
      run_id: runId,
      detail: errorMessage,
      error_type: "agent_error",
    }));
  } finally {
    unsubscribe();
  }
}

/** 同步（非流式）运行，返回最终结果（ReaderPage 旧接口兼容） */
async function runAgentSync(data: StreamRequest) {
  const { config, models } = await getModels();
  const model = models.getModel("pdf-reader", config.model);
  if (!model) throw new Error(`模型不存在: ${config.model}`);

  const sessionId = data.session_id || `session-${Date.now().toString(36)}`;
  const runId = `run-${Date.now().toString(36)}`;

  const sessionEntry = getOrCreateSession(sessionId, models, model, {
    paperId: data.paper_id,
  });

  let answerText = "";
  let toolCalls = 0;
  let llmCalls = 0;
  let toolNames: string[] = [];

  const unsubscribe = sessionEntry.agent.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      answerText += event.assistantMessageEvent.delta;
    }

    if (event.type === "tool_execution_start") {
      toolCalls += 1;
      toolNames.push(event.toolName);
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      llmCalls += 1;
    }
  });

  try {
    await sessionEntry.agent.prompt(buildUserPrompt(data));
    return {
      run_id: runId,
      agent: "paper_qa",
      status: "completed",
      answer: {
        content: answerText,
        sources: [],
        trace_summary: {
          tool_calls: toolCalls,
          tools_used: toolNames,
          llm_calls: llmCalls,
        },
      },
      execution: {
        mode: "agent",
        trace_visibility: "compact",
        reason: "pi-agent",
      },
    };
  } finally {
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
    });
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
        },
        (chunk) => res.write(chunk),
      );
    } catch (err: any) {
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
      });
      sendJson(res, 200, result);
    } catch (err: any) {
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
