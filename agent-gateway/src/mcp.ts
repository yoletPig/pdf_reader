/**
 * MCP (Model Context Protocol) 工具服务器管理。
 *
 * 根据系统设置里的 agent.mcp_servers 配置连接 MCP 服务器
 * （stdio 本地进程 / Streamable HTTP 远程端点），把服务器暴露的工具
 * 包装成 pi AgentTool 供 agent 调用。
 *
 * - 配置指纹不变时保持长连接，变化/删除时关闭重连
 * - 连接失败不阻塞 agent：记录错误状态，其余工具照常可用
 * - 提供 testServer 供设置页「测试连接」使用
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { McpServerConfig } from "./agent-config.js";

export interface McpServerStatus {
  name: string;
  transport: "stdio" | "http";
  status: "connected" | "connecting" | "error" | "disabled";
  tools: string[];
  error?: string;
}

interface McpConnection {
  config: McpServerConfig;
  client: Client;
  tools: AgentTool[];
  status: McpServerStatus;
}

const CONNECT_TIMEOUT_MS = 15_000;

function configFingerprint(cfg: McpServerConfig): string {
  return JSON.stringify({
    transport: cfg.transport,
    command: cfg.command,
    args: cfg.args,
    env: cfg.env,
    url: cfg.url,
    headers: cfg.headers,
    enabled: cfg.enabled,
  });
}

/** 工具名净化：LLM 工具名通常只允许 [a-zA-Z0-9_-] */
function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";
}

function buildTransport(cfg: McpServerConfig): StdioClientTransport | StreamableHTTPClientTransport {
  if (cfg.transport === "http") {
    const url = String(cfg.url || "").trim();
    if (!url) throw new Error("缺少 url");
    return new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { ...(cfg.headers || {}) } },
    });
  }
  const command = String(cfg.command || "").trim();
  if (!command) throw new Error("缺少 command");
  return new StdioClientTransport({
    command,
    args: (cfg.args || []).map(String),
    env: { ...(cfg.env || {}) },
  });
}

/** 把 MCP 工具包装为 AgentTool */
function wrapTool(conn: McpConnection, tool: any, usedNames: Set<string>): AgentTool {
  const rawName = String(tool?.name || "tool");
  let name = sanitizeToolName(`mcp__${conn.config.name}__${rawName}`);
  let dedupe = 2;
  while (usedNames.has(name)) {
    name = sanitizeToolName(`mcp__${conn.config.name}__${rawName}_${dedupe++}`);
  }
  usedNames.add(name);

  return {
    name,
    label: `MCP ${conn.config.name}: ${rawName}`,
    description: `[MCP 服务器 ${conn.config.name}] ${String(tool?.description || rawName)}`,
    parameters: (tool?.inputSchema ?? { type: "object", properties: {} }) as AgentTool["parameters"],
    execute: async (_toolCallId, rawParams): Promise<AgentToolResult> => {
      const result: any = await conn.client.callTool({
        name: rawName,
        arguments: ((rawParams as Record<string, unknown>) || {}) as Record<string, unknown>,
      });
      const blocks: any[] = Array.isArray(result?.content) ? result.content : [];
      const content: AgentToolResult["content"] = [];
      for (const block of blocks) {
        if (block?.type === "text") {
          content.push({ type: "text", text: String(block.text ?? "") });
        } else if (block?.type === "image") {
          content.push({
            type: "image",
            data: String(block.data ?? ""),
            mimeType: String(block.mimeType ?? "image/png"),
          });
        }
      }
      if (!content.length) {
        content.push({
          type: "text",
          text: result?.isError ? "（MCP 工具执行失败，无输出）" : "（MCP 工具无文本输出）",
        });
      }
      return {
        content,
        details: { server: conn.config.name, tool: rawName, isError: !!result?.isError },
      };
    },
  };
}

export class McpManager {
  private connections = new Map<string, McpConnection>();
  /** 配置中被禁用的服务器（保留展示状态） */
  private disabledNames = new Set<string>();

