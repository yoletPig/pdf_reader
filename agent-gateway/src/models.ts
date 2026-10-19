/**
 * 模型提供方 - 从 Python 后端系统设置读取 OpenAI 兼容配置，
 * 构造 pi-ai 的自定义 provider（openai-completions API）。
 */
import {
  createModels,
  createProvider,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const BACKEND_URL = process.env.PDF_READER_BACKEND_URL || "http://127.0.0.1:8000";

// ---------------------------------------------------------------------------
// 代理感知的 fetch（解决"服务器需代理才能访问自定义 LLM 地址"的问题）
//
// Node 20 的全局 fetch 不读取 http_proxy/https_proxy 环境变量，而 pi-ai 的
// openai-completions API 走 openai SDK，默认用全局 fetch → 请求绕过代理，
// 导致访问需代理的 LLM 端点时连接超时。
//
// 方案：注入自定义 fetch，用 undici 的 EnvHttpProxyAgent 自动读取
// http_proxy/https_proxy/no_proxy 环境变量（backend 工具的 localhost 请求
// 会被 no_proxy 直连，不受影响）。
//
// EnvHttpProxyAgent 在构造时快照环境变量，因此检测到代理环境变化
// （proxyon/proxyoff）时重建 agent，无需重启进程。
// ---------------------------------------------------------------------------
import { fetch as undiciFetch, EnvHttpProxyAgent } from "undici";

let cachedProxyAgent: { agent: EnvHttpProxyAgent; envFingerprint: string } | null = null;

/** 读取当前代理环境变量指纹（http_proxy/https_proxy/no_proxy） */
function proxyEnvFingerprint(): string {
  const pick = (name: string) => process.env[name] || "";
  return [pick("http_proxy"), pick("HTTP_PROXY"), pick("https_proxy"), pick("HTTPS_PROXY"), pick("no_proxy"), pick("NO_PROXY")].join("|");
}

/** 获取（必要时重建）代理 agent；未配置代理时返回 undefined */
function getProxyDispatcher(): EnvHttpProxyAgent | undefined {
  const fp = proxyEnvFingerprint();
  if (cachedProxyAgent && cachedProxyAgent.envFingerprint === fp) {
    return cachedProxyAgent.agent;
  }
  // 全为空 → 无需代理，直接返回 undefined 让调用方回退到全局 fetch
  if (!fp.replace(/\|/g, "")) {
    cachedProxyAgent = null;
    return undefined;
  }
  const agent = new EnvHttpProxyAgent();
  cachedProxyAgent = { agent, envFingerprint: fp };
  return agent;
}

/** 代理感知的 fetch：LLM 请求经代理，no_proxy 中的目标（如 localhost 后端）直连 */
export function createProxiedFetch() {
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const dispatcher = getProxyDispatcher();
    // undici 与 DOM 的 RequestInit 类型存在差异，此处显式断言桥接
    const response = await undiciFetch(input as never, {
      ...(init as object),
      ...(dispatcher ? { dispatcher } : {}),
    } as never);
    return response as unknown as Response;
  };
}

// gateway 默认注入该 fetch（系统设置页模型连通性/问答都会用到）
export const proxiedFetch = createProxiedFetch();

export interface ModelConfig {
  base_url: string;
  api_key: string;
  model: string;
  max_tokens: number;
  temperature: number;
}

/** 从后端读取当前生效的模型配置（合并 .env 与数据库覆盖） */
export async function fetchModelConfig(): Promise<ModelConfig> {
  // 使用本机专用端点获取完整 key（/api/config/model 返回脱敏值）
  const response = await fetch(`${BACKEND_URL}/api/config/model-internal`);
  if (!response.ok) {
    throw new Error(`读取模型配置失败: ${response.status}`);
  }
  const data: any = await response.json();
  return {
    base_url: String(data.base_url || ""),
    api_key: String(data.api_key || ""),
    model: String(data.model || ""),
    max_tokens: Number(data.max_tokens || 4096),
    temperature: Number(data.temperature ?? 0.3),
  };
}

/** 用给定的模型配置构建 pi-ai Models 集合 */
export function buildModels(config: ModelConfig) {
  // 归一化 baseUrl：已含 /v1（或以 /v# 结尾）则不再追加
  const trimmed = config.base_url.replace(/\/+$/, "");
  const baseUrl = /\/v\d+$/.test(trimmed) ? trimmed : trimmed + "/v1";

  const customModel: Model<"openai-completions"> = {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: "pdf-reader",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: config.max_tokens,
    compat: {
      // 兼容多数自建/代理 OpenAI 端点
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
    },
  };

  const provider = createProvider({
    id: "pdf-reader",
    name: "PDF Reader LLM",
    baseUrl: customModel.baseUrl,
    auth: {
      apiKey: {
        name: "PDF Reader LLM API key",
        resolve: async () => ({
          auth: { apiKey: config.api_key },
        }),
      },
    },
    models: [customModel],
    api: openAICompletionsApi(),
  });

  const models = createModels();
  models.setProvider(provider);
  return models;
}
