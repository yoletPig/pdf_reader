/**
 * agent 行为配置 - 从 Python 后端 /api/config/agent-internal 读取。
 *
 * 包含：自定义系统指令、最大工具调用轮数、上下文窗口、技能（Skills）、MCP 服务器。
 * 与模型配置一样带 TTL 缓存，设置页保存后由后端调用 invalidate-config 立即刷新。
 */
import { proxiedFetch } from "./models.js";

const BACKEND_URL = process.env.PDF_READER_BACKEND_URL || "http://127.0.0.1:8000";

export interface SkillConfig {
  name: string;
  description: string;
  content: string;
}

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  /** stdio：启动命令（如 npx / uvx / node） */
  command?: string;
  /** stdio：命令参数 */
  args?: string[];
  /** stdio：附加环境变量 */
  env?: Record<string, string>;
  /** http：Streamable HTTP 端点 URL */
  url?: string;
  /** http：附加请求头（如 Authorization） */
  headers?: Record<string, string>;
  /** 是否启用（false 时仅保留配置不连接） */
  enabled?: boolean;
}

export interface AgentConfig {
  system_prompt: string;
  max_turns: number;
  context_window: number;
  skills: SkillConfig[];
  mcp_servers: McpServerConfig[];
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  system_prompt: "",
  max_turns: 25,
  context_window: 128000,
  skills: [],
  mcp_servers: [],
};

/** 从后端读取当前生效的 agent 配置 */
export async function fetchAgentConfig(): Promise<AgentConfig> {
  const response = await proxiedFetch(`${BACKEND_URL}/api/config/agent-internal`);
  if (!response.ok) {
    throw new Error(`读取 agent 配置失败: ${response.status}`);
  }
  const data: any = await response.json();
  return {
    system_prompt: String(data.system_prompt || ""),
    max_turns: Math.max(1, Math.min(200, Number(data.max_turns || 25))),
    context_window: Math.max(1000, Number(data.context_window || 128000)),
    skills: Array.isArray(data.skills) ? data.skills : [],
    mcp_servers: Array.isArray(data.mcp_servers) ? data.mcp_servers : [],
  };
}

/** 配置指纹：用于判断会话是否需要按新配置重建 */
export function agentConfigFingerprint(config: AgentConfig): string {
  return JSON.stringify({
    system_prompt: config.system_prompt,
    skills: config.skills,
    // MCP 工具变化影响工具列表；轮数/窗口只影响运行参数，无需重建会话
  });
}
