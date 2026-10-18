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