  /** 按配置同步连接（增量：指纹不变的连接保留） */
  async sync(servers: McpServerConfig[]): Promise<void> {
    const enabled = servers.filter((s) => s.enabled !== false);
    this.disabledNames = new Set(
      servers.filter((s) => s.enabled === false).map((s) => s.name),
    );
    const wanted = new Set(enabled.map((s) => s.name));

    for (const [name, conn] of [...this.connections]) {
      const keep = wanted.has(name) && configFingerprint(conn.config) === configFingerprint(
        enabled.find((s) => s.name === name)!,
      );
      if (!keep) {
        await conn.client.close().catch(() => {});
        this.connections.delete(name);
      }
    }

    for (const cfg of enabled) {
      if (this.connections.has(cfg.name)) continue;
      await this.open(cfg);
    }
  }

  private async open(cfg: McpServerConfig): Promise<McpConnection> {
    const conn: McpConnection = {
      config: cfg,
      client: new Client({ name: "pdf-reader-agent-gateway", version: "0.1.0" }),
      tools: [],
      status: { name: cfg.name, transport: cfg.transport, status: "connecting", tools: [] },
    };
    this.connections.set(cfg.name, conn);
    try {
      const transport = buildTransport(cfg);
      await Promise.race([
        conn.client.connect(transport),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`连接超时（${CONNECT_TIMEOUT_MS / 1000}s）`)), CONNECT_TIMEOUT_MS),
        ),
      ]);
      const listed: any = await conn.client.listTools();
      const usedNames = new Set<string>([
        ...this.builtinReservedNames(),
      ]);
      conn.tools = (listed?.tools || []).map((t: any) => wrapTool(conn, t, usedNames));
      conn.status = {
        name: cfg.name,
        transport: cfg.transport,
        status: "connected",
        tools: conn.tools.map((t) => t.name),
      };
    } catch (err: any) {
      conn.status = {
        name: cfg.name,
        transport: cfg.transport,
        status: "error",
        tools: [],
        error: String(err?.message || err),
      };
      await conn.client.close().catch(() => {});
    }
    return conn;
  }

  /** gateway 内置工具名（避免 MCP 包装名冲突） */
  private builtinReservedNames(): string[] {
    return [
      "list_papers", "read_paper_page", "read_paper_markdown", "search_paper_library",
      "read_paper_translation", "use_skill",
    ];
  }

  /** 当前全部 MCP 工具（连接成功的服务器） */
  tools(): AgentTool[] {
    const all: AgentTool[] = [];
    for (const conn of this.connections.values()) {
      if (conn.status.status === "connected") all.push(...conn.tools);
    }
    return all;
  }

  /** 全部服务器状态（含禁用/失败） */
  status(): McpServerStatus[] {
    const list: McpServerStatus[] = [];
    for (const conn of this.connections.values()) {
      list.push(conn.status);
    }
    for (const name of this.disabledNames) {
      list.push({ name, transport: "stdio", status: "disabled", tools: [] });
    }
    return list;
  }

  /** 测试单个服务器配置（不持久化，测完即关） */
  async testServer(cfg: McpServerConfig): Promise<McpServerStatus> {
    let client: Client | null = null;
    try {
      client = new Client({ name: "pdf-reader-agent-gateway-test", version: "0.1.0" });
      const transport = buildTransport(cfg);
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`连接超时（${CONNECT_TIMEOUT_MS / 1000}s）`)), CONNECT_TIMEOUT_MS),
        ),
      ]);
      const listed: any = await client.listTools();
      const names = (listed?.tools || []).map((t: any) => String(t?.name || ""));
      return {
        name: cfg.name,
        transport: cfg.transport,
        status: "connected",
        tools: names,
      };
    } catch (err: any) {
      return {
        name: cfg.name,
        transport: cfg.transport,
        status: "error",
        tools: [],
        error: String(err?.message || err),
      };
    } finally {
      if (client) await client.close().catch(() => {});
    }
  }

  /** 关闭全部连接（进程退出时调用） */
  async disposeAll(): Promise<void> {
    for (const conn of this.connections.values()) {
      await conn.client.close().catch(() => {});
    }
    this.connections.clear();
  }
}

export const mcpManager = new McpManager();
